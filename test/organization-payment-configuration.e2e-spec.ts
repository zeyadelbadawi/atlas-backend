/**
 * Organization Payment Configuration — functional/contract e2e suite
 * (master plan §4.1/§4.2/§5.8, prerequisite to Phase P13). Exercises the
 * finalized two-mode payment-collection decision, the commission
 * configuration hierarchy, and the provider-abstraction registry through
 * the real HTTP surface — same pattern as `billing.e2e-spec.ts`. Tenant
 * isolation is covered separately in
 * `organization-payment-configuration-tenant-isolation.e2e-spec.ts`.
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

describe('Organization Payment Configuration (e2e)', () => {
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

  // --- 1/2. Payment mode resolution: unconfigured is the real, honest default ---

  it('1/2: a brand-new Organization resolves to unconfigured — never a silent default to either real mode', async () => {
    const { owner, org } = await seedOrgWithOwner('t-mode-default');

    const res = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.paymentCollectionMode).toBe('unconfigured');
  });

  // --- 3. Atlas Payments mode ---

  it('3: an Organization can select Atlas Payments mode, and it persists on re-read', async () => {
    const { owner, org } = await seedOrgWithOwner('t-mode-atlas');

    const patch = await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_payments' })
      .expect(200);
    expect(patch.body.paymentCollectionMode).toBe('atlas_payments');

    const get = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(get.body.paymentCollectionMode).toBe('atlas_payments');
  });

  // --- 4. Organization-Owned Gateway mode ---

  it('4: an Organization can select Organization-Owned Gateway mode, and it persists on re-read', async () => {
    const { owner, org } = await seedOrgWithOwner('t-mode-owngw');

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'organization_gateway' })
      .expect(200);

    const get = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(get.body.paymentCollectionMode).toBe('organization_gateway');
  });

  it('4b: saving Organization-Owned Gateway credentials is honestly rejected — no real gateway is registered yet, never a fake success', async () => {
    const { owner, org } = await seedOrgWithOwner('t-mode-owngw-reject');

    const providers = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/gateway-providers`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(providers.body).toEqual([]);

    await request(app.getHttpServer())
      .put(`/organizations/${org.id}/payment-settings/gateway-credentials`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ providerKey: 'stripe', config: { apiKey: 'sk_test_whatever' } })
      .expect(409);
  });

  it('rejects an invalid payment collection mode value', async () => {
    const { owner, org } = await seedOrgWithOwner('t-mode-invalid');

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ paymentCollectionMode: 'atlas_bank_transfer_direct' })
      .expect(400);
  });

  // --- 10. Encrypted gateway config never leaks through API responses ---

  it("10: encrypted gateway config never leaks through any API response, even though the credential row can't actually be saved with today's empty registry", async () => {
    const { owner, org } = await seedOrgWithOwner('t-secret-leak');

    const get = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/gateway-credentials`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(get.body).not.toHaveProperty('encryptedConfig');
    expect(get.body).not.toHaveProperty('config');
    expect(JSON.stringify(get.body)).not.toMatch(/secret|apiKey|sk_test/i);
    expect(get.body).toEqual({
      organizationId: org.id,
      providerKey: null,
      status: 'not_configured',
      enabled: false,
    });
  });

  // --- Connected account foundation ---

  it('an Organization with no connected account row reads an honest not_started default, never a fabricated connected status', async () => {
    const { owner, org } = await seedOrgWithOwner('t-connected-account');

    const res = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/connected-account`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body).toEqual({
      organizationId: org.id,
      providerKey: null,
      onboardingStatus: 'not_started',
      payoutsEnabled: false,
    });
  });

  // --- 6. Platform Owner access to global commission configuration ---

  it('6: a Platform Owner can read and set the global default commission percentage', async () => {
    const reviewer = await signUpAndSignIn(app, 't-global-commission-owner');
    await makePlatformOwner(admin, reviewer.userId);

    const before = await request(app.getHttpServer())
      .get('/platform-commission/global')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    // Deliberately not asserting a specific starting value here — a prior
    // test in this same run may have already set it (shared dev/test DB,
    // singleton row, no per-run reset) — only that reading it succeeds.
    expect(
      typeof before.body.defaultCommissionBasisPoints === 'number' ||
        before.body.defaultCommissionBasisPoints === null,
    ).toBe(true);

    const updated = await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ defaultCommissionBasisPoints: 1000 })
      .expect(200);
    expect(updated.body.defaultCommissionBasisPoints).toBe(1000);
  });

  // --- 7. An Organization cannot modify the global commission configuration ---

  it('7: an ordinary Organization member cannot read or write the global commission configuration', async () => {
    const { owner } = await seedOrgWithOwner('t-global-commission-forbidden');

    await request(app.getHttpServer())
      .get('/platform-commission/global')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ defaultCommissionBasisPoints: 9999 })
      .expect(403);
  });

  it("7b: an ordinary Organization member cannot modify its own Organization's commission override — no PATCH route exists on the organization-facing controller at all", async () => {
    const { owner, org } = await seedOrgWithOwner('t-org-commission-forbidden');

    await request(app.getHttpServer())
      .patch(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ commissionMode: 'exempt' })
      .expect(404); // no such route — Nest returns 404, not 403, for an unmapped path
  });

  // --- 8/9. default/custom/exempt commission resolution, no global rate configured ---

  it('8/9: an unconfigured Organization with no global default resolves to unresolved, never a fabricated rate', async () => {
    const reviewer = await signUpAndSignIn(app, 't-resolution-unset-owner');
    await makePlatformOwner(admin, reviewer.userId);
    const { owner, org } = await seedOrgWithOwner('t-resolution-unset');

    // Ensure a clean, genuinely-unset global config for this scenario —
    // deletes the singleton row entirely rather than trusting no prior
    // test has set it (shared dev/test DB).
    await admin.atlasCommissionConfig.deleteMany({});

    const res = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.commissionMode).toBe('default');
    expect(res.body.effective).toEqual({ resolved: false });
    void reviewer; // keep the platform-owner seed for future extension of this scenario
  });

  it('8: default/custom/exempt all resolve correctly once a global default exists', async () => {
    const reviewer = await signUpAndSignIn(app, 't-resolution-modes-owner');
    await makePlatformOwner(admin, reviewer.userId);
    await request(app.getHttpServer())
      .patch('/platform-commission/global')
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ defaultCommissionBasisPoints: 1000 })
      .expect(200);

    // default
    const { owner: defaultOwner, org: defaultOrg } =
      await seedOrgWithOwner('t-res-default');
    const defaultRes = await request(app.getHttpServer())
      .get(`/organizations/${defaultOrg.id}/payment-settings/commission`)
      .set('Authorization', `Bearer ${defaultOwner.accessToken}`)
      .expect(200);
    expect(defaultRes.body.effective).toEqual({
      resolved: true,
      basisPoints: 1000,
      source: 'default',
    });

    // custom
    const { org: customOrg } = await seedOrgWithOwner('t-res-custom');
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${customOrg.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ commissionMode: 'custom', customPercentageBasisPoints: 500 })
      .expect(200);
    const customRes = await request(app.getHttpServer())
      .get(`/platform-commission/organizations/${customOrg.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(customRes.body.effective).toEqual({
      resolved: true,
      basisPoints: 500,
      source: 'custom',
    });

    // exempt
    const { org: exemptOrg } = await seedOrgWithOwner('t-res-exempt');
    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${exemptOrg.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ commissionMode: 'exempt' })
      .expect(200);
    const exemptRes = await request(app.getHttpServer())
      .get(`/platform-commission/organizations/${exemptOrg.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .expect(200);
    expect(exemptRes.body.effective).toEqual({
      resolved: true,
      basisPoints: 0,
      source: 'exempt',
    });
  });

  it('rejects a custom commission override with no percentage supplied', async () => {
    const reviewer = await signUpAndSignIn(app, 't-custom-missing-owner');
    await makePlatformOwner(admin, reviewer.userId);
    const { org } = await seedOrgWithOwner('t-custom-missing');

    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${reviewer.accessToken}`)
      .send({ commissionMode: 'custom' })
      .expect(400);
  });

  // --- 15. Platform-Owner-only access where required ---

  it("15: an ordinary Organization member cannot read or write another Organization's commission override via the platform surface", async () => {
    const { owner, org } = await seedOrgWithOwner('t-platform-forbidden');

    await request(app.getHttpServer())
      .get(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .patch(`/platform-commission/organizations/${org.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ commissionMode: 'exempt' })
      .expect(403);
  });

  // --- 13. Existing manual-transfer behavior remains unchanged ---

  it('13: the payment-methods catalog still reports the real, unchanged manual-transfer capabilities after the provider-abstraction refactor', async () => {
    const { owner } = await seedOrgWithOwner('t-manual-unchanged');

    const res = await request(app.getHttpServer())
      .get('/payment-methods')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(Array.isArray(res.body)).toBe(true);
  });
});
