/**
 * Expiry enforcement — a PAID subscription actually ends (e2e, fake clock).
 *
 * THE DEFECT THIS GUARDS AGAINST. Before this work nothing read
 * `currentPeriodEnd`: an `active` row kept full access forever, the sweep
 * only ever expired trials, `cancelAtPeriodEnd` was recorded and never
 * acted on, and `grace_period` was never entered. Trials were protected by
 * a live clock check; paid periods were not.
 *
 * DEFENCE IN DEPTH, ASSERTED SEPARATELY:
 *   1. The LIVE decision — every mutation and the lifecycle read derive
 *      the effective status from the row + the clock, so the sweep NOT
 *      having run is never a way through.
 *   2. The SWEEP — persists the same transitions (`grace_period`,
 *      `cancelled`, `expired`), writes the audit trail, invalidates the
 *      public serving cache, and is idempotent.
 *   3. RENEWAL — a payment before the period ends EXTENDS from
 *      `currentPeriodEnd`; after expiry it RESTARTS from now.
 *
 * THE CLOCK. `PLANS_CLOCK` is the plans module's one source of "now" for
 * access decisions, the sweep and renewal arithmetic. Overridden here with
 * a pinnable clock so a test can stand exactly 1 ms either side of a
 * period end and "wait out" a grace window without sleeping. Everything
 * else — JWTs, sessions, Postgres defaults — runs on real time, which is
 * also what makes the "stale session" case genuine: the token really was
 * minted before the subscription ended.
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
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import { PLANS_CLOCK, type Clock } from '../src/plans/utils/clock';
import {
  SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS,
  SubscriptionExpiryService,
} from '../src/plans/services/subscription-expiry.service';
import { PublicWebsiteCacheService } from '../src/public-website/services/public-website-cache.service';
import { GRACE_PERIOD_MS } from '../src/plans/queue/subscription-sweep.types';

const DAY = 24 * 60 * 60 * 1000;
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** Real time until pinned; pinned time until reset. */
class FakeClock implements Clock {
  private fixed: Date | null = null;
  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }
  set(at: Date): void {
    this.fixed = new Date(at);
  }
  reset(): void {
    this.fixed = null;
  }
}

