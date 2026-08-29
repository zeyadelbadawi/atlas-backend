/**
 * `POST /organizations` e2e — Phase P19 (`Reports/
 * DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-1/P0-2). Real Organization creation,
 * previously missing entirely: no controller/service/repository method
 * existed anywhere, and every membership this codebase ever created
 * (real or seeded) had a hardcoded, always-empty `permissions` array.
 * This suite proves both are genuinely fixed — through the real API, not
 * a fixture bypass — and that tenant isolation/authorization around the
 * new endpoint hold.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

describe('POST /organizations (e2e) — Phase P19', () => {
  let app: INestApplication;
  // Deliberately the elevated admin connection (`createAdminPrisma`,
  // `DATABASE_URL`), NOT the app's own RLS-governed `PrismaService` — a
  // plain `.findUnique()` outside any `runInTenantContext` has no
  // `app.current_organization_id` set, so RLS correctly (fail-closed)
  // returns nothing. Verification reads use the same admin-connection
  // pattern every other e2e spec file in this codebase already
  // establishes (see `test/utils/db-admin.ts`'s own doc comment).
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

  // Real Postgres, shared across e2e runs with no per-run reset (same
  // rationale as `uniqueTestEmail`) — a fixed literal name would collide
  // with a leftover row from a previous run of this exact file.
  function uniqueOrgName(label: string): string {
    return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function signUpAndSignIn(label: string) {
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

  it('1: rejects an unauthenticated request', async () => {
    await request(app.getHttpServer())
      .post('/organizations')
      .send({ name: 'No Auth Org' })
      .expect(401);
  });

  it('2: a real, brand-new user (zero prior organizations) can create one', async () => {
    const client = await signUpAndSignIn('org-create-fresh');
    const name = uniqueOrgName('Fresh Client Academy Group');

    const response = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({ name })
      .expect(201);

    expect(response.body).toMatchObject({
      name,
      status: 'active',
      ownerUserId: client.userId,
    });
    expect(response.body.slug).toBeTruthy();
    expect(response.body.id).toBeTruthy();

    // The real DB row — owner_user_id set exactly as the RLS insert
    // policy requires (`organizations_insert`: owner_user_id =
    // app.current_user_id).
    const org = await admin.organization.findUnique({
      where: { id: response.body.id },
    });
    expect(org?.ownerUserId).toBe(client.userId);
  });

  it('3: the creator becomes a real owner-role member with a non-empty, real permission set — closing the P0-2 gap', async () => {
    const client = await signUpAndSignIn('org-create-permissions');

    const created = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({ name: uniqueOrgName('Permission Check Org') })
      .expect(201);

    const membership = await admin.organizationMembership.findFirst({
      where: { organizationId: created.body.id, userId: client.userId },
    });
    expect(membership).toMatchObject({ role: 'owner', isPrimary: true });
    // The exact regression the audit found live: this used to always be
    // `[]`, for every membership ever created, anywhere.
    expect(membership?.permissions.length).toBeGreaterThan(0);
    expect(membership?.permissions).toEqual(
      expect.arrayContaining(['tenant.subscription.view', 'academy.provisioning.create']),
    );

    // The real session shape a fresh sign-in now returns — what
    // `RouteGuard`'s `organization.permissions.includes(...)` check on
    // the frontend actually reads.
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email: (await admin.user.findUnique({ where: { id: client.userId } }))!.email,
        password: 'correct-horse-battery',
      })
      .expect(200);
    const orgMembership = signIn.body.user.organizationMemberships.find(
      (m: { organizationId: string }) => m.organizationId === created.body.id,
    );
    expect(orgMembership.permissions.length).toBeGreaterThan(0);
  });

  it('4: a duplicate organization name does not collide — slug is uniquified, never a hard failure', async () => {
    const clientA = await signUpAndSignIn('org-create-dup-a');
    const clientB = await signUpAndSignIn('org-create-dup-b');
    // Deliberately the SAME name for both creates below — that collision
    // is exactly what this test proves is handled gracefully. Still
    // unique across repeated runs of this file (real, persistent
    // Postgres, no reset) via `uniqueOrgName`.
    const sharedName = uniqueOrgName('Shared Name Academy');

    const first = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${clientA.accessToken}`)
      .send({ name: sharedName })
      .expect(201);

    const second = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${clientB.accessToken}`)
      .send({ name: sharedName })
      .expect(201);

    expect(second.body.slug).not.toBe(first.body.slug);
  });

  it('5: rejects an empty name (validation, not a silent create)', async () => {
    const client = await signUpAndSignIn('org-create-invalid');

    await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({ name: '' })
      .expect(400);
  });

  it('6: tenant isolation — a different user cannot read the new organization', async () => {
    const owner = await signUpAndSignIn('org-create-owner');
    const stranger = await signUpAndSignIn('org-create-stranger');

    const created = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: uniqueOrgName('Isolated Org') })
      .expect(201);

    // `stranger` has no membership in this org at all — every
    // `/organizations/:id/*` route must fail closed
    // (`OrganizationMembershipGuard`), never leak existence.
    await request(app.getHttpServer())
      .get(`/organizations/${created.body.id}/subscription`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);
  });

  it('7: a brand-new organization honestly reports "no subscription yet" — never a fabricated default', async () => {
    const client = await signUpAndSignIn('org-create-no-sub');

    const created = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({ name: uniqueOrgName('Unpaid Org') })
      .expect(201);

    const response = await request(app.getHttpServer())
      .get(`/organizations/${created.body.id}/subscription`)
      .set('Authorization', `Bearer ${client.accessToken}`)
      .expect(404);
    expect(response.body.error.messageKey).toBe('errors.tenant.noSubscription');
  });

  it('8: provisioning is blocked for a real organization with no active subscription — the payment gate cannot be bypassed by knowing the organization id', async () => {
    const client = await signUpAndSignIn('org-create-no-provisioning');

    const created = await request(app.getHttpServer())
      .post('/organizations')
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({ name: uniqueOrgName('Unpaid Provisioning Org') })
      .expect(201);

    const response = await request(app.getHttpServer())
      .post(`/organizations/${created.body.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${client.accessToken}`)
      .send({
        academyName: 'Should Not Provision',
        requestedSubdomain: `no-sub-${Date.now()}`,
        idempotencyKey: `no-sub-idem-${Date.now()}`,
      })
      .expect(409);
    expect(response.body.error.messageKey).toBe(
      'errors.provisioning.subscriptionRequired',
    );
  });
});
