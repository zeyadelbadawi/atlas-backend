/**
 * Public Website & Domain tenant-isolation suite — P11-TENANT-001..006
 * (master plan §18/§21 Phase P11), extending the permanent
 * tenant-isolation suite established in `tenant-isolation.e2e-spec.ts`
 * (P2) through `website-content-tenant-isolation.e2e-spec.ts` (P10) —
 * one file per phase, same pattern. Exercised through the real HTTP
 * surface; the pure DB-level RLS proof lives in `rls-domain.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
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

describe('Public Website & Domain tenant isolation (e2e) — P11-TENANT-001..006', () => {
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

  async function seedManagedAcademy(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    return { owner, academy };
  }

  it("P11-TENANT-001: Organization B cannot read Organization A's domain configuration by direct id", async () => {
    const { academy: academyA } = await seedManagedAcademy('t11-001-a');
    const { owner: ownerB } = await seedManagedAcademy('t11-001-b');

    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/website/domain`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);
  });

  it("P11-TENANT-002: Organization B cannot add a custom domain to Organization A's Academy by direct id", async () => {
    const { academy: academyA } = await seedManagedAcademy('t11-002-a');
    const { owner: ownerB } = await seedManagedAcademy('t11-002-b');

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ hostname: `hijack-${Date.now()}.example.com` })
      .expect(403);

    const row = await admin.domainConnection.findUnique({
      where: { academyId: academyA.id },
    });
    expect(row).toBeNull();
  });

  it("P11-TENANT-003: Organization B cannot remove Organization A's custom domain by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t11-003-a');
    const { owner: ownerB } = await seedManagedAcademy('t11-003-b');
    const hostname = `t11-003-${Date.now()}.example.com`;

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ hostname })
      .expect(201);

    await request(app.getHttpServer())
      .delete(`/academies/${academyA.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);

    const row = await admin.domainConnection.findUniqueOrThrow({
      where: { academyId: academyA.id },
    });
    expect(row.hostname).toBe(hostname);
    expect(row.status).toBe('verification_required');
  });

  it('P11-TENANT-004: a subdomain resolves to exactly its own Academy, never a different one, even when both Academies exist', async () => {
    const { academy: academyA } = await seedManagedAcademy('t11-004-a');
    const { academy: academyB } = await seedManagedAcademy('t11-004-b');

    const labelA = `t11004a${Date.now()}`;
    await admin.subdomainAllocation.create({
      data: { academyId: academyA.id, subdomain: labelA, status: 'assigned' },
    });

    const resolved = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname: labelA })
      .expect(200);
    expect(resolved.body.academyId).toBe(academyA.id);
    expect(resolved.body.academyId).not.toBe(academyB.id);
  });

  it('P11-TENANT-005: a custom domain resolves to exactly its own Academy, never a different one', async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t11-005-a');
    const { academy: academyB } = await seedManagedAcademy('t11-005-b');
    const hostname = `t11-005-${Date.now()}.example.com`;

    await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({ hostname })
      .expect(201);
    // Directly mark it connected — the public resolver only trusts
    // `status = 'connected'`, and no real Cloudflare check runs in this
    // test environment (see `domain.e2e-spec.ts`'s own doc comment).
    await admin.domainConnection.update({
      where: { academyId: academyA.id },
      data: { status: 'connected' },
    });

    const resolved = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname })
      .expect(200);
    expect(resolved.body.academyId).toBe(academyA.id);
    expect(resolved.body.academyId).not.toBe(academyB.id);
  });

  it('P11-TENANT-006: a not-yet-connected (verification_required) custom domain never resolves publicly, even though the row genuinely exists', async () => {
    const { owner, academy } = await seedManagedAcademy('t11-006');
    const hostname = `t11-006-${Date.now()}.example.com`;

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/website/domain/custom-domain`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ hostname })
      .expect(201);

    const resolved = await request(app.getHttpServer())
      .get('/public/websites/resolve')
      .query({ hostname });
    expect(resolved.status).toBe(404);
  });
});
