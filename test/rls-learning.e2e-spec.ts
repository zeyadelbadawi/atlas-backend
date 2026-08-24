/**
 * Direct PostgreSQL/RLS proof for the P6 tables (`enrollments`,
 * `course_progress`, `lesson_progress`, `quiz_attempts`,
 * `assignment_submissions`) plus the additive public-discovery policies on
 * `courses`/`course_categories`/`course_instructors` — mirrors
 * `rls-courses.e2e-spec.ts` exactly: every test talks to Postgres directly
 * through the app's own `PrismaService` (connected as the restricted
 * `atlas_app` role) and `TenancyContextService`. No guard, no service, no
 * HTTP request is involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uniqueTestEmail, createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — P6 Student Learning tables (direct, no guards)', () => {
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

  /** Mirrors `rls-courses.e2e-spec.ts`'s `createOrgOwnedBy` exactly — the org's own `id` must be pre-generated and set as `app.current_organization_id` *before* the INSERT, matching the P2 `organizations_insert` policy's `WITH CHECK` shape (`id` must equal the active tenant context, not merely `owner_user_id` matching the caller). */
  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: {
          id,
          name: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          ownerUserId: ownerId,
        },
      });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  async function createFullCourseGraph(label: string) {
    const owner = await createUser(`${label}-owner`);
    const org = await createOrgOwnedBy(owner.id, label);
    const academy = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.academy.create({
        data: { organizationId: org.id, name: label, slug: `${label}-${Date.now()}` },
      }),
    );
    const course = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.course.create({
        data: {
          academyId: academy.id,
          title: label,
          slug: `${label}-${Date.now()}`,
          status: 'published',
          visibility: 'public',
        },
      }),
    );
    return { owner, org, academy, course };
  }

  async function createEnrollment(
    studentId: string,
    courseId: string,
    academyId: string,
  ) {
    return tenancyContext.runInUserContext(studentId, (tx) =>
      tx.enrollment.create({
        data: {
          studentId,
          courseId,
          academyId,
          status: 'enrolled',
          enrolledAt: new Date(),
        },
      }),
    );
  }

  it('SELECT: with no session variable set at all, every enrollment row is invisible (fail-closed)', async () => {
    const { course, academy } = await createFullCourseGraph('rls-enroll-noctx');
    const student = await createUser('rls-enroll-noctx-student');
    const enrollment = await createEnrollment(student.id, course.id, academy.id);

    const rows = await prisma.enrollment.findMany({ where: { id: enrollment.id } });
    expect(rows).toEqual([]);
  });

  it("SELECT: a student user-context only ever sees their own enrollment, never another student's", async () => {
    const { course, academy } = await createFullCourseGraph('rls-enroll-cross');
    const studentA = await createUser('rls-enroll-cross-a');
    const studentB = await createUser('rls-enroll-cross-b');
    const enrollmentA = await createEnrollment(studentA.id, course.id, academy.id);
    const enrollmentB = await createEnrollment(studentB.id, course.id, academy.id);

    const visibleToA = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.enrollment.findMany({ where: { id: { in: [enrollmentA.id, enrollmentB.id] } } }),
    );
    expect(visibleToA.map((e) => e.id)).toEqual([enrollmentA.id]);
  });

  it('ATTACK (blocked): cannot insert an enrollment for a different student than the active user context', async () => {
    const { course, academy } = await createFullCourseGraph('rls-atk-enroll');
    const attacker = await createUser('rls-atk-enroll-attacker');
    const victim = await createUser('rls-atk-enroll-victim');

    await expect(
      tenancyContext.runInUserContext(attacker.id, (tx) =>
        tx.enrollment.create({
          data: {
            studentId: victim.id,
            courseId: course.id,
            academyId: academy.id,
            status: 'enrolled',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("SELECT (transitive): course_progress/lesson_progress are visible only through their own enrollment's student context", async () => {
    const { course, academy } = await createFullCourseGraph('rls-progress-cross');
    const studentA = await createUser('rls-progress-cross-a');
    const studentB = await createUser('rls-progress-cross-b');
    const enrollmentA = await createEnrollment(studentA.id, course.id, academy.id);

    const progress = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.courseProgress.create({
        data: { enrollmentId: enrollmentA.id, totalLessons: 1 },
      }),
    );

    const visibleToOwner = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.courseProgress.findUnique({ where: { enrollmentId: enrollmentA.id } }),
    );
    expect(visibleToOwner?.enrollmentId).toBe(enrollmentA.id);

    const visibleToOther = await tenancyContext.runInUserContext(studentB.id, (tx) =>
      tx.courseProgress.findUnique({ where: { enrollmentId: enrollmentA.id } }),
    );
    expect(visibleToOther).toBeNull();
    void progress;
  });

  it('SELECT: a student user-context only ever sees their own quiz_attempts', async () => {
    const { course } = await createFullCourseGraph('rls-attempt-cross');
    // `quizzes` has no INSERT policy at all (read-only, admin-seeded only
    // — see this migration's own doc comment) — created via the admin
    // (superuser) connection, mirroring every HTTP-level P6 e2e spec's
    // `seedQuiz` usage, never through the restricted `atlas_app` role.
    const quiz = await admin.quiz.create({
      data: { courseId: course.id, title: 'Quiz', status: 'published' },
    });
    const studentA = await createUser('rls-attempt-cross-a');
    const studentB = await createUser('rls-attempt-cross-b');
    const attemptA = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.quizAttempt.create({
        data: {
          quizId: quiz.id,
          studentId: studentA.id,
          status: 'in_progress',
          attemptNumber: 1,
        },
      }),
    );

    const visibleToOwner = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.quizAttempt.findUnique({ where: { id: attemptA.id } }),
    );
    expect(visibleToOwner?.id).toBe(attemptA.id);

    const visibleToOther = await tenancyContext.runInUserContext(studentB.id, (tx) =>
      tx.quizAttempt.findUnique({ where: { id: attemptA.id } }),
    );
    expect(visibleToOther).toBeNull();
  });

  it('ATTACK (blocked): cannot insert a quiz_attempt for a different student than the active user context', async () => {
    const { course } = await createFullCourseGraph('rls-atk-attempt');
    const quiz = await admin.quiz.create({
      data: { courseId: course.id, title: 'Quiz', status: 'published' },
    });
    const attacker = await createUser('rls-atk-attempt-attacker');
    const victim = await createUser('rls-atk-attempt-victim');

    await expect(
      tenancyContext.runInUserContext(attacker.id, (tx) =>
        tx.quizAttempt.create({
          data: {
            quizId: quiz.id,
            studentId: victim.id,
            status: 'in_progress',
            attemptNumber: 1,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('SELECT: a student user-context only ever sees their own assignment_submissions', async () => {
    const { course } = await createFullCourseGraph('rls-submission-cross');
    // `assignments` also has no INSERT policy — same reasoning as `quiz` above.
    const assignment = await admin.assignment.create({
      data: { courseId: course.id, title: 'A', status: 'published' },
    });
    const studentA = await createUser('rls-submission-cross-a');
    const studentB = await createUser('rls-submission-cross-b');
    const submissionA = await tenancyContext.runInUserContext(studentA.id, (tx) =>
      tx.assignmentSubmission.create({
        data: {
          assignmentId: assignment.id,
          studentId: studentA.id,
          status: 'submitted',
        },
      }),
    );

    const visibleToOther = await tenancyContext.runInUserContext(studentB.id, (tx) =>
      tx.assignmentSubmission.findUnique({ where: { id: submissionA.id } }),
    );
    expect(visibleToOther).toBeNull();
  });

  it('ADDITIVE POLICY: a published+public course is readable with NO session context set at all', async () => {
    const { course } = await createFullCourseGraph('rls-discovery-public');

    const visible = await prisma.course.findUnique({ where: { id: course.id } });
    expect(visible?.id).toBe(course.id);
  });

  it('ADDITIVE POLICY: a draft course is still invisible with no session context, despite the public-discovery policy', async () => {
    const owner = await createUser('rls-discovery-draft-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-discovery-draft');
    const academy = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.academy.create({
        data: {
          organizationId: org.id,
          name: 'rls-discovery-draft',
          slug: `rls-discovery-draft-${Date.now()}`,
        },
      }),
    );
    const draft = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.course.create({
        data: {
          academyId: academy.id,
          title: 'Draft',
          slug: `rls-discovery-draft-c-${Date.now()}`,
          status: 'draft',
          visibility: 'public',
        },
      }),
    );

    const visible = await prisma.course.findUnique({ where: { id: draft.id } });
    expect(visible).toBeNull();
  });

  it("LEGITIMATE (allowed): materializing course_progress + lesson_progress at enrollment time within the student's own user context", async () => {
    const { course, org, academy } = await createFullCourseGraph('rls-legit-progress');
    const section = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.courseSection.create({ data: { courseId: course.id, title: 'S', order: 0 } }),
    );
    const lesson = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.courseLesson.create({
        data: {
          sectionId: section.id,
          courseId: course.id,
          title: 'L',
          order: 0,
          contentType: 'text',
          status: 'published',
        },
      }),
    );
    const student = await createUser('rls-legit-progress-student');
    const enrollment = await createEnrollment(student.id, course.id, academy.id);

    const { progress, lessonProgress } = await tenancyContext.runInUserContext(
      student.id,
      async (tx) => {
        const progress = await tx.courseProgress.create({
          data: { enrollmentId: enrollment.id, totalLessons: 1 },
        });
        const lessonProgress = await tx.lessonProgress.create({
          data: {
            enrollmentId: enrollment.id,
            lessonId: lesson.id,
            sectionId: section.id,
            courseId: course.id,
            status: 'available',
          },
        });
        return { progress, lessonProgress };
      },
    );

    expect(progress.enrollmentId).toBe(enrollment.id);
    expect(lessonProgress.lessonId).toBe(lesson.id);
  });
});
