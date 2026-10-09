/**
 * Academy offline work (Oct 2026) — the server-side guarantees the learner
 * portal's offline outbox relies on:
 *
 *  - an assignment submit replayed with the same `idempotencyKey` returns
 *    the original submission and NEVER resets a grade given in between,
 *    even when the Redis record is gone (`baseRevision` compare-and-set);
 *  - a draft saved from an older copy is refused (compare-and-set on
 *    `draft_saved_at`), never silently overwrites the newer one;
 *  - lesson complete/undo stamped with `opId` + `clientOpAt`: an older
 *    operation arriving later is not applied (`applied: false`);
 *  - a stale quiz autosave is not applied and hands back the newer answers
 *    so the client can rebase instead of dropping its edits;
 *  - learner/authenticated responses are `Cache-Control: private, no-store`;
 *    published website reads are briefly cacheable by the visitor's own
 *    browser only (`private`), errors never;
 *  - a text lesson grant carries the server's offline-reading permission;
 *    a video grant never does.
 */
import { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import type { LearningFeatureFlags } from '../src/config/configuration';
import { RedisService } from '../src/redis/redis.service';

const PASSWORD = 'correct-horse-battery';

function allFlags(mode: 'on' | 'off'): LearningFeatureFlags {
  const flag = { mode, academyIds: [] as string[] };
  return {
    contentProtected: flag,
    videoNormal: flag,
    videoPremium: flag,
    quizEngineV2: flag,
    quizIntegrity: flag,
  };
}

describe('Academy offline — replay safety, ordering and caching (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let redis: RedisService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(FeatureFlagsService).useValue(
          new FeatureFlagsService({
            get: () => allFlags('on'),
          } as unknown as ConfigService),
        ),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    redis = app.get(RedisService);
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    const setCookie =
      (signIn.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const device = setCookie.find((value) => value.startsWith('atlas_device='));
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
      cookie: device ? device.split(';')[0] : '',
      signInHeaders: signIn.headers,
    };
  }

  async function world(label: string) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-section`, 0);
    return { owner, org, academy, course, section };
  }

  async function enroll(w: Awaited<ReturnType<typeof world>>, label: string) {
    const student = await signUp(label);
    await seedAcademyStudent(admin, w.academy.id, student.userId);
    await http()
      .post('/enrollments')
      .set(auth(student.token))
      .send({ courseId: w.course.id })
      .expect(201);
    return student;
  }

  // -------------------------------------------------------------------
  // assignment submit — idempotency
  // -------------------------------------------------------------------

  describe('assignment submit', () => {
    async function setup(label: string) {
      const w = await world(label);
      const assignment = await seedAssignment(admin, w.course.id, `${label} essay`, {
        status: 'published',
        allowResubmission: true,
        sectionId: w.section.id,
      });
      const student = await enroll(w, `${label}-student`);
      const path = `/courses/${w.course.id}/assignments/${assignment.id}/submission`;
      const grade = async () =>
        admin.assignmentSubmission.updateMany({
          where: { assignmentId: assignment.id, studentId: student.userId },
          data: {
            gradingStatus: 'graded',
            score: 90,
            feedback: 'Well argued.',
            gradedAt: new Date(),
          },
        });
      const row = async () =>
        admin.assignmentSubmission.findFirstOrThrow({
          where: { assignmentId: assignment.id, studentId: student.userId },
        });
      return { w, assignment, student, path, grade, row };
    }

    it('a replay with the same key returns the original submission and never resets a grade given in between', async () => {
      const { student, path, grade, row } = await setup('off-idem');
      const key = 'offline-submit-key-0001';
      const first = await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'My essay.', idempotencyKey: key, baseRevision: 0 })
        .expect(201);
      expect(first.body).toMatchObject({ status: 'submitted', submittedRevision: 1 });

      await grade();

      const replay = await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'My essay.', idempotencyKey: key, baseRevision: 0 })
        .expect(201);
      expect(replay.body.id).toBe(first.body.id);
      expect(replay.body.submittedRevision).toBe(1);
      expect(replay.body.gradingStatus).toBe('graded');
      expect(replay.body.grade).toMatchObject({ score: 90, feedback: 'Well argued.' });

      const stored = await row();
      expect(stored.submittedRevision).toBe(1);
      expect(stored.gradingStatus).toBe('graded');
      expect(Number(stored.score)).toBe(90);
    });

    it('the same key with a different payload is refused', async () => {
      const { student, path } = await setup('off-idem-reuse');
      const key = 'offline-submit-key-0002';
      await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'Version A', idempotencyKey: key, baseRevision: 0 })
        .expect(201);
      const reused = await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'Version B', idempotencyKey: key, baseRevision: 0 })
        .expect(422);
      expect(reused.body.error).toMatchObject({
        messageKey: 'errors.assignment.idempotencyKeyReused',
      });
    });

    it('with the Redis record gone, the revision compare-and-set still refuses the replay — the grade survives', async () => {
      const { student, assignment, path, grade, row } = await setup('off-idem-cas');
      const key = 'offline-submit-key-0003';
      await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'My essay.', idempotencyKey: key, baseRevision: 0 })
        .expect(201);
      await grade();
      await redis
        .getClient()
        .del(`learning:idem:assignment-submit:${student.userId}:${assignment.id}:${key}`);

      const replay = await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'My essay.', idempotencyKey: key, baseRevision: 0 })
        .expect(409);
      expect(replay.body.error).toMatchObject({
        messageKey: 'errors.assignment.submissionChanged',
      });
      const stored = await row();
      expect(stored.submittedRevision).toBe(1);
      expect(stored.gradingStatus).toBe('graded');
    });

    it('a real resubmission (new key, current revision) still works', async () => {
      const { student, path, grade, row } = await setup('off-resubmit');
      await http()
        .post(path)
        .set(auth(student.token))
        .send({
          response: 'First.',
          idempotencyKey: 'offline-submit-key-0004',
          baseRevision: 0,
        })
        .expect(201);
      await grade();
      const second = await http()
        .post(path)
        .set(auth(student.token))
        .send({
          response: 'Second.',
          idempotencyKey: 'offline-submit-key-0005',
          baseRevision: 1,
        })
        .expect(201);
      expect(second.body).toMatchObject({ submittedRevision: 2, response: 'Second.' });
      expect((await row()).gradingStatus).toBe('ungraded');
    });

    it('an older client (no key, no base) behaves exactly as before', async () => {
      const { student, path } = await setup('off-legacy');
      const first = await http()
        .post(path)
        .set(auth(student.token))
        .send({ response: 'Legacy.' })
        .expect(201);
      expect(first.body.submittedRevision).toBe(1);
    });

    it('draft compare-and-set: a save based on an older copy is refused with the newer draft', async () => {
      const { student, w, assignment } = await setup('off-draft');
      const path = `/courses/${w.course.id}/assignments/${assignment.id}/submission/draft`;
      const first = await http()
        .put(path)
        .set(auth(student.token))
        .send({ response: 'Tab A', baseDraftSavedAt: null })
        .expect(200);
      const base = first.body.draftSavedAt as string;
      const second = await http()
        .put(path)
        .set(auth(student.token))
        .send({ response: 'Tab A, more', baseDraftSavedAt: base })
        .expect(200);

      // A second tab still holding the first copy.
      const stale = await http()
        .put(path)
        .set(auth(student.token))
        .send({ response: 'Tab B', baseDraftSavedAt: base })
        .expect(409);
      expect(stale.body.error).toMatchObject({
        messageKey: 'errors.assignment.draftConflict',
      });
      expect(stale.body.error.details).toMatchObject({
        draftResponse: 'Tab A, more',
        draftSavedAt: second.body.draftSavedAt,
      });

      // No base: last write wins, as before.
      await http()
        .put(path)
        .set(auth(student.token))
        .send({ response: 'Legacy client' })
        .expect(200);
    });
  });

  // -------------------------------------------------------------------
  // lesson complete / undo — ordering
  // -------------------------------------------------------------------

  describe('lesson complete / undo ordering', () => {
    async function setup(label: string) {
      const w = await world(label);
      const lesson = await seedCourseLesson(admin, w.section.id, w.course.id, 'L1', 0, {
        status: 'published',
      });
      await seedCourseLesson(admin, w.section.id, w.course.id, 'L2', 1, {
        status: 'published',
      });
      const student = await enroll(w, `${label}-student`);
      await http()
        .get(`/courses/${w.course.id}/progress`)
        .set(auth(student.token))
        .expect(200);
      const statusOf = async () => {
        const progress = await http()
          .get(`/courses/${w.course.id}/progress`)
          .set(auth(student.token))
          .expect(200);
        return progress.body.lessons.find(
          (l: { lessonId: string }) => l.lessonId === lesson.id,
        ).status as string;
      };
      return { w, lesson, student, statusOf };
    }

    it('a complete queued offline that arrives AFTER a newer undo is not applied', async () => {
      const { w, lesson, student, statusOf } = await setup('off-order');
      const t0 = Date.now() - 60_000;
      // Online, device 1: complete at t0, then undo at t0 + 20 s.
      await http()
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(auth(student.token))
        .send({ lessonId: lesson.id, opId: 'op-complete-online', clientOpAt: t0 })
        .expect(201);
      const undo = await http()
        .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
        .query({ opId: 'op-undo-online', clientOpAt: t0 + 20_000 })
        .set(auth(student.token))
        .expect(200);
      expect(undo.body.applied).toBe(true);
      expect(await statusOf()).not.toBe('completed');

      // Device 2 pressed "complete" offline at t0 + 10 s; it syncs now.
      const late = await http()
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(auth(student.token))
        .send({
          lessonId: lesson.id,
          opId: 'op-complete-offline',
          clientOpAt: t0 + 10_000,
        })
        .expect(201);
      expect(late.body.applied).toBe(false);
      expect(await statusOf()).not.toBe('completed');

      // The undo replayed (lost response, outbox retry) is applied again — idempotent.
      const replay = await http()
        .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
        .query({ opId: 'op-undo-online', clientOpAt: t0 + 20_000 })
        .set(auth(student.token))
        .expect(200);
      expect(replay.body.applied).toBe(true);

      // A genuinely newer complete wins.
      const newer = await http()
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(auth(student.token))
        .send({ lessonId: lesson.id, opId: 'op-complete-newer', clientOpAt: t0 + 30_000 })
        .expect(201);
      expect(newer.body.applied).toBe(true);
      expect(await statusOf()).toBe('completed');
    });

    it('without a ledger record, an undo older than the recorded completion is stale', async () => {
      const { w, lesson, student, statusOf } = await setup('off-order-db');
      await http()
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(auth(student.token))
        .send({ lessonId: lesson.id })
        .expect(201);
      const stale = await http()
        .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
        .query({ opId: 'op-undo-ancient', clientOpAt: Date.now() - 60 * 60 * 1000 })
        .set(auth(student.token))
        .expect(200);
      expect(stale.body.applied).toBe(false);
      expect(await statusOf()).toBe('completed');
    });

    it('unstamped operations (older clients) are applied as before', async () => {
      const { w, lesson, student, statusOf } = await setup('off-order-legacy');
      await http()
        .post(`/courses/${w.course.id}/progress/complete-lesson`)
        .set(auth(student.token))
        .send({ lessonId: lesson.id })
        .expect(201);
      expect(await statusOf()).toBe('completed');
      await http()
        .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
        .set(auth(student.token))
        .expect(200);
      expect(await statusOf()).not.toBe('completed');
    });

    it('rejects a malformed ordering stamp', async () => {
      const { w, lesson, student } = await setup('off-order-bad');
      await http()
        .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
        .query({ opId: 'x', clientOpAt: 'yesterday' })
        .set(auth(student.token))
        .expect(400);
    });
  });

  // -------------------------------------------------------------------
  // quiz autosave — stale revision
  // -------------------------------------------------------------------

  it('quiz: a stale autosave is not applied and returns the newer answers to rebase onto', async () => {
    const w = await world('off-quiz');
    const quiz = await seedQuiz(admin, w.course.id, 'off-quiz', {
      status: 'published',
      passingScore: 50,
      sectionId: w.section.id,
    });
    const q1 = await seedQuizQuestion(admin, quiz.id, 'What is 2+2?', 'single_choice', 0);
    const right = await seedQuizQuestionOption(admin, q1.id, '4', true);
    const wrong = await seedQuizQuestionOption(admin, q1.id, '5', false);
    const student = await enroll(w, 'off-quiz-student');
    const attemptsPath = `/courses/${w.course.id}/quizzes/${quiz.id}/attempts`;
    const attempt = await http().post(attemptsPath).set(auth(student.token)).expect(201);
    expect(attempt.body.deadlineAt).toBeNull(); // untimed
    const path = `${attemptsPath}/${attempt.body.id}/answers`;

    const fresh = await http()
      .put(path)
      .set(auth(student.token))
      .send({
        revision: 3,
        answers: [{ questionId: q1.id, selectedOptionIds: [right.id] }],
      })
      .expect(200);
    expect(fresh.body).toMatchObject({ applied: true, revision: 3 });
    expect(fresh.body.answers).toBeUndefined();

    const stale = await http()
      .put(path)
      .set(auth(student.token))
      .send({
        revision: 2,
        answers: [{ questionId: q1.id, selectedOptionIds: [wrong.id] }],
      })
      .expect(200);
    expect(stale.body).toMatchObject({ applied: false, revision: 3 });
    expect(stale.body.answers).toEqual([
      expect.objectContaining({ questionId: q1.id, selectedOptionIds: [right.id] }),
    ]);
    expect(JSON.stringify(stale.body)).not.toContain('isCorrect');

    // The rebased retry at revision + 1 is applied.
    const rebased = await http()
      .put(path)
      .set(auth(student.token))
      .send({
        revision: 4,
        answers: [{ questionId: q1.id, selectedOptionIds: [wrong.id] }],
      })
      .expect(200);
    expect(rebased.body).toMatchObject({ applied: true, revision: 4 });
  });

  // -------------------------------------------------------------------
  // caching headers
  // -------------------------------------------------------------------

  describe('Cache-Control', () => {
    it('learner, authenticated and credential-bearing responses are private, no-store', async () => {
      const w = await world('off-cache');
      await seedCourseLesson(admin, w.section.id, w.course.id, 'L1', 0, {
        status: 'published',
      });
      const student = await enroll(w, 'off-cache-student');
      expect(student.signInHeaders['cache-control']).toBe('private, no-store');

      const progress = await http()
        .get(`/courses/${w.course.id}/progress`)
        .set(auth(student.token))
        .expect(200);
      expect(progress.headers['cache-control']).toBe('private, no-store');

      const enrollments = await http()
        .get('/enrollments')
        .set(auth(student.token))
        .expect(200);
      expect(enrollments.headers['cache-control']).toBe('private, no-store');

      // Refusals too — set before any guard runs.
      const refused = await http().get(`/courses/${w.course.id}/progress`).expect(401);
      expect(refused.headers['cache-control']).toBe('private, no-store');
    });

    it('published website reads are private and briefly cacheable; errors and writes are not', async () => {
      const w = await world('off-cache-public');
      const missing = await http()
        .get(`/public/websites/${w.academy.id}`)
        .expect((res) => expect([200, 404]).toContain(res.status));
      if (missing.status === 404) {
        expect(missing.headers['cache-control']).toBe('private, no-store');
      } else {
        expect(missing.headers['cache-control']).toBe(
          'private, max-age=60, stale-while-revalidate=300',
        );
      }
      const statistics = await http().get(`/public/websites/${w.academy.id}/statistics`);
      if (statistics.status === 200) {
        expect(statistics.headers['cache-control']).toBe(
          'private, max-age=60, stale-while-revalidate=300',
        );
      } else {
        expect(statistics.headers['cache-control']).toBe('private, no-store');
      }
      const unknown = await http()
        .get('/public/websites/resolve')
        .query({ hostname: `nobody-${Date.now()}.example.test` })
        .expect(404);
      expect(unknown.headers['cache-control']).toBe('private, no-store');
    });
  });

  // -------------------------------------------------------------------
  // offline reading permission on the grant
  // -------------------------------------------------------------------

  it('a text lesson grant carries the offline-reading permission and stays no-store', async () => {
    const w = await world('off-grant');
    const lesson = await seedCourseLesson(
      admin,
      w.section.id,
      w.course.id,
      'Reading',
      0,
      {
        contentType: 'text',
        status: 'published',
      },
    );
    await admin.lessonContent.create({
      data: {
        lessonId: lesson.id,
        courseId: w.course.id,
        academyId: w.academy.id,
        kind: 'text',
        bodyHtml: '<p>Reading material.</p>',
      },
    });
    const student = await enroll(w, 'off-grant-student');
    await http()
      .get(`/courses/${w.course.id}/progress`)
      .set(auth(student.token))
      .expect(200);
    const grant = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${lesson.id}/content`)
      .set(auth(student.token))
      .set('Cookie', student.cookie)
      .expect(200);
    expect(grant.headers['cache-control']).toBe('private, no-store');
    expect(grant.body.kind).toBe('text');
    expect(grant.body.offlineReading.allowed).toBe(true);
    const until = Date.parse(grant.body.offlineReading.until);
    expect(until).toBeGreaterThan(Date.now() + 71 * 60 * 60 * 1000);
    expect(until).toBeLessThanOrEqual(Date.now() + 72 * 60 * 60 * 1000 + 5_000);
  });
});
