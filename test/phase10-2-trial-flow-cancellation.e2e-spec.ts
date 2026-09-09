/**
 * Phase 10.2 — explicit trial flow, cancellation and admin authorization
 * (P102-001..026).
 *
 * THE BEHAVIOUR CHANGE THIS PINS. Creating an Organization used to grant
 * a 3-day trial automatically. It no longer grants anything: a trial is
 * redeemed only by an explicit, confirmed "Start Free Trial" request.
 * P102-001..005 are the regression guards for that, and they are written
 * to fail loudly if the old automatic behaviour ever returns.
 *
 * WHAT "NO TRIAL" LOOKS LIKE. A new Organization gets a real subscription
 * row with `status: 'expired'` and `trialEndsAt: null` — the existing,
 * already-handled representation of "no usable entitlement". So these
 * tests assert on the subscription state rather than on the absence of a
 * row.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { trialSubjectHash } from '../src/plans/utils/trial-subject.util';

const PASSWORD = 'correct-horse-battery';

describe('Phase 10.2 trial flow, cancellation & admin (e2e) — P102-001..026', () => {
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

  async function signUp(email: string): Promise<{ token: string; userId: string }> {
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Flow Tester', email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return { token: signIn.body.accessToken, userId: signIn.body.user.id };
  }

  function createOrganization(token: string, name: string) {
    return request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
  }

  function startTrial(token: string, orgId: string, body: object = { confirm: true }) {
    return request(app.getHttpServer())
      .post(`/organizations/${orgId}/subscription/trial`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function cancelTrial(token: string, orgId: string, body: object) {
    return request(app.getHttpServer())
      .post(`/organizations/${orgId}/subscription/trial/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  function cancelSubscription(token: string, orgId: string, body: object) {
    return request(app.getHttpServer())
      .post(`/organizations/${orgId}/subscription/cancel`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function subscriptionOf(organizationId: string) {
    return admin.tenantSubscription.findUnique({ where: { organizationId } });
  }

  async function hasUsableTrial(organizationId: string): Promise<boolean> {
    const subscription = await subscriptionOf(organizationId);
    if (!subscription?.trialEndsAt) return false;
    if (subscription.status !== 'trialing') return false;
    return subscription.trialEndsAt.getTime() > Date.now();
  }

  // ---------------------------------------------------------------
  // No implicit trials anywhere before explicit confirmation
  // ---------------------------------------------------------------

  it('P102-001 — creating an ACCOUNT grants no trial', async () => {
    const email = uniqueTestEmail('p102-001');
    await signUp(email);

    const redemption = await admin.trialRedemption.findUnique({
      where: { subjectHash: trialSubjectHash(email) },
    });
    expect(redemption).toBeNull();
  });

  it('P102-002 — creating an ORGANIZATION grants no trial', async () => {
    // The headline regression guard for the removed automatic grant.
    const email = uniqueTestEmail('p102-002');
    const { token } = await signUp(email);
    const org = await createOrganization(token, `P102-002 ${Date.now()}`).expect(201);

    const subscription = await subscriptionOf(org.body.id);
    expect(subscription).toBeTruthy();
    expect(subscription?.trialEndsAt).toBeNull();
    expect(subscription?.status).toBe('expired');
    expect(await hasUsableTrial(org.body.id)).toBe(false);

    // And nothing was consumed from the durable ledger.
    const redemption = await admin.trialRedemption.findUnique({
      where: { subjectHash: trialSubjectHash(email) },
    });
    expect(redemption).toBeNull();
  });

  it('P102-003 — creating MANY organizations still grants no trials', async () => {
    const email = uniqueTestEmail('p102-003');
    const { token } = await signUp(email);
    const stamp = Date.now();

    const orgs = [];
    for (let i = 0; i < 3; i += 1) {
      const org = await createOrganization(token, `P102-003 ${stamp} ${i}`).expect(201);
      orgs.push(org.body.id);
    }

    for (const id of orgs) {
      expect(await hasUsableTrial(id)).toBe(false);
    }
    expect(
      await admin.trialRedemption.count({
        where: { subjectHash: trialSubjectHash(email) },
      }),
    ).toBe(0);
  });

  it('P102-004 — viewing plans grants no trial', async () => {
    const email = uniqueTestEmail('p102-004');
    const { token } = await signUp(email);
    const org = await createOrganization(token, `P102-004 ${Date.now()}`).expect(201);

    await request(app.getHttpServer())
      .get('/plans')
      .set('Authorization', `Bearer ${token}`);

    expect(await hasUsableTrial(org.body.id)).toBe(false);
    expect(
      await admin.trialRedemption.count({
        where: { subjectHash: trialSubjectHash(email) },
      }),
    ).toBe(0);
  });

  it('P102-005 — reading the subscription grants no trial', async () => {
    const email = uniqueTestEmail('p102-005');
    const { token } = await signUp(email);
    const org = await createOrganization(token, `P102-005 ${Date.now()}`).expect(201);

    await request(app.getHttpServer())
      .get(`/organizations/${org.body.id}/subscription`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);

    expect(await hasUsableTrial(org.body.id)).toBe(false);
  });

  // ---------------------------------------------------------------
  // Explicit redemption
  // ---------------------------------------------------------------

  it('P102-006 — explicit Start Free Trial grants exactly one real trial', async () => {
    const email = uniqueTestEmail('p102-006');
    const { token } = await signUp(email);
    const org = await createOrganization(token, `P102-006 ${Date.now()}`).expect(201);

    const response = await startTrial(token, org.body.id).expect(200);

    expect(response.body.started).toBe(true);
    expect(response.body.trialEndsAt).toBeTruthy();
    expect(await hasUsableTrial(org.body.id)).toBe(true);

    const redemption = await admin.trialRedemption.findUnique({
      where: { subjectHash: trialSubjectHash(email) },
    });
    expect(redemption).toBeTruthy();
    expect(redemption?.organizationId).toBe(org.body.id);
  });

  it('P102-007 — a request without explicit confirmation is rejected', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-007'));
    const org = await createOrganization(token, `P102-007 ${Date.now()}`).expect(201);

    await startTrial(token, org.body.id, {}).expect(400);
    await startTrial(token, org.body.id, { confirm: false }).expect(400);

    expect(await hasUsableTrial(org.body.id)).toBe(false);
  });

  it('P102-008 — a second Start Free Trial on the same organization is refused', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-008'));
    const org = await createOrganization(token, `P102-008 ${Date.now()}`).expect(201);

    await startTrial(token, org.body.id).expect(200);
    const second = await startTrial(token, org.body.id).expect(200);

    expect(second.body.started).toBe(false);
  });

  it('P102-009 — a SECOND ORGANIZATION cannot redeem another trial', async () => {
    const email = uniqueTestEmail('p102-009');
    const { token } = await signUp(email);
    const stamp = Date.now();

    const first = await createOrganization(token, `P102-009 a ${stamp}`).expect(201);
    await startTrial(token, first.body.id).expect(200);
    expect(await hasUsableTrial(first.body.id)).toBe(true);

    const second = await createOrganization(token, `P102-009 b ${stamp}`).expect(201);
    const attempt = await startTrial(token, second.body.id).expect(200);

    expect(attempt.body.started).toBe(false);
    expect(attempt.body.reason).toBe('already_redeemed');
    expect(await hasUsableTrial(second.body.id)).toBe(false);
    // Still exactly one redemption for this subject, ever.
    expect(
      await admin.trialRedemption.count({
        where: { subjectHash: trialSubjectHash(email) },
      }),
    ).toBe(1);
  });

  it('P102-010 — CONCURRENT Start Free Trial requests produce exactly one trial', async () => {
    const email = uniqueTestEmail('p102-010');
    const { token } = await signUp(email);
    const stamp = Date.now();

    // Two organizations, six simultaneous redemption attempts across
    // them. Nothing in the path holds an application-level lock.
    const orgA = await createOrganization(token, `P102-010 a ${stamp}`).expect(201);
    const orgB = await createOrganization(token, `P102-010 b ${stamp}`).expect(201);

    const responses = await Promise.all([
      startTrial(token, orgA.body.id),
      startTrial(token, orgA.body.id),
      startTrial(token, orgA.body.id),
      startTrial(token, orgB.body.id),
      startTrial(token, orgB.body.id),
      startTrial(token, orgB.body.id),
    ]);

    const started = responses.filter((r) => r.status === 200 && r.body.started === true);
    expect(started).toHaveLength(1);

    expect(
      await admin.trialRedemption.count({
        where: { subjectHash: trialSubjectHash(email) },
      }),
    ).toBe(1);

    const usable = await Promise.all([
      hasUsableTrial(orgA.body.id),
      hasUsableTrial(orgB.body.id),
    ]);
    expect(usable.filter(Boolean)).toHaveLength(1);
  });

  it('P102-011 — changing device, IP and network does not restore eligibility', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-011'));
    const stamp = Date.now();

    const first = await createOrganization(token, `P102-011 a ${stamp}`).expect(201);
    await startTrial(token, first.body.id).expect(200);

    const second = await createOrganization(token, `P102-011 b ${stamp}`).expect(201);
    const evasive = await request(app.getHttpServer())
      .post(`/organizations/${second.body.id}/subscription/trial`)
      .set('Authorization', `Bearer ${token}`)
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari/604.1')
      .set('CF-Connecting-IP', '198.51.100.99')
      .set('X-Forwarded-For', '203.0.113.5')
      .send({ confirm: true })
      .expect(200);

    expect(evasive.body.started).toBe(false);
    expect(await hasUsableTrial(second.body.id)).toBe(false);
  });

  it('P102-012 — a forged payload cannot grant a longer or unearned trial', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-012'));
    const org = await createOrganization(token, `P102-012 ${Date.now()}`).expect(201);

    const forged = await startTrial(token, org.body.id, {
      confirm: true,
      trialEndsAt: new Date(Date.now() + 999 * 86_400_000).toISOString(),
      durationDays: 999,
    });

    // `forbidNonWhitelisted` rejects the unknown properties outright.
    expect(forged.status).toBe(400);
    expect(await hasUsableTrial(org.body.id)).toBe(false);
  });

  // ---------------------------------------------------------------
  // Trial cancellation
  // ---------------------------------------------------------------

  it('P102-013 — cancelling a trial ends it immediately and records the reason', async () => {
    const { token, userId } = await signUp(uniqueTestEmail('p102-013'));
    const org = await createOrganization(token, `P102-013 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    const response = await cancelTrial(token, org.body.id, {
      confirm: true,
      reason: 'too_expensive',
      feedback: 'Great product, wrong budget cycle.',
    }).expect(200);

    expect(response.body.cancelled).toBe(true);
    expect(await hasUsableTrial(org.body.id)).toBe(false);
    expect((await subscriptionOf(org.body.id))?.status).toBe('cancelled');

    const record = await admin.subscriptionCancellation.findFirst({
      where: { organizationId: org.body.id, kind: 'trial' },
    });
    expect(record?.reason).toBe('too_expensive');
    expect(record?.feedback).toBe('Great product, wrong budget cycle.');
    expect(record?.cancelledByUserId).toBe(userId);
  });

  it('P102-014 — feedback is optional; cancelling without it works', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-014'));
    const org = await createOrganization(token, `P102-014 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    await cancelTrial(token, org.body.id, {
      confirm: true,
      reason: 'not_using_it',
    }).expect(200);

    const record = await admin.subscriptionCancellation.findFirstOrThrow({
      where: { organizationId: org.body.id, kind: 'trial' },
    });
    expect(record.feedback).toBeNull();
  });

  it('P102-015 — an unrecognised cancellation reason is rejected', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-015'));
    const org = await createOrganization(token, `P102-015 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    await cancelTrial(token, org.body.id, {
      confirm: true,
      reason: 'because-i-said-so',
    }).expect(400);
  });

  it('P102-016 — cancellation requires explicit confirmation', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-016'));
    const org = await createOrganization(token, `P102-016 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    await cancelTrial(token, org.body.id, { reason: 'not_using_it' }).expect(400);
    expect(await hasUsableTrial(org.body.id)).toBe(true);
  });

  it('P102-017 — cancelling twice is idempotent, not an error', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-017'));
    const org = await createOrganization(token, `P102-017 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    const first = await cancelTrial(token, org.body.id, {
      confirm: true,
      reason: 'not_using_it',
    }).expect(200);
    const second = await cancelTrial(token, org.body.id, {
      confirm: true,
      reason: 'too_expensive',
    }).expect(200);

    expect(first.body.alreadyCancelled).toBe(false);
    expect(second.body.alreadyCancelled).toBe(true);

    // Exactly one record, and the FIRST reason is the one kept.
    const records = await admin.subscriptionCancellation.findMany({
      where: { organizationId: org.body.id, kind: 'trial' },
    });
    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe('not_using_it');
  });

  it('P102-018 — CONCURRENT cancellations produce exactly one record', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-018'));
    const org = await createOrganization(token, `P102-018 ${Date.now()}`).expect(201);
    await startTrial(token, org.body.id).expect(200);

    await Promise.all(
      Array.from({ length: 5 }, () =>
        cancelTrial(token, org.body.id, { confirm: true, reason: 'not_using_it' }),
      ),
    );

    const records = await admin.subscriptionCancellation.findMany({
      where: { organizationId: org.body.id, kind: 'trial' },
    });
    expect(records).toHaveLength(1);
  });

  it('P102-019 — a CANCELLED trial can never be redeemed again', async () => {
    // The rule that must never break: leaving does not earn you another
    // free go.
    const email = uniqueTestEmail('p102-019');
    const { token } = await signUp(email);
    const stamp = Date.now();

    const first = await createOrganization(token, `P102-019 a ${stamp}`).expect(201);
    await startTrial(token, first.body.id).expect(200);
    await cancelTrial(token, first.body.id, {
      confirm: true,
      reason: 'switching_provider',
    }).expect(200);

    // Same organization...
    const retry = await startTrial(token, first.body.id).expect(200);
    expect(retry.body.started).toBe(false);

    // ...and a brand-new one.
    const second = await createOrganization(token, `P102-019 b ${stamp}`).expect(201);
    const attempt = await startTrial(token, second.body.id).expect(200);
    expect(attempt.body.started).toBe(false);
    expect(await hasUsableTrial(second.body.id)).toBe(false);

    // The redemption survived the cancellation untouched.
    expect(
      await admin.trialRedemption.count({
        where: { subjectHash: trialSubjectHash(email) },
      }),
    ).toBe(1);
  });

  it('P102-020 — an EXPIRED trial cannot be redeemed again', async () => {
    const email = uniqueTestEmail('p102-020');
    const { token } = await signUp(email);
    const stamp = Date.now();

    const first = await createOrganization(token, `P102-020 a ${stamp}`).expect(201);
    await startTrial(token, first.body.id).expect(200);
    await admin.tenantSubscription.update({
      where: { organizationId: first.body.id },
      data: { status: 'expired', trialEndsAt: new Date(Date.now() - 86_400_000) },
    });

    const second = await createOrganization(token, `P102-020 b ${stamp}`).expect(201);
    const attempt = await startTrial(token, second.body.id).expect(200);
    expect(attempt.body.started).toBe(false);
  });

  // ---------------------------------------------------------------
  // Paid subscription cancellation
  // ---------------------------------------------------------------

  it('P102-021 — cancelling a paid subscription honours the period already paid for', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-021'));
    const org = await createOrganization(token, `P102-021 ${Date.now()}`).expect(201);

    const periodEnd = new Date(Date.now() + 20 * 86_400_000);
    await admin.tenantSubscription.update({
      where: { organizationId: org.body.id },
      data: { status: 'active', currentPeriodEnd: periodEnd, trialEndsAt: null },
    });

    const response = await cancelSubscription(token, org.body.id, {
      confirm: true,
      reason: 'too_expensive',
    }).expect(200);

    expect(response.body.cancelled).toBe(true);
    // Effective at period end, NOT immediately — paid time is not forfeited.
    expect(new Date(response.body.effectiveAt).getTime()).toBe(periodEnd.getTime());

    const subscription = await subscriptionOf(org.body.id);
    expect(subscription?.cancelAtPeriodEnd).toBe(true);
    // Still active until the period actually ends.
    expect(subscription?.status).toBe('active');
  });

  it('P102-022 — paid cancellation is idempotent', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-022'));
    const org = await createOrganization(token, `P102-022 ${Date.now()}`).expect(201);
    await admin.tenantSubscription.update({
      where: { organizationId: org.body.id },
      data: {
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
      },
    });

    await cancelSubscription(token, org.body.id, {
      confirm: true,
      reason: 'not_using_it',
    }).expect(200);
    const second = await cancelSubscription(token, org.body.id, {
      confirm: true,
      reason: 'not_using_it',
    }).expect(200);

    expect(second.body.alreadyCancelled).toBe(true);
    expect(
      await admin.subscriptionCancellation.count({
        where: { organizationId: org.body.id, kind: 'paid' },
      }),
    ).toBe(1);
  });

  it('P102-023 — cancelling a paid subscription does not restore trial eligibility', async () => {
    const email = uniqueTestEmail('p102-023');
    const { token } = await signUp(email);
    const stamp = Date.now();

    const org = await createOrganization(token, `P102-023 a ${stamp}`).expect(201);
    await startTrial(token, org.body.id).expect(200);
    await admin.tenantSubscription.update({
      where: { organizationId: org.body.id },
      data: {
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000),
      },
    });
    await cancelSubscription(token, org.body.id, {
      confirm: true,
      reason: 'too_expensive',
    }).expect(200);

    const another = await createOrganization(token, `P102-023 b ${stamp}`).expect(201);
    const attempt = await startTrial(token, another.body.id).expect(200);
    expect(attempt.body.started).toBe(false);
  });

  // ---------------------------------------------------------------
  // Authorization
  // ---------------------------------------------------------------

  it("P102-024 — a non-member cannot start or cancel another organization's billing", async () => {
    const ownerAuth = await signUp(uniqueTestEmail('p102-024-owner'));
    const org = await createOrganization(
      ownerAuth.token,
      `P102-024 ${Date.now()}`,
    ).expect(201);

    const outsider = await signUp(uniqueTestEmail('p102-024-outsider'));

    // Cross-organization access is refused outright.
    const start = await startTrial(outsider.token, org.body.id);
    expect([403, 404]).toContain(start.status);

    const cancel = await cancelTrial(outsider.token, org.body.id, {
      confirm: true,
      reason: 'not_using_it',
    });
    expect([403, 404]).toContain(cancel.status);

    expect(await hasUsableTrial(org.body.id)).toBe(false);
  });

  it('P102-025 — an unauthenticated caller cannot reach any billing mutation', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-025'));
    const org = await createOrganization(token, `P102-025 ${Date.now()}`).expect(201);

    await request(app.getHttpServer())
      .post(`/organizations/${org.body.id}/subscription/trial`)
      .send({ confirm: true })
      .expect(401);
    await request(app.getHttpServer())
      .post(`/organizations/${org.body.id}/subscription/cancel`)
      .send({ confirm: true, reason: 'not_using_it' })
      .expect(401);
  });

  it('P102-026 — the admin dashboard is refused to non-platform-owners and returns real data to owners', async () => {
    const { token } = await signUp(uniqueTestEmail('p102-026-tenant'));

    // An ordinary Organization Owner is NOT a platform admin.
    await request(app.getHttpServer())
      .get('/platform/subscriptions/overview')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);

    // Unauthenticated is refused too.
    await request(app.getHttpServer())
      .get('/platform/subscriptions/overview')
      .expect(401);

    // A real platform owner sees real aggregates.
    const adminAuth = await signUp(uniqueTestEmail('p102-026-admin'));
    await admin.user.update({
      where: { id: adminAuth.userId },
      data: { isPlatformOwner: true },
    });
    const fresh = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: (await admin.user.findUniqueOrThrow({ where: { id: adminAuth.userId } }))
          .email,
        password: PASSWORD,
      })
      .expect(200);

    const overview = await request(app.getHttpServer())
      .get('/platform/subscriptions/overview')
      .set('Authorization', `Bearer ${fresh.body.accessToken}`)
      .expect(200);

    expect(typeof overview.body.organizations).toBe('number');
    expect(overview.body.organizations).toBeGreaterThan(0);
    expect(typeof overview.body.trials.everRedeemed).toBe('number');
    expect(Array.isArray(overview.body.plans)).toBe(true);
    // Revenue is reported as untracked, never fabricated.
    expect(overview.body.revenue).toEqual({ tracked: false });
    // Cancellation rows carry no email addresses.
    expect(JSON.stringify(overview.body)).not.toContain('@atlas.test');
  });
});
