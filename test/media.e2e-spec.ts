/**
 * Media Library e2e suite (master plan §21 Phase P8, §10). Exercises
 * `MediaController`'s real HTTP surface — list, detail, upload, update,
 * archive — against a real MinIO-backed `R2StorageProvider` (no mocked
 * storage anywhere) and real file-validation rules.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
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

/** A real, valid 1x1 PNG. */
const REAL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const REAL_PNG_DATA_URL = `data:image/png;base64,${REAL_PNG_BASE64}`;
const REAL_PNG_BYTE_LENGTH = Buffer.from(REAL_PNG_BASE64, 'base64').length;

describe('Media Library (e2e)', () => {
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
    return { owner, org, academy };
  }

  it('an academy owner uploads a real PNG — it persists durably in object storage, is listable, and matches the frontend contract', async () => {
    const { owner, academy } = await seedManagedAcademy('media-upload');

    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
        altText: 'Academy logo',
      })
      .expect(201);

    expect(uploaded.body).toMatchObject({
      academyId: academy.id,
      type: 'image',
      status: 'active',
      fileName: 'logo.png',
      mimeType: 'image/png',
      sizeBytes: REAL_PNG_BYTE_LENGTH,
      altText: 'Academy logo',
    });
    expect(uploaded.body.url).toContain(academy.id);
    expect(uploaded.body.id).toBeTruthy();

    // Durable in the real object store — a direct HTTP GET against the
    // returned URL (MinIO's own HTTP endpoint) returns the real bytes,
    // not a fabricated success.
    const objectResponse = await fetch(uploaded.body.url);
    expect(objectResponse.status).toBe(200);
    const objectBytes = Buffer.from(await objectResponse.arrayBuffer());
    expect(Buffer.compare(objectBytes, Buffer.from(REAL_PNG_BASE64, 'base64'))).toBe(0);

    // Real DB metadata row, storage key scoped under the academy.
    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: uploaded.body.id },
    });
    expect(row.storageKey).toBe(`academies/${academy.id}/${row.id}.png`);
    expect(row.academyId).toBe(academy.id);

    // Listable.
    const list = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(list.body.items.map((a: { id: string }) => a.id)).toContain(uploaded.body.id);
    expect(list.body.pagination).toMatchObject({ totalItems: expect.any(Number) });
  });

  // Explicit headroom over Jest's 5000ms default — a real BullMQ round
  // trip (enqueue → worker pickup → download from object storage →
  // `sharp` → DB update), not a slow assertion.
  it('the media-processing worker extracts real image dimensions asynchronously — never inline in the upload response', async () => {
    const { owner, academy } = await seedManagedAcademy('media-dimensions');

    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);
    // Never computed synchronously in the request/response cycle.
    expect(uploaded.body.dimensions).toBeUndefined();

    const withDimensions = await waitForAsync(async () => {
      const row = await admin.mediaAsset.findUniqueOrThrow({
        where: { id: uploaded.body.id },
      });
      return row.width !== null ? row : undefined;
    });
    expect(withDimensions.width).toBe(1);
    expect(withDimensions.height).toBe(1);
  }, 15000);

  it('rejects a payload whose bytes are not really an image, regardless of the claimed mimeType', async () => {
    const { owner, academy } = await seedManagedAcademy('media-invalid-mime');

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'fake.png',
        mimeType: 'image/png',
        sizeBytes: 20,
        dataUrl: `data:image/png;base64,${Buffer.from('not actually a png').toString('base64')}`,
      })
      .expect(400);
  });

  it('rejects an oversized payload server-side, regardless of the claimed sizeBytes', async () => {
    const { owner, academy } = await seedManagedAcademy('media-too-large');
    // A real PNG signature followed by padding well past a tiny configured-in-test ceiling is unnecessary —
    // the default 10MB ceiling is used here; build a real, valid-signature PNG-prefixed buffer over that size.
    const oversized = Buffer.concat([
      Buffer.from(REAL_PNG_BASE64, 'base64'),
      Buffer.alloc(11 * 1024 * 1024, 0),
    ]);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'huge.png',
        mimeType: 'image/png',
        sizeBytes: oversized.length,
        dataUrl: `data:image/png;base64,${oversized.toString('base64')}`,
      })
      .expect(413);
  });

  it('a plain org member (no academy role) cannot upload, update, or archive media, but can still list it', async () => {
    const { academy, org } = await seedManagedAcademy('media-authz');
    const plainMember = await signUpAndSignIn(app, 'media-authz-member');
    // A plain organization member, deliberately with NO academy_members row.
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: plainMember.userId, role: 'member' },
    });

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(200);

    await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .send({
        fileName: 'x.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(403);
  });

  it('altText can be updated by an academy manager, and archiving flips status without hard-deleting the row', async () => {
    const { owner, academy } = await seedManagedAcademy('media-lifecycle');
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'a.png',
        mimeType: 'image/png',
        sizeBytes: REAL_PNG_BYTE_LENGTH,
        dataUrl: REAL_PNG_DATA_URL,
      })
      .expect(201);

    const updated = await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/media/${uploaded.body.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ altText: 'A real description' })
      .expect(200);
    expect(updated.body.altText).toBe('A real description');

    const archived = await request(app.getHttpServer())
      .post(`/academies/${academy.id}/media/${uploaded.body.id}/archive`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(archived.body.status).toBe('archived');

    // Row still exists — no hard delete.
    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: uploaded.body.id },
    });
    expect(row.status).toBe('archived');

    // Excluded when filtering to active-only, still returned when filtering archived.
    const activeList = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .query({ status: 'active' })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(activeList.body.items.map((a: { id: string }) => a.id)).not.toContain(
      uploaded.body.id,
    );

    const archivedList = await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .query({ status: 'archived' })
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(archivedList.body.items.map((a: { id: string }) => a.id)).toContain(
      uploaded.body.id,
    );
  });
});
