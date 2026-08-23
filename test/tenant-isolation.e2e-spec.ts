/**
 * Tenant-isolation suite — CI-blocking from Phase P2 onward (master plan
 * §18). Scenarios 1–5 exercised through the REAL HTTP surface (guards +
 * services + RLS all engaged together); scenario 6 (pure DB-level RLS,
 * bypassing guards/services entirely) lives in
 * `rls-organizations.e2e-spec.ts`.
 *
 * Test fixtures are seeded with a dedicated superuser Prisma connection
 * (`test/utils/db-admin.ts`), never through the app's own restricted
 * `atlas_app` connection — the narrowed RLS INSERT policies (see
 * `prisma/migrations/20260823184500_p2_narrow_insert_rls_policies`)
 * intentionally do not support "seed an arbitrary org+membership graph for
 * a test," any more than a real onboarding/provisioning flow (Phase P14,
 * out of scope) would run through the same low-privilege runtime role.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; email: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  const register = await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  void register;
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, email, accessToken: signIn.body.accessToken };
}

describe('Tenant isolation (e2e) — scenarios 1-5', () => {
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

  // This file alone signs in well over the default per-IP sign-in rate
  // limit across its scenarios — flushing between tests (not just once at
  // file start) keeps that a non-issue without touching the real limit.
  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  it('SCENARIO 1: User A (member of Org 1 only) GETs Org 2 by direct id -> 403/404, never 200', async () => {
    const userA = await signUpAndSignIn(app, 'scenario1-userA');
    const userB = await signUpAndSignIn(app, 'scenario1-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'scenario1-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 'scenario1-org2');
    void org1;

    const response = await request(app.getHttpServer())
      .get(`/organizations/${org2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);

    expect([403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  it("SCENARIO 2: no crafted parameter ever widens a user's own-organizations read to include another tenant", async () => {
    const userA = await signUpAndSignIn(app, 'scenario2-userA');
    const userB = await signUpAndSignIn(app, 'scenario2-userB');
    const orgA = await seedOrganizationWithOwner(admin, userA.userId, 'scenario2-orgA');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'scenario2-orgB');

    // `GET /users/me` accepts no organization-scoping parameter at all —
    // proving that attempting to smuggle one in has no effect is itself
    // the point: there is no filter surface to craft against.
    const response = await request(app.getHttpServer())
      .get('/users/me')
      .query({
        organizationId: orgB.id,
        organization_id: orgB.id,
        filter: `org:${orgB.id}`,
      })
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const visibleOrgIds = response.body.organizations.map(
      (o: { organizationId: string }) => o.organizationId,
    );
    expect(visibleOrgIds).toEqual([orgA.id]);
    expect(visibleOrgIds).not.toContain(orgB.id);
  });

  it('SCENARIO 3: PATCH/DELETE against an Org 2 resource never succeeds — no such mutation route exists', async () => {
    const userA = await signUpAndSignIn(app, 'scenario3-userA');
    const userB = await signUpAndSignIn(app, 'scenario3-userB');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'scenario3-orgB');

    const patchResponse = await request(app.getHttpServer())
      .patch(`/organizations/${orgB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ name: 'Hijacked Name' });
    expect(patchResponse.status).toBe(404); // route does not exist — structurally impossible, not merely denied.

    const deleteResponse = await request(app.getHttpServer())
      .delete(`/organizations/${orgB.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(deleteResponse.status).toBe(404);

    // The organization is provably untouched.
    const stillIntact = await admin.organization.findUniqueOrThrow({
      where: { id: orgB.id },
    });
    expect(stillIntact.name).toBe(orgB.name);
  });

  it('SCENARIO 4: a user in Org 1 AND Org 2 can access both; a user not in Org 3 cannot access it', async () => {
    const userA = await signUpAndSignIn(app, 'scenario4-userA');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 'scenario4-org1');
    // userA is also owner of a second organization — the real backend
    // equivalent of "belongs to two organizations."
    const org2 = await seedOrganizationWithOwner(admin, userA.userId, 'scenario4-org2');
    const otherUser = await signUpAndSignIn(app, 'scenario4-other');
    const org3 = await seedOrganizationWithOwner(
      admin,
      otherUser.userId,
      'scenario4-org3',
    );

    await request(app.getHttpServer())
      .get(`/organizations/${org1.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .get(`/organizations/${org2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const forbidden = await request(app.getHttpServer())
      .get(`/organizations/${org3.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(forbidden.status);
  });

  it('SCENARIO 5: concurrent requests for different organizations never cross-contaminate', async () => {
    const userA = await signUpAndSignIn(app, 'scenario5-userA');
    const userB = await signUpAndSignIn(app, 'scenario5-userB');
    const orgA = await seedOrganizationWithOwner(admin, userA.userId, 'scenario5-orgA');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 'scenario5-orgB');

    const ROUNDS = 15;
    const requests = Array.from({ length: ROUNDS }, (_, i) =>
      i % 2 === 0
        ? request(app.getHttpServer())
            .get(`/organizations/${orgA.id}`)
            .set('Authorization', `Bearer ${userA.accessToken}`)
            .then((res) => ({ expected: orgA.id, res }))
        : request(app.getHttpServer())
            .get(`/organizations/${orgB.id}`)
            .set('Authorization', `Bearer ${userB.accessToken}`)
            .then((res) => ({ expected: orgB.id, res })),
    );

    const results = await Promise.all(requests);

    for (const { expected, res } of results) {
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(expected);
    }
  });

  it("sanity: a random, never-seeded organization id is also rejected (not just other tenants' real orgs)", async () => {
    const userA = await signUpAndSignIn(app, 'scenario-sanity-userA');
    const response = await request(app.getHttpServer())
      .get(`/organizations/${randomUUID()}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(response.status);
  });
});
