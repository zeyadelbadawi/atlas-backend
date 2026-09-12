/**
 * What an expired tenant can and cannot do.
 *
 * THE GAP THIS CLOSES. Entitlement enforcement has always run at the write
 * sites where a plan LIMIT applies — creating a course, provisioning an
 * academy. Everything else was ungated, so an Organization whose trial
 * ended last night could still edit and publish its website, upload media,
 * author announcements and manage members: none of those consume a counted
 * resource, so none of them ever asked. Hiding the screens in the frontend
 * is not a control; the API was reachable with a token and a URL, which is
 * exactly what these tests exercise.
 *
 * THE TWO HALVES THAT MATTER MOST:
 *   - Mutations are refused (fail closed), including by direct API call
 *     with no UI involved.
 *   - Reads still work and the DATA IS STILL THERE. An expired tenant must
 *     be able to see their own academies, courses and pages — "your
 *     subscription ended" must never look like "your data is gone".
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedOrganizationWithOwner,
  seedPlan,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

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

describe('Subscription expiration enforcement (e2e)', () => {
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

  /** An academy with a real, working subscription and a real page to edit. */
  async function seedTenant(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    await seedActiveSubscriptionForOrg(admin, org.id, `${label}-plan`);

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    return { owner, org, academy, page: pages.body.items[0] };
  }

  /** Moves the tenant into a terminal state, exactly as the sweep would. */
  async function expire(organizationId: string) {
    await admin.tenantSubscription.update({
      where: { organizationId },
      data: { status: 'expired', trialEndsAt: null },
    });
  }

  /** A trial whose clock has run out but which the sweep has not yet flipped. */
  async function endTrialWithoutSweeping(organizationId: string) {
    await admin.tenantSubscription.update({
      where: { organizationId },
      data: {
        status: 'trialing',
        trialEndsAt: new Date(Date.now() - 60 * 60 * 1000),
      },
    });
  }

  // --- Mutations are refused ------------------------------------------------

  /**
   * The page's current concurrency token.
   *
   * `expectedVersion` is required on every page update (see
   * `WebsitePagesService.update` for why the old lenient path was closed), and
   * these tests are not about concurrency — they are about entitlement,
   * isolation and validation. Reading the version immediately before each
   * write keeps them focused on what they actually assert, instead of
   * bookkeeping a counter that every earlier write in the test moves.
   */
  async function pageVersion(
    academyId: string,
    pageId: string,
    token: string,
  ): Promise<number> {
    const res = await request(app.getHttpServer())
      .get(`/academies/${academyId}/website/pages/${pageId}`)
      .set('Authorization', `Bearer ${token}`);
    return res.body.version as number;
  }

  it('refuses a website page edit once the subscription is expired', async () => {
    const { owner, org, academy, page } = await seedTenant('exp-page');

    // Works while the subscription is active.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Before expiry', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(200);

    await expire(org.id);

    const refused = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'After expiry', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(403);

    expect(refused.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
    expect(refused.body.error.details.reason).toBe('expired');
  });

  it('refuses publishing the website once expired', async () => {
    const { owner, org, academy } = await seedTenant('exp-publish');
    await expire(org.id);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });

  it('refuses authoring an academy announcement once expired', async () => {
    const { owner, org, academy } = await seedTenant('exp-ann');
    await expire(org.id);

    const refused = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/announcements`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Should not post', body: 'No.' })
      .expect(403);

    expect(refused.body.error.code).toBe('SUBSCRIPTION_REQUIRED');
  });

  it('refuses a media upload once expired', async () => {
    const { owner, org, academy } = await seedTenant('exp-media');
    await expire(org.id);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'x.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        dataUrl: 'data:image/png;base64,iVBORw0KGgo=',
      })
      .expect(403);
  });

  /*
   * The sweep runs on a schedule. Between a trial ending and the sweep
   * noticing, `status` still reads `trialing` and is simply wrong —
   * enforcing on the DATE closes that window instead of depending on a
   * background job having run.
   */
  it('refuses mutations for a trial whose clock ran out before the sweep noticed', async () => {
    const { owner, org, academy, page } = await seedTenant('exp-trial-window');
    await endTrialWithoutSweeping(org.id);

    const refused = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'During the gap', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(403);

    expect(refused.body.error.details.reason).toBe('trial_ended');
  });

  // --- Reads, and the data itself, survive ---------------------------------

  it('still serves every read, and the data is all still there', async () => {
    const { owner, org, academy, page } = await seedTenant('exp-reads');
    await expire(org.id);

    const pages = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/pages`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(pages.body.items.map((p: { id: string }) => p.id)).toContain(page.id);

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    // The rows themselves are untouched — nothing was deleted or archived.
    const stillThere = await admin.websitePage.count({
      where: { academyId: academy.id },
    });
    expect(stillThere).toBeGreaterThan(0);
    const academyRow = await admin.academy.findUnique({ where: { id: academy.id } });
    expect(academyRow?.status).not.toBe('archived');
  });

  it('still lets an expired tenant read its own subscription, to see what lapsed', async () => {
    const { owner, org } = await seedTenant('exp-billing-read');
    await expire(org.id);

    const subscription = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/subscription`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(subscription.body.status).toBe('expired');
  });

  // --- The recovery path stays open ----------------------------------------

  /*
   * Locking an expired tenant out of everything includes locking them out
   * of paying, which turns a recoverable billing problem into a lost
   * customer. These are the routes that END the expired state.
   */
  it('still allows a checkout to be created, so the customer can pay', async () => {
    const { owner, org } = await seedTenant('exp-checkout');
    const plan = await seedPlan(admin, `exp-checkout-target-${Date.now()}`);
    await expire(org.id);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/checkouts`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        target: { type: 'plan_subscription', planKey: plan.key },
        billingCycle: 'monthly',
        idempotencyKey: `exp-checkout-${Date.now()}`,
      })
      .expect(201);
  });

  it('still allows an expired tenant to open a support case', async () => {
    const { owner, org } = await seedTenant('exp-support');
    await expire(org.id);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/support-cases`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        subject: 'My subscription lapsed',
        description: 'I need help restoring access.',
      })
      .expect(201);
  });

  it('never blocks signing out or signing back in', async () => {
    const { owner, org } = await seedTenant('exp-auth');
    await expire(org.id);

    // Auth carries no tenant scope at all, so the interceptor never
    // engages — asserted rather than assumed, because locking a customer
    // out of their own account over billing would be the worst outcome here.
    await request(app.getHttpServer())
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(org.id).toBeTruthy();
  });

  // --- Isolation ------------------------------------------------------------

  it("one organization's expiry never affects another's access", async () => {
    const expired = await seedTenant('exp-iso-a');
    const healthy = await seedTenant('exp-iso-b');
    await expire(expired.org.id);

    await request(app.getHttpServer())
      .patch(`/academies/${expired.academy.id}/website/pages/${expired.page.id}`)
      .set('Authorization', `Bearer ${expired.owner.accessToken}`)
      .send({ title: 'Refused', expectedVersion: await pageVersion(expired.academy.id, expired.page.id, expired.owner.accessToken) })
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/academies/${healthy.academy.id}/website/pages/${healthy.page.id}`)
      .set('Authorization', `Bearer ${healthy.owner.accessToken}`)
      .send({ title: 'Still fine', expectedVersion: await pageVersion(healthy.academy.id, healthy.page.id, healthy.owner.accessToken) })
      .expect(200);
  });

  it('restores access the moment the subscription is active again', async () => {
    const { owner, org, academy, page } = await seedTenant('exp-reactivate');
    await expire(org.id);

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Refused', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(403);

    await admin.tenantSubscription.update({
      where: { organizationId: org.id },
      data: {
        status: 'active',
        currentPeriodEnd: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    // No cache to wait out on the dashboard path — the check is live there,
    // and only the PUBLIC runtime trades a minute of staleness for traffic.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Working again', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(200);
  });

  // --- Grace period is not expiry ------------------------------------------

  /*
   * A grace period exists so that a tenant whose payment is late keeps
   * working while it is sorted out. Treating it as expired would defeat the
   * feature Atlas already models and punish the customer for the gap
   * between a failed charge and a retry.
   */
  it('does NOT lock a tenant in its grace period', async () => {
    const { owner, org, academy, page } = await seedTenant('exp-grace');
    await admin.tenantSubscription.update({
      where: { organizationId: org.id },
      data: {
        status: 'grace_period',
        graceEndsAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      },
    });

    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/website/pages/${page.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ title: 'Still allowed during grace', expectedVersion: await pageVersion(academy.id, page.id, owner.accessToken) })
      .expect(200);
  });
});
