/**
 * Media Library tenant-isolation suite — P8-TENANT-001..005 (master plan
 * §18/§21 Phase P8), extending the permanent tenant-isolation suite
 * established in `tenant-isolation.e2e-spec.ts` (P2) through
 * `p7-tenant-isolation.e2e-spec.ts` (P7) — one file per phase, same
 * pattern. Exercised through the real HTTP surface; the pure DB-level RLS
 * proof lives in `rls-media.e2e-spec.ts`.
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

const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG_BASE64}`;
const REAL_PNG_BYTE_LENGTH = Buffer.from(REAL_PNG_BASE64, 'base64').length;

describe('Media Library tenant isolation (e2e) — P8-TENANT-001..005', () => {
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

  it("P8-TENANT-001: Organization B cannot read Organization A's media asset by guessing its id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t8-001-a');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t8-001-b');

    // Owner B is legitimately authorized for their OWN academy (academyB)
    // — `AcademyScopeGuard` correctly lets the request through — but
    // Academy A's asset id resolves to nothing within academyB's own
    // scope: 404, not the real cross-tenant row, matching every other
    // "direct id, wrong tenant" precedent in this codebase.
    await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/media/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    // The stronger form: Owner B addressing Academy A's real id directly
    // is rejected at the guard layer before any media logic ever runs.
    await request(app.getHttpServer())
      .get(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(403);
  });

  it("P8-TENANT-002: Organization B's media list never includes Organization A's assets, even with a crafted search filter", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t8-002-a');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        fileName: 'unique-marker-file.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t8-002-b');

    const list = await request(app.getHttpServer())
      .get(`/academies/${academyB.id}/media`)
      .query({ search: 'unique-marker-file' })
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).not.toContain(
      uploaded.body.id,
    );
  });

  it("P8-TENANT-003: Organization B cannot archive Organization A's media asset by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t8-003-a');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t8-003-b');

    await request(app.getHttpServer())
      .post(`/academies/${academyB.id}/media/${uploaded.body.id}/archive`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .expect(404);

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: uploaded.body.id },
    });
    expect(row.status).toBe('active');
  });

  it("P8-TENANT-004: Organization B cannot update Organization A's media altText by direct id", async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t8-004-a');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const { owner: ownerB, academy: academyB } = await seedManagedAcademy('t8-004-b');

    await request(app.getHttpServer())
      .patch(`/academies/${academyB.id}/media/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${ownerB.accessToken}`)
      .send({ altText: 'hijacked' })
      .expect(404);
  });

  it('P8-TENANT-005: a storage key from one academy is structurally unreachable through another academy — keys are always namespaced by the real academy id, never client-influenced', async () => {
    const { owner: ownerA, academy: academyA } = await seedManagedAcademy('t8-005-a');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academyA.id}/media`)
      .set('Authorization', `Bearer ${ownerA.accessToken}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: uploaded.body.id },
    });
    expect(row.storageKey.startsWith(`academies/${academyA.id}/`)).toBe(true);
    expect(row.storageKey).not.toContain('..');
    expect(row.storageKey).not.toContain('\\');
  });
});
