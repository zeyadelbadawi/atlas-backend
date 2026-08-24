/**
 * Academy tenant-isolation suite — P3-TENANT-001..010 (master plan §18,
 * extended one level from `tenant-isolation.e2e-spec.ts`'s P2 scenarios).
 * Exercised through the real HTTP surface (guards + services + RLS all
 * engaged together); the pure DB-level RLS proof lives in
 * `rls-academies.e2e-spec.ts`.
 *
 * Fixtures are seeded with the dedicated superuser Prisma connection
 * (`test/utils/db-admin.ts`) — see that file's doc comment for why.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedMembership,
  seedAcademy,
  seedAcademyMember,
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

describe('Academy tenant isolation (e2e) — P3-TENANT-001..010', () => {
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

  it("P3-TENANT-001: User A (org1 member) GETs org2's academy by direct id -> 403/404, never 200", async () => {
    const userA = await signUpAndSignIn(app, 't001-userA');
    const userB = await signUpAndSignIn(app, 't001-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 't001-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't001-org2');
    void org1;
    const academy2 = await seedAcademy(admin, org2.id, 't001-a2');
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(response.status);
    expect(response.status).not.toBe(200);
  });

  it('P3-TENANT-002: GET /academies?organizationId=<org the caller is not a member of> -> 403', async () => {
    const userA = await signUpAndSignIn(app, 't002-userA');
    const userB = await signUpAndSignIn(app, 't002-userB');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't002-org2');

    const response = await request(app.getHttpServer())
      .get('/academies')
      .query({ organizationId: org2.id })
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect(response.status).toBe(403);
  });

  it("P3-TENANT-003: org1's academy list never includes org2's academies, even when both exist", async () => {
    const userA = await signUpAndSignIn(app, 't003-userA');
    const userB = await signUpAndSignIn(app, 't003-userB');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 't003-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't003-org2');
    const academy1 = await seedAcademy(admin, org1.id, 't003-a1');
    const academy2 = await seedAcademy(admin, org2.id, 't003-a2');
    await seedAcademyMember(admin, academy1.id, userA.userId);
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .get('/academies')
      .query({ organizationId: org1.id })
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const ids = response.body.items.map((a: { id: string }) => a.id);
    expect(ids).toContain(academy1.id);
    expect(ids).not.toContain(academy2.id);
  });

  it("P3-TENANT-004: PATCH against org2's academy from userA (org1) never succeeds, and the row is provably untouched", async () => {
    const userA = await signUpAndSignIn(app, 't004-userA');
    const userB = await signUpAndSignIn(app, 't004-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 't004-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't004-org2');
    const academy2 = await seedAcademy(admin, org2.id, 't004-a2');
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .patch(`/academies/${academy2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .send({ name: 'Hijacked Name' });
    expect([403, 404]).toContain(response.status);

    const stillIntact = await admin.academy.findUniqueOrThrow({
      where: { id: academy2.id },
    });
    expect(stillIntact.name).toBe(academy2.name);
  });

  it("P3-TENANT-005: DELETE (archive) against org2's academy from userA (org1) never succeeds, and status is untouched", async () => {
    const userA = await signUpAndSignIn(app, 't005-userA');
    const userB = await signUpAndSignIn(app, 't005-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 't005-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't005-org2');
    const academy2 = await seedAcademy(admin, org2.id, 't005-a2');
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .delete(`/academies/${academy2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(response.status);

    const stillIntact = await admin.academy.findUniqueOrThrow({
      where: { id: academy2.id },
    });
    expect(stillIntact.status).toBe('draft');
  });

  it('P3-TENANT-006: a user in org1 AND org2 can access academies in both; a user not in org3 cannot access it', async () => {
    const userA = await signUpAndSignIn(app, 't006-userA');
    const org1 = await seedOrganizationWithOwner(admin, userA.userId, 't006-org1');
    const org2 = await seedOrganizationWithOwner(admin, userA.userId, 't006-org2');
    const academy1 = await seedAcademy(admin, org1.id, 't006-a1');
    const academy2 = await seedAcademy(admin, org2.id, 't006-a2');
    await seedAcademyMember(admin, academy1.id, userA.userId);
    await seedAcademyMember(admin, academy2.id, userA.userId);

    const otherUser = await signUpAndSignIn(app, 't006-other');
    const org3 = await seedOrganizationWithOwner(admin, otherUser.userId, 't006-org3');
    const academy3 = await seedAcademy(admin, org3.id, 't006-a3');
    await seedAcademyMember(admin, academy3.id, otherUser.userId);

    await request(app.getHttpServer())
      .get(`/academies/${academy1.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/academies/${academy2.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`)
      .expect(200);

    const forbidden = await request(app.getHttpServer())
      .get(`/academies/${academy3.id}`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(forbidden.status);
  });

  it("P3-TENANT-007: GET .../members against org2's academy from userA (org1) never leaks member rows", async () => {
    const userA = await signUpAndSignIn(app, 't007-userA');
    const userB = await signUpAndSignIn(app, 't007-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 't007-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't007-org2');
    const academy2 = await seedAcademy(admin, org2.id, 't007-a2');
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy2.id}/members`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(response.status);
  });

  it("P3-TENANT-008: GET .../stats against org2's academy from userA (org1) is denied", async () => {
    const userA = await signUpAndSignIn(app, 't008-userA');
    const userB = await signUpAndSignIn(app, 't008-userB');
    await seedOrganizationWithOwner(admin, userA.userId, 't008-org1');
    const org2 = await seedOrganizationWithOwner(admin, userB.userId, 't008-org2');
    const academy2 = await seedAcademy(admin, org2.id, 't008-a2');
    await seedAcademyMember(admin, academy2.id, userB.userId);

    const response = await request(app.getHttpServer())
      .get(`/academies/${academy2.id}/stats`)
      .set('Authorization', `Bearer ${userA.accessToken}`);
    expect([403, 404]).toContain(response.status);
  });

  it("P3-TENANT-009: concurrent requests for different organizations' academies never cross-contaminate", async () => {
    const userA = await signUpAndSignIn(app, 't009-userA');
    const userB = await signUpAndSignIn(app, 't009-userB');
    const orgA = await seedOrganizationWithOwner(admin, userA.userId, 't009-orgA');
    const orgB = await seedOrganizationWithOwner(admin, userB.userId, 't009-orgB');
    const academyA = await seedAcademy(admin, orgA.id, 't009-aA');
    const academyB = await seedAcademy(admin, orgB.id, 't009-aB');
    await seedAcademyMember(admin, academyA.id, userA.userId);
    await seedAcademyMember(admin, academyB.id, userB.userId);

    const ROUNDS = 15;
    const requests = Array.from({ length: ROUNDS }, (_, i) =>
      i % 2 === 0
        ? request(app.getHttpServer())
            .get(`/academies/${academyA.id}`)
            .set('Authorization', `Bearer ${userA.accessToken}`)
            .then((res) => ({ expected: academyA.id, res }))
        : request(app.getHttpServer())
            .get(`/academies/${academyB.id}`)
            .set('Authorization', `Bearer ${userB.accessToken}`)
            .then((res) => ({ expected: academyB.id, res })),
    );

    const results = await Promise.all(requests);
    for (const { expected, res } of results) {
      expect(res.status).toBe(200);
      expect(res.body.id).toBe(expected);
    }
  });

  it('P3-TENANT-010: organization membership alone is never sufficient to WRITE — an org member with no academy_members row is denied PATCH; a random academy id is also rejected', async () => {
    const owner = await signUpAndSignIn(app, 't010-owner');
    const orgMemberOnly = await signUpAndSignIn(app, 't010-org-member-only');
    const org = await seedOrganizationWithOwner(admin, owner.userId, 't010-org');
    // `orgMemberOnly` is a real organization member — but never added to
    // `academy_members` for this specific academy.
    await seedMembership(admin, org.id, orgMemberOnly.userId, 'member');
    const academy = await seedAcademy(admin, org.id, 't010-a');
    await seedAcademyMember(admin, academy.id, owner.userId);

    // Read is allowed — org membership alone governs read visibility.
    await request(app.getHttpServer())
      .get(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${orgMemberOnly.accessToken}`)
      .expect(200);

    // Write is denied — org membership is explicitly NOT assumed to imply
    // unrestricted Academy Owner/administrator rights (master plan P3
    // instruction).
    const patchResponse = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}`)
      .set('Authorization', `Bearer ${orgMemberOnly.accessToken}`)
      .send({ name: 'Should Not Apply' });
    expect(patchResponse.status).toBe(403);

    const stillIntact = await admin.academy.findUniqueOrThrow({
      where: { id: academy.id },
    });
    expect(stillIntact.name).toBe(academy.name);

    // Sanity: a random, never-seeded academy id is also rejected.
    const sanity = await request(app.getHttpServer())
      .get(`/academies/${randomUUID()}`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect([403, 404]).toContain(sanity.status);
  });
});
