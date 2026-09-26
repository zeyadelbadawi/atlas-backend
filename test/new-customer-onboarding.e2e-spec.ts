/**
 * New Customer Onboarding (docs/NEW_CUSTOMER_ONBOARDING.md) — against real
 * Postgres as `atlas_app`, so every read and write below crosses real RLS.
 *
 *   - one-page signup creates user + organization + owner membership +
 *     subscription + trial atomically, and the organization starts PENDING;
 *   - every refusal (flag off, forged/ineligible/archived/hidden plan, trials
 *     disabled, academy surface, missing name) creates NOTHING;
 *   - duplicate and concurrent signups resolve to one account (409s, no 500);
 *   - an injected failure after the organization insert leaves no rows;
 *   - a mailbox that already used its trial gets `no_plan` and the EXISTING
 *     paid checkout → payment → proof → approval path, never a second trial;
 *   - existing / legacy organizations are never pending;
 *   - onboarding status + completion are owner-only and derived, "finish"
 *     is refused while a required step is open, "defer" always works.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedMembership,
  seedOrganizationWithOwner,
  seedPaymentMethod,
} from './utils/db-admin';
import { TrialPolicyRepository } from '../src/plans/repositories/trial-policy.repository';
import { OrganizationSubscriptionBootstrapService } from '../src/plans/services/organization-subscription-bootstrap.service';
import type { IdentityConfig } from '../src/config/configuration';
import { Prisma } from '@prisma/client';
import type { Plan, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/database/prisma.service';

const PASSWORD = 'correct-horse-battery';
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

/** A plus-addressable mailbox (the trial subject collapses `+tags` on gmail.com). */
function gmailBase(label: string): string {
  return `atlasonb.${label}.${Date.now()}${Math.random().toString(36).slice(2, 7)}`;
}