/** Mirrors `addPeriod` in `payment-application.service.ts` for a monthly cycle. */
function plusOneMonth(start: Date): Date {
  const end = new Date(start);
  end.setMonth(end.getMonth() + 1);
  return end;
}

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
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
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('P64 communications — subscription expiry enforcement (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let expiryService: SubscriptionExpiryService;
  let servingCache: PublicWebsiteCacheService;
  let reviewer: { userId: string; accessToken: string };
  const clock = new FakeClock();

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) => builder.overrideProvider(PLANS_CLOCK).useValue(clock),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    expiryService = app.get(SubscriptionExpiryService);
    servingCache = app.get(PublicWebsiteCacheService);

    // The sweep runs under a real platform owner; approvals need one too.
    reviewer = await signUpAndSignIn(app, 'expiry-reviewer');
    await admin.user.update({
      where: { id: reviewer.userId },
      data: { isPlatformOwner: true },
    });
  });

  afterAll(async () => {
    clock.reset();
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    clock.reset();
    await flushRateLimitKeys();
  });

  // --- fixtures -------------------------------------------------------------

  async function seedTenant(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const subscription = await seedActiveSubscriptionForOrg(
      admin,
      org.id,
      `${label}-plan`,
    );
    const plan = await admin.plan.findUniqueOrThrow({
      where: { id: subscription.planId },
    });

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    return { owner, org, academy, plan, page: pages.body.items[0] };
  }

  async function setSubscription(
    organizationId: string,
    data: {
      status?: 'trialing' | 'active' | 'grace_period' | 'expired' | 'cancelled';
      trialEndsAt?: Date | null;
      currentPeriodStart?: Date | null;
      currentPeriodEnd?: Date | null;
      graceEndsAt?: Date | null;
      cancelAtPeriodEnd?: boolean;
    },
  ) {
    return admin.tenantSubscription.update({ where: { organizationId }, data });
  }

  function subscriptionRow(organizationId: string) {
    return admin.tenantSubscription.findUniqueOrThrow({ where: { organizationId } });
  }

  async function pageVersion(academyId: string, pageId: string, token: string) {
    const res = await request(app.getHttpServer())
      .get(`/academies/${academyId}/website/pages/${pageId}`)
      .set('Authorization', `Bearer ${token}`);
    return res.body.version as number;
  }

  /** The representative gated mutation — a website page edit through the global interceptor. */
  async function tryMutation(
    t: { owner: { accessToken: string }; academy: { id: string }; page: { id: string } },
    title: string,
  ) {
    return request(app.getHttpServer())
      .patch(`/academies/${t.academy.id}/website/pages/${t.page.id}`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .send({
        title,
        expectedVersion: await pageVersion(t.academy.id, t.page.id, t.owner.accessToken),
      });
  }

  async function lifecycle(orgId: string, token: string) {
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgId}/subscription/lifecycle`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body;
  }

  async function publishSite(t: {
    owner: { accessToken: string };
    academy: { id: string };
    page: { id: string };
  }) {
    await request(app.getHttpServer())
      .patch(`/academies/${t.academy.id}/website/pages/${t.page.id}`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .send({
        visible: true,
        sections: [
          {
            id: 'sec-hero',
            type: 'hero',
            enabled: true,
            visibility: { desktop: true, tablet: true, mobile: true },
            config: { title: 'Welcome' },
          },
        ],
        expectedVersion: await pageVersion(t.academy.id, t.page.id, t.owner.accessToken),
      })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/academies/${t.academy.id}/website/publish`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .expect(201);
  }

  function publicSite(academyId: string) {
    return request(app.getHttpServer()).get(`/public/websites/${academyId}`);
  }

  /** A real renewal: checkout -> payment -> proof -> platform-owner approval. */
  async function renew(t: {
    owner: { accessToken: string };
    org: { id: string };
    plan: { key: string };
  }) {
    const method = await seedPaymentMethod(admin, 'expiry-method');
    const checkout = await request(app.getHttpServer())
      .post(`/organizations/${t.org.id}/checkouts`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: t.plan.key },
        billingCycle: 'monthly',
        idempotencyKey: `expiry-renew-${Date.now()}-${Math.random()}`,
      })
      .expect(201);
    const payment = await request(app.getHttpServer())
      .post(`/organizations/${t.org.id}/payments`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .send({ checkoutId: checkout.body.id, methodKey: method.key })
      .expect(201);
    await request(app.getHttpServer())
      .patch(`/organizations/${t.org.id}/payments/${payment.body.id}/proof`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .send({ fileData: PROOF_DATA_URL, fileName: 'proof.png', mimeType: 'image/png' })
      .expect(200);
    await request(app.getHttpServer())
      .post(`/payments/${payment.body.id}/approve`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ notes: 'renewal' })
      .expect(201);
  }

  function auditEntries(organizationId: string, action: string) {
    return admin.auditLogEntry.findMany({ where: { organizationId, action } });
  }

  // --- 1. Live decisions: the sweep is never what enforces ------------------

  it('an active trial works, and reports when access ends', async () => {
    const t = await seedTenant('exp-trial-live');
    const trialEndsAt = new Date(clock.now().getTime() + 2 * DAY);
    await setSubscription(t.org.id, { status: 'trialing', trialEndsAt });

    expect((await tryMutation(t, 'During trial')).status).toBe(200);

    const state = await lifecycle(t.org.id, t.owner.accessToken);
    expect(state).toMatchObject({
      lifecycle: 'trialing',
      hasAccess: true,
      status: 'trialing',
      effectiveStatus: 'trialing',
      accessEndsAt: trialEndsAt.toISOString(),
    });
  });

  it('an expired trial is refused on the clock alone (sweep not run)', async () => {
    const t = await seedTenant('exp-trial-over');
    const trialEndsAt = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'trialing', trialEndsAt });
    clock.set(new Date(trialEndsAt.getTime() + 1));

    const refused = await tryMutation(t, 'After trial');
    expect(refused.status).toBe(403);
    expect(refused.body.error.details.reason).toBe('trial_ended');

    const state = await lifecycle(t.org.id, t.owner.accessToken);
    expect(state).toMatchObject({
      lifecycle: 'trial_expired',
      hasAccess: false,
      status: 'trialing',
      effectiveStatus: 'trial_expired',
    });
    expect(state.accessEndsAt).toBeUndefined();
  });

  it('an active paid subscription works, and access ends at the grace end if never renewed', async () => {
    const t = await seedTenant('exp-paid-live');
    const now = clock.now();
    const periodEnd = new Date(now.getTime() + 20 * DAY);
    await setSubscription(t.org.id, {
      status: 'active',
      currentPeriodStart: new Date(now.getTime() - 10 * DAY),
      currentPeriodEnd: periodEnd,
    });

    expect((await tryMutation(t, 'Paid and current')).status).toBe(200);

    const state = await lifecycle(t.org.id, t.owner.accessToken);
    expect(state).toMatchObject({
      lifecycle: 'active',
      hasAccess: true,
      status: 'active',
      effectiveStatus: 'active',
      currentPeriodEnd: periodEnd.toISOString(),
      accessEndsAt: new Date(periodEnd.getTime() + GRACE_PERIOD_MS).toISOString(),
    });
    expect(state.graceEndsAt).toBeUndefined();
  });

  it('an expired paid subscription is refused even though the row still says active and the sweep never ran', async () => {
    const t = await seedTenant('exp-paid-over');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });

    clock.set(new Date(periodEnd.getTime() + GRACE_PERIOD_MS + DAY));

    const refused = await tryMutation(t, 'Long after the period');
    expect(refused.status).toBe(403);
    expect(refused.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(refused.body.error.details.reason).toBe('expired');

    // Nothing persisted — this is the live decision alone.
    expect((await subscriptionRow(t.org.id)).status).toBe('active');

    const state = await lifecycle(t.org.id, t.owner.accessToken);
    expect(state).toMatchObject({
      lifecycle: 'expired',
      hasAccess: false,
      status: 'active',
      effectiveStatus: 'expired',
      graceEndsAt: new Date(periodEnd.getTime() + GRACE_PERIOD_MS).toISOString(),
    });
    expect(state.accessEndsAt).toBeUndefined();

    // Reads stay open — the data is still there.
    await request(app.getHttpServer())
      .get(`/academies/${t.academy.id}/website/pages`)
      .set('Authorization', `Bearer ${t.owner.accessToken}`)
      .expect(200);
  });

  it('a session minted before expiry is refused after it — the token is not the entitlement', async () => {
    const t = await seedTenant('exp-stale-session');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });

    // Same token, before: allowed.
    expect((await tryMutation(t, 'Before')).status).toBe(200);

    // Same token, after the grace window: refused, no re-login involved.
    clock.set(new Date(periodEnd.getTime() + GRACE_PERIOD_MS));
    expect((await tryMutation(t, 'After')).status).toBe(403);
  });

  it('stands exactly at the boundaries: 1 ms before/at/after currentPeriodEnd and the grace end', async () => {
    const t = await seedTenant('exp-boundary');
    const periodEnd = new Date(clock.now().getTime() + 3 * DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    const graceEnd = new Date(periodEnd.getTime() + GRACE_PERIOD_MS);

    clock.set(new Date(periodEnd.getTime() - 1));
    expect((await tryMutation(t, '-1ms')).status).toBe(200);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'active',
      effectiveStatus: 'active',
    });

    clock.set(periodEnd);
    expect((await tryMutation(t, 'at period end')).status).toBe(200);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'grace_period',
      hasAccess: true,
      status: 'active',
      effectiveStatus: 'grace_period',
      graceEndsAt: graceEnd.toISOString(),
      accessEndsAt: graceEnd.toISOString(),
    });

    clock.set(new Date(periodEnd.getTime() + 1));
    expect((await tryMutation(t, '+1ms')).status).toBe(200);
    expect((await lifecycle(t.org.id, t.owner.accessToken)).lifecycle).toBe(
      'grace_period',
    );

    clock.set(new Date(graceEnd.getTime() - 1));
    expect((await tryMutation(t, 'grace -1ms')).status).toBe(200);

    clock.set(graceEnd);
    const atGraceEnd = await tryMutation(t, 'grace end');
    expect(atGraceEnd.status).toBe(403);
    expect(atGraceEnd.body.error.details.reason).toBe('expired');

    clock.set(new Date(graceEnd.getTime() + 1));
    expect((await tryMutation(t, 'grace +1ms')).status).toBe(403);
  });

  it('cancel-at-period-end ends access AT the period end with no grace — live, before any sweep', async () => {
    const t = await seedTenant('exp-cancel-live');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, {
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });

    clock.set(new Date(periodEnd.getTime() - 1));
    expect((await tryMutation(t, 'still paid for')).status).toBe(200);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'cancelled_active',
      accessEndsAt: periodEnd.toISOString(),
    });

    clock.set(periodEnd);
    expect((await tryMutation(t, 'cancelled')).status).toBe(403);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'expired',
      hasAccess: false,
      effectiveStatus: 'cancelled',
    });
  });

  // --- 2. The sweep: durable, audited, cache-invalidating, idempotent ------

  it('sweep: active -> grace_period at period end, then -> expired at grace end; the public site is served during grace and not after', async () => {
    const t = await seedTenant('exp-sweep-grace');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    await publishSite(t);
    expect((await publicSite(t.academy.id)).status).toBe(200);

    // Period ends: the sweep persists grace.
    clock.set(new Date(periodEnd.getTime() + 60_000));
    // Counters are PLATFORM-WIDE (the shared dev database holds other
    // suites' leftover rows), so the row and its audit trail are what is
    // asserted exactly; the counter only has to include this tenant.
    const first = await expiryService.expireDuePaidPeriods();
    expect(first.graceStarted).toBeGreaterThanOrEqual(1);

    const graceRow = await subscriptionRow(t.org.id);
    expect(graceRow.status).toBe('grace_period');
    expect(graceRow.graceEndsAt).toEqual(new Date(periodEnd.getTime() + GRACE_PERIOD_MS));
    expect(
      await auditEntries(t.org.id, SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.graceStarted),
    ).toHaveLength(1);

    // Still working, still served, and the lifecycle says so.
    expect((await tryMutation(t, 'during grace')).status).toBe(200);
    expect((await publicSite(t.academy.id)).status).toBe(200);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'grace_period',
      status: 'grace_period',
      effectiveStatus: 'grace_period',
      graceEndsAt: graceRow.graceEndsAt!.toISOString(),
    });

    // Grace ends: the sweep persists expiry and the site goes dark.
    clock.set(new Date(graceRow.graceEndsAt!.getTime() + 60_000));
    const second = await expiryService.expireDuePaidPeriods();
    expect(second.expired).toBeGreaterThanOrEqual(1);

    const expiredRow = await subscriptionRow(t.org.id);
    expect(expiredRow.status).toBe('expired');
    expect(expiredRow.graceEndsAt).toEqual(graceRow.graceEndsAt);
    expect(expiredRow.trialEndsAt).toBeNull();
    expect(
      await auditEntries(t.org.id, SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.expired),
    ).toHaveLength(1);

    expect((await tryMutation(t, 'after grace')).status).toBe(403);
    expect((await publicSite(t.academy.id)).status).toBe(404);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'expired',
      status: 'expired',
      effectiveStatus: 'expired',
    });
  });

  it('sweep: invalidates a stale serving-eligibility cache, so a cached "served" answer does not outlive expiry', async () => {
    const t = await seedTenant('exp-sweep-cache');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    await publishSite(t);

    // A public read caches "eligible" for the TTL.
    expect((await publicSite(t.academy.id)).status).toBe(200);
    expect(await servingCache.getServingEligibility(t.org.id)).toBe(true);

    // Straight past the grace window without any intermediate tick — a
    // sweep that has been down for over a week must still get it right.
    clock.set(new Date(periodEnd.getTime() + GRACE_PERIOD_MS + DAY));
    expect((await expiryService.expireDuePaidPeriods()).expired).toBeGreaterThanOrEqual(
      1,
    );

    expect(await servingCache.getServingEligibility(t.org.id)).toBeUndefined();
    expect((await publicSite(t.academy.id)).status).toBe(404);
    expect(await servingCache.getServingEligibility(t.org.id)).toBe(false);
    expect((await subscriptionRow(t.org.id)).status).toBe('expired');
  });

  it('sweep: cancelAtPeriodEnd -> cancelled at period end, no grace, audited', async () => {
    const t = await seedTenant('exp-sweep-cancel');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, {
      status: 'active',
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    await publishSite(t);
    expect((await publicSite(t.academy.id)).status).toBe(200);

    clock.set(new Date(periodEnd.getTime() + 1));
    expect((await expiryService.expireDuePaidPeriods()).cancelled).toBeGreaterThanOrEqual(
      1,
    );

    const row = await subscriptionRow(t.org.id);
    expect(row.status).toBe('cancelled');
    expect(row.graceEndsAt).toBeNull();
    expect(
      await auditEntries(
        t.org.id,
        SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.cancelledAtPeriodEnd,
      ),
    ).toHaveLength(1);
    expect(
      await auditEntries(t.org.id, SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.graceStarted),
    ).toHaveLength(0);

    expect((await tryMutation(t, 'cancelled')).status).toBe(403);
    expect((await publicSite(t.academy.id)).status).toBe(404);
  });

  it('sweep: running twice is idempotent — no second transition, no duplicate audit entries', async () => {
    const t = await seedTenant('exp-sweep-twice');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });

    clock.set(new Date(periodEnd.getTime() + 1));
    await expiryService.expireDuePaidPeriods();
    const again = await expiryService.expireDuePaidPeriods();
    expect(again).toEqual({ graceStarted: 0, cancelled: 0, expired: 0 });

    expect((await subscriptionRow(t.org.id)).status).toBe('grace_period');
    expect(
      await auditEntries(t.org.id, SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.graceStarted),
    ).toHaveLength(1);

    // And again after grace: exactly one expiry.
    clock.set(new Date(periodEnd.getTime() + GRACE_PERIOD_MS + 1));
    await expiryService.expireDuePaidPeriods();
    const afterExpiry = await expiryService.expireDuePaidPeriods();
    expect(afterExpiry).toEqual({ graceStarted: 0, cancelled: 0, expired: 0 });
    expect(
      await auditEntries(t.org.id, SUBSCRIPTION_EXPIRY_AUDIT_ACTIONS.expired),
    ).toHaveLength(1);
  });

  it('sweep: not running it changes nothing about enforcement — refusal happens regardless', async () => {
    const t = await seedTenant('exp-no-sweep');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    await publishSite(t);

    clock.set(new Date(periodEnd.getTime() + GRACE_PERIOD_MS + 1));

    expect((await tryMutation(t, 'no sweep')).status).toBe(403);
    // A fresh public read (no cache yet for this org) is also refused.
    await servingCache.invalidateServingEligibility(t.org.id);
    expect((await publicSite(t.academy.id)).status).toBe(404);
    expect((await subscriptionRow(t.org.id)).status).toBe('active');
  });

  // --- 3. Renewal ------------------------------------------------------------

  it('renewal BEFORE expiry extends from currentPeriodEnd — early payment forfeits nothing', async () => {
    const t = await seedTenant('exp-renew-early');
    const now = clock.now();
    const periodEnd = new Date(now.getTime() + 10 * DAY);
    await setSubscription(t.org.id, {
      status: 'active',
      currentPeriodStart: new Date(now.getTime() - 20 * DAY),
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: true,
    });
    clock.set(now);

    await renew(t);

    const row = await subscriptionRow(t.org.id);
    expect(row.status).toBe('active');
    expect(row.currentPeriodStart).toEqual(periodEnd);
    expect(row.currentPeriodEnd).toEqual(plusOneMonth(periodEnd));
    expect(row.cancelAtPeriodEnd).toBe(false);
    expect(row.graceEndsAt).toBeNull();
    expect(row.grantedLimits).not.toBeNull();
  });

  it('renewal DURING grace (period already ended) restarts from now', async () => {
    const t = await seedTenant('exp-renew-grace');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    const renewAt = new Date(periodEnd.getTime() + 2 * DAY);
    clock.set(renewAt);
    await expiryService.expireDuePaidPeriods();
    expect((await subscriptionRow(t.org.id)).status).toBe('grace_period');

    await renew(t);

    const row = await subscriptionRow(t.org.id);
    expect(row.status).toBe('active');
    expect(row.currentPeriodStart).toEqual(renewAt);
    expect(row.currentPeriodEnd).toEqual(plusOneMonth(renewAt));
    expect(row.graceEndsAt).toBeNull();
    expect((await tryMutation(t, 'renewed')).status).toBe(200);
  });

  it('renewal AFTER expiry restarts from now and restores access and serving', async () => {
    const t = await seedTenant('exp-renew-late');
    const periodEnd = new Date(clock.now().getTime() + DAY);
    await setSubscription(t.org.id, { status: 'active', currentPeriodEnd: periodEnd });
    await publishSite(t);

    const renewAt = new Date(periodEnd.getTime() + GRACE_PERIOD_MS + 5 * DAY);
    clock.set(renewAt);
    await expiryService.expireDuePaidPeriods();
    expect((await subscriptionRow(t.org.id)).status).toBe('expired');
    expect((await tryMutation(t, 'expired')).status).toBe(403);
    expect((await publicSite(t.academy.id)).status).toBe(404);

    await renew(t);

    const row = await subscriptionRow(t.org.id);
    expect(row.status).toBe('active');
    expect(row.currentPeriodStart).toEqual(renewAt);
    expect(row.currentPeriodEnd).toEqual(plusOneMonth(renewAt));
    expect(row.graceEndsAt).toBeNull();
    expect(row.cancelAtPeriodEnd).toBe(false);

    expect((await tryMutation(t, 'renewed')).status).toBe(200);
    // Approval invalidates the serving cache after commit, so the site is back at once.
    expect((await publicSite(t.academy.id)).status).toBe(200);
    expect(await lifecycle(t.org.id, t.owner.accessToken)).toMatchObject({
      lifecycle: 'active',
      effectiveStatus: 'active',
    });
  });
});
