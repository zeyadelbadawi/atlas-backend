/**
 * Organization Payment Configuration tenant-isolation suite —
 * P12.5-TENANT-001..006 (master plan §18), extending the permanent
 * tenant-isolation suite established in `tenant-isolation.e2e-spec.ts`
 * (P2) through `billing-tenant-isolation.e2e-spec.ts` (P12) — one file per
 * phase, same pattern. Exercised through the real HTTP surface.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
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

async function makePlatformOwner(admin: PrismaClient, userId: string): Promise<void> {
  await admin.user.update({ where: { id: userId }, data: { isPlatformOwner: true } });
}

describe('Organization Payment Configuration tenant isolation (e2e) — P12.5-TENANT-001..006', () => {
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

  async function seedOrgWithOwner(label: string) {
    const owner = await signUpAndSignIn(app, label);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    return { owner, org };
  }

  it("P12.5-TENANT-001: an Organization B member cannot read Organization A's payment-collection mode through Organization B's own URL", async () => {
    const { owner: ownerA, org: orgA } = await seedOrgWithOwner('t125-001-a');
    await request(app.getHttpServer())
      .patch(`/organizations/${orgA.id}/payment-settings`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);

    const { owner: ownerB, org: orgB } = await seedOrgWithOwner('t125-001-b');

    // B reading through B's own URL never surfaces A's mode — RLS scopes
    // strictly to `organization_id`, not to "any org the caller can see."
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payment-settings`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(res.body.paymentCollectionMode).toBe('unconfigured');
    expect(res.body.organizationId).toBe(orgB.id);
  });

  it("P12.5-TENANT-002: an Organization B member cannot write Organization A's payment-collection mode by supplying Organization A's id under Organization B's own membership context", async () => {
    const { org: orgA } = await seedOrgWithOwner('t125-002-a');
    const { owner: ownerB } = await seedOrgWithOwner('t125-002-b');

    // ownerB is not a member of orgA — OrganizationMembershipGuard rejects before the handler ever runs.
    await request(app.getHttpServer())
      .patch(`/organizations/${orgA.id}/payment-settings`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(403);

    const stillUnconfigured = await admin.organizationPaymentSettings.findUnique({
      where: { organizationId: orgA.id },
    });
    expect(stillUnconfigured).toBeNull();
  });

  it("P12.5-TENANT-003: an Organization B member cannot read Organization A's gateway-credential status through Organization B's own URL", async () => {
    const { owner: ownerA, org: orgA } = await seedOrgWithOwner('t125-003-a');
    await request(app.getHttpServer())
      .patch(`/organizations/${orgA.id}/payment-settings`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ paymentCollectionMode: 'organization_gateway' })
      .expect(200);

    const { owner: ownerB, org: orgB } = await seedOrgWithOwner('t125-003-b');

    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payment-settings/gateway-credentials`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(res.body.organizationId).toBe(orgB.id);
    expect(res.body.status).toBe('not_configured');
  });

  it("P12.5-TENANT-004: an Organization B member cannot read Organization A's connected-account status through Organization B's own URL", async () => {
    const { org: orgA } = await seedOrgWithOwner('t125-004-a');
    const { owner: ownerB, org: orgB } = await seedOrgWithOwner('t125-004-b');
    void orgA;

    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payment-settings/connected-account`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(res.body.organizationId).toBe(orgB.id);
  });

  it("P12.5-TENANT-005: an Organization B member reading its own commission visibility never sees Organization A's override", async () => {
    const reviewer = await signUpAndSignIn(app, 't125-005-reviewer');
    await makePlatformOwner(admin, reviewer.userId);

    const { org: orgA } = await seedOrgWithOwner('t125-005-a');
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${orgA.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ commissionMode: 'custom', customPercentageBasisPoints: 4242 })
      .expect(200);

    const { owner: ownerB, org: orgB } = await seedOrgWithOwner('t125-005-b');
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgB.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);

    expect(res.body.commissionMode).toBe('default');
    expect(res.body.customPercentageBasisPoints).toBeNull();
  });

  it('P12.5-TENANT-006: a non-platform-owner cannot reach the flat /platform-commission surface for any organization, including their own', async () => {
    const { owner, org } = await seedOrgWithOwner('t125-006');

    await request(app.getHttpServer())
      .get(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);
  });
});
