/**
 * P64 Phase 3 — Assessments, Integrity, Completion Rules and Certificates.
 *
 * Runs against the real PostgreSQL (RLS on, `atlas_app` role through the
 * app's own Prisma) and the real Redis (BullMQ under the `bull-test`
 * prefix). Time-dependent behaviour is exercised by moving the attempt's
 * own server-side deadline through the admin connection — never by
 * trusting a client clock.
 *
 * Every flag this phase ships behind is ON for this suite (a separate
 * case flips the engine flag OFF to prove the legacy behaviour survives).
 */
import { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import type { LearningFeatureFlags } from '../src/config/configuration';
import { QuizAttemptEngineService } from '../src/learning/services/quiz-attempt-engine.service';
import { CertificatesService } from '../src/certificates/services/certificates.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Phase2MaintenanceService } from '../src/learning/services/phase2-maintenance.service';
import {
  QUIZ_DEADLINE_QUEUE,
  quizDeadlineJobId,
} from '../src/learning/queue/quiz-deadline.types';

const PASSWORD = 'correct-horse-battery';

function allFlags(mode: 'on' | 'off'): LearningFeatureFlags {
  const flag = { mode, academyIds: [] as string[] };
  return {
    contentProtected: flag,
    videoNormal: flag,
    videoPremium: flag,
    devicesPolicy: flag,
    learnerDashboardV2: flag,
    playerV2: flag,
    quizEngineV2: flag,
    quizIntegrity: flag,
    certificates: flag,
  };
}
const flags: { value: LearningFeatureFlags } = { value: allFlags('on') };

const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('P64 Phase 3 — assessments, integrity, completion and certificates (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let engine: QuizAttemptEngineService;
  let certificates: CertificatesService;
  let tenancy: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(FeatureFlagsService).useValue(
          new FeatureFlagsService({
            get: () => flags.value,
          } as unknown as ConfigService),
        ),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    engine = app.get(QuizAttemptEngineService);
    certificates = app.get(CertificatesService);
    tenancy = app.get(TenancyContextService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    flags.value = allFlags('on');
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
      email,
    };
  }

  interface WorldOptions {
    readonly passingScore?: number;
    readonly maxAttempts?: number;
    readonly quiz?: Record<string, unknown>;
    readonly essay?: boolean;
  }

  /** Owner + manager + instructor + learner around one published course with one lesson and one quiz. */
  async function world(label: string, opts: WorldOptions = {}) {
    await flushRateLimitKeys();
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const manager = await signUp(`${label}-manager`);
    await seedAcademyMember(admin, academy.id, manager.userId, 'manager');
    const course = await seedCourse(admin, academy.id, `${label} Course ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    // The quiz sits at ordinal 0 (created below) and the lesson at 1, so the
    // quiz is FIRST in the curriculum sequence. Sequential progression is now
    // enforced on the server (quiz start is refused while an earlier item is
    // unfinished), so a quiz placed AFTER an incomplete lesson would be locked;
    // these tests exercise quiz mechanics, not gating, so the quiz leads. The
    // lesson is not `requiredToProgress`-gated by the non-required quiz before
    // it, so it stays available for the completion tests. Progression gating
    // itself is covered by its own dedicated tests.
    const lesson = await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 1, {
      status: 'published',
    });
    const instructor = await signUp(`${label}-instructor`);
    await seedAcademyMember(admin, academy.id, instructor.userId, 'instructor');
    await seedCourseInstructor(admin, course.id, instructor.userId);
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
      passingScore: opts.passingScore ?? 50,
      maxAttempts: opts.maxAttempts,
      sectionId: section.id,
    });
    if (opts.quiz) await admin.quiz.update({ where: { id: quiz.id }, data: opts.quiz });
    const q1 = await seedQuizQuestion(admin, quiz.id, 'What is 2+2?', 'single_choice', 0);
    const q1Correct = await seedQuizQuestionOption(admin, q1.id, '4', true);
    const q1Wrong = await seedQuizQuestionOption(admin, q1.id, '5', false);
    const q2 = await seedQuizQuestion(
      admin,
      quiz.id,
      'Pick the even numbers',
      'multiple_choice',
      1,
    );
    const q2A = await seedQuizQuestionOption(admin, q2.id, '2', true);
    const q2B = await seedQuizQuestionOption(admin, q2.id, '4', true);
    const q2C = await seedQuizQuestionOption(admin, q2.id, '3', false);
    let essay: { id: string } | null = null;
    if (opts.essay) {
      essay = await admin.quizQuestion.create({
        data: { quizId: quiz.id, prompt: 'Explain', type: 'essay', order: 2, points: 4 },
      });
    }
    const student = await signUp(`${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    const enroll = await http()
      .post('/enrollments')
      .set(auth(student.token))
      .send({ courseId: course.id })
      .expect(201);
    const enrollmentId = enroll.body.id as string;
    return {
      owner,
      manager,
      instructor,
      student,
      org,
      academy,
      course,
      section,
      lesson,
      quiz,
      q1,
      q1Correct,
      q1Wrong,
      q2,
      q2A,
      q2B,
      q2C,
      essay,
      enrollmentId,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  const attemptsPath = (w: World) =>
    `/courses/${w.course.id}/quizzes/${w.quiz.id}/attempts`;
  const reviewPath = (w: World) => `/review/courses/${w.course.id}/quizzes/${w.quiz.id}`;

  async function start(w: World, token = w.student.token) {
    const res = await http().post(attemptsPath(w)).set(auth(token)).expect(201);
    return res.body as {
      id: string;
      deadlineAt: string | null;
      startedAt: string;
      status: string;
      revision: number;
    };
  }

  const correctAnswers = (w: World) => [
    { questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] },
    { questionId: w.q2.id, selectedOptionIds: [w.q2A.id, w.q2B.id] },
  ];

  // ---------------------------------------------------------------------
  // engine v2: start / resume / autosave / deadline
  // ---------------------------------------------------------------------

  it('start sets a server deadline from the time limit; the session carries the paper without isCorrect, the saved answers and the server clock', async () => {
    const w = await world('p3-start', { quiz: { timeLimitSeconds: 600 } });
    const attempt = await start(w);
    expect(attempt.deadlineAt).not.toBeNull();
    const gap =
      (new Date(attempt.deadlineAt!).getTime() - new Date(attempt.startedAt).getTime()) /
      1000;
    expect(gap).toBeGreaterThanOrEqual(595);
    expect(gap).toBeLessThanOrEqual(605);

    const session = await http()
      .get(`${attemptsPath(w)}/${attempt.id}`)
      .set(auth(w.student.token))
      .expect(200);
    expect(session.body.questions).toHaveLength(2);
    expect(JSON.stringify(session.body)).not.toContain('isCorrect');
    expect(session.body.answers).toEqual([]);
    expect(session.body.remainingSeconds).toBeLessThanOrEqual(600);
    expect(session.body.settings.engineV2).toBe(true);
    expect(typeof session.body.serverNow).toBe('string');
  });

  it('autosave revisions are monotonic: a stale revision is ignored, never applied', async () => {
    const w = await world('p3-autosave', { quiz: { timeLimitSeconds: 600 } });
    const attempt = await start(w);
    const path = `${attemptsPath(w)}/${attempt.id}/answers`;
    const first = await http()
      .put(path)
      .set(auth(w.student.token))
      .send({ revision: 2, answers: correctAnswers(w) })
      .expect(200);
    expect(first.body).toMatchObject({ applied: true, revision: 2 });
    const stale = await http()
      .put(path)
      .set(auth(w.student.token))
      .send({
        revision: 1,
        answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Wrong.id] }],
      })
      .expect(200);
    expect(stale.body).toMatchObject({ applied: false, revision: 2 });
    const session = await http()
      .get(`${attemptsPath(w)}/${attempt.id}`)
      .set(auth(w.student.token))
      .expect(200);
    expect(session.body.revision).toBe(2);
    expect(
      session.body.answers.find((a: { questionId: string }) => a.questionId === w.q1.id)
        .selectedOptionIds,
    ).toEqual([w.q1Correct.id]);
  });

  it('ten concurrent starts create exactly one attempt (Phase 1 regression under engine v2)', async () => {
    const w = await world('p3-race', { quiz: { timeLimitSeconds: 300 } });
    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        http().post(attemptsPath(w)).set(auth(w.student.token)),
      ),
    );
    for (const res of results) expect(res.status).toBe(201);
    const ids = new Set(results.map((res) => res.body.id));
    expect(ids.size).toBe(1);
    expect(
      await admin.quizAttempt.count({
        where: { quizId: w.quiz.id, studentId: w.student.userId },
      }),
    ).toBe(1);
  });

  it('foreign option ids and wrong answer shapes are rejected on save and submit', async () => {
    const w = await world('p3-foreign');
    const attempt = await start(w);
    await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({
        revision: 1,
        answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q2A.id] }],
      })
      .expect(400);
    await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({ revision: 1, answers: [{ questionId: w.q1.id, text: 'four' }] })
      .expect(400);
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: [{ questionId: 'nope', selectedOptionIds: [w.q1Correct.id] }] })
      .expect(400);
  });

  it('timeout: a save after deadline + grace is refused and the attempt is auto-submitted, graded as-is (never auto-failed), reason timeout', async () => {
    const w = await world('p3-timeout', { quiz: { timeLimitSeconds: 600 } });
    const attempt = await start(w);
    await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({ revision: 1, answers: correctAnswers(w) })
      .expect(200);
    // The server clock moves: the deadline is now in the past.
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { deadlineAt: new Date(Date.now() - 60_000) },
    });
    const late = await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({
        revision: 2,
        answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Wrong.id] }],
      })
      .expect(409);
    expect(late.body.messageKey ?? late.body.error?.messageKey).toBeDefined();
    // The finalisation the refused save performed must have COMMITTED —
    // before 22 Sep 2026 the 409 was thrown inside the same transaction
    // and rolled it back, so the row stayed `in_progress` until the
    // results read below finalised it (which is why this test passed).
    const afterLateSave = await admin.quizAttempt.findUniqueOrThrow({
      where: { id: attempt.id },
    });
    expect(afterLateSave.status).toBe('passed');
    expect(afterLateSave.autoSubmittedReason).toBe('timeout');
    const results = await http()
      .get(`${attemptsPath(w)}/${attempt.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(results.body).toMatchObject({
      status: 'passed',
      autoSubmitted: true,
      autoSubmittedReason: 'timeout',
      score: 100,
    });
    // The late answers were never applied.
    const row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.answersRevision).toBe(1);
  });

  it('an abandoned expired attempt is finalised (committed) by the next start, session read or event batch, and a new attempt can then be started', async () => {
    // Production, 22 Sep 2026: a learner whose open attempt had expired got
    // 409 "expired" on every start, forever — the finalisation ran and was
    // rolled back with the 409.
    const w = await world('p3-expired-restart', {
      quiz: { timeLimitSeconds: 600 },
      maxAttempts: 3,
    });
    const first = await start(w);
    await admin.quizAttempt.update({
      where: { id: first.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    // Session read: 409, but the row is finalised for good.
    await http()
      .get(`${attemptsPath(w)}/${first.id}`)
      .set(auth(w.student.token))
      .expect(409);
    let row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: first.id } });
    expect(row.status).toBe('failed'); // nothing answered, graded as-is
    expect(row.autoSubmittedReason).toBe('timeout');

    // A second attempt whose expiry is discovered by a late SUBMIT (past the
    // grace window): refused, and the finalisation commits. (An event batch
    // is deliberately not a refusal — integrity events are recorded, never
    // a wall — so it is not exercised here.)
    const second = await start(w);
    expect(second.id).not.toBe(first.id);
    await admin.quizAttempt.update({
      where: { id: second.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    await http()
      .post(`${attemptsPath(w)}/${second.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(409);
    row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.status).toBe('failed'); // the late answers were never applied
    expect(row.autoSubmittedReason).toBe('timeout');

    // A third attempt whose expiry is discovered by the next START: the
    // start answers 409 once (the paper the learner was resuming is dead),
    // the row is finalised, and the start after that opens a new paper.
    const third = await start(w);
    await admin.quizAttempt.update({
      where: { id: third.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    await http().post(attemptsPath(w)).set(auth(w.student.token)).expect(409);
    row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: third.id } });
    expect(row.status).toBe('failed');
    expect(row.autoSubmittedReason).toBe('timeout');
    // Cap is 3 and all three are used: the next start is refused for THAT
    // reason, not as "expired" — proving the open attempt is gone.
    const capped = await http()
      .post(attemptsPath(w))
      .set(auth(w.student.token))
      .expect(403);
    expect(capped.body.error?.messageKey ?? capped.body.messageKey).toBe(
      'errors.quiz.maxAttemptsReached',
    );
  });

  it('the sweep finalises an overdue attempt whose delayed job never fired; unanswered questions count as incorrect', async () => {
    const w = await world('p3-sweep', {
      quiz: { timeLimitSeconds: 600 },
      passingScore: 50,
    });
    const attempt = await start(w);
    await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({
        revision: 1,
        answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }],
      })
      .expect(200);
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    const finalized = await engine.finalizeOverdue(50);
    expect(finalized).toBeGreaterThanOrEqual(1);
    const row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.status).toBe('passed'); // 1 of 2 points = 50 ≥ passing 50
    expect(row.autoSubmittedReason).toBe('timeout');
    expect(Number(row.score)).toBe(50);
    // Idempotent: a second sweep touches nothing.
    expect(await engine.finalizeOverdueAttempt(attempt.id, w.student.userId)).toBe(
      'skipped',
    );
  });

  it('the delayed deadline job itself finalises an attempt through the BullMQ worker (reason timeout, graded as-is)', async () => {
    // Production validation, 22 Sep 2026: the job was scheduled but never
    // observed to fire; this pins the whole path — producer → Redis →
    // worker → engine — rather than only the engine method the sweep calls.
    const w = await world('p3-deadline-job', {
      quiz: { timeLimitSeconds: 600 },
      passingScore: 50,
    });
    const attempt = await start(w);
    await http()
      .put(`${attemptsPath(w)}/${attempt.id}/answers`)
      .set(auth(w.student.token))
      .send({
        revision: 1,
        answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }],
      })
      .expect(200);
    const queue = app.get<Queue>(getQueueToken(QUIZ_DEADLINE_QUEUE));
    const job = await queue.getJob(quizDeadlineJobId(attempt.id));
    expect(job).toBeDefined();
    // Move the deadline into the past, then release the delayed job now
    // instead of waiting ten minutes for its timer.
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    await job!.promote();
    const deadlineToFinalize = Date.now() + 15_000;
    let row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    while (row.status === 'in_progress' && Date.now() < deadlineToFinalize) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    }
    expect(row.status).toBe('passed');
    expect(row.autoSubmitted).toBe(true);
    expect(row.autoSubmittedReason).toBe('timeout');
    expect(Number(row.score)).toBe(50);
  });

  it('the maintenance sweep job finalises overdue attempts (the safety net for a lost deadline job)', async () => {
    const w = await world('p3-maintenance-sweep', {
      quiz: { timeLimitSeconds: 600 },
      passingScore: 50,
    });
    const attempt = await start(w);
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { deadlineAt: new Date(Date.now() - 120_000) },
    });
    const result = await app.get(Phase2MaintenanceService).run();
    expect(result.finalizedOverdueQuizAttempts).toBeGreaterThanOrEqual(1);
    const row = await admin.quizAttempt.findUniqueOrThrow({ where: { id: attempt.id } });
    expect(row.status).toBe('failed'); // nothing answered: 0 of 2, graded as-is, never "expired"
    expect(row.autoSubmittedReason).toBe('timeout');
  });

  it('submit is idempotent; under engine v2 a partial submit grades unanswered questions as incorrect', async () => {
    const w = await world('p3-partial', { passingScore: 50 });
    const attempt = await start(w);
    const first = await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }] })
      .expect(201);
    expect(first.body).toMatchObject({
      status: 'passed',
      score: 50,
      gradingStatus: 'not_required',
    });
    const again = await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({})
      .expect(201);
    expect(again.body.id).toBe(attempt.id);
    expect(again.body.status).toBe('passed');
  });

  it('with the engine flag OFF the legacy behaviour survives: no deadline, every question required, no shuffle', async () => {
    flags.value = allFlags('off');
    const w = await world('p3-legacy', {
      quiz: { timeLimitSeconds: 60, shuffleQuestions: true },
    });
    const attempt = await start(w);
    expect(attempt.deadlineAt).toBeNull();
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }] })
      .expect(400);
    const done = await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    expect(done.body.status).toBe('passed');
    const session = await http()
      .get(`${attemptsPath(w)}/${attempt.id}`)
      .set(auth(w.student.token))
      .expect(200);
    expect(session.body.settings.engineV2).toBe(false);
    expect(session.body.questions.map((q: { id: string }) => q.id)).toEqual([
      w.q1.id,
      w.q2.id,
    ]);
  });

  // ---------------------------------------------------------------------
  // disclosure, manual grading, integrity
  // ---------------------------------------------------------------------

  it('disclosure: correct answers never appear before the policy allows; explanations follow the answers policy', async () => {
    const w = await world('p3-disclosure', {
      quiz: { showAnswers: 'never', showExplanations: true },
    });
    await admin.quizQuestion.update({
      where: { id: w.q1.id },
      data: { explanation: 'Because arithmetic.' },
    });
    const attempt = await start(w);
    const inProgress = await http()
      .get(`${attemptsPath(w)}/${attempt.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(inProgress.body.disclosure).toEqual({
      score: false,
      answers: false,
      explanations: false,
    });
    expect(inProgress.body.score).toBeUndefined();
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    const hidden = await http()
      .get(`${attemptsPath(w)}/${attempt.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(hidden.body.disclosure).toEqual({
      score: true,
      answers: false,
      explanations: false,
    });
    expect(JSON.stringify(hidden.body)).not.toContain('correctOptionIds');
    expect(JSON.stringify(hidden.body)).not.toContain('Because arithmetic.');
    // Policy change on the quiz row: the snapshot governs disclosure of THIS attempt's answers...
    await admin.quiz.update({
      where: { id: w.quiz.id },
      data: { showAnswers: 'immediately' },
    });
    const w2 = await start(w); // ...so a new attempt under the new policy discloses.
    await http()
      .post(`${attemptsPath(w)}/${w2.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    const shown = await http()
      .get(`${attemptsPath(w)}/${w2.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(shown.body.disclosure).toEqual({
      score: true,
      answers: true,
      explanations: true,
    });
    const q1 = shown.body.questions.find(
      (q: { questionId: string }) => q.questionId === w.q1.id,
    );
    expect(q1.correctOptionIds).toEqual([w.q1Correct.id]);
    expect(q1.explanation).toBe('Because arithmetic.');
  });

  it('manual grading: an essay leaves the attempt pending until a manager grades it; then pass is computed; an instructor of another course is refused', async () => {
    const w = await world('p3-essay', { essay: true, passingScore: 50 });
    const other = await world('p3-essay-other');
    const attempt = await start(w);
    const submitted = await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({
        answers: [
          ...correctAnswers(w),
          { questionId: w.essay!.id, text: 'A thoughtful essay.' },
        ],
      })
      .expect(201);
    expect(submitted.body).toMatchObject({
      status: 'submitted',
      gradingStatus: 'pending',
    });
    expect(submitted.body.score).toBeUndefined();
    const results = await http()
      .get(`${attemptsPath(w)}/${attempt.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(results.body.score).toBeNull();
    expect(
      results.body.questions.find(
        (q: { questionId: string }) => q.questionId === w.essay!.id,
      ).needsManualGrading,
    ).toBe(true);

    // Foreign instructor: refused at the guard/service layer.
    await http()
      .get(`${reviewPath(w)}/attempts/${attempt.id}`)
      .set(auth(other.instructor.token))
      .expect(404);
    await http()
      .post(`${reviewPath(w)}/attempts/${attempt.id}/grade`)
      .set(auth(other.instructor.token))
      .send({ grades: [{ questionId: w.essay!.id, points: 4 }] })
      .expect(404);

    // Manager grades; points above the maximum are refused.
    await http()
      .post(`${reviewPath(w)}/attempts/${attempt.id}/grade`)
      .set(auth(w.manager.token))
      .send({ grades: [{ questionId: w.essay!.id, points: 99 }] })
      .expect(400);
    const graded = await http()
      .post(`${reviewPath(w)}/attempts/${attempt.id}/grade`)
      .set(auth(w.manager.token))
      .send({ grades: [{ questionId: w.essay!.id, points: 4 }] })
      .expect(200);
    expect(graded.body).toMatchObject({
      status: 'passed',
      gradingStatus: 'graded',
      score: 100,
    });
    expect(
      graded.body.questions.find(
        (q: { questionId: string }) => q.questionId === w.essay!.id,
      ),
    ).toMatchObject({ manualPoints: 4, pointsAwarded: 4 });
    const result = await admin.quizResult.findUniqueOrThrow({
      where: { quizId_studentId: { quizId: w.quiz.id, studentId: w.student.userId } },
    });
    expect(result.passed).toBe(true);
    expect(Number(result.effectiveScore)).toBe(100);
    // The learner was told.
    const notification = await admin.notification.findFirst({
      where: {
        userId: w.student.userId,
        titleKey: 'notifications:events.quizGraded.title',
      },
    });
    expect(notification).not.toBeNull();
  });

  it('integrity: events are recorded with server timestamps; warn mode only warns; strict mode auto-submits exactly at the threshold; off records nothing as a violation', async () => {
    const w = await world('p3-integrity', {
      quiz: { integrityMode: 'strict', maxViolations: 2 },
    });
    const attempt = await start(w);
    // Past the warm-up.
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { startedAt: new Date(Date.now() - 20_000) },
    });
    const path = `${attemptsPath(w)}/${attempt.id}/events`;
    const first = await http()
      .post(path)
      .set(auth(w.student.token))
      .send({ events: [{ type: 'blur', clientAt: new Date().toISOString() }] })
      .expect(200);
    expect(first.body).toMatchObject({
      recorded: 1,
      violationCount: 1,
      action: 'warn',
      status: 'in_progress',
    });
    const second = await http()
      .post(path)
      .set(auth(w.student.token))
      .send({ events: [{ type: 'heartbeat' }, { type: 'copy' }] })
      .expect(200);
    expect(second.body).toMatchObject({
      recorded: 2,
      violationCount: 2,
      action: 'auto_submit',
    });
    expect(second.body.status).not.toBe('in_progress');
    const results = await http()
      .get(`${attemptsPath(w)}/${attempt.id}/results`)
      .set(auth(w.student.token))
      .expect(200);
    expect(results.body).toMatchObject({
      autoSubmitted: true,
      autoSubmittedReason: 'integrity',
    });
    const events = await admin.quizAttemptEvent.findMany({
      where: { attemptId: attempt.id },
      orderBy: { serverAt: 'asc' },
    });
    expect(events.map((e) => [e.type, e.counted])).toEqual([
      ['blur', true],
      ['heartbeat', false],
      ['copy', true],
    ]);

    // The reviewer sees the timeline and can export it.
    const review = await http()
      .get(`${reviewPath(w)}/attempts/${attempt.id}`)
      .set(auth(w.owner.token))
      .expect(200);
    expect(review.body.events).toHaveLength(3);
    expect(review.body.violationCount).toBe(2);
    const csv = await http()
      .get(`${reviewPath(w)}/integrity.csv`)
      .set(auth(w.owner.token))
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text.split('\r\n')[0]).toContain('violations_counted');
    expect(csv.text).toContain(attempt.id);

    // Warn mode never auto-submits.
    const warn = await world('p3-integrity-warn', {
      quiz: { integrityMode: 'warn', maxViolations: 1 },
    });
    const wa = await start(warn);
    await admin.quizAttempt.update({
      where: { id: wa.id },
      data: { startedAt: new Date(Date.now() - 20_000) },
    });
    const w1 = await http()
      .post(`${attemptsPath(warn)}/${wa.id}/events`)
      .set(auth(warn.student.token))
      .send({ events: [{ type: 'blur' }] })
      .expect(200);
    expect(w1.body).toMatchObject({ action: 'warn', status: 'in_progress' });
    await new Promise((r) => setTimeout(r, 2_100)); // past the per-type debounce
    const w2 = await http()
      .post(`${attemptsPath(warn)}/${wa.id}/events`)
      .set(auth(warn.student.token))
      .send({ events: [{ type: 'blur' }] })
      .expect(200);
    expect(w2.body).toMatchObject({
      violationCount: 2,
      action: 'warn',
      status: 'in_progress',
    });

    // Off: nothing counts, no warning, but the event is still recorded for the timeline.
    const off = await world('p3-integrity-off');
    const oa = await start(off);
    await admin.quizAttempt.update({
      where: { id: oa.id },
      data: { startedAt: new Date(Date.now() - 20_000) },
    });
    const o1 = await http()
      .post(`${attemptsPath(off)}/${oa.id}/events`)
      .set(auth(off.student.token))
      .send({ events: [{ type: 'print' }] })
      .expect(200);
    expect(o1.body).toMatchObject({ recorded: 1, violationCount: 0, action: 'none' });
  });

  // ---------------------------------------------------------------------
  // review: void, overrides, RLS
  // ---------------------------------------------------------------------

  it('a reviewer voids an attempt: it no longer counts, completion is recomputed, and the action is audited', async () => {
    const w = await world('p3-void', { passingScore: 50 });
    await http()
      .put(`/academies/${w.academy.id}/courses/${w.course.id}/completion-rule`)
      .set(auth(w.owner.token))
      .send({ requiredQuizIds: [w.quiz.id] })
      .expect(200);
    await http()
      .post(`/courses/${w.course.id}/progress/complete-lesson`)
      .set(auth(w.student.token))
      .send({ lessonId: w.lesson.id })
      .expect(201);
    const attempt = await start(w);
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    const before = await admin.courseProgress.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(before.completionState).toBe('completed');

    const voided = await http()
      .post(`${reviewPath(w)}/attempts/${attempt.id}/invalidate`)
      .set(auth(w.manager.token))
      .send({ reason: 'Answers were shared.' })
      .expect(200);
    expect(voided.body).toMatchObject({
      status: 'invalidated',
      invalidationReason: 'Answers were shared.',
    });
    const result = await admin.quizResult.findUniqueOrThrow({
      where: { quizId_studentId: { quizId: w.quiz.id, studentId: w.student.userId } },
    });
    expect(result.passed).toBe(false);
    expect(result.attemptsCount).toBe(0);
    const after = await admin.courseProgress.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(after.completionState).not.toBe('completed');
    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'quiz_attempt.invalidated', targetId: attempt.id },
    });
    expect(audit).not.toBeNull();
    // A voided attempt cannot be submitted or graded.
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({})
      .expect(400);
  });

  it('overrides extend one student only: extra attempts and time multiplier apply to the named learner and no one else', async () => {
    const w = await world('p3-override', {
      maxAttempts: 1,
      quiz: { timeLimitSeconds: 600 },
    });
    const otherStudent = await signUp('p3-override-student2');
    await seedAcademyStudent(admin, w.academy.id, otherStudent.userId);
    await http()
      .post('/enrollments')
      .set(auth(otherStudent.token))
      .send({ courseId: w.course.id })
      .expect(201);

    const a1 = await start(w);
    await http()
      .post(`${attemptsPath(w)}/${a1.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    await http().post(attemptsPath(w)).set(auth(w.student.token)).expect(403);

    // Learners cannot set overrides; instructors of the course can.
    await http()
      .put(`${reviewPath(w)}/overrides`)
      .set(auth(w.student.token))
      .send({ studentId: w.student.userId, extraAttempts: 1 })
      .expect(403);
    const created = await http()
      .put(`${reviewPath(w)}/overrides`)
      .set(auth(w.instructor.token))
      .send({
        studentId: w.student.userId,
        extraAttempts: 1,
        timeMultiplier: 1.5,
        reason: 'Accommodation',
      })
      .expect(200);
    expect(created.body).toMatchObject({ extraAttempts: 1, timeMultiplier: 1.5 });
    const a2 = await start(w);
    const gap =
      (new Date(a2.deadlineAt!).getTime() - new Date(a2.startedAt).getTime()) / 1000;
    expect(gap).toBeGreaterThanOrEqual(895); // 600 × 1.5
    // The other learner is unaffected.
    const b1 = await start(w, otherStudent.token);
    await http()
      .post(`${attemptsPath(w)}/${b1.id}/submit`)
      .set(auth(otherStudent.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    await http().post(attemptsPath(w)).set(auth(otherStudent.token)).expect(403);
    const list = await http()
      .get(`${reviewPath(w)}/overrides`)
      .set(auth(w.owner.token))
      .expect(200);
    expect(list.body).toHaveLength(1);
    await http()
      .delete(`${reviewPath(w)}/overrides/${w.student.userId}`)
      .set(auth(w.owner.token))
      .expect(204);
  });

  it('RLS agrees independently: events, results and overrides of one academy are invisible to a foreign reviewer and to a foreign learner', async () => {
    const w = await world('p3-rls');
    const other = await world('p3-rls-other');
    const attempt = await start(w);
    await admin.quizAttempt.update({
      where: { id: attempt.id },
      data: { startedAt: new Date(Date.now() - 20_000) },
    });
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/events`)
      .set(auth(w.student.token))
      .send({ events: [{ type: 'blur' }] })
      .expect(200);
    await http()
      .post(`${attemptsPath(w)}/${attempt.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    await http()
      .put(`${reviewPath(w)}/overrides`)
      .set(auth(w.owner.token))
      .send({ studentId: w.student.userId, extraAttempts: 1 })
      .expect(200);

    for (const foreign of [
      other.instructor.userId,
      other.owner.userId,
      other.student.userId,
    ]) {
      const rows = await tenancy.runInUserContext(foreign, async (tx) => ({
        events: await tx.quizAttemptEvent.count({ where: { attemptId: attempt.id } }),
        results: await tx.quizResult.count({ where: { quizId: w.quiz.id } }),
        overrides: await tx.quizStudentOverride.count({ where: { quizId: w.quiz.id } }),
        attempts: await tx.quizAttempt.count({ where: { id: attempt.id } }),
      }));
      expect(rows).toEqual({ events: 0, results: 0, overrides: 0, attempts: 0 });
    }
    // The owning academy's reviewer sees everything; the learner sees their own.
    const seen = await tenancy.runInUserContext(w.instructor.userId, async (tx) => ({
      events: await tx.quizAttemptEvent.count({ where: { attemptId: attempt.id } }),
      results: await tx.quizResult.count({ where: { quizId: w.quiz.id } }),
    }));
    expect(seen).toEqual({ events: 1, results: 1 });
    const own = await tenancy.runInUserContext(w.student.userId, (tx) =>
      tx.quizResult.count({ where: { quizId: w.quiz.id } }),
    );
    expect(own).toBe(1);
    // Foreign tenant context: nothing.
    const tenantRows = await tenancy.runInTenantContext(other.org.id, (tx) =>
      tx.quizResult.count({ where: { quizId: w.quiz.id } }),
    );
    expect(tenantRows).toBe(0);
  });

  // ---------------------------------------------------------------------
  // assignments
  // ---------------------------------------------------------------------

  it("assignments: drafts autosave; the late policy blocks or flags; the attachment must be the student's own protected asset; the learner sees grade and feedback", async () => {
    const w = await world('p3-assign');
    const other = await world('p3-assign-other');
    const assignment = await seedAssignment(admin, w.course.id, 'Essay', {
      status: 'published',
      sectionId: w.section.id,
      dueAt: new Date(Date.now() - 3_600_000),
    });
    const base = `/courses/${w.course.id}/assignments/${assignment.id}/submission`;

    // The very first keystroke in an assignment the learner never opened
    // before arrives as a draft with NO attachment, which the client sends
    // as `attachmentAssetId: null`. That must create the row, not 500.
    await http()
      .put(`${base}/draft`)
      .set(auth(w.student.token))
      .send({ response: 'First keystroke', attachmentAssetId: null })
      .expect(200);

    const draft = await http()
      .put(`${base}/draft`)
      .set(auth(w.student.token))
      .send({ response: 'Work in progress' })
      .expect(200);
    expect(draft.body).toMatchObject({
      status: 'draft',
      draftResponse: 'Work in progress',
    });
    expect(draft.body.draftSavedAt).not.toBeNull();

    // A foreign asset (another academy's, another student's) is refused as an attachment.
    const foreignUpload = await http()
      .post(
        `/courses/${other.course.id}/assignments/${assignment.id}/submission/attachment`,
      )
      .set(auth(other.student.token))
      .send({
        fileName: 'x.png',
        mimeType: 'image/png',
        sizeBytes: 68,
        dataUrl: TINY_PNG,
      })
      .expect(201);
    await http()
      .post(base)
      .set(auth(w.student.token))
      .send({ attachmentAssetId: foreignUpload.body.assetId })
      .expect(400);

    // Own protected upload → submission accepted late and FLAGGED (default policy).
    const upload = await http()
      .post(`/courses/${w.course.id}/assignments/${assignment.id}/submission/attachment`)
      .set(auth(w.student.token))
      .send({
        fileName: 'mine.png',
        mimeType: 'image/png',
        sizeBytes: 68,
        dataUrl: TINY_PNG,
      })
      .expect(201);
    expect(upload.body.assetId).toBeDefined();
    expect(JSON.stringify(upload.body)).not.toContain('http'); // no durable URL
    const asset = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: upload.body.assetId },
    });
    expect(asset.access).toBe('protected');
    expect(asset.uploadedByUserId).toBe(w.student.userId);

    const submitted = await http()
      .post(base)
      .set(auth(w.student.token))
      .send({ attachmentAssetId: upload.body.assetId })
      .expect(201);
    expect(submitted.body).toMatchObject({
      status: 'submitted',
      isLate: true,
      submittedRevision: 1,
      draftResponse: null,
    });
    expect(submitted.body.response).toBe('Work in progress'); // the draft became the submission
    expect(submitted.body.attachment.url).toContain('http');
    expect(submitted.body.grade).toBeNull();

    // Grading → the learner sees the grade; completion recomputed; notified.
    const submissions = await http()
      .get(`/review/courses/${w.course.id}/assignments/${assignment.id}/submissions`)
      .set(auth(w.manager.token))
      .expect(200);
    const submissionId = submissions.body.items[0].id;
    const detail = await http()
      .get(
        `/review/courses/${w.course.id}/assignments/${assignment.id}/submissions/${submissionId}`,
      )
      .set(auth(w.manager.token))
      .expect(200);
    expect(detail.body.attachment?.url).toContain('http');
    await http()
      .post(
        `/review/courses/${w.course.id}/assignments/${assignment.id}/submissions/${submissionId}/grade`,
      )
      .set(auth(w.manager.token))
      .send({ score: 88, feedback: 'Well argued.' })
      .expect(201);
    const mine = await http().get(base).set(auth(w.student.token)).expect(200);
    expect(mine.body.grade).toMatchObject({ score: 88, feedback: 'Well argued.' });
    expect(
      await admin.notification.findFirst({
        where: {
          userId: w.student.userId,
          titleKey: 'notifications:events.assignmentGraded.title',
        },
      }),
    ).not.toBeNull();

    // Block policy refuses late work outright.
    const blocked = await seedAssignment(admin, w.course.id, 'Blocked', {
      status: 'published',
      dueAt: new Date(Date.now() - 1_000),
    });
    await admin.assignment.update({
      where: { id: blocked.id },
      data: { latePolicy: 'block' },
    });
    await http()
      .post(`/courses/${w.course.id}/assignments/${blocked.id}/submission`)
      .set(auth(w.student.token))
      .send({ response: 'too late' })
      .expect(403);
  });

  // ---------------------------------------------------------------------
  // completion rules and certificates
  // ---------------------------------------------------------------------

  it('completion follows the rule (required quiz gates it); a certificate is issued with an immutable snapshot that a higher retake never changes; regeneration bumps the version; revocation shows on verification; unknown codes are uniform', async () => {
    const w = await world('p3-cert', {
      passingScore: 50,
      quiz: { gradingPolicy: 'highest' },
    });
    const rulePath = `/academies/${w.academy.id}/courses/${w.course.id}/completion-rule`;
    // Learner tokens are refused on the management surface.
    await http().get(rulePath).set(auth(w.student.token)).expect(403);
    const rule = await http()
      .put(rulePath)
      .set(auth(w.owner.token))
      .send({
        requiredQuizIds: [w.quiz.id],
        certificatesEnabled: true,
        certificateMinScore: 50,
      })
      .expect(200);
    expect(rule.body).toMatchObject({
      certificatesEnabled: true,
      certificatesFeatureEnabled: true,
    });
    expect(
      rule.body.quizzes.find((q: { id: string }) => q.id === w.quiz.id)
        .requiredForCompletion,
    ).toBe(true);

    // Lessons done, quiz not yet passed → not complete, missing names the quiz.
    await http()
      .post(`/courses/${w.course.id}/progress/complete-lesson`)
      .set(auth(w.student.token))
      .send({ lessonId: w.lesson.id })
      .expect(201);
    const partial = await http()
      .get(`/learning/courses/${w.course.id}/completion`)
      .set(auth(w.student.token))
      .expect(200);
    expect(partial.body.completed).toBe(false);
    expect(partial.body.missing.map((m: { kind: string }) => m.kind)).toEqual([
      'quiz_not_passed',
    ]);
    expect(partial.body.certificate).toMatchObject({
      enabled: true,
      status: 'unavailable',
    });

    // Pass with exactly 50 → complete; eligible.
    const a1 = await start(w);
    await http()
      .post(`${attemptsPath(w)}/${a1.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }] })
      .expect(201);
    const complete = await http()
      .get(`/learning/courses/${w.course.id}/completion`)
      .set(auth(w.student.token))
      .expect(200);
    expect(complete.body).toMatchObject({ completed: true, overallScore: 50 });
    expect(['eligible', 'issued']).toContain(complete.body.certificate.status);

    // Issuance (the queue may already have done it; the call is idempotent).
    await certificates.issueAutomatically(w.enrollmentId, w.academy.id);
    const issued = await admin.certificate.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(issued.status).toBe('issued');
    expect(issued.serial).toMatch(/^[A-Z0-9]{2,4}-\d{4}-\d{6}$/);
    const snapshot = issued.snapshot as { overallScore: number; learnerName: string };
    expect(snapshot.overallScore).toBe(50);
    const progress = await admin.courseProgress.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(progress.certificateStatus).toBe('issued');

    // D7: a higher retake never touches the issued certificate.
    const a2 = await start(w);
    await http()
      .post(`${attemptsPath(w)}/${a2.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: correctAnswers(w) })
      .expect(201);
    const afterRetake = await admin.certificate.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect((afterRetake.snapshot as { overallScore: number }).overallScore).toBe(50);
    expect(afterRetake.version).toBe(1);
    const progressAfter = await admin.courseProgress.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(progressAfter.certificateStatus).toBe('issued');
    expect(Number(progressAfter.overallScore)).toBe(100);

    // Learner list + download (409 until rendered), then render and download.
    const list = await http()
      .get('/learning/certificates')
      .query({ academyId: w.academy.id })
      .set(auth(w.student.token))
      .expect(200);
    expect(list.body.enabled).toBe(true);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0]).toMatchObject({
      serial: issued.serial,
      status: 'issued',
      overallScore: 50,
    });
    expect(JSON.stringify(list.body)).not.toContain('storageKey');
    if (issued.renderStatus !== 'ready') {
      const renderPending = await http()
        .get(`/learning/certificates/${issued.id}/download`)
        .set(auth(w.student.token));
      expect([409, 200]).toContain(renderPending.status);
    }
    const rendered = await certificates.renderCertificate(issued.id, w.academy.id);
    expect(rendered).toBe('rendered');
    const download = await http()
      .get(`/learning/certificates/${issued.id}/download`)
      .set(auth(w.student.token))
      .expect(200);
    expect(download.body.url).toContain(`certificates/${issued.id}/v`);
    expect(download.body.fileName).toContain(issued.serial);

    // Public verification: valid, revoked, unknown — all 200, uniform shape for unknown.
    const valid = await http().get(`/verify/${issued.verificationCode}`).expect(200);
    expect(valid.body).toMatchObject({
      valid: true,
      status: 'issued',
      serial: issued.serial,
      academySlug: w.academy.slug,
    });
    expect(JSON.stringify(valid.body)).not.toContain(w.student.email);
    const unknown = await http().get('/verify/ABCDEFGHJK23').expect(200);
    expect(unknown.body).toEqual({ valid: false });
    const malformed = await http().get('/verify/not-a-code').expect(200);
    expect(malformed.body).toEqual({ valid: false });

    // Regeneration is explicit: instructors are refused, managers bump the version, serial and code stay.
    await http()
      .post(`/academies/${w.academy.id}/certificates/${issued.id}/regenerate`)
      .set(auth(w.instructor.token))
      .send({})
      .expect(403);
    const regenerated = await http()
      .post(`/academies/${w.academy.id}/certificates/${issued.id}/regenerate`)
      .set(auth(w.manager.token))
      .send({ reason: 'Name corrected' })
      .expect(200);
    expect(regenerated.body).toMatchObject({
      version: 2,
      serial: issued.serial,
      verificationCode: issued.verificationCode,
      overallScore: 50,
    });

    // Staff list scoped by role: instructor sees only assigned courses (this one), a foreign owner sees nothing.
    const staffList = await http()
      .get(`/academies/${w.academy.id}/certificates`)
      .set(auth(w.instructor.token))
      .expect(200);
    expect(staffList.body.items).toHaveLength(1);
    const other = await world('p3-cert-other');
    await http()
      .get(`/academies/${w.academy.id}/certificates`)
      .set(auth(other.owner.token))
      .expect(403);

    // Revocation: reflected on verification and on the learner's status.
    await http()
      .post(`/academies/${w.academy.id}/certificates/${issued.id}/revoke`)
      .set(auth(w.instructor.token))
      .send({ reason: 'x' })
      .expect(403);
    const revoked = await http()
      .post(`/academies/${w.academy.id}/certificates/${issued.id}/revoke`)
      .set(auth(w.owner.token))
      .send({ reason: 'Misconduct' })
      .expect(200);
    expect(revoked.body).toMatchObject({ status: 'revoked', revokeReason: 'Misconduct' });
    const verifyRevoked = await http()
      .get(`/verify/${issued.verificationCode}`)
      .expect(200);
    expect(verifyRevoked.body).toMatchObject({ valid: false, status: 'revoked' });
    await http()
      .get(`/learning/certificates/${issued.id}/download`)
      .set(auth(w.student.token))
      .expect(403);
    const revokedProgress = await admin.courseProgress.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect(revokedProgress.certificateStatus).toBe('revoked');
    expect(
      await admin.auditLogEntry.count({
        where: {
          targetId: issued.id,
          action: {
            in: ['certificate.issued', 'certificate.regenerated', 'certificate.revoked'],
          },
        },
      }),
    ).toBe(3);

    // RLS: a foreign learner and a foreign tenant see zero certificate rows.
    expect(
      await tenancy.runInUserContext(other.student.userId, (tx) =>
        tx.certificate.count({ where: { id: issued.id } }),
      ),
    ).toBe(0);
    expect(
      await tenancy.runInTenantContext(other.org.id, (tx) =>
        tx.certificate.count({ where: { id: issued.id } }),
      ),
    ).toBe(0);
    expect(
      await tenancy.runInUserContext(w.student.userId, (tx) =>
        tx.certificate.count({ where: { id: issued.id } }),
      ),
    ).toBe(1);
  });

  it('deleting the learner account anonymises their certificate snapshot through the queued job', async () => {
    // The job id used to contain a colon, which BullMQ refuses for a
    // two-segment custom id; the enqueue failed silently and no certificate
    // was ever anonymised (22 Sep 2026). This pins the whole path.
    const w = await world('p3-anon', { passingScore: 50 });
    await http()
      .put(`/academies/${w.academy.id}/courses/${w.course.id}/completion-rule`)
      .set(auth(w.owner.token))
      .send({ requiredQuizIds: [w.quiz.id], certificatesEnabled: true })
      .expect(200);
    await http()
      .post(`/courses/${w.course.id}/progress/complete-lesson`)
      .set(auth(w.student.token))
      .send({ lessonId: w.lesson.id })
      .expect(201);
    const a1 = await start(w);
    await http()
      .post(`${attemptsPath(w)}/${a1.id}/submit`)
      .set(auth(w.student.token))
      .send({ answers: [{ questionId: w.q1.id, selectedOptionIds: [w.q1Correct.id] }] })
      .expect(201);
    await certificates.issueAutomatically(w.enrollmentId, w.academy.id);
    const before = await admin.certificate.findUniqueOrThrow({
      where: { enrollmentId: w.enrollmentId },
    });
    expect((before.snapshot as { learnerName: string }).learnerName).not.toBe(
      'Deleted account',
    );

    await http()
      .post('/users/me/delete')
      .set(auth(w.student.token))
      .send({ confirm: true, reason: 'no_longer_needed' })
      .expect(200);

    const until = Date.now() + 15_000;
    let after = await admin.certificate.findUniqueOrThrow({ where: { id: before.id } });
    while (
      (after.snapshot as { learnerName: string }).learnerName !== 'Deleted account' &&
      Date.now() < until
    ) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      after = await admin.certificate.findUniqueOrThrow({ where: { id: before.id } });
    }
    const snapshot = after.snapshot as {
      learnerName: string;
      learnerEmailMasked: string;
      anonymizedAt?: string;
    };
    expect(snapshot.learnerName).toBe('Deleted account');
    expect(snapshot.learnerEmailMasked).toBe('');
    expect(snapshot.anonymizedAt).toBeDefined();
    // Serial and code survive: a verifier can still confirm the certificate existed.
    expect(after.serial).toBe(before.serial);
    expect(after.verificationCode).toBe(before.verificationCode);
  });

  it('a manual issuance by an owner is audited and refused for an ineligible enrollment unless forced; the certificate template is owner/manager only', async () => {
    const w = await world('p3-manual');
    await http()
      .put(`/academies/${w.academy.id}/courses/${w.course.id}/completion-rule`)
      .set(auth(w.owner.token))
      .send({ certificatesEnabled: true })
      .expect(200);
    await http()
      .post(`/academies/${w.academy.id}/enrollments/${w.enrollmentId}/certificate`)
      .set(auth(w.owner.token))
      .send({})
      .expect(409);
    const forced = await http()
      .post(`/academies/${w.academy.id}/enrollments/${w.enrollmentId}/certificate`)
      .set(auth(w.owner.token))
      .send({ force: true, reason: 'Completed offline' })
      .expect(201);
    expect(forced.body).toMatchObject({ status: 'issued', issuedManually: true });
    const audit = await admin.auditLogEntry.findFirst({
      where: { action: 'certificate.issued', targetId: forced.body.id },
    });
    expect(audit?.context).toMatchObject({ forced: true });

    await http()
      .get(`/academies/${w.academy.id}/certificate-template`)
      .set(auth(w.instructor.token))
      .expect(403);
    const template = await http()
      .get(`/academies/${w.academy.id}/certificate-template`)
      .set(auth(w.manager.token))
      .expect(200);
    expect(template.body.wording.en.title).toBe('Certificate of Completion');
    const updated = await http()
      .put(`/academies/${w.academy.id}/certificate-template`)
      .set(auth(w.manager.token))
      .send({ signatoryName: 'Dr. Example', wording: { ar: { title: 'شهادة إنجاز' } } })
      .expect(200);
    expect(updated.body).toMatchObject({
      signatoryName: 'Dr. Example',
      version: template.body.version + 1,
    });
    expect(updated.body.wording.ar.title).toBe('شهادة إنجاز');
  });

  it('sequential progression is enforced on quiz start: a quiz after an unfinished lesson is locked until the lesson is completed', async () => {
    const w = await world('p3-seq-gate');
    // Move the quiz AFTER the lesson (world seeds it first). The learner has
    // not completed the lesson, so the quiz is now locked.
    await admin.quiz.update({ where: { id: w.quiz.id }, data: { order: 5 } });
    const locked = await http()
      .post(attemptsPath(w))
      .set(auth(w.student.token))
      .expect(403);
    expect(locked.body.error?.messageKey ?? locked.body.messageKey).toBe(
      'errors.quiz.locked',
    );
    // Completing the lesson unlocks the quiz — the SAME derivation the sidebar
    // uses now lets the attempt through.
    await http()
      .post(`/courses/${w.course.id}/progress/complete-lesson`)
      .set(auth(w.student.token))
      .send({ lessonId: w.lesson.id })
      .expect(201);
    const started = await http()
      .post(attemptsPath(w))
      .set(auth(w.student.token))
      .expect(201);
    expect(started.body.status).toBe('in_progress');
  });

  it('a live reorder changes the quiz gate: moving the quiz before the lesson unlocks its first attempt immediately', async () => {
    const w = await world('p3-seq-reorder');
    await admin.quiz.update({ where: { id: w.quiz.id }, data: { order: 5 } });
    // Quiz after the unfinished lesson → locked.
    const locked = await http()
      .post(attemptsPath(w))
      .set(auth(w.student.token))
      .expect(403);
    expect(locked.body.error?.messageKey ?? locked.body.messageKey).toBe(
      'errors.quiz.locked',
    );
    // Author reorders the quiz to the front. Only the `order` columns change.
    await admin.quiz.update({ where: { id: w.quiz.id }, data: { order: 0 } });
    await admin.courseLesson.update({ where: { id: w.lesson.id }, data: { order: 1 } });
    // The quiz is now first → startable, the lesson still unfinished.
    const started = await http()
      .post(attemptsPath(w))
      .set(auth(w.student.token))
      .expect(201);
    expect(started.body.status).toBe('in_progress');
  });

  it('quiz authoring accepts the Phase 3 settings and question types and rejects contradictory ones', async () => {
    const w = await world('p3-authoring');
    const created = await http()
      .post(`/courses/${w.course.id}/quizzes`)
      .set(auth(w.owner.token))
      .send({
        title: 'Timed exam',
        status: 'published',
        mode: 'exam',
        timeLimitSeconds: 900,
        shuffleQuestions: true,
        questionsPerAttempt: 2,
        showAnswers: 'after_attempts_exhausted',
        integrityMode: 'warn',
        maxViolations: 3,
        requiredForCompletion: true,
        questions: [
          {
            prompt: 'Capital of France?',
            type: 'short_answer',
            acceptedAnswers: ['Paris', 'paris'],
            points: 2,
          },
          { prompt: 'Discuss.', type: 'essay', points: 5, explanation: 'Rubric' },
          {
            prompt: '2+2',
            type: 'single_choice',
            options: [
              { label: '4', isCorrect: true },
              { label: '5', isCorrect: false },
            ],
          },
        ],
      })
      .expect(201);
    expect(created.body.settings).toMatchObject({
      mode: 'exam',
      timeLimitSeconds: 900,
      questionsPerAttempt: 2,
      integrityMode: 'warn',
    });
    expect(created.body.questions.map((q: { type: string }) => q.type)).toEqual([
      'short_answer',
      'essay',
      'single_choice',
    ]);
    // Contradictions.
    await http()
      .post(`/courses/${w.course.id}/quizzes`)
      .set(auth(w.owner.token))
      .send({
        title: 'Bad',
        questions: [{ prompt: 'x', type: 'short_answer', acceptedAnswers: [] }],
      })
      .expect(400);
    await http()
      .post(`/courses/${w.course.id}/quizzes`)
      .set(auth(w.owner.token))
      .send({
        title: 'Bad',
        questionsPerAttempt: 5,
        questions: [{ prompt: 'x', type: 'essay' }],
      })
      .expect(400);
    await http()
      .post(`/courses/${w.course.id}/quizzes`)
      .set(auth(w.owner.token))
      .send({
        title: 'Bad',
        availableFrom: '2026-10-02T00:00:00Z',
        availableUntil: '2026-10-01T00:00:00Z',
        questions: [{ prompt: 'x', type: 'essay' }],
      })
      .expect(400);
    // The learner projection carries settings but never accepted answers.
    const learnerView = await http()
      .get(`/courses/${w.course.id}/quizzes/${created.body.id}`)
      .set(auth(w.student.token))
      .expect(200);
    expect(learnerView.body.settings.timeLimitSeconds).toBe(900);
    expect(JSON.stringify(learnerView.body)).not.toContain('acceptedAnswers');
    expect(JSON.stringify(learnerView.body)).not.toContain('isCorrect');
  });
});
