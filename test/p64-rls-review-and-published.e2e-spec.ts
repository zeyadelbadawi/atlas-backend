/**
 * P64 Phase 1 — Row-Level Security, with HONEST fixtures.
 *
 * The pre-existing `rls-courses.e2e-spec.ts` asserts "fail-closed with no
 * session variable" using courses created at their schema defaults —
 * `draft`/`private`. That says nothing about the one policy that actually
 * matters for paid content: `courses_public_discovery_select` (and its
 * section/lesson twins), which admit a PUBLISHED + PUBLIC course with no
 * session predicate at all. Every fixture here is published + public on
 * purpose, so the tests describe the real exposure rather than a shape
 * that was never in question (master plan audit finding S2).
 *
 * It also proves the P64 review tier at the database layer: the policies
 * and the guards must agree independently (`can_review_course`), and an
 * instructor of another course, a plain organization member and another
 * tenant must all see zero rows.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('P64 Phase 1 — RLS with published+public fixtures and the review tier', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(label: string) {
    return prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
  }

  async function createOrgOwnedBy(ownerId: string, label: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: { id, name: label, slug: `${label}-${Date.now()}`, ownerUserId: ownerId },
      });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  /** A whole published+public world: academy, staff rows, course, quiz, enrolled student with an attempt. */
  async function publishedWorld(label: string) {
    const structure = await buildStructure(label);
    // Student-owned rows are written under the STUDENT's own context, in a
    // SEPARATE transaction — `*_self_insert` is the only policy that admits
    // them, and its `EXISTS (enrollments ...)` check can only see rows the
    // structure transaction has already committed. Exactly the production
    // sequence.
    const studentRows = await tenancyContext.runInUserContext(
      structure.student.id,
      async (stx) => {
        await stx.courseProgress.create({
          data: {
            enrollmentId: structure.enrollment.id,
            totalLessons: 1,
            completedLessons: 0,
          },
        });
        await stx.lessonProgress.create({
          data: {
            enrollmentId: structure.enrollment.id,
            lessonId: structure.lesson.id,
            sectionId: structure.section.id,
            courseId: structure.course.id,
            status: 'available',
          },
        });
        const attempt = await stx.quizAttempt.create({
          data: {
            quizId: structure.quiz.id,
            studentId: structure.student.id,
            status: 'failed',
            answers: [],
            score: 0,
            passed: false,
            attemptNumber: 1,
            submittedAt: new Date(),
          },
        });
        const submission = await stx.assignmentSubmission.create({
          data: {
            assignmentId: structure.assignment.id,
            studentId: structure.student.id,
            status: 'submitted',
            response: 'text',
            submittedAt: new Date(),
          },
        });
        return { attempt, submission };
      },
    );
    return { ...structure, ...studentRows };
  }

  async function buildStructure(label: string) {
    const owner = await createUser(`${label}-owner`);
    const manager = await createUser(`${label}-manager`);
    const instructor = await createUser(`${label}-instructor`);
    const otherInstructor = await createUser(`${label}-other-instructor`);
    const staff = await createUser(`${label}-staff`);
    const orgMember = await createUser(`${label}-org-member`);
    const student = await createUser(`${label}-student`);
    const stranger = await createUser(`${label}-stranger`);

    const org = await createOrgOwnedBy(owner.id, `${label}-org`);

    return tenancyContext.runInTenantAndUserContext(org.id, owner.id, async (tx) => {
      const academy = await tx.academy.create({
        data: { organizationId: org.id, name: label, slug: `${label}-${Date.now()}` },
      });
      for (const [user, role] of [
        [owner, 'owner'],
        [manager, 'manager'],
        [instructor, 'instructor'],
        [otherInstructor, 'instructor'],
        [staff, 'staff'],
      ] as const) {
        await tx.academyMember.create({
          data: { academyId: academy.id, userId: user.id, role, status: 'active' },
        });
      }
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: orgMember.id, role: 'member' },
      });

      const course = await tx.course.create({
        data: {
          academyId: academy.id,
          title: `${label} course`,
          slug: `${label}-course-${Date.now()}`,
          // The shape the old spec never created.
          status: 'published',
          visibility: 'public',
        },
      });
      const otherCourse = await tx.course.create({
        data: {
          academyId: academy.id,
          title: `${label} other`,
          slug: `${label}-other-${Date.now()}`,
          status: 'published',
          visibility: 'public',
        },
      });
      await tx.courseInstructor.create({
        data: { courseId: course.id, userId: instructor.id },
      });
      await tx.courseInstructor.create({
        data: { courseId: otherCourse.id, userId: otherInstructor.id },
      });

      const section = await tx.courseSection.create({
        data: { courseId: course.id, title: 'S1', order: 0 },
      });
      const lesson = await tx.courseLesson.create({
        data: {
          sectionId: section.id,
          courseId: course.id,
          title: 'L1',
          order: 0,
          contentType: 'text',
          status: 'published',
          contentUrl: 'https://example.com/secret.mp4',
        },
      });

      await tx.academyStudent.create({
        data: {
          academyId: academy.id,
          userId: student.id,
          status: 'active',
          source: 'staff_created',
        },
      });
      const enrollment = await tx.enrollment.create({
        data: {
          studentId: student.id,
          courseId: course.id,
          academyId: academy.id,
          status: 'enrolled',
          enrolledAt: new Date(),
        },
      });

      const quiz = await tx.quiz.create({
        data: { courseId: course.id, title: 'Quiz', status: 'published', order: 0 },
      });
      const assignment = await tx.assignment.create({
        data: { courseId: course.id, title: 'Assignment', status: 'published', order: 1 },
      });

      return {
        org,
        academy,
        course,
        otherCourse,
        section,
        lesson,
        quiz,
        assignment,
        enrollment,
        owner,
        manager,
        instructor,
        otherInstructor,
        staff,
        orgMember,
        student,
        stranger,
      };
    });
  }

  it('a PUBLISHED + PUBLIC course and its curriculum are visible with no context — the exposure this phase documents', async () => {
    const w = await publishedWorld('rls-pub');

    const rows = await prisma.$transaction(async (tx) => {
      const courses = await tx.course.findMany({ where: { id: w.course.id } });
      const sections = await tx.courseSection.findMany({ where: { id: w.section.id } });
      const lessons = await tx.courseLesson.findMany({ where: { id: w.lesson.id } });
      return { courses, sections, lessons };
    });

    // This is the finding, asserted rather than assumed: the public
    // discovery policies carry no session predicate, so a contextless
    // reader sees the row. Phase 2 moves lesson BODIES into
    // `lesson_contents`, which will have no public policy at all.
    expect(rows.courses).toHaveLength(1);
    expect(rows.sections).toHaveLength(1);
    expect(rows.lessons).toHaveLength(1);
  });

  it('student-owned rows stay invisible without context, even for a published+public course', async () => {
    const w = await publishedWorld('rls-student-rows');

    const rows = await prisma.$transaction(async (tx) => ({
      enrollments: await tx.enrollment.findMany({ where: { id: w.enrollment.id } }),
      attempts: await tx.quizAttempt.findMany({ where: { id: w.attempt.id } }),
      submissions: await tx.assignmentSubmission.findMany({
        where: { id: w.submission.id },
      }),
      progress: await tx.courseProgress.findMany({
        where: { enrollmentId: w.enrollment.id },
      }),
      lessonProgress: await tx.lessonProgress.findMany({
        where: { enrollmentId: w.enrollment.id },
      }),
    }));

    expect(rows.enrollments).toHaveLength(0);
    expect(rows.attempts).toHaveLength(0);
    expect(rows.submissions).toHaveLength(0);
    expect(rows.progress).toHaveLength(0);
    expect(rows.lessonProgress).toHaveLength(0);
  });

  it('the review tier admits the course instructor, the owner and the manager — and nobody else', async () => {
    const w = await publishedWorld('rls-review');

    for (const reviewer of [w.instructor, w.owner, w.manager]) {
      const seen = await tenancyContext.runInUserContext(reviewer.id, async (tx) => ({
        attempts: await tx.quizAttempt.findMany({ where: { id: w.attempt.id } }),
        submissions: await tx.assignmentSubmission.findMany({
          where: { id: w.submission.id },
        }),
        progress: await tx.courseProgress.findMany({
          where: { enrollmentId: w.enrollment.id },
        }),
        lessonProgress: await tx.lessonProgress.findMany({
          where: { enrollmentId: w.enrollment.id },
        }),
      }));
      expect(seen.attempts).toHaveLength(1);
      expect(seen.submissions).toHaveLength(1);
      expect(seen.progress).toHaveLength(1);
      expect(seen.lessonProgress).toHaveLength(1);
    }

    for (const outsider of [w.otherInstructor, w.staff, w.orgMember, w.stranger]) {
      const seen = await tenancyContext.runInUserContext(outsider.id, async (tx) => ({
        attempts: await tx.quizAttempt.findMany({ where: { id: w.attempt.id } }),
        submissions: await tx.assignmentSubmission.findMany({
          where: { id: w.submission.id },
        }),
      }));
      expect(seen.attempts).toHaveLength(0);
      expect(seen.submissions).toHaveLength(0);
    }
  });

  it('a foreign tenant sees none of another academy’s student rows', async () => {
    const a = await publishedWorld('rls-tenant-a');
    const b = await publishedWorld('rls-tenant-b');

    const seen = await tenancyContext.runInTenantAndUserContext(
      b.org.id,
      b.owner.id,
      async (tx) => ({
        attempts: await tx.quizAttempt.findMany({ where: { id: a.attempt.id } }),
        students: await tx.academyStudent.findMany({
          where: { academyId: a.academy.id },
        }),
        enrollments: await tx.enrollment.findMany({ where: { id: a.enrollment.id } }),
      }),
    );
    expect(seen.attempts).toHaveLength(0);
    expect(seen.students).toHaveLength(0);
    expect(seen.enrollments).toHaveLength(0);
  });

  it('the roster policy narrows an instructor to the students of their own courses (user-only context)', async () => {
    const w = await publishedWorld('rls-roster');

    // Under a USER-ONLY context the only applicable policy is
    // `academy_students_staff_select` → `can_view_academy_student`, which is
    // the rule the RBAC matrix states.
    const asInstructor = await tenancyContext.runInUserContext(w.instructor.id, (tx) =>
      tx.academyStudent.findMany({ where: { academyId: w.academy.id } }),
    );
    expect(asInstructor.map((row) => row.userId)).toEqual([w.student.id]);

    const asOtherInstructor = await tenancyContext.runInUserContext(
      w.otherInstructor.id,
      (tx) => tx.academyStudent.findMany({ where: { academyId: w.academy.id } }),
    );
    expect(asOtherInstructor).toHaveLength(0);

    const asStaff = await tenancyContext.runInUserContext(w.staff.id, (tx) =>
      tx.academyStudent.findMany({ where: { academyId: w.academy.id } }),
    );
    expect(asStaff).toHaveLength(0);

    for (const manager of [w.owner, w.manager]) {
      const seen = await tenancyContext.runInUserContext(manager.id, (tx) =>
        tx.academyStudent.findMany({ where: { academyId: w.academy.id } }),
      );
      expect(seen.map((row) => row.userId)).toEqual([w.student.id]);
    }

    // Documented layering: the pre-existing `academy_students_tenant_select`
    // (P27c) deliberately admits the whole roster to ANY caller who can open
    // the organization's tenant context — that is what the owner dashboards
    // read through. Narrowing an instructor to their own courses is the
    // application layer's job there (`AcademyStudentsService.resolveViewer`),
    // and `p64-rbac-review.e2e-spec.ts` asserts it end to end over HTTP.
    const asOtherInstructorWithTenant = await tenancyContext.runInTenantAndUserContext(
      w.org.id,
      w.otherInstructor.id,
      (tx) => tx.academyStudent.findMany({ where: { academyId: w.academy.id } }),
    );
    expect(asOtherInstructorWithTenant).toHaveLength(1);
  });

  it('a student cannot change their own enrollment lifecycle columns', async () => {
    const w = await publishedWorld('rls-self-update');

    // Progress-shaped updates on their own row stay allowed.
    await expect(
      tenancyContext.runInUserContext(w.student.id, (tx) =>
        tx.enrollment.update({
          where: { id: w.enrollment.id },
          data: { status: 'completed', completedAt: new Date() },
        }),
      ),
    ).resolves.toBeDefined();

    for (const data of [
      { revokedAt: new Date() },
      { expiresAt: new Date(Date.now() + 86_400_000) },
      { accessSource: 'order' as const },
      { courseId: w.otherCourse.id },
    ]) {
      await expect(
        tenancyContext.runInUserContext(w.student.id, (tx) =>
          tx.enrollment.update({ where: { id: w.enrollment.id }, data }),
        ),
      ).rejects.toThrow();
    }

    // And a revoked enrollment cannot be revived by its own student.
    await tenancyContext.runInTenantAndUserContext(w.org.id, w.owner.id, (tx) =>
      tx.enrollment.update({
        where: { id: w.enrollment.id },
        data: { status: 'unavailable', revokedAt: new Date(), revokeReason: 'manual' },
      }),
    );
    await expect(
      tenancyContext.runInUserContext(w.student.id, (tx) =>
        tx.enrollment.update({
          where: { id: w.enrollment.id },
          data: { status: 'enrolled' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('the author tier can read sections and lessons of a DRAFT course under a user-only context', async () => {
    const w = await publishedWorld('rls-draft-author');

    const draft = await tenancyContext.runInTenantAndUserContext(
      w.org.id,
      w.owner.id,
      async (tx) => {
        const course = await tx.course.create({
          data: {
            academyId: w.academy.id,
            title: 'Draft',
            slug: `draft-${Date.now()}`,
            status: 'draft',
            visibility: 'private',
          },
        });
        const section = await tx.courseSection.create({
          data: { courseId: course.id, title: 'Draft section', order: 0 },
        });
        return { course, section };
      },
    );

    const seen = await tenancyContext.runInUserContext(w.owner.id, (tx) =>
      tx.courseSection.findMany({ where: { id: draft.section.id } }),
    );
    expect(seen).toHaveLength(1);

    const unrelated = await tenancyContext.runInUserContext(w.stranger.id, (tx) =>
      tx.courseSection.findMany({ where: { id: draft.section.id } }),
    );
    expect(unrelated).toHaveLength(0);
  });

  it('resolves the enrolled-student course tier through a definer function, not an inline subquery', async () => {
    /*
      A cost regression, pinned because it was expensive rather than wrong.

      `courses_enrolled_student_select` first shipped as an inline
      `EXISTS (SELECT 1 FROM enrollments ...)`. That subquery runs as the
      invoking role, so it evaluated every RLS policy on `enrollments`
      once per candidate course row. Measured through the pre-existing
      `course_categories_public_discovery_select` policy on a database
      carrying ~2,400 published public courses: 2,319 ms without the tier,
      3,658 ms with it, 2,025 ms once it went through
      `is_enrolled_in_course` — and the guarded course-list endpoint went
      from 5.8 s and failing to 0.68 s.

      Asserting the SHAPE of the policy rather than a duration keeps this
      deterministic: a timing assertion would be flaky on shared hardware,
      and the shape is what actually decides the cost.
    */
    const [policy] = await prisma.$queryRaw<{ qual: string }[]>`
      SELECT qual FROM pg_policies
      WHERE tablename = 'courses' AND policyname = 'courses_enrolled_student_select'
    `;
    expect(policy).toBeTruthy();
    expect(policy.qual).toContain('is_enrolled_in_course');
    expect(policy.qual.toLowerCase()).not.toContain('from enrollments');

    // ...and the function is SECURITY DEFINER, which is what lets it skip
    // the policies of the table it reads.
    const [fn] = await prisma.$queryRaw<{ prosecdef: boolean }[]>`
      SELECT prosecdef FROM pg_proc WHERE proname = 'is_enrolled_in_course'
    `;
    expect(fn?.prosecdef).toBe(true);
  });
});
