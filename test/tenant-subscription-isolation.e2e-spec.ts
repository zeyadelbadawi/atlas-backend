/**
 * Tenant Subscription/Usage/Add-ons tenant-isolation suite — P4-TENANT-001
 * onward, extending the permanent tenant-isolation suite established in
 * `tenant-isolation.e2e-spec.ts` (P2) and `academies-tenant-isolation.
 * e2e-spec.ts` (P3), one file per phase, same pattern. Exercised through
 * the real HTTP surface; the pure DB-level RLS proof lives in
 * `rls-tenant-subscriptions.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAddOn,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantAddOn,
  seedTenantSubscription,
} from './utils/db-admin';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';
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

describe('Tenant Subscription/Usage/Add-ons tenant isolation (e2e) — P4-TENANT-001..007', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let recomputeService: TenantUsageRecomputeService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    recomputeService = app.get(TenantUsageRecomputeService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it("P4-TENANT-001: User A (org1 member) cannot read org2's subscription by direct id", async () => {
    const userA = await signUpAndSignIn(app, 'p4t001-userA');
    const userB = await signUpAndSignIn(app, 'p4t001-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 'p4t001-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p4t001-org2');
    const plan = await seedPlan(admin, 'p4t001-plan');
    await seedTenantSubscription(admin, org2.id, plan.id);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org2.id}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(403);
  });

  it("P4-TENANT-002: no crafted parameter ever widens org1's usage read to include org2's data", async () => {
    const userA = await signUpAndSignIn(app, 'p4t002-userA');
    const userB = await signUpAndSignIn(app, 'p4t002-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p4t002-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p4t002-org2');
    const plan1 = await seedPlan(admin, 'p4t002-plan1');
    const plan2 = await seedPlan(admin, 'p4t002-plan2');
    await seedTenantSubscription(admin, org1.id, plan1.id);
    await seedTenantSubscription(admin, org2.id, plan2.id);
    await recomputeService.recomputeOne(org1.id);
    await recomputeService.recomputeOne(org2.id);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org1.id}/usage`)
      .query({ organizationId: org2.id, filter: `org:${org2.id}` })
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    expect(response.body.organizationId).toBe(org1.id);
  });

  it("P4-TENANT-003: PATCH/DELETE against org2's subscription/usage never succeeds — no such mutation route exists", async () => {
    const userA = await signUpAndSignIn(app, 'p4t003-userA');
    const userB = await signUpAndSignIn(app, 'p4t003-userB');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p4t003-org2');

    const patchResponse = await request(app.getHttpServer())
      .patch(`/organizations/${org2.id}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ status: 'active' });
    expect(patchResponse.status).toBe(404);

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/organizations/${org2.id}/usage`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(deleteResponse.status).toBe(404);
  });

  it('P4-TENANT-004: a user in org1 AND org2 can read subscriptions for both; a user not in org3 cannot', async () => {
    const userA = await signUpAndSignIn(app, 'p4t004-userA');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'p4t004-org1');
    const org2 = await seedOrganizationWithOwner(admin, userA.userId, 'p4t004-org2');
    const plan1 = await seedPlan(admin, 'p4t004-plan1');
    const plan2 = await seedPlan(admin, 'p4t004-plan2');
    await seedTenantSubscription(admin, org1.id, plan1.id);
    await seedTenantSubscription(admin, org2.id, plan2.id);

    const otherUser = await signUpAndSignIn(app, 'p4t004-other');
    const org3 = await seedOrganizationWithOwner(admin, otherUser.userId, 'p4t004-org3');
    const plan3 = await seedPlan(admin, 'p4t004-plan3');
    await seedTenantSubscription(admin, org3.id, plan3.id);

    await request(app.getHttpServer())
      .get(`/organizations/${org1.id}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/organizations/${org2.id}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const forbidden = await request(app.getHttpServer())
      .get(`/organizations/${org3.id}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(forbidden.status).toBe(403);
  });

  it("P4-TENANT-005: concurrent requests for different organizations' usage never cross-contaminate", async () => {
    const userA = await signUpAndSignIn(app, 'p4t005-userA');
    const userB = await signUpAndSignIn(app, 'p4t005-userB');
    const orgA = await seedOrganizationWithOwner(admin, userA.userId, 'p4t005-orgA');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'p4t005-orgB');
    const planA = await seedPlan(admin, 'p4t005-planA');
    const planB = await seedPlan(admin, 'p4t005-planB');
    await seedTenantSubscription(admin, orgA.id, planA.id);
    await seedTenantSubscription(admin, orgB.id, planB.id);
    await recomputeService.recomputeOne(orgA.id);
    await recomputeService.recomputeOne(orgB.id);

    const ROUNDS = 15;
    const requests = Array.from({ length: ROUNDS }, (_, i) =>
      i % 2 === 0
        ? request(app.getHttpServer())
            .get(`/organizations/${orgA.id}/usage`)
            .set('Authorization', `Bearer ${userA.accessToken}`)
            .then((res) => ({ expected: orgA.id, res }))
        : request(app.getHttpServer())
            .get(`/organizations/${orgB.id}/usage`)
            .set('Authorization', `Bearer ${userB.accessToken}`)
            .then((res) => ({ expected: orgB.id, res })),
    );

    const results = await Promise.all(requests);
    for (const { expected, res } of results) {
      expect(res.status).toBe(200);
      expect(res.body.organizationId).toBe(expected);
    }
  });

  it('P4-TENANT-006: GET .../add-ons against org2 from userA (org1) never leaks add-on rows', async () => {
    const userA = await signUpAndSignIn(app, 'p4t006-userA');
    const userB = await signUpAndSignIn(app, 'p4t006-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 'p4t006-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'p4t006-org2');
    const addOn = await seedAddOn(
      admin,
      'p4t006-addon',
      { type: 'feature', featureKey: 'backup' },
      [],
    );
    await seedTenantAddOn(admin, org2.id, addOn.id);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org2.id}/add-ons`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(403);
  });

  it("P4-TENANT-007: a random, never-seeded organization id is also rejected (not just other tenants' real orgs)", async () => {
    const userA = await signUpAndSignIn(app, 'p4t007-userA');
    const response = await request(app.getHttpServer())
      .get(`/organizations/${randomUUID()}/subscription`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(403);
  });
});
