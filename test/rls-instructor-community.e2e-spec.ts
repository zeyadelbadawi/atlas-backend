/**
 * Direct PostgreSQL/RLS proof for the P7 migration — mirrors
 * `rls-learning.e2e-spec.ts`'s exact pattern: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role) and `TenancyContextService`. No guard, no
 * service, no HTTP request is involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { uniqueTestEmail, createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — P7 Instructor Operations & Community tables (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    admin = createAdminPrisma();
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function createUser(label: string): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
    return { id: user.id };
  }

  async function createFullCourseGraph(label: string) {
    const owner = await createUser(`${label}-owner`);
    const org = await admin.organization.create({
      data: { name: label, slug: `${label}-${Date.now()}`, ownerUserId: owner.id },
    });
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: owner.id, role: 'owner', isPrimary: true },
    });
    const academy = await admin.academy.create({
      data: { organizationId: org.id, name: label, slug: `${label}-${Date.now()}` },
    });
    // Phase 1 (Extended Scope, dependency A/B) — reproduces the real
    // `AcademiesService.create`'s auto-granted owner membership, which the
    // new `is_academy_member`-gated `blog_posts` write policies now require.
    await admin.academyMember.create({
      data: { academyId: academy.id, userId: owner.id, role: 'owner', status: 'active' },
    });
    const course = await admin.course.create({
      data: {
        academyId: academy.id,
        title: label,
        slug: `${label}-${Date.now()}`,
        status: 'published',
        visibility: 'public',
      },
    });
    return { owner, org, academy, course };
  }

  it('announcements: with no session context set, a course-scoped draft announcement is invisible', async () => {
    const { course, owner } = await createFullCourseGraph('rls-ann-draft');
    const announcement = await admin.announcement.create({
      data: {
        audience: 'course',
        courseId: course.id,
        academyId: (await admin.course.findUniqueOrThrow({ where: { id: course.id } }))
          .academyId,
        authorId: owner.id,
        title: 'Draft',
        body: 'x',
        status: 'draft',
      },
    });

    const rows = await prisma.announcement.findMany({ where: { id: announcement.id } });
    expect(rows).toEqual([]);
  });

  it('announcements: a published course announcement is visible to an actively enrolled student under their own user context', async () => {
    const { course, owner, academy } = await createFullCourseGraph('rls-ann-published');
    const student = await createUser('rls-ann-published-student');
    await admin.academyStudent.create({
      data: { academyId: academy.id, userId: student.id },
    });
    await tenancyContext.runInUserContext(student.id, (tx) =>
      tx.enrollment.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          academyId: academy.id,
          status: 'enrolled',
          enrolledAt: new Date(),
        },
      }),
    );
    const announcement = await admin.announcement.create({
      data: {
        audience: 'course',
        courseId: course.id,
        academyId: academy.id,
        authorId: owner.id,
        title: 'Published',
        body: 'x',
        status: 'published',
        publishedAt: new Date(),
      },
    });

    const visible = await tenancyContext.runInUserContext(student.id, (tx) =>
      tx.announcement.findUnique({ where: { id: announcement.id } }),
    );
    expect(visible?.id).toBe(announcement.id);

    const otherStudent = await createUser('rls-ann-published-other');
    const invisible = await tenancyContext.runInUserContext(otherStudent.id, (tx) =>
      tx.announcement.findUnique({ where: { id: announcement.id } }),
    );
    expect(invisible).toBeNull();
  });

  it('blog_posts: only the real author can UPDATE their post, even with a crafted id — a different real staff member is blocked at the database level', async () => {
    const { academy, owner } = await createFullCourseGraph('rls-blog-author');
    const otherStaff = await createUser('rls-blog-author-other');
    await admin.academyMember.create({
      data: { academyId: academy.id, userId: otherStaff.id, role: 'administrator' },
    });

    const post = await tenancyContext.runInUserContext(owner.id, (tx) =>
      tx.blogPost.create({
        data: {
          academyId: academy.id,
          authorId: owner.id,
          title: 'Mine',
          slug: `rls-blog-author-${Date.now()}`,
          content: 'x',
        },
      }),
    );

    await expect(
      tenancyContext.runInUserContext(otherStaff.id, (tx) =>
        tx.blogPost.update({ where: { id: post.id }, data: { title: 'Hijacked' } }),
      ),
    ).rejects.toThrow();

    const stillOriginal = await admin.blogPost.findUniqueOrThrow({
      where: { id: post.id },
    });
    expect(stillOriginal.title).toBe('Mine');
  });

  it('course_instructors: still has no INSERT policy at all — a real instructor cannot self-assign, even under their own user context', async () => {
    const { course } = await createFullCourseGraph('rls-ci-no-insert');
    const wouldBeInstructor = await createUser('rls-ci-no-insert-instructor');

    await expect(
      tenancyContext.runInUserContext(wouldBeInstructor.id, (tx) =>
        tx.courseInstructor.create({
          data: { courseId: course.id, userId: wouldBeInstructor.id },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('assignment_submissions: the additive instructor policy lets a real course instructor grade, but an instructor of a DIFFERENT course cannot, even given the exact submission id', async () => {
    const { course } = await createFullCourseGraph('rls-grade-instructor');
    const student = await createUser('rls-grade-instructor-student');
    const realInstructor = await createUser('rls-grade-instructor-real');
    const otherInstructor = await createUser('rls-grade-instructor-other');
    const { course: otherCourse } = await createFullCourseGraph(
      'rls-grade-instructor-other-course',
    );

    await admin.courseInstructor.create({
      data: { courseId: course.id, userId: realInstructor.id },
    });
    await admin.courseInstructor.create({
      data: { courseId: otherCourse.id, userId: otherInstructor.id },
    });
    const assignment = await admin.assignment.create({
      data: { courseId: course.id, title: 'A', status: 'published' },
    });
    const submission = await tenancyContext.runInUserContext(student.id, (tx) =>
      tx.assignmentSubmission.create({
        data: {
          assignmentId: assignment.id,
          studentId: student.id,
          status: 'submitted',
          submittedAt: new Date(),
        },
      }),
    );

    // The real instructor CAN see and grade it.
    const visibleToReal = await tenancyContext.runInUserContext(realInstructor.id, (tx) =>
      tx.assignmentSubmission.findUnique({ where: { id: submission.id } }),
    );
    expect(visibleToReal?.id).toBe(submission.id);

    await tenancyContext.runInUserContext(realInstructor.id, (tx) =>
      tx.assignmentSubmission.update({
        where: { id: submission.id },
        data: { gradingStatus: 'graded', score: 90 },
      }),
    );

    // A different course's instructor can neither see it...
    const visibleToOther = await tenancyContext.runInUserContext(
      otherInstructor.id,
      (tx) => tx.assignmentSubmission.findUnique({ where: { id: submission.id } }),
    );
    expect(visibleToOther).toBeNull();

    // ...nor update it, even addressing the exact real id directly.
    const result = await tenancyContext.runInUserContext(otherInstructor.id, (tx) =>
      tx.assignmentSubmission.updateMany({
        where: { id: submission.id },
        data: { feedback: 'should never land' },
      }),
    );
    expect(result.count).toBe(0);
    const stillReal = await admin.assignmentSubmission.findUniqueOrThrow({
      where: { id: submission.id },
    });
    expect(stillReal.feedback).not.toBe('should never land');
  });

  it('forum_replies: cannot be inserted by a user with no real relationship to the course, even with a crafted thread id', async () => {
    const { course } = await createFullCourseGraph('rls-forum-attack');
    const instructor = await createUser('rls-forum-attack-instructor');
    await admin.courseInstructor.create({
      data: { courseId: course.id, userId: instructor.id },
    });
    const forum = await tenancyContext.runInUserContext(instructor.id, (tx) =>
      tx.forum.create({
        data: { courseId: course.id, academyId: course.academyId, title: 'Forum' },
      }),
    );
    const thread = await tenancyContext.runInUserContext(instructor.id, (tx) =>
      tx.forumThread.create({
        data: {
          forumId: forum.id,
          courseId: course.id,
          authorId: instructor.id,
          title: 'T',
          body: 'x',
        },
      }),
    );

    const attacker = await createUser('rls-forum-attack-attacker');
    await expect(
      tenancyContext.runInUserContext(attacker.id, (tx) =>
        tx.forumReply.create({
          data: { threadId: thread.id, authorId: attacker.id, body: 'sneaking in' },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });
});