describe('New Customer Onboarding (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let identityConfig: {
    signupOrganizationMode: IdentityConfig['signupOrganizationMode'];
  };
  let trialPlan: Plan;
  let originalPolicy: { enabled: boolean; durationDays: number };

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    // The config object is the live one `AuthService` and the signup
    // options endpoint read on every request — toggled per test below.
    identityConfig = app
      .get(ConfigService)
      .getOrThrow<IdentityConfig>('identity') as never;
    // The singleton is created lazily (as the app does), so a fresh
    // database works too.
    const policy = await app.get(TrialPolicyRepository).findSingleton();
    originalPolicy = { enabled: policy.enabled, durationDays: policy.durationDays };
    trialPlan = await seedCatalogPlan('onb-trial', { trialEligible: true });
  });

  beforeEach(async () => {
    await flush();
    identityConfig.signupOrganizationMode = 'on';
    await admin.trialPolicy.updateMany({ data: { enabled: true, durationDays: 3 } });
  });

  afterAll(async () => {
    // Fixture plans need `displayOrder > 0` to be customer-facing, so they
    // would otherwise linger in every later catalog read of this shared
    // database — archive them (archived plans are never offered).
    await admin.plan.updateMany({
      where: { key: { startsWith: 'onb-' } },
      data: { status: 'archived' },
    });
    identityConfig.signupOrganizationMode = 'off';
    await admin.trialPolicy.updateMany({ data: originalPolicy });
    await admin.$disconnect();
    await app.close();
  });

  async function seedCatalogPlan(
    label: string,
    overrides: {
      trialEligible?: boolean;
      status?: 'active' | 'archived';
      displayOrder?: number;
    },
  ): Promise<Plan> {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        status: overrides.status ?? 'active',
        displayOrder: overrides.displayOrder ?? 900,
        trialEligible: overrides.trialEligible ?? false,
        limits: {
          academies: 2,
          students: 50,
          instructors: 5,
          staff: 5,
          courses: 20,
          generalStorage: 10,
          videoStorage: 10,
        },
        features: { cms: true, themes: true },
        pricing: { amount: 49, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  }

  const register = (body: Record<string, unknown>) =>
    request(app.getHttpServer()).post('/auth/register').send(body);

  async function signIn(email: string) {
    const res = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body as {
      accessToken: string;
      user: {
        id: string;
        organizations: {
          organizationId: string;
          role: string;
          onboardingPending: boolean;
        }[];
      };
    };
  }

  async function signupWithOrganization(
    email: string,
    planId: string | null = trialPlan.id,
  ) {
    const organizationName = `Onboarding Org ${Math.random().toString(36).slice(2, 8)}`;
    await register({
      name: 'Owner Name',
      email,
      password: PASSWORD,
      organizationName,
      planId: planId ?? undefined,
    }).expect(201);
    const session = await signIn(email);
    return {
      session,
      organizationName,
      organizationId: session.user.organizations[0]?.organizationId,
    };
  }

  const getStatus = (organizationId: string, token: string) =>
    request(app.getHttpServer())
      .get(`/organizations/${organizationId}/onboarding`)
      .set('Authorization', `Bearer ${token}`);

  const complete = (organizationId: string, token: string, mode: 'finish' | 'defer') =>
    request(app.getHttpServer())
      .post(`/organizations/${organizationId}/onboarding/complete`)
      .set('Authorization', `Bearer ${token}`)
      .send({ mode });

  async function rowsForEmail(email: string) {
    const users = await admin.user.findMany({ where: { email }, select: { id: true } });
    const orgs = users.length
      ? await admin.organization.count({
          where: { ownerUserId: { in: users.map((u) => u.id) } },
        })
      : 0;
    return { users: users.length, orgs };
  }

  // -------------------------------------------------------------------------
  describe('GET /public/signup-options', () => {
    it('reports the flag, the trial policy and ONLY active, customer-facing, trial-eligible plans', async () => {
      const ineligible = await seedCatalogPlan('onb-no-trial', { trialEligible: false });
      const archived = await seedCatalogPlan('onb-archived', {
        trialEligible: true,
        status: 'archived',
      });
      const hidden = await seedCatalogPlan('onb-hidden', {
        trialEligible: true,
        displayOrder: 0,
      });

      const on = await request(app.getHttpServer())
        .get('/public/signup-options')
        .expect(200);
      expect(on.body.organizationSignup).toBe(true);
      expect(on.body.trialsEnabled).toBe(true);
      const keys = on.body.trialPlans.map((p: { key: string }) => p.key);
      expect(keys).toContain(trialPlan.key);
      expect(keys).not.toContain(ineligible.key);
      expect(keys).not.toContain(archived.key);
      expect(keys).not.toContain(hidden.key);
      expect(
        on.body.trialPlans.every((p: { trialEligible: boolean }) => p.trialEligible),
      ).toBe(true);

      await admin.trialPolicy.updateMany({ data: { enabled: false } });
      const disabled = await request(app.getHttpServer())
        .get('/public/signup-options')
        .expect(200);
      expect(disabled.body).toMatchObject({ trialsEnabled: false, trialPlans: [] });

      identityConfig.signupOrganizationMode = 'off';
      const off = await request(app.getHttpServer())
        .get('/public/signup-options')
        .expect(200);
      expect(off.body.organizationSignup).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('one-page signup (state A)', () => {
    it('creates user + organization + owner membership + trialing subscription atomically, and the organization starts PENDING', async () => {
      const email = uniqueTestEmail('onb-happy');
      const { session, organizationName, organizationId } =
        await signupWithOrganization(email);

      const organization = await admin.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      expect(organization.name).toBe(organizationName);
      expect(organization.ownerUserId).toBe(session.user.id);
      // THE acceptance criterion: a signup organization persists NULL.
      expect(organization.onboardingCompletedAt).toBeNull();

      const membership = await admin.organizationMembership.findFirstOrThrow({
        where: { organizationId, userId: session.user.id },
      });
      expect(membership.role).toBe('owner');
      expect(membership.isPrimary).toBe(true);

      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId },
      });
      expect(subscription).toMatchObject({ status: 'trialing', planId: trialPlan.id });
      expect(subscription.trialEndsAt).not.toBeNull();
      expect(await admin.trialRedemption.count({ where: { organizationId } })).toBe(1);

      const audit = await admin.auditLogEntry.findMany({
        where: { organizationId },
        select: { action: true },
      });
      expect(audit.map((a) => a.action)).toEqual(
        expect.arrayContaining(['organization.created', 'subscription.trial.redeemed']),
      );
      expect(
        await admin.communicationOutbox.count({
          where: { key: 'lifecycle.trial.started', recipientUserId: session.user.id },
        }),
      ).toBe(1);

      // First authenticated owner login → the session marks it pending,
      // which is what routes `/dashboard` to `/onboarding`.
      expect(session.user.organizations).toEqual([
        expect.objectContaining({
          organizationId,
          role: 'owner',
          onboardingPending: true,
        }),
      ]);

      const status = await getStatus(organizationId, session.accessToken).expect(200);
      expect(status.body).toMatchObject({
        pending: true,
        completedAt: null,
        requiredComplete: false,
        readyLabelAllowed: false,
        subscription: {
          status: 'trialing',
          planKey: trialPlan.key,
          trialAvailable: false,
        },
        nextStep: 'academy',
      });
      expect(status.body.steps).toEqual([
        { key: 'plan', requirement: 'prerequisite', status: 'complete' },
        { key: 'academy', requirement: 'required', status: 'incomplete' },
        { key: 'branding', requirement: 'recommended', status: 'blocked' },
        { key: 'website', requirement: 'required', status: 'blocked' },
        { key: 'course', requirement: 'recommended', status: 'blocked' },
      ]);
    });

    it('legacy signup (no organization fields) is unchanged: account only, no organization', async () => {
      const email = uniqueTestEmail('onb-legacy');
      await register({ name: 'Legacy', email, password: PASSWORD }).expect(201);
      expect(await rowsForEmail(email)).toEqual({ users: 1, orgs: 0 });
      identityConfig.signupOrganizationMode = 'off';
      const email2 = uniqueTestEmail('onb-legacy-off');
      await register({ name: 'Legacy', email: email2, password: PASSWORD }).expect(201);
      expect(await rowsForEmail(email2)).toEqual({ users: 1, orgs: 0 });
    });
  });

  // -------------------------------------------------------------------------
  describe('refusals create NOTHING (states C, D)', () => {
    const cases: [string, () => Promise<Record<string, unknown>>, string][] = [
      [
        'forged plan id',
        async () => ({ planId: randomUUID() }),
        'errors.auth.signupPlanUnavailable',
      ],
      [
        'non-trial plan',
        async () => ({ planId: (await seedCatalogPlan('onb-paid', {})).id }),
        'errors.auth.signupPlanUnavailable',
      ],
      [
        'archived plan',
        async () => ({
          planId: (
            await seedCatalogPlan('onb-arch', { trialEligible: true, status: 'archived' })
          ).id,
        }),
        'errors.auth.signupPlanUnavailable',
      ],
      [
        'hidden (not customer-facing) plan',
        async () => ({
          planId: (
            await seedCatalogPlan('onb-hid', { trialEligible: true, displayOrder: 0 })
          ).id,
        }),
        'errors.auth.signupPlanUnavailable',
      ],
      [
        'plan without organization name',
        async () => ({ organizationName: undefined }),
        'errors.auth.organizationNameRequired',
      ],
      [
        'blank organization name',
        async () => ({ organizationName: '   ' }),
        'errors.auth.organizationNameRequired',
      ],
    ];

    it.each(cases)('%s → 400 and no rows', async (_label, build, key) => {
      const email = uniqueTestEmail('onb-refused');
      const res = await register({
        name: 'Refused',
        email,
        password: PASSWORD,
        organizationName: 'Refused Org',
        planId: trialPlan.id,
        ...(await build()),
      }).expect(400);
      expect(res.body.error.messageKey).toBe(key);
      expect(await rowsForEmail(email)).toEqual({ users: 0, orgs: 0 });
    });

    it('trials disabled + a plan → 400 signupTrialsUnavailable; without a plan → organization with no_plan', async () => {
      await admin.trialPolicy.updateMany({ data: { enabled: false } });
      const email = uniqueTestEmail('onb-no-trials');
      const res = await register({
        name: 'No Trials',
        email,
        password: PASSWORD,
        organizationName: 'No Trials Org',
        planId: trialPlan.id,
      }).expect(400);
      expect(res.body.error.messageKey).toBe('errors.auth.signupTrialsUnavailable');
      expect(await rowsForEmail(email)).toEqual({ users: 0, orgs: 0 });

      const email2 = uniqueTestEmail('onb-no-trials-ok');
      const { organizationId, session } = await signupWithOrganization(email2, null);
      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId },
      });
      expect(subscription.status).toBe('no_plan');
      const status = await getStatus(organizationId, session.accessToken).expect(200);
      expect(status.body.nextStep).toBe('plan');
      expect(status.body.subscription.trialAvailable).toBe(false);
    });

    it('flag off → organization fields refused, nothing created', async () => {
      identityConfig.signupOrganizationMode = 'off';
      const email = uniqueTestEmail('onb-flag-off');
      const res = await register({
        name: 'Flag Off',
        email,
        password: PASSWORD,
        organizationName: 'Flag Off Org',
        planId: trialPlan.id,
      }).expect(400);
      expect(res.body.error.messageKey).toBe('errors.auth.organizationSignupDisabled');
      expect(await rowsForEmail(email)).toEqual({ users: 0, orgs: 0 });
    });

    it('academy surface (academyId) → signupFieldsNotAllowed, nothing created', async () => {
      const owner = await seedOrganizationWithOwner(
        admin,
        (
          await admin.user.create({
            data: {
              email: uniqueTestEmail('onb-acad-owner'),
              passwordHash: 'x',
              name: 'o',
            },
          })
        ).id,
        'onb-acad-org',
      );
      const academy = await seedAcademy(admin, owner.id, 'onb-acad');
      const email = uniqueTestEmail('onb-learner');
      const res = await register({
        name: 'Learner',
        email,
        password: PASSWORD,
        academyId: academy.id,
        organizationName: 'Should Not Exist',
        planId: trialPlan.id,
      }).expect(400);
      expect(res.body.error.messageKey).toBe('errors.auth.signupFieldsNotAllowed');
      expect(await rowsForEmail(email)).toEqual({ users: 0, orgs: 0 });
    });
  });

  // -------------------------------------------------------------------------
  describe('duplicates, concurrency and partial failure (state E)', () => {
    it('five concurrent signups of one address → exactly one account/organization/trial, the rest 409, never 500', async () => {
      const email = uniqueTestEmail('onb-race');
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          register({
            name: 'Racer',
            email,
            password: PASSWORD,
            organizationName: 'Race Org',
            planId: trialPlan.id,
          }),
        ),
      );
      const codes = results.map((r) => r.status).sort();
      expect(codes).toEqual([201, 409, 409, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) {
        expect(r.body.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
      }
      expect(await rowsForEmail(email)).toEqual({ users: 1, orgs: 1 });
    });

    it('a retry after success is a clean 409 (the account already exists)', async () => {
      const email = uniqueTestEmail('onb-retry');
      const body = {
        name: 'Retry',
        email,
        password: PASSWORD,
        organizationName: 'Retry Org',
        planId: trialPlan.id,
      };
      await register(body).expect(201);
      const again = await register(body).expect(409);
      expect(again.body.error.messageKey).toBe('errors.auth.emailAlreadyRegistered');
      expect(await rowsForEmail(email)).toEqual({ users: 1, orgs: 1 });
    });

    it('a failure AFTER the organization insert rolls back everything — no user, no organization', async () => {
      const bootstrap = app.get(OrganizationSubscriptionBootstrapService);
      const spy = jest
        .spyOn(bootstrap, 'bootstrapSubscription')
        .mockRejectedValueOnce(new Error('injected failure'));
      const email = uniqueTestEmail('onb-injected');
      try {
        await register({
          name: 'Injected',
          email,
          password: PASSWORD,
          organizationName: 'Injected Org',
          planId: trialPlan.id,
        }).expect(500);
      } finally {
        spy.mockRestore();
      }
      expect(await rowsForEmail(email)).toEqual({ users: 0, orgs: 0 });
      expect(await admin.organization.count({ where: { name: 'Injected Org' } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('trial already used → existing paid path (state B)', () => {
    it('no second trial; Plan step drives checkout → payment → proof → (reject | approve) → academy', async () => {
      const base = gmailBase('reuse');
      // The mailbox's first (and only) trial.
      await signupWithOrganization(`${base}@gmail.com`);

      // Same mailbox via plus-addressing: a NEW user, not a new trial subject.
      const email = `${base}+again@gmail.com`;
      const { session, organizationId } = await signupWithOrganization(email);
      const token = session.accessToken;

      const subscription = await admin.tenantSubscription.findUniqueOrThrow({
        where: { organizationId },
      });
      expect(subscription.status).toBe('no_plan');
      expect(await admin.trialRedemption.count({ where: { organizationId } })).toBe(0);
      expect(session.user.organizations[0].onboardingPending).toBe(true);

      let status = await getStatus(organizationId, token).expect(200);
      expect(status.body).toMatchObject({
        nextStep: 'plan',
        subscription: { status: 'no_plan', planKey: null, trialAvailable: false },
        latestSubscriptionPayment: null,
      });
      expect(status.body.steps[0]).toEqual({
        key: 'plan',
        requirement: 'prerequisite',
        status: 'incomplete',
      });
      expect(status.body.steps[1].status).toBe('blocked');

      // The trial endpoint refuses: the once-per-mailbox rule holds.
      const trial = await request(app.getHttpServer())
        .post(`/organizations/${organizationId}/subscription/trial`)
        .set('Authorization', `Bearer ${token}`)
        .send({ confirm: true, planId: trialPlan.id })
        .expect(200);
      expect(trial.body).toMatchObject({ started: false, reason: 'already_redeemed' });
      expect(await admin.trialRedemption.count({ where: { organizationId } })).toBe(0);

      // The EXISTING paid path.
      const method = await seedPaymentMethod(admin, 'onb-method');
      const pay = async (label: string) => {
        const checkout = await request(app.getHttpServer())
          .post(`/organizations/${organizationId}/checkouts`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            target: { type: 'plan_subscription', planKey: trialPlan.key },
            billingCycle: 'monthly',
            idempotencyKey: `onb-${label}-${randomUUID()}`,
          })
          .expect(201);
        const payment = await request(app.getHttpServer())
          .post(`/organizations/${organizationId}/payments`)
          .set('Authorization', `Bearer ${token}`)
          .send({ checkoutId: checkout.body.id, methodKey: method.key })
          .expect(201);
        await request(app.getHttpServer())
          .patch(`/organizations/${organizationId}/payments/${payment.body.id}/proof`)
          .set('Authorization', `Bearer ${token}`)
          .send({
            fileData: PROOF_DATA_URL,
            fileName: 'proof.png',
            mimeType: 'image/png',
          })
          .expect(200);
        return payment.body.id as string;
      };

      const reviewerEmail = uniqueTestEmail('onb-reviewer');
      await register({
        name: 'Reviewer',
        email: reviewerEmail,
        password: PASSWORD,
      }).expect(201);
      const reviewer = await signIn(reviewerEmail);
      await admin.user.update({
        where: { id: reviewer.user.id },
        data: { isPlatformOwner: true },
      });

      const rejectedId = await pay('rejected');
      status = await getStatus(organizationId, token).expect(200);
      expect(status.body.steps[0].status).toBe('awaiting_confirmation');
      expect(status.body.latestSubscriptionPayment).toMatchObject({
        id: rejectedId,
        planKey: trialPlan.key,
      });

      await request(app.getHttpServer())
        .post(`/payments/${rejectedId}/reject`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({ notes: 'amount does not match' })
        .expect(201);
      status = await getStatus(organizationId, token).expect(200);
      expect(status.body.steps[0].status).toBe('incomplete');
      expect(status.body.latestSubscriptionPayment).toMatchObject({
        id: rejectedId,
        status: 'failed',
        failureReason: 'errors.payment.rejectedByReviewer',
        reviewNotes: 'amount does not match',
      });

      const approvedId = await pay('approved');
      await request(app.getHttpServer())
        .post(`/payments/${approvedId}/approve`)
        .set('Authorization', `Bearer ${reviewer.accessToken}`)
        .send({})
        .expect(201);

      status = await getStatus(organizationId, token).expect(200);
      expect(status.body.steps[0].status).toBe('complete');
      expect(status.body.subscription).toMatchObject({
        status: 'active',
        planKey: trialPlan.key,
      });
      expect(status.body.nextStep).toBe('academy');
      // Still exactly one redemption for the mailbox, held by the FIRST organization.
      expect(await admin.trialRedemption.count({ where: { organizationId } })).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  describe('existing and legacy organizations are never pending (state F)', () => {
    it('POST /organizations and seeded (pre-migration shaped) organizations are already onboarded', async () => {
      const email = uniqueTestEmail('onb-legacy-owner');
      await register({ name: 'Legacy Owner', email, password: PASSWORD }).expect(201);
      let session = await signIn(email);
      const created = await request(app.getHttpServer())
        .post('/organizations')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ name: 'Legacy Path Org' })
        .expect(201);
      const legacy = await admin.organization.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(legacy.onboardingCompletedAt).not.toBeNull();

      const seeded = await seedOrganizationWithOwner(
        admin,
        session.user.id,
        'onb-seeded',
      );
      expect(
        (await admin.organization.findUniqueOrThrow({ where: { id: seeded.id } }))
          .onboardingCompletedAt,
      ).not.toBeNull();

      session = await signIn(email);
      expect(session.user.organizations.every((m) => m.onboardingPending === false)).toBe(
        true,
      );

      const status = await getStatus(created.body.id, session.accessToken).expect(200);
      expect(status.body.pending).toBe(false);
    });

    it('multiple organizations (state H): only the signup organization is pending', async () => {
      const email = uniqueTestEmail('onb-multi');
      const { session, organizationId } = await signupWithOrganization(email);
      const second = await request(app.getHttpServer())
        .post('/organizations')
        .set('Authorization', `Bearer ${session.accessToken}`)
        .send({ name: 'Second Org' })
        .expect(201);
      const again = await signIn(email);
      const byId = new Map(
        again.user.organizations.map((m) => [m.organizationId, m.onboardingPending]),
      );
      expect(byId.get(organizationId)).toBe(true);
      expect(byId.get(second.body.id)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('completion semantics', () => {
    it('"finish" is refused while required steps are open; "defer" stamps completion once; state stays derived', async () => {
      const email = uniqueTestEmail('onb-defer');
      const { session, organizationId } = await signupWithOrganization(email);
      const token = session.accessToken;

      const refused = await complete(organizationId, token, 'finish').expect(409);
      expect(refused.body.error.messageKey).toBe('errors.onboarding.requiredIncomplete');
      expect(
        (await admin.organization.findUniqueOrThrow({ where: { id: organizationId } }))
          .onboardingCompletedAt,
      ).toBeNull();

      const deferred = await complete(organizationId, token, 'defer').expect(200);
      expect(deferred.body).toMatchObject({
        pending: false,
        requiredComplete: false,
        readyLabelAllowed: false,
      });
      expect(deferred.body.completedAt).not.toBeNull();
      // Idempotent — and audited once.
      await complete(organizationId, token, 'defer').expect(200);
      expect(
        await admin.auditLogEntry.count({
          where: { organizationId, action: 'organization.onboarding.completed' },
        }),
      ).toBe(1);

      const again = await signIn(email);
      expect(again.user.organizations[0].onboardingPending).toBe(false);
      // Steps are still derived after "Finish for now" — the dashboard keeps them.
      const status = await getStatus(organizationId, token).expect(200);
      expect(status.body.nextStep).toBe('academy');
    });

    it('"finish" succeeds and "ready" is allowed only once Academy AND Website are complete', async () => {
      const email = uniqueTestEmail('onb-finish');
      const { session, organizationId } = await signupWithOrganization(email);
      const token = session.accessToken;

      const academy = await seedAcademy(admin, organizationId, 'onb-finish-academy');
      // The creator of a real academy is its `owner` member (what makes its
      // website configuration visible under RLS) — seeded the same way here.
      await seedAcademyMember(admin, academy.id, session.user.id, 'owner');
      let status = await getStatus(organizationId, token).expect(200);
      expect(
        status.body.steps.find((s: { key: string }) => s.key === 'academy').status,
      ).toBe('complete');
      expect(status.body.readyLabelAllowed).toBe(false);
      expect(status.body.nextStep).toBe('website');
      await complete(organizationId, token, 'finish').expect(409);

      await admin.websiteConfiguration.create({
        data: {
          academyId: academy.id,
          themeKey: 'modern-education',
          themeVersion: 1,
          brand: {},
          seo: {},
          navigation: {},
          header: {},
          footer: {},
          status: 'published',
          publishedAt: new Date(),
        },
      });
      status = await getStatus(organizationId, token).expect(200);
      expect(status.body).toMatchObject({
        requiredComplete: true,
        readyLabelAllowed: true,
        nextStep: 'branding',
      });
      expect(
        status.body.steps.find((s: { key: string }) => s.key === 'course').status,
      ).toBe('incomplete');

      const finished = await complete(organizationId, token, 'finish').expect(200);
      expect(finished.body.pending).toBe(false);
      const audit = await admin.auditLogEntry.findFirstOrThrow({
        where: { organizationId, action: 'organization.onboarding.completed' },
      });
      expect(audit.context).toMatchObject({ mode: 'finish', requiredComplete: true });
    });

    it('trial expiry (state I) makes the Plan step blocking again; earlier derived steps stay complete', async () => {
      const email = uniqueTestEmail('onb-expired');
      const { session, organizationId } = await signupWithOrganization(email);
      await seedAcademy(admin, organizationId, 'onb-expired-academy');
      await admin.tenantSubscription.update({
        where: { organizationId },
        data: { status: 'trial_expired' },
      });
      const status = await getStatus(organizationId, session.accessToken).expect(200);
      expect(status.body.nextStep).toBe('plan');
      expect(status.body.steps[0].status).toBe('incomplete');
      expect(status.body.steps[1].status).toBe('complete');
      expect(status.body.subscription.trialAvailable).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  describe('authorization and tenant isolation (state G)', () => {
    it("anonymous 401; manager, instructor and learner 403; another organization's owner 403; forged completion only reaches your own organization", async () => {
      const { session: owner, organizationId } = await signupWithOrganization(
        uniqueTestEmail('onb-authz'),
      );

      await request(app.getHttpServer())
        .get(`/organizations/${organizationId}/onboarding`)
        .expect(401);

      const managerEmail = uniqueTestEmail('onb-manager');
      await register({ name: 'Manager', email: managerEmail, password: PASSWORD }).expect(
        201,
      );
      const manager = await signIn(managerEmail);
      await seedMembership(admin, organizationId, manager.user.id, 'manager');
      await getStatus(organizationId, manager.accessToken).expect(403);
      await complete(organizationId, manager.accessToken, 'defer').expect(403);
      expect((await signIn(managerEmail)).user.organizations[0]).toMatchObject({
        role: 'manager',
        onboardingPending: false,
      });

      // An instructor (organization member + academy instructor) and a
      // learner (academy student, no organization membership) of the SAME
      // organization are refused too: onboarding is the owner's alone.
      const academy = await seedAcademy(admin, organizationId, 'onb-authz-academy');
      const instructorEmail = uniqueTestEmail('onb-instructor');
      await register({
        name: 'Instructor',
        email: instructorEmail,
        password: PASSWORD,
      }).expect(201);
      const instructor = await signIn(instructorEmail);
      await seedMembership(admin, organizationId, instructor.user.id, 'instructor');
      await seedAcademyMember(admin, academy.id, instructor.user.id, 'instructor');
      await getStatus(organizationId, instructor.accessToken).expect(403);
      await complete(organizationId, instructor.accessToken, 'defer').expect(403);
      expect((await signIn(instructorEmail)).user.organizations[0]).toMatchObject({
        role: 'instructor',
        onboardingPending: false,
      });

      const learnerEmail = uniqueTestEmail('onb-learner');
      await register({ name: 'Learner', email: learnerEmail, password: PASSWORD }).expect(
        201,
      );
      const learner = await signIn(learnerEmail);
      await seedAcademyStudent(admin, academy.id, learner.user.id);
      await getStatus(organizationId, learner.accessToken).expect(403);
      await complete(organizationId, learner.accessToken, 'defer').expect(403);

      const { session: stranger } = await signupWithOrganization(
        uniqueTestEmail('onb-stranger'),
      );
      await getStatus(organizationId, stranger.accessToken).expect(403);
      await complete(organizationId, stranger.accessToken, 'defer').expect(403);
      expect(
        (await admin.organization.findUniqueOrThrow({ where: { id: organizationId } }))
          .onboardingCompletedAt,
      ).toBeNull();

      await complete(organizationId, owner.accessToken, 'defer').expect(200);
    });

    it('RLS: as atlas_app, the completion function refuses a non-owner and a mismatched organization context; organizations stay non-updatable', async () => {
      const prisma = app.get(PrismaService);
      const { session: owner, organizationId } = await signupWithOrganization(
        uniqueTestEmail('onb-rls'),
      );
      const managerEmail = uniqueTestEmail('onb-rls-manager');
      await register({ name: 'Manager', email: managerEmail, password: PASSWORD }).expect(
        201,
      );
      const manager = await signIn(managerEmail);
      await seedMembership(admin, organizationId, manager.user.id, 'manager');
      const { organizationId: otherOrgId } = await signupWithOrganization(
        uniqueTestEmail('onb-rls-other'),
      );

      const asUser = (userId: string, orgId: string, sql: Prisma.Sql) =>
        prisma.$transaction(async (tx) => {
          await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
          await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${orgId}, true)`;
          return tx.$queryRaw(sql);
        });

      // A manager of the organization: refused.
      await expect(
        asUser(
          manager.user.id,
          organizationId,
          Prisma.sql`SELECT complete_organization_onboarding(${organizationId})`,
        ),
      ).rejects.toThrow(/refused/);
      // The owner, but with ANOTHER organization in context: refused.
      await expect(
        asUser(
          owner.user.id,
          otherOrgId,
          Prisma.sql`SELECT complete_organization_onboarding(${organizationId})`,
        ),
      ).rejects.toThrow(/refused/);
      // No UPDATE policy: a direct write as the owner changes nothing.
      await asUser(
        owner.user.id,
        organizationId,
        Prisma.sql`UPDATE organizations SET onboarding_completed_at = now(), name = 'hijacked' WHERE id = ${organizationId}`,
      );
      const row = await admin.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      expect(row.onboardingCompletedAt).toBeNull();
      expect(row.name).not.toBe('hijacked');
      // The owner in their own context: allowed, exactly once.
      const first = await asUser(
        owner.user.id,
        organizationId,
        Prisma.sql`SELECT complete_organization_onboarding(${organizationId}) AS changed`,
      );
      const second = await asUser(
        owner.user.id,
        organizationId,
        Prisma.sql`SELECT complete_organization_onboarding(${organizationId}) AS changed`,
      );
      expect((first as { changed: number }[])[0].changed).toBe(1);
      expect((second as { changed: number }[])[0].changed).toBe(0);
    });

    it('validates the completion body', async () => {
      const { session, organizationId } = await signupWithOrganization(
        uniqueTestEmail('onb-body'),
      );
      await complete(organizationId, session.accessToken, 'nonsense' as never).expect(
        400,
      );
    });
  });
});
