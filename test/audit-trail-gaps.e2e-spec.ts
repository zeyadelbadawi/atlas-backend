/**
 * B0-ANL-02 — the operations that wrote no audit row now write exactly one,
 * with the right scope and no credential, address or token in it:
 *
 *   - password sign-in failure (known account) and success;
 *   - `PATCH /trial-policy` (with the previous values);
 *   - plan- and organization-level commission overrides;
 *   - provisioning retry / cancel, by the owner (tenant-visible) and by the
 *     Platform Owner console (`*_by_platform`, operator-only);
 *   - academy payouts created and marked paid.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedCourse,
  seedCourseOrder,
  seedOrganizationWithOwner,
  seedPlan,
  seedRevenueLedgerEntry,
} from './utils/db-admin';

const PASSWORD = 'correct-horse-battery';

describe('B0-ANL-02 audit trail gaps (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function account(label: string) {
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

  async function platformOwner(label: string) {
    const user = await account(label);
    await admin.user.update({
      where: { id: user.userId },
      data: { isPlatformOwner: true },
    });
    return user;
  }

  function rows(action: string, targetId: string) {
    return admin.auditLogEntry.findMany({
      where: { action, targetId },
      orderBy: { occurredAt: 'asc' },
    });
  }

  it('records a known account’s failed and successful password sign-ins, without credentials', async () => {
    const user = await account('anl02-signin');
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: user.email, password: 'not-the-password' })
      .expect(401);

    const failed = await rows('auth.sign_in.failed', user.userId);
    expect(failed).toHaveLength(1);
    expect(failed[0].organizationId).toBeNull();
    expect(failed[0].context).toMatchObject({
      method: 'password',
      surface: 'management',
      reason: 'invalid_password',
    });
    const serialized = JSON.stringify(failed[0]);
    expect(serialized).not.toContain('not-the-password');
    expect(serialized).not.toContain(user.email);

    // `account()` signed in once already; each minted session is one row.
    const succeeded = await rows('auth.sign_in.succeeded', user.userId);
    expect(succeeded).toHaveLength(1);
    expect(succeeded[0].context).toMatchObject({
      method: 'password',
      surface: 'management',
    });
    expect(typeof (succeeded[0].context as Record<string, unknown>).sessionId).toBe(
      'string',
    );
    expect(JSON.stringify(succeeded[0])).not.toContain(PASSWORD);
  });

  it('writes nothing for an address with no account', async () => {
    const email = uniqueTestEmail('anl02-nobody');
    const before = await admin.auditLogEntry.count({
      where: { action: 'auth.sign_in.failed' },
    });
    await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: 'whatever-password' })
      .expect(401);
    const after = await admin.auditLogEntry.count({
      where: { action: 'auth.sign_in.failed' },
    });
    expect(after).toBe(before);
  });

  it('records a trial-policy change with the previous values', async () => {
    const owner = await platformOwner('anl02-trial');
    const current = await request(app.getHttpServer())
      .get('/trial-policy')
      .set(owner.auth)
      .expect(200);
    // Re-apply the current policy: the row is still written, and nothing
    // other suites rely on changes.
    const updated = await request(app.getHttpServer())
      .patch('/trial-policy')
      .set(owner.auth)
      .send({ enabled: current.body.enabled, durationDays: current.body.durationDays })
      .expect(200);
    expect(updated.body).toEqual(current.body);

    const entries = await admin.auditLogEntry.findMany({
      where: { action: 'trial_policy.updated', actorUserId: owner.userId },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].context).toEqual({
      enabled: current.body.enabled,
      durationDays: current.body.durationDays,
      previousEnabled: current.body.enabled,
      previousDurationDays: current.body.durationDays,
    });
  });

  it('records plan- and organization-level commission overrides', async () => {
    const owner = await platformOwner('anl02-commission');
    const plan = await seedPlan(admin, 'anl02-commission-plan');
    await request(app.getHttpServer())
      .patch(`/platform-commission/plans/${plan.key}`)
      .set(owner.auth)
      .send({ commissionBasisPoints: 750 })
      .expect(200);
    const planRows = await rows('commission_config.plan_updated', plan.id);
    expect(planRows).toHaveLength(1);
    expect(planRows[0].context).toEqual({
      planKey: plan.key,
      commissionBasisPoints: 750,
      previousCommissionBasisPoints: null,
    });

    const customer = await account('anl02-commission-org-owner');
    const org = await seedOrganizationWithOwner(admin, customer.userId, 'anl02-comm');
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${org.id}`)
      .set(owner.auth)
      .send({ commissionMode: 'custom', customPercentageBasisPoints: 500 })
      .expect(200);
    const orgRows = await rows('commission_config.organization_updated', org.id);
    expect(orgRows).toHaveLength(1);
    expect(orgRows[0].organizationId).toBe(org.id);
    expect(orgRows[0].context).toMatchObject({
      commissionMode: 'custom',
      customPercentageBasisPoints: 500,
      previousCommissionMode: null,
    });
  });

  describe('provisioning retry / cancel', () => {
    async function orgWithRequest(label: string) {
      const owner = await account(`${label}-owner`);
      const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
      const plan = await seedPlan(admin, `${label}-plan`);
      await admin.tenantSubscription.create({
        data: { organizationId: org.id, planId: plan.id, status: 'active' },
      });
      const subdomain = `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        .toLowerCase()
        .slice(0, 50);
      // Seeded without a worker job, so it stays non-terminal until the
      // endpoint under test acts on it.
      const seeded = await admin.provisioningRequest.create({
        data: {
          organizationId: org.id,
          requestedByUserId: owner.userId,
          requestedAcademyName: `${label} Academy`,
          requestedSubdomain: subdomain,
          idempotencyKey: `idem-${subdomain}`,
        },
      });
      await admin.provisioningStep.createMany({
        data: (
          [
            'tenant',
            'academy',
            'theme',
            'branding',
            'subdomain',
            'domain',
            'finalization',
          ] as const
        ).map((key) => ({ provisioningRequestId: seeded.id, key })),
      });
      return { owner, org, request: seeded };
    }

    it('the owner’s cancel is in the owner’s feed; the Platform Owner’s is operator-only', async () => {
      const mine = await orgWithRequest('anl02-cancel');
      await request(app.getHttpServer())
        .post(
          `/organizations/${mine.org.id}/provisioning-requests/${mine.request.id}/cancel`,
        )
        .set(mine.owner.auth)
        .expect(201);
      const ownerRows = await rows('provisioning_request.cancelled', mine.request.id);
      expect(ownerRows).toHaveLength(1);
      expect(ownerRows[0].organizationId).toBe(mine.org.id);
      expect(ownerRows[0].actorUserId).toBe(mine.owner.userId);
      expect(ownerRows[0].context).toEqual({ previousStatus: mine.request.status });

      const theirs = await orgWithRequest('anl02-cancel-po');
      const operator = await platformOwner('anl02-cancel-operator');
      await request(app.getHttpServer())
        .post(`/provisioning-requests/${theirs.request.id}/cancel`)
        .set(operator.auth)
        .expect(201);
      const platformRows = await rows(
        'provisioning_request.cancelled_by_platform',
        theirs.request.id,
      );
      expect(platformRows).toHaveLength(1);
      expect(platformRows[0].actorUserId).toBe(operator.userId);
      expect(
        await rows('provisioning_request.cancelled', theirs.request.id),
      ).toHaveLength(0);
    });

    it('records the owner’s retry once the job is queued', async () => {
      const mine = await orgWithRequest('anl02-retry');
      await request(app.getHttpServer())
        .post(
          `/organizations/${mine.org.id}/provisioning-requests/${mine.request.id}/retry`,
        )
        .set(mine.owner.auth)
        .expect(201);
      const retryRows = await rows('provisioning_request.retried', mine.request.id);
      expect(retryRows).toHaveLength(1);
      expect(retryRows[0].context).toEqual({ step: 'resume' });

      // Let the queued run finish so it does not outlive this suite.
      await waitForAsync(async () => {
        const fresh = await admin.provisioningRequest.findUnique({
          where: { id: mine.request.id },
        });
        return fresh && ['ready', 'failed', 'cancelled'].includes(fresh.status)
          ? fresh
          : undefined;
      });
    });
  });

  it('records a payout when it is created and when it is marked paid', async () => {
    const operator = await platformOwner('anl02-payout-operator');
    const customer = await account('anl02-payout-owner');
    const org = await seedOrganizationWithOwner(admin, customer.userId, 'anl02-payout');
    const academy = await seedAcademy(admin, org.id, 'anl02-payout-academy');
    const course = await seedCourse(admin, academy.id, 'anl02-payout-course');
    const order = await seedCourseOrder(
      admin,
      customer.userId,
      course.id,
      academy.id,
      org.id,
    );
    await seedRevenueLedgerEntry(admin, academy.id, order.id, {
      entryType: 'sale',
      amountMinorUnits: 12_000n,
      occurredAt: new Date(Date.now() - 1_000),
    });

    const created = await request(app.getHttpServer())
      .post('/platform-academy-payouts')
      .set(operator.auth)
      .send({
        academyId: academy.id,
        periodStart: new Date(Date.now() - 60_000).toISOString(),
        periodEnd: new Date(Date.now() + 60_000).toISOString(),
      })
      .expect(201);
    expect(created.body).toHaveLength(1);
    const payoutId = created.body[0].id as string;

    const createdRows = await rows('payout.created', payoutId);
    expect(createdRows).toHaveLength(1);
    expect(createdRows[0].organizationId).toBe(org.id);
    expect(createdRows[0].context).toMatchObject({
      academyId: academy.id,
      currency: 'USD',
      amountMinorUnits: '12000',
      items: 1,
    });

    await request(app.getHttpServer())
      .post(`/platform-academy-payouts/${payoutId}/mark-paid`)
      .set(operator.auth)
      .send({ providerReference: 'BANK-REF-1' })
      .expect(201);
    // A repeat on an already-paid payout writes nothing new.
    await request(app.getHttpServer())
      .post(`/platform-academy-payouts/${payoutId}/mark-paid`)
      .set(operator.auth)
      .send({})
      .expect(201);
    const paidRows = await rows('payout.marked_paid', payoutId);
    expect(paidRows).toHaveLength(1);
    expect(paidRows[0].context).toMatchObject({
      currency: 'USD',
      amountMinorUnits: '12000',
      providerReference: 'BANK-REF-1',
    });
  });
});
