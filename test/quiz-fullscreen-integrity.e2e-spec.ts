/**
 * P4 — full-screen exams, server side (real PostgreSQL).
 *
 * - The attempt's settings snapshot is the authority: full screen is
 *   required only when the quiz asks for it AND integrity is on. A stored
 *   switch under integrity "off" (the editor hides it) does not leak into
 *   the attempt, nor into the learner's quiz view.
 * - `fullscreen_unavailable` is recorded for the reviewer and never
 *   counted; leaving full screen is counted (after the warm-up).
 * - A client can attach only allow-listed payload keys/values; anything
 *   else is dropped before storage.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
  seedQuiz,
  seedQuizQuestion,
  seedQuizQuestionOption,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import type { LearningFeatureFlags } from '../src/config/configuration';

/** Engine v2 and integrity on for every Academy, whatever the environment says (CI sets none). */
const ON = { mode: 'on' as const, academyIds: [] as string[] };
const FLAGS: LearningFeatureFlags = {
  contentProtected: ON,
  videoNormal: ON,
  videoPremium: ON,
  quizEngineV2: ON,
  quizIntegrity: ON,
};

describe('Full-screen exams (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(FeatureFlagsService)
          .useValue(
            new FeatureFlagsService({ get: () => FLAGS } as unknown as ConfigService),
          ),
    });
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

  async function signUpAndSignIn(label: string) {
    const email = uniqueTestEmail(label);
    const password = 'correct-horse-battery';
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedQuizForStudent(
    label: string,
    settings: {
      integrityMode: 'off' | 'monitor' | 'warn' | 'strict';
      requireFullscreen: boolean;
    },
  ) {
    const owner = await signUpAndSignIn(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label}-course-${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const quiz = await seedQuiz(admin, course.id, `${label} quiz`, {
      status: 'published',
    });
    await admin.quiz.update({
      where: { id: quiz.id },
      data: { ...settings, maxViolations: 5 },
    });
    const question = await seedQuizQuestion(admin, quiz.id, '2+2?', 'single_choice', 0);
    await seedQuizQuestionOption(admin, question.id, '4', true);
    await seedQuizQuestionOption(admin, question.id, '5', false);

    const student = await signUpAndSignIn(`${label}-student`);
    await seedAcademyStudent(admin, academy.id, student.userId);
    await request(app.getHttpServer())
      .post('/enrollments')
      .set('Authorization', `Bearer ${student.token}`)
      .send({ courseId: course.id })
      .expect(201);
    const base = `/courses/${course.id}/quizzes/${quiz.id}`;
    const as = (method: 'get' | 'post', url: string) =>
      request(app.getHttpServer())
        [method](url)
        .set('Authorization', `Bearer ${student.token}`);
    const asOwner = (url: string) =>
      request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${owner.token}`);
    return { base, as, asOwner, courseId: course.id, quizId: quiz.id };
  }

  it('integrity on + full screen: the attempt requires it; unavailable is context, an exit is counted, payloads are allow-listed', async () => {
    const { base, as } = await seedQuizForStudent('fs-on', {
      integrityMode: 'warn',
      requireFullscreen: true,
    });
    const quizView = await as('get', base).expect(200);
    expect(quizView.body.settings.requireFullscreen).toBe(true);

    const attempt = await as('post', `${base}/attempts`).send({}).expect(201);
    const session = await as('get', `${base}/attempts/${attempt.body.id}`).expect(200);
    expect(session.body.settings.requireFullscreen).toBe(true);

    // Past the warm-up, so a violation can count.
    await admin.quizAttempt.update({
      where: { id: attempt.body.id },
      data: { startedAt: new Date(Date.now() - 60_000) },
    });

    const unavailable = await as('post', `${base}/attempts/${attempt.body.id}/events`)
      .send({
        events: [
          {
            type: 'fullscreen_unavailable',
            payload: { reason: 'unsupported', userAgent: 'x', screen: '1x1' },
          },
        ],
      })
      .expect(200);
    expect(unavailable.body.violationCount).toBe(0);

    const exit = await as('post', `${base}/attempts/${attempt.body.id}/events`)
      .send({ events: [{ type: 'fullscreen_exit', payload: { anything: 'else' } }] })
      .expect(200);
    expect(exit.body.violationCount).toBe(1);
    expect(exit.body.action).toBe('warn');

    const stored = await admin.quizAttemptEvent.findMany({
      where: { attemptId: attempt.body.id },
      orderBy: { serverAt: 'asc' },
    });
    expect(stored.map((e) => [e.type, e.counted, e.payload])).toEqual([
      ['fullscreen_unavailable', false, { reason: 'unsupported' }],
      ['fullscreen_exit', true, null],
    ]);
  });

  it('P5: the reviewer sees explainable signals with their evidence; the learner cannot reach the review', async () => {
    const { base, as, asOwner, courseId, quizId } = await seedQuizForStudent(
      'fs-signals',
      {
        integrityMode: 'warn',
        requireFullscreen: true,
      },
    );
    const attempt = await as('post', `${base}/attempts`).send({}).expect(201);
    await as('post', `${base}/attempts/${attempt.body.id}/events`)
      .send({ events: [{ type: 'paste' }, { type: 'print' }] })
      .expect(200);
    const reviewUrl = `/review/courses/${courseId}/quizzes/${quizId}/attempts/${attempt.body.id}`;
    await as('get', reviewUrl).expect(403);

    const review = await asOwner(reviewUrl).expect(200);
    expect(review.body.requireFullscreen).toBe(true);
    const byKey = Object.fromEntries(
      (review.body.signals as { key: string; level: string; eventIds: string[] }[]).map(
        (s) => [s.key, s],
      ),
    );
    const ids = Object.fromEntries(
      (review.body.events as { id: string; type: string }[]).map((e) => [e.type, e.id]),
    );
    expect(byKey.paste_without_copy).toMatchObject({
      level: 'review',
      eventIds: [ids.paste],
    });
    expect(byKey.print).toMatchObject({ level: 'review', eventIds: [ids.print] });
    expect(byKey.fullscreen_never_entered).toMatchObject({ level: 'review' });
    expect(JSON.stringify(review.body.signals)).not.toMatch(/score|probab|cheat/i);
  });

  it('a stored full-screen switch under integrity "off" never reaches the attempt or the learner', async () => {
    const { base, as } = await seedQuizForStudent('fs-off', {
      integrityMode: 'off',
      requireFullscreen: true,
    });
    const quizView = await as('get', base).expect(200);
    expect(quizView.body.settings.requireFullscreen).toBe(false);
    const attempt = await as('post', `${base}/attempts`).send({}).expect(201);
    const session = await as('get', `${base}/attempts/${attempt.body.id}`).expect(200);
    expect(session.body.settings.requireFullscreen).toBe(false);
    expect(session.body.settings.integrityMode).toBe('off');
  });

  it('an unknown reason value is dropped, not stored', async () => {
    const { base, as } = await seedQuizForStudent('fs-reason', {
      integrityMode: 'monitor',
      requireFullscreen: true,
    });
    const attempt = await as('post', `${base}/attempts`).send({}).expect(201);
    await as('post', `${base}/attempts/${attempt.body.id}/events`)
      .send({
        events: [{ type: 'fullscreen_unavailable', payload: { reason: 'my-gpu-is-x' } }],
      })
      .expect(200);
    const [event] = await admin.quizAttemptEvent.findMany({
      where: { attemptId: attempt.body.id },
    });
    expect(event.payload).toBeNull();
  });
});
