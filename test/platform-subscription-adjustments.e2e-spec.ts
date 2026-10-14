/**
 * B0-BIL-06 — the Platform Owner's audited subscription remedies: extend,
 * grant days and change plan. Platform Owner only, a written reason every
 * time, one audit row per action, and the subscription sweep honours the
 * new dates.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { Plan, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import { SubscriptionExpiryService } from '../src/plans/services/subscription-expiry.service';

jest.setTimeout(90000);

const DAY = 24 * 60 * 60 * 1000;
const REASON = 'Founding academy pilot agreed on WhatsApp';

interface Account {
  readonly userId: string;
  readonly accessToken: string;
}

describe('Platform subscription adjustments (e2e) — B0-BIL-06', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let platformOwner: Account;
  let plan: Plan;
  let hiddenPlan: Plan;
  let archivedPlan: Plan;

  async function signUp(label: string): Promise<Account> {
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
      accessToken: signIn.body.accessToken as string,
    };
  }

  async function seedPlan(
    label: string,
    students: number,
    extra: { displayOrder?: number; status?: 'active' | 'archived' } = {},
  ): Promise<Plan> {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        limits: {
          academies: 1,
          students,
          instructors: 3,
          staff: 3,
          courses: 20,
          generalStorage: 10,
          videoStorage: 30,
        },
        features: { liveSessions: false },
        pricing: { amount: 1190, currency: 'EGP', billingCycle: 'monthly' },
        ...extra,
      },
    });
  }

  async function organization(
    label: string,
    data: {
      status: 'trialing' | 'active' | 'grace_period' | 'expired';
      end: Date;
    },
  ) {
    await flush();
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await admin.tenantSubscription.create({
      data: {
        organizationId: org.id,
        planId: plan.id,
        status: data.status,
        billingCycle: data.status === 'trialing' ? null : 'monthly',
        grantedLimits: plan.limits as object,
        ...(data.status === 'trialing'
          ? { trialEndsAt: data.end }
          : {
              currentPeriodStart: new Date(data.end.getTime() - 30 * DAY),
              currentPeriodEnd: data.end,
            }),
        ...(data.status === 'grace_period'
          ? { graceEndsAt: new Date(data.end.getTime() + 7 * DAY) }
          : {}),
      },
    });
    return { owner, orgId: org.id };
  }

  const post = (token: string, path: string, body: object) =>
    request(app.getHttpServer())
      .post(`/platform-subscriptions/${path}`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);

  const lastAudit = (orgId: string, action: string) =>
    admin.auditLogEntry.findFirst({
      where: { targetId: orgId, action },
      orderBy: { occurredAt: 'desc' },
    });

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flush = testApp.flushRateLimitKeys;
    platformOwner = await signUp('bil06-platform-owner');
    await admin.user.update({
      where: { id: platformOwner.userId },
      data: { isPlatformOwner: true },
    });
    plan = await seedPlan('bil06-plan', 100);
    hiddenPlan = await seedPlan('bil06-founding', 400, { displayOrder: 0 });
    archivedPlan = await seedPlan('bil06-archived', 100, { status: 'archived' });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  it('refuses everyone but a Platform Owner, and changes nothing', async () => {
    const { owner, orgId } = await organization('bil06-guard', {
      status: 'active',
      end: new Date(Date.now() + 10 * DAY),
    });
    for (const path of ['extend', 'grant-days']) {
      await post(owner.accessToken, `${orgId}/${path}`, {
        days: 5,
        reason: REASON,
      }).expect(403);
    }
    await post(owner.accessToken, `${orgId}/change-plan`, {
      planKey: hiddenPlan.key,
      applyAt: 'now',
      reason: REASON,
    }).expect(403);
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    expect(row.planId).toBe(plan.id);
    expect(await lastAudit(orgId, 'subscription.extended_by_platform')).toBeNull();
  });

  it('requires a written reason and a day count between 1 and 365', async () => {
    const { orgId } = await organization('bil06-validation', {
      status: 'active',
      end: new Date(Date.now() + 10 * DAY),
    });
    await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: 5,
      reason: 'short',
    }).expect(400);
    await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: -5,
      reason: REASON,
    }).expect(400);
    await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: 366,
      reason: REASON,
    }).expect(400);
  });

  it('extends a lapsed trial from now, audits it, and the sweep keeps it trialing', async () => {
    const { orgId } = await organization('bil06-trial', {
      status: 'trialing',
      end: new Date(Date.now() - DAY),
    });
    const before = Date.now();
    const res = await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: 10,
      reason: REASON,
    }).expect(200);

    const trialEndsAt = new Date(res.body.trialEndsAt).getTime();
    expect(trialEndsAt).toBeGreaterThanOrEqual(before + 10 * DAY);
    expect(trialEndsAt).toBeLessThan(before + 10 * DAY + 60_000);

    const audit = await lastAudit(orgId, 'subscription.extended_by_platform');
    expect(audit?.actorUserId).toBe(platformOwner.userId);
    expect(audit?.context).toMatchObject({
      days: 10,
      reason: REASON,
      field: 'trialEndsAt',
      previousStatus: 'trialing',
    });

    await app.get(SubscriptionExpiryService).expireDueTrials(new Date());
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    expect(row.status).toBe('trialing');
  });

  it('grants days on top of a running paid period, recorded as a grant', async () => {
    const end = new Date(Date.now() + 10 * DAY);
    const { orgId } = await organization('bil06-grant', { status: 'active', end });
    const res = await post(platformOwner.accessToken, `${orgId}/grant-days`, {
      days: 5,
      reason: REASON,
    }).expect(200);
    expect(res.body.currentPeriodEnd).toBe(
      new Date(end.getTime() + 5 * DAY).toISOString(),
    );
    expect(
      await lastAudit(orgId, 'subscription.days_granted_by_platform'),
    ).not.toBeNull();
    expect(await lastAudit(orgId, 'subscription.extended_by_platform')).toBeNull();
  });

  it('returns a grace-period subscription to active', async () => {
    const { orgId } = await organization('bil06-grace', {
      status: 'grace_period',
      end: new Date(Date.now() - 2 * DAY),
    });
    const res = await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: 7,
      reason: REASON,
    }).expect(200);
    expect(res.body.status).toBe('active');
    expect(res.body.graceEndsAt).toBeUndefined();
    expect(new Date(res.body.currentPeriodEnd).getTime()).toBeGreaterThan(
      Date.now() + 6 * DAY,
    );
  });

  it('refuses to extend an expired subscription', async () => {
    const { orgId } = await organization('bil06-expired', {
      status: 'expired',
      end: new Date(Date.now() - 30 * DAY),
    });
    const res = await post(platformOwner.accessToken, `${orgId}/extend`, {
      days: 7,
      reason: REASON,
    }).expect(409);
    expect(res.body.error.messageKey).toBe(
      'errors.platform.subscriptionAdjustment.notExtendable',
    );
  });

  it('changes the plan now to a hidden plan and re-grants its limits', async () => {
    const { orgId } = await organization('bil06-change-now', {
      status: 'active',
      end: new Date(Date.now() + 10 * DAY),
    });
    const res = await post(platformOwner.accessToken, `${orgId}/change-plan`, {
      planKey: hiddenPlan.key,
      applyAt: 'now',
      reason: REASON,
    }).expect(200);
    expect(res.body.planId).toBe(hiddenPlan.id);
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    expect((row.grantedLimits as { students: number }).students).toBe(400);

    const audit = await lastAudit(orgId, 'subscription.plan_changed_by_platform');
    expect(audit?.context).toMatchObject({
      fromPlanId: plan.id,
      toPlanId: hiddenPlan.id,
      toPlanKey: hiddenPlan.key,
      applyAt: 'now',
      reason: REASON,
    });
  });

  it('schedules a plan change for the end of the paid period, applied by the sweep', async () => {
    const end = new Date(Date.now() + 10 * DAY);
    const { orgId } = await organization('bil06-change-later', { status: 'active', end });
    const res = await post(platformOwner.accessToken, `${orgId}/change-plan`, {
      planKey: hiddenPlan.key,
      applyAt: 'period_end',
      reason: REASON,
    }).expect(200);
    expect(res.body.planId).toBe(plan.id);
    expect(res.body.scheduledChange).toEqual({
      planId: hiddenPlan.id,
      planName: 'bil06-founding',
      effectiveAt: end.toISOString(),
    });

    await app
      .get(SubscriptionExpiryService)
      .applyDueScheduledPlanChanges(new Date(end.getTime() + 1000));
    const row = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: orgId },
    });
    expect(row.planId).toBe(hiddenPlan.id);
  });

  it('refuses a scheduled change without a running paid period, an archived plan, and an unknown plan', async () => {
    const { orgId } = await organization('bil06-change-refused', {
      status: 'trialing',
      end: new Date(Date.now() + 5 * DAY),
    });
    const noPeriod = await post(platformOwner.accessToken, `${orgId}/change-plan`, {
      planKey: hiddenPlan.key,
      applyAt: 'period_end',
      reason: REASON,
    }).expect(409);
    expect(noPeriod.body.error.messageKey).toBe(
      'errors.platform.subscriptionAdjustment.noPaidPeriod',
    );
    const archived = await post(platformOwner.accessToken, `${orgId}/change-plan`, {
      planKey: archivedPlan.key,
      applyAt: 'now',
      reason: REASON,
    }).expect(409);
    expect(archived.body.error.messageKey).toBe(
      'errors.platform.subscriptionAdjustment.planArchived',
    );
    await post(platformOwner.accessToken, `${orgId}/change-plan`, {
      planKey: 'no-such-plan',
      applyAt: 'now',
      reason: REASON,
    }).expect(404);
  });
});
