/**
 * P64 Communications C9 — graded work reaches the learner who did it, and
 * reaches nobody else.
 *
 * WHY THIS SUITE EXISTS. `assessment.quiz.graded` and
 * `assessment.assignment.graded` were already emitted, and every existing
 * test asserted the happy half: the learner who submitted gets told. None
 * asserted the half that actually carries the risk — that the classmate
 * sitting next to them, a learner in a different academy, and the
 * instructor who did the grading each get NOTHING. A grade is the most
 * private fact this product holds about a person; "the right learner was
 * notified" and "only the right learner was notified" are different
 * claims, and only the second one is worth having.
 *
 * WHAT MAKES THE ISOLATION STRUCTURAL rather than lucky. Neither grading
 * request carries a learner id at all. The recipient is read back from the
 * row being graded — `attempt.studentId`, `submission.studentId` — so
 * there is no field a caller could tamper with to redirect the message.
 * These tests pin that: they assert on the DB row's own `studentId`, and
 * they assert the empty set for everyone else at all three layers the
 * learner could actually perceive — the outbox, the in-app feed, and the
 * mail that leaves the building.
 *
 * EXAM MODE. `exam` is a MODE of a quiz (`QuizMode`), not a separate
 * entity, so one key correctly covers both; the last test proves an
 * exam-mode quiz emits the same key rather than falling through a gap.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery';
const QUIZ_GRADED = 'assessment.quiz.graded';
const ASSIGNMENT_GRADED = 'assessment.assignment.graded';

describe('P64 C9 — graded work notifications are isolated to the owning learner (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stub: StubEmailProvider;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    stub = testApp.stubEmailProvider;
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
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** A learner of ONE academy, signed in on the surface that academy uses. */
  async function learner(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /**
   * One academy, one published course, one ESSAY quiz (so grading is
   * genuinely a human act that happens later — which is the only moment a
   * "your work was graded" message is worth sending) and one assignment.
   * The owner is the reviewer: an academy owner may review every course.
   */
  async function world(label: string, quizMode: 'practice' | 'exam' = 'practice') {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
    });
    if (quizMode === 'exam') {
      await admin.quiz.update({ where: { id: quiz.id }, data: { mode: 'exam' } });
    }
    // Essay: `scoreAttempt` reports `pendingManual` until a human assigns
    // the points, so the emit fires at the moment grading completes.
    const question = await admin.quizQuestion.create({
      data: {
        quizId: quiz.id,
        prompt: 'Explain your reasoning.',
        type: 'essay',
        order: 0,
        points: 10,
      },
    });
    const assignment = await seedAssignment(admin, course.id, `${label}-assignment`, {
      status: 'published',
    });
    return { owner, org, academy, course, quiz, question, assignment };
  }

  async function enrol(who: { auth: Record<string, string> }, courseId: string) {
    await request(app.getHttpServer())
      .post('/enrollments')
      .set(who.auth)
      .send({ courseId })
      .expect(201);
  }

  /** Sit the quiz: start an attempt, answer the essay, submit. */
  async function sitQuiz(
    w: Awaited<ReturnType<typeof world>>,
    who: { auth: Record<string, string> },
  ): Promise<string> {
    const attempt = await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`)
      .set(who.auth)
      .expect(201);
    await request(app.getHttpServer())
      .post(
        `/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts/${attempt.body.id}/submit`,
      )
      .set(who.auth)
      .send({ answers: [{ questionId: w.question.id, text: 'Because of X and Y.' }] })
      .expect(201);
    return attempt.body.id as string;
  }

  async function submitAssignment(
    w: Awaited<ReturnType<typeof world>>,
    who: { auth: Record<string, string> },
  ): Promise<string> {
    await request(app.getHttpServer())
      .post(`/courses/${w.course.id}/assignments/${w.assignment.id}/submission`)
      .set(who.auth)
      .send({ response: 'My answer' })
      .expect(201);
    const row = await admin.assignmentSubmission.findFirst({
      where: { assignmentId: w.assignment.id },
      orderBy: { createdAt: 'desc' },
    });
    if (!row) throw new Error('no submission row was written');
    return row.id;
  }

  function gradeQuiz(
    w: Awaited<ReturnType<typeof world>>,
    attemptId: string,
    auth: Record<string, string>,
    expected = 200,
  ) {
    return request(app.getHttpServer())
      .post(
        `/review/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts/${attemptId}/grade`,
      )
      .set(auth)
      .send({ grades: [{ questionId: w.question.id, points: 8 }] })
      .expect(expected);
  }

  function gradeAssignment(
    w: Awaited<ReturnType<typeof world>>,
    submissionId: string,
    auth: Record<string, string>,
    expected = 201,
  ) {
    return request(app.getHttpServer())
      .post(
        `/review/courses/${w.course.id}/assignments/${w.assignment.id}/submissions/${submissionId}/grade`,
      )
      .set(auth)
      .send({ score: 80, feedback: 'Good work.' })
      .expect(expected);
  }

  function outboxRows(userId: string, key: string) {
    return admin.communicationOutbox.findMany({
      where: { recipientUserId: userId, key },
      orderBy: { createdAt: 'asc' },
    });
  }

  function feedRows(userId: string, dedupePrefix: string) {
    return admin.notification.findMany({
      where: { userId, dedupeKey: { startsWith: dedupePrefix } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Mail actually sent to one address FOR ONE EVENT.
   *
   * Scoped by the event tag rather than by address alone: registering and
   * enrolling legitimately send their own mail (a verification email, "you
   * are enrolled"), so "this person received nothing at all" is the wrong
   * question. The one worth asking is whether the grade reached them.
   */
  function mailedTo(email: string, key: string) {
    return stub
      .recordedSends()
      .filter(
        (s) =>
          s.to.toLowerCase() === email.toLowerCase() &&
          (s.tags ?? []).includes(`key:${key}`),
      );
  }

  async function waitForMail(email: string, key: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (mailedTo(email, key).length > 0) return mailedTo(email, key);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`no ${key} email reached the stub for ${email}`);
  }

  describe('a graded quiz', () => {
    it('tells the learner who sat it — and nobody else, on any channel', async () => {
      const a = await world('c9-quiz');
      const mine = await learner('c9-quiz-mine', a.academy.id);
      const classmate = await learner('c9-quiz-mate', a.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);

      // A learner of a DIFFERENT academy, enrolled in that academy's own
      // course: a real person the message must never reach.
      const b = await world('c9-quiz-other');
      const stranger = await learner('c9-quiz-stranger', b.academy.id);
      await enrol(stranger, b.course.id);

      // Both classmates sit the quiz; only one of them is graded.
      const attemptId = await sitQuiz(a, mine);
      await sitQuiz(a, classmate);

      await gradeQuiz(a, attemptId, a.owner.auth);

      // 1. The outbox holds exactly one row, and it is about MY attempt.
      const rows = await outboxRows(mine.userId, QUIZ_GRADED);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(attemptId);

      // The recipient matches the row being graded — server-derived, not
      // anything the grading request carried (it carries no learner id).
      const attempt = await admin.quizAttempt.findUnique({ where: { id: attemptId } });
      expect(attempt?.studentId).toBe(mine.userId);
      expect(rows[0].recipientUserId).toBe(attempt?.studentId);

      // 2. The in-app feed shows it once.
      expect(await feedRows(mine.userId, 'quiz_attempt.graded:')).toHaveLength(1);

      // 3. The email actually left, to my address.
      await waitForMail(mine.email, QUIZ_GRADED);

      // 4. NOBODY ELSE — outbox, feed, and mail.
      for (const other of [classmate, stranger]) {
        expect(await outboxRows(other.userId, QUIZ_GRADED)).toHaveLength(0);
        expect(await feedRows(other.userId, 'quiz_attempt.graded:')).toHaveLength(0);
        expect(mailedTo(other.email, QUIZ_GRADED)).toHaveLength(0);
      }
      // Not the reviewer who did the grading, either: this is the
      // learner's news, and staff already know — they just typed it.
      expect(await outboxRows(a.owner.userId, QUIZ_GRADED)).toHaveLength(0);
      expect(await feedRows(a.owner.userId, 'quiz_attempt.graded:')).toHaveLength(0);
    });

    it('cannot be triggered by a reviewer from another academy', async () => {
      const a = await world('c9-quiz-x');
      const b = await world('c9-quiz-y');
      const mine = await learner('c9-quiz-x-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const attemptId = await sitQuiz(a, mine);

      // B's owner has no standing on A's course: the guard refuses before
      // any grade is written…
      await gradeQuiz(a, attemptId, b.owner.auth, 404);

      // …and, decisively, no message was manufactured on the way out.
      expect(await outboxRows(mine.userId, QUIZ_GRADED)).toHaveLength(0);
      expect(await feedRows(mine.userId, 'quiz_attempt.graded:')).toHaveLength(0);
      expect(mailedTo(mine.email, QUIZ_GRADED)).toHaveLength(0);
    });

    it('treats an EXAM the same as a practice quiz — one key covers both', async () => {
      // `exam` is a MODE of a quiz, not a separate entity, so there is no
      // second key to forget. This pins that an exam-mode quiz does not
      // fall through a gap between the two.
      const a = await world('c9-exam', 'exam');
      const mine = await learner('c9-exam-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const attemptId = await sitQuiz(a, mine);

      await gradeQuiz(a, attemptId, a.owner.auth);

      const stored = await admin.quiz.findUnique({ where: { id: a.quiz.id } });
      expect(stored?.mode).toBe('exam');
      const rows = await outboxRows(mine.userId, QUIZ_GRADED);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(attemptId);
    });
  });

  describe('a graded assignment', () => {
    it('tells the learner who submitted it — and nobody else, on any channel', async () => {
      const a = await world('c9-asg');
      const mine = await learner('c9-asg-mine', a.academy.id);
      const classmate = await learner('c9-asg-mate', a.academy.id);
      await enrol(mine, a.course.id);
      await enrol(classmate, a.course.id);

      const b = await world('c9-asg-other');
      const stranger = await learner('c9-asg-stranger', b.academy.id);
      await enrol(stranger, b.course.id);

      const submissionId = await submitAssignment(a, mine);
      await submitAssignment(a, classmate);

      await gradeAssignment(a, submissionId, a.owner.auth);

      const rows = await outboxRows(mine.userId, ASSIGNMENT_GRADED);
      expect(rows).toHaveLength(1);
      expect(rows[0].entityId).toBe(submissionId);

      const submission = await admin.assignmentSubmission.findUnique({
        where: { id: submissionId },
      });
      expect(submission?.studentId).toBe(mine.userId);
      expect(rows[0].recipientUserId).toBe(submission?.studentId);

      expect(await feedRows(mine.userId, 'assignment_submission.graded:')).toHaveLength(
        1,
      );
      await waitForMail(mine.email, ASSIGNMENT_GRADED);

      for (const other of [classmate, stranger]) {
        expect(await outboxRows(other.userId, ASSIGNMENT_GRADED)).toHaveLength(0);
        expect(
          await feedRows(other.userId, 'assignment_submission.graded:'),
        ).toHaveLength(0);
        expect(mailedTo(other.email, ASSIGNMENT_GRADED)).toHaveLength(0);
      }
      expect(await outboxRows(a.owner.userId, ASSIGNMENT_GRADED)).toHaveLength(0);
    });

    it('cannot be triggered by a reviewer from another academy', async () => {
      const a = await world('c9-asg-x');
      const b = await world('c9-asg-y');
      const mine = await learner('c9-asg-x-mine', a.academy.id);
      await enrol(mine, a.course.id);
      const submissionId = await submitAssignment(a, mine);

      await gradeAssignment(a, submissionId, b.owner.auth, 404);

      expect(await outboxRows(mine.userId, ASSIGNMENT_GRADED)).toHaveLength(0);
      expect(await feedRows(mine.userId, 'assignment_submission.graded:')).toHaveLength(
        0,
      );
      expect(mailedTo(mine.email, ASSIGNMENT_GRADED)).toHaveLength(0);
    });
  });
});
