/**
 * P64 Phase 1 — the RBAC matrix at the guard layer (master plan Finding F5,
 * Section O).
 *
 * The matrix under test, per course:
 *   view attempts / submissions / grade  → course instructor, academy
 *                                          owner/administrator/manager
 *   edit curriculum                      → the same set (instructor limited
 *                                          to assigned courses)
 *   list students                        → owner/manager (whole academy),
 *                                          instructor (their courses only)
 *   security policy (registration)       → owner only (D8)
 * Everyone else — academy `staff`, a plain organization member, a student,
 * an instructor of ANOTHER course — gets 404/403.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedMembership,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 1 — review and curriculum RBAC (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function account(label: string) {
    // Many accounts per test: keep the sign-in rate limiter out of the way.
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** One academy with every role, one course with an instructor, a quiz, an assignment and an enrolled student. */
  async function world(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const manager = await account(`${label}-manager`);
    await seedMembership(admin, org.id, manager.userId, 'manager');
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');

    const instructor = await account(`${label}-instructor`);
    await seedMembership(admin, org.id, instructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');

    const otherInstructor = await account(`${label}-other-instructor`);
    await seedMembership(admin, org.id, otherInstructor.userId, 'instructor');
    await seedAcademyMember(admin, academy.id, otherInstructor.userId, 'instructor');

    const staff = await account(`${label}-staff`);
    await seedMembership(admin, org.id, staff.userId, 'member');
    await seedAcademyMember(admin, academy.id, staff.userId, 'staff');

    const orgMember = await account(`${label}-org-member`);
    await seedMembership(admin, org.id, orgMember.userId, 'member');

    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    await seedCourseInstructor(admin, course.id, instructor.userId);

    const otherCourse = await seedCourse(admin, academy.id, `${label} Other`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    await seedCourseInstructor(admin, otherCourse.id, otherInstructor.userId);

    const section = await seedCourseSection(admin, course.id, `${label}-section`, 0);
    await seedCourseLesson(admin, section.id, course.id, `${label}-lesson`, 0, {
      status: 'published',
    });

    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
    });
    const question = await seedQuizQuestion(admin, quiz.id, 'Q1', 'single_choice', 0);
    const correct = await seedQuizQuestionOption(admin, question.id, 'Right', true);
    await seedQuizQuestionOption(admin, question.id, 'Wrong', false);

    const assignment = await seedAssignment(admin, course.id, `${label}-assignment`, {
      status: 'published',
    });

    // A real student with a real attempt and a real submission.
    await flushRateLimitKeys();
    const studentEmail = uniqueTestEmail(`${label}-student`);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Student',
        email: studentEmail,
        password: PASSWORD,
        academyId: academy.id,
      })
      .expect(201);
    const studentSignIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: studentEmail,
        password: PASSWORD,
        surface: 'academy',
        academyId: academy.id,
      })
      .expect(200);
    const student = {
      userId: studentSignIn.body.user.id as string,
      auth: { Authorization: `Bearer ${studentSignIn.body.accessToken as string}` },
    };
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(student.auth)
      .send({ courseId: course.id })
      .expect(201);

    const attempt = await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts`)
      .set(student.auth)
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/quizzes/${quiz.id}/attempts/${attempt.body.id}/submit`)
      .set(student.auth)
      .send({ answers: [{ questionId: question.id, selectedOptionIds: [correct.id] }] })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/courses/${course.id}/assignments/${assignment.id}/submission`)
      .set(student.auth)
      .send({ response: 'My answer' })
      .expect(201);

    return {
      org,
      academy,
      course,
      otherCourse,
      section,
      quiz,
      assignment,
      owner,
      manager,
      instructor,
      otherInstructor,
      staff,
      orgMember,
      student,
    };
  }

  it('owner, manager and the course instructor can review attempts; nobody else can', async () => {
    const w = await world('review-attempts');
    const path = `/review/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`;

    for (const actor of [w.owner, w.manager, w.instructor]) {
      const res = await request(app.getHttpServer())
        .get(path)
        .set(actor.auth)
        .expect(200);
      expect(res.body.items.length).toBeGreaterThan(0);
    }
    for (const actor of [w.otherInstructor, w.staff, w.orgMember]) {
      await request(app.getHttpServer()).get(path).set(actor.auth).expect(404);
    }
    // A learner is refused by the management-surface guard before the
    // course is even looked up.
    await request(app.getHttpServer()).get(path).set(w.student.auth).expect(403);

    // The legacy `instructor/*` prefix still works for one release.
    await request(app.getHttpServer())
      .get(`/instructor/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(w.owner.auth)
      .expect(200);
  });

  it('owner and manager can read and GRADE submissions, not only the instructor', async () => {
    const w = await world('review-grade');
    const list = await request(app.getHttpServer())
      .get(`/review/courses/${w.course.id}/assignments/${w.assignment.id}/submissions`)
      .set(w.manager.auth)
      .expect(200);
    const submissionId = list.body.items[0].id as string;

    await request(app.getHttpServer())
      .post(
        `/review/courses/${w.course.id}/assignments/${w.assignment.id}/submissions/${submissionId}/grade`,
      )
      .set(w.manager.auth)
      .send({ score: 90, feedback: 'Good work' })
      .expect(201);

    const graded = await admin.assignmentSubmission.findUniqueOrThrow({
      where: { id: submissionId },
    });
    expect(Number(graded.score)).toBe(90);
    expect(graded.gradingStatus).toBe('graded');
    expect(graded.gradedBy).toBe(w.manager.userId);

    // An instructor of another course cannot grade this one.
    await request(app.getHttpServer())
      .post(
        `/review/courses/${w.course.id}/assignments/${w.assignment.id}/submissions/${submissionId}/grade`,
      )
      .set(w.otherInstructor.auth)
      .send({ score: 10 })
      .expect(404);
  });

  it('an assigned instructor can edit their course curriculum; an unassigned one cannot', async () => {
    const w = await world('curriculum');

    const created = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/courses/${w.course.id}/sections`)
      .set(w.instructor.auth)
      .send({ title: 'Instructor section' })
      .expect(201);
    expect(created.body.id).toBeTruthy();

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/courses/${w.otherCourse.id}/sections`)
      .set(w.instructor.auth)
      .send({ title: 'Not my course' })
      .expect(403);

    // A plain organization member can neither read nor write curriculum.
    await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/courses/${w.course.id}/sections`)
      .set(w.orgMember.auth)
      .expect(403);
  });

  it('an owner can attach a quiz to a section of a DRAFT course (the 500 this phase fixes)', async () => {
    const w = await world('draft-authoring');
    const draft = await seedCourse(admin, w.academy.id, `Draft ${Date.now()}`, {
      status: 'draft',
      visibility: 'private',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, draft.id, 'draft-section', 0);

    const res = await request(app.getHttpServer())
      .post(`/courses/${draft.id}/quizzes`)
      .set(w.owner.auth)
      .send({
        title: 'Draft quiz',
        status: 'draft',
        sectionId: section.id,
        questions: [
          {
            prompt: 'Q',
            type: 'true_false',
            options: [
              { label: 'True', isCorrect: true },
              { label: 'False', isCorrect: false },
            ],
          },
        ],
      })
      .expect(201);
    expect(res.body.id).toBeTruthy();
  });

  it('the roster is academy-wide for owner/manager, course-scoped for an instructor, and closed to everyone else', async () => {
    const w = await world('roster-scope');

    for (const actor of [w.owner, w.manager]) {
      const res = await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}/students`)
        .set(actor.auth)
        .expect(200);
      expect(res.body.items.map((row: { userId: string }) => row.userId)).toContain(
        w.student.userId,
      );
    }

    const instructorView = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.instructor.auth)
      .expect(200);
    expect(instructorView.body.items.map((r: { userId: string }) => r.userId)).toContain(
      w.student.userId,
    );

    // The instructor of a course this student is not enrolled in sees nobody.
    const otherView = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.otherInstructor.auth)
      .expect(200);
    expect(otherView.body.items).toHaveLength(0);

    await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.staff.auth)
      .expect(403);
    await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/students`)
      .set(w.orgMember.auth)
      .expect(403);
  });

  it('only the Client Owner may change the registration policy (D8)', async () => {
    const w = await world('security-policy');

    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/registration-policy`)
      .set(w.owner.auth)
      .send({ registrationPolicy: 'invite' })
      .expect(200);

    const refused = await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/registration-policy`)
      .set(w.manager.auth)
      .send({ registrationPolicy: 'open' })
      .expect(403);
    expect(refused.body.error.messageKey).toBe('errors.academy.insufficientRole');

    // A manager may still READ it (operational visibility).
    const read = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/registration-policy`)
      .set(w.manager.auth)
      .expect(200);
    expect(read.body.registrationPolicy).toBe('invite');
  });

  it('cross-academy: staff of another academy see nothing of this one', async () => {
    const a = await world('cross-a');
    const b = await world('cross-b');

    await request(app.getHttpServer())
      .get(`/academies/${a.academy.id}/students`)
      .set(b.owner.auth)
      .expect(403);

    await request(app.getHttpServer())
      .get(`/review/courses/${a.course.id}/quizzes/${a.quiz.id}/attempts`)
      .set(b.owner.auth)
      .expect(404);

    await request(app.getHttpServer())
      .get(`/academies/${a.academy.id}/students/${a.student.userId}`)
      .set(b.manager.auth)
      .expect(403);
  });

  it('the owner analytics "failing quiz" signal can read attempts under tenant context', async () => {
    const w = await world('analytics');
    // A failing attempt for a second student.
    const failing = await account('analytics-failing-student');
    await admin.academyStudent.create({
      data: {
        academyId: w.academy.id,
        userId: failing.userId,
        status: 'active',
        source: 'staff_created',
      },
    });
    await seedEnrollment(admin, failing.userId, w.course.id, w.academy.id, {
      status: 'enrolled',
    });
    await admin.quizAttempt.create({
      data: {
        quizId: w.quiz.id,
        studentId: failing.userId,
        status: 'failed',
        answers: [],
        score: 0,
        passed: false,
        attemptNumber: 1,
        submittedAt: new Date(),
      },
    });

    const res = await request(app.getHttpServer())
      .get(`/organizations/${w.org.id}/student-analytics`)
      .set(w.owner.auth)
      .expect(200);
    const rows = (res.body.atRiskStudents ?? []) as {
      studentId: string;
      reasons: string[];
    }[];
    const row = rows.find((r) => r.studentId === failing.userId);
    expect(row).toBeDefined();
    expect(row!.reasons).toContain('failing_quiz');
  });
});
