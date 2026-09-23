/**
 * P64 Phase 4 — observability and retention (master plan §D.5 / §U).
 *
 * Runs against the real PostgreSQL (RLS on, `atlas_app` role through the
 * app's own Prisma) and the real Redis. Two things are proven here that a
 * unit test structurally cannot:
 *
 *   - the `quiz_attempt_events` retention DELETE actually removes a row
 *     older than 180 days AND leaves a recent one alone, through the
 *     runtime role in a platform owner's user context (row visibility
 *     only) — i.e. the `quiz_attempt_events_retention_delete` policy
 *     admits exactly the sweep's own cutoff and nothing inside the window;
 *   - `GET /metrics` — the real controller behind `JwtAuthGuard` +
 *     `PlatformOwnerGuard`, no global prefix in the test app — exposes the
 *     Phase 4 series by name, with the sweep and catalog samples the suite
 *     itself just produced.
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
  seedCourse,
  seedOrganizationWithOwner,
  seedQuiz,
} from './utils/db-admin';
import { Phase2MaintenanceService } from '../src/learning/services/phase2-maintenance.service';
import { QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS } from '../src/learning/queue/phase2-maintenance.types';

const PASSWORD = 'correct-horse-battery';
const DAY_MS = 24 * 60 * 60 * 1000;

const PHASE4_SERIES = [
  'atlas_checkout_orders_total',
  'atlas_checkout_approval_latency_seconds',
  'atlas_public_catalog_query_duration_ms',
  'atlas_retention_sweep_pruned_rows_total',
  'atlas_retention_sweep_runs_total',
] as const;

describe('P64 Phase 4 — observability and retention (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platformOwnerToken: string;
  const createdOrgIds: string[] = [];

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    platformOwnerToken = (await seedPlatformOwner('p4-obs-po')).token;
  });

  afterAll(async () => {
    if (createdOrgIds.length > 0) {
      // Academy → course → quiz → attempt → events all cascade from the organization.
      await admin.organization.deleteMany({ where: { id: { in: createdOrgIds } } });
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
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

  /** Same recipe as `p60-platform-courses.e2e-spec.ts`: the flag lives on `users.is_platform_owner`, which no API grants, so it is set through the admin connection and the token re-minted. */
  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  /** Owner + org + academy + one published public course + one published quiz, plus a learner who owns a finished attempt. */
  async function world(label: string) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    createdOrgIds.push(org.id);
    await seedActiveSubscriptionForOrg(admin, org.id);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course ${Date.now()}`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const quiz = await seedQuiz(admin, course.id, `${label}-quiz`, {
      status: 'published',
    });
    const student = await signUp(`${label}-student`);
    // A finished attempt with no deadline: nothing in the sweep's other
    // duties (overdue finalisation) has any reason to touch it.
    const attempt = await admin.quizAttempt.create({
      data: {
        quizId: quiz.id,
        studentId: student.userId,
        status: 'submitted',
        attemptNumber: 1,
        submittedAt: new Date(
          Date.now() - (QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS + 1) * DAY_MS,
        ),
      },
    });
    return { org, academy, course, quiz, student, attempt };
  }

  it('the maintenance sweep prunes a quiz_attempt_event older than 180 days and keeps a recent one', async () => {
    const w = await world('p4-obs-retention');
    const stale = await admin.quizAttemptEvent.create({
      data: {
        attemptId: w.attempt.id,
        type: 'blur',
        counted: true,
        serverAt: new Date(
          Date.now() - (QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS + 1) * DAY_MS,
        ),
      },
    });
    const recent = await admin.quizAttemptEvent.create({
      data: {
        attemptId: w.attempt.id,
        type: 'focus',
        counted: false,
        serverAt: new Date(),
      },
    });
    // Just inside the window: one day short of the cutoff must survive too.
    const edge = await admin.quizAttemptEvent.create({
      data: {
        attemptId: w.attempt.id,
        type: 'heartbeat',
        counted: false,
        serverAt: new Date(
          Date.now() - (QUIZ_ATTEMPT_EVENTS_RETENTION_DAYS - 1) * DAY_MS,
        ),
      },
    });

    const result = await app.get(Phase2MaintenanceService).run();
    expect(result.prunedQuizAttemptEventRows).toBeGreaterThanOrEqual(1);

    expect(
      await admin.quizAttemptEvent.findUnique({ where: { id: stale.id } }),
    ).toBeNull();
    expect(
      await admin.quizAttemptEvent.findUnique({ where: { id: recent.id } }),
    ).toMatchObject({
      id: recent.id,
      type: 'focus',
    });
    expect(
      await admin.quizAttemptEvent.findUnique({ where: { id: edge.id } }),
    ).toMatchObject({
      id: edge.id,
      type: 'heartbeat',
    });

    // A second run finds nothing more of ours to delete and still leaves the
    // in-window rows alone — the sweep is idempotent.
    await app.get(Phase2MaintenanceService).run();
    expect(
      await admin.quizAttemptEvent.count({ where: { attemptId: w.attempt.id } }),
    ).toBe(2);
  });

  it('GET /metrics is platform-owner only and exposes every Phase 4 series by name', async () => {
    await http().get('/metrics').expect(401);

    const w = await world('p4-obs-metrics');
    const learner = await signUp('p4-obs-learner');
    await http().get('/metrics').set(auth(learner.token)).expect(403);

    // Produce a real catalog sample through the public route the timer wraps.
    const catalog = await http()
      .get(`/public/websites/${w.academy.id}/courses`)
      .expect(200);
    expect(catalog.body.items.map((c: { id: string }) => c.id)).toContain(w.course.id);

    const scrape = await http().get('/metrics').set(auth(platformOwnerToken)).expect(200);
    expect(scrape.headers['content-type']).toContain('text/plain');
    expect(scrape.headers['cache-control']).toBe('no-store');
    const body = scrape.text;

    for (const name of PHASE4_SERIES) {
      expect(body).toContain(`# HELP ${name} `);
      expect(body).toContain(`# TYPE ${name} `);
    }

    // The sweep the previous case ran left real samples behind: both tables
    // report an ok run, and both have a pruned-rows sample (whatever its
    // value — how MANY rows the sweep may delete is the retention case's
    // assertion, not this one's).
    expect(body).toMatch(
      /atlas_retention_sweep_runs_total\{(?=[^}]*table="quiz_attempt_events")(?=[^}]*result="ok")[^}]*\} [1-9]\d*/,
    );
    expect(body).toMatch(
      /atlas_retention_sweep_runs_total\{(?=[^}]*table="content_access_log")(?=[^}]*result="ok")[^}]*\} [1-9]\d*/,
    );
    expect(body).toMatch(
      /atlas_retention_sweep_pruned_rows_total\{table="quiz_attempt_events"\} \d+/,
    );
    expect(body).toMatch(
      /atlas_retention_sweep_pruned_rows_total\{table="content_access_log"\} \d+/,
    );
    // And the catalog read a moment ago was timed.
    expect(body).toMatch(/atlas_public_catalog_query_duration_ms_count [1-9]\d*/);
  });
});
