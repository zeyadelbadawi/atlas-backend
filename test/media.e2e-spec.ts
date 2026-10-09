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
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../src/media/storage/media-storage.interface';
import { ContentGrantSigner } from '../src/learning/services/content-grant.signer';
import { PublicMediaLinkSigner } from '../src/media/services/public-media-link.signer';

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

/** See the note at the first call site — the test app has no global prefix. */
function stripApiPrefix(url: string): string {
  return url.replace(/^\/api\/v1/, '');
}

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
    await seedActiveSubscriptionForOrg(admin, org.id, label);
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

    /*
      THE URL THE FRONTEND IS GIVEN MUST ACTUALLY RETURN THE IMAGE.

      This used to `fetch()` the returned URL directly, because it used to
      be an absolute link to the object store. In production that link
      pointed at R2's S3 API endpoint, which answers an unsigned browser
      request with `400 InvalidArgument: Authorization` — so the old
      assertion passed against MinIO while real uploads rendered as broken
      images for customers. Atlas now serves its own media and the URL is
      relative, so this asks the APPLICATION for it, which is the request a
      browser actually makes.

      `createTestApp` deliberately does not replay `main.ts`'s
      `setGlobalPrefix`/`enableVersioning` (see its own doc comment), so the
      `/api/v1` the real deployment adds is stripped here.
    */
    const objectResponse = await request(app.getHttpServer())
      .get(stripApiPrefix(uploaded.body.url))
      .expect(200);
    expect(objectResponse.headers['content-type']).toContain('image/png');
    expect(
      Buffer.compare(objectResponse.body, Buffer.from(REAL_PNG_BASE64, 'base64')),
    ).toBe(0);

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

  it('fails safely on hostile upload bodies: over the request limit 413, malformed JSON 400, malformed data URL 400 — never a 500', async () => {
    const { owner, academy } = await seedManagedAcademy('media-hostile');
    const url = `/academies/${academy.id}/media`;
    // Over the global JSON body limit (3 x the upload ceiling): refused by
    // the body parser before any handler, as a 413.
    const overBody = 'A'.repeat(31 * 1024 * 1024);
    await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'huge.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        dataUrl: `data:image/png;base64,${overBody}`,
      })
      .expect(413);
    await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .set('Content-Type', 'application/json')
      .send('{"fileName": "x.png", "dataUrl": ')
      .expect(400);
    for (const dataUrl of [
      'data:image/png;base64',
      `data:${'x'.repeat(400)};base64,AAAA`,
      'data:image/png;charset=x;base64,AAAA',
      REAL_PNG_BASE64,
    ]) {
      await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ fileName: 'x.png', mimeType: 'image/png', sizeBytes: 10, dataUrl })
        .expect(400);
    }
    // A legitimate upload still works.
    await request(app.getHttpServer())
      .post(url)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'ok.png',
        mimeType: 'image/png',
        sizeBytes: 10,
        dataUrl: `data:image/png;base64,${REAL_PNG_BASE64}`,
      })
      .expect(201);
  });

  // W5 (F12) — listing used to be allowed on organization membership alone;
  // an organization member who is not staff of THIS academy is now refused.
  it('a plain org member (no academy role) can neither list nor upload media', async () => {
    const { academy, org } = await seedManagedAcademy('media-authz');
    const plainMember = await signUpAndSignIn(app, 'media-authz-member');
    // A plain organization member, deliberately with NO academy_members row.
    await admin.organizationMembership.create({
      data: { organizationId: org.id, userId: plainMember.userId, role: 'member' },
    });

    await request(app.getHttpServer())
      .get(`/academies/${academy.id}/media`)
      .set('Authorization', `Bearer ${plainMember.accessToken}`)
      .expect(403);

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

  // ---------------------------------------------------------------------
  // The public serving route — the half that was actually broken.
  // ---------------------------------------------------------------------

  describe('public media serving', () => {
    async function uploadPng(label: string) {
      const { owner, academy } = await seedManagedAcademy(label);
      const uploaded = await request(app.getHttpServer())
        .post(`/academies/${academy.id}/media`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({
          fileName: 'logo.png',
          mimeType: 'image/png',
          sizeBytes: REAL_PNG_BYTE_LENGTH,
          dataUrl: REAL_PNG_DATA_URL,
        })
        .expect(201);
      return { owner, academy, asset: uploaded.body };
    }

    /*
     * A public Academy website is rendered for anonymous visitors, so its
     * logo and hero images have to load with no session at all. This is the
     * request a real visitor's browser makes.
     */
    it('serves an image to an anonymous caller, with the right content type', async () => {
      const { asset } = await uploadPng('media-serve-anon');

      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .expect(200);

      expect(response.headers['content-type']).toContain('image/png');
      // W1 — a library image not (yet) published anywhere is anonymous but
      // cached for an hour; only published branding may be immutable
      // (asserted in the W1 block below). This used to be immutable for
      // every object, whatever it was.
      expect(response.headers['cache-control']).toBe('public, max-age=3600');
      expect(response.headers['x-content-type-options']).toBe('nosniff');
      expect(Buffer.compare(response.body, Buffer.from(REAL_PNG_BASE64, 'base64'))).toBe(
        0,
      );
    });

    it('returns a URL the browser can use, not a storage endpoint', async () => {
      const { asset, academy } = await uploadPng('media-serve-shape');

      expect(asset.url).toBe(
        `/api/v1/public/media/academies/${academy.id}/${asset.id}.png`,
      );
      // The exact failure mode that shipped: an S3 API host in a URL a
      // browser is expected to load.
      expect(asset.url).not.toContain('r2.cloudflarestorage.com');
      expect(asset.url).not.toContain('amazonaws.com');
    });

    /*
     * Existing rows carry the old, unusable absolute URL in their `url`
     * column. The response derives it from `storageKey` instead, so they
     * are corrected without a data migration — which is the reason the
     * schema keeps the two fields separate in the first place.
     */
    it('corrects an asset whose stored url column holds the old broken value', async () => {
      const { owner, academy, asset } = await uploadPng('media-serve-legacy');

      // Exactly what every asset uploaded before this fix has in the
      // database: an absolute S3-endpoint URL no browser can load.
      await admin.mediaAsset.update({
        where: { id: asset.id },
        data: {
          url: 'https://example-account.r2.cloudflarestorage.com/bucket/whatever.png',
        },
      });

      const reread = await request(app.getHttpServer())
        .get(`/academies/${academy.id}/media/${asset.id}`)
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);

      // Derived from `storageKey`, so the stale column never reaches a client.
      expect(reread.body.url).toBe(
        `/api/v1/public/media/academies/${academy.id}/${asset.id}.png`,
      );
      expect(reread.body.url).not.toContain('r2.cloudflarestorage.com');

      // And it really serves.
      await request(app.getHttpServer()).get(stripApiPrefix(reread.body.url)).expect(200);
    });

    it('refuses a path that is not an academy-scoped uuid object', async () => {
      const { academy } = await uploadPng('media-serve-traversal');

      // Traversal attempts and non-uuid names never become a storage read.
      await request(app.getHttpServer())
        .get(`/public/media/academies/${academy.id}/..%2F..%2Fsecret.png`)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/public/media/academies/not-a-uuid/${academy.id}.png`)
        .expect(400);
      await request(app.getHttpServer())
        .get(`/public/media/academies/${academy.id}/${academy.id}.exe`)
        .expect(400);
    });

    it('404s an object that does not exist, rather than failing loudly', async () => {
      const { academy } = await uploadPng('media-serve-missing');
      await request(app.getHttpServer())
        .get(
          `/public/media/academies/${academy.id}/11111111-2222-3333-4444-555555555555.png`,
        )
        .expect(404);
    });

    /*
     * Serving is by storage key, and keys are namespaced by the real
     * academy id at upload time — so one academy's path can never address
     * another's object even though the route itself is public.
     */
    it("cannot reach another academy's object through this academy's path", async () => {
      const a = await uploadPng('media-serve-iso-a');
      const b = await uploadPng('media-serve-iso-b');

      await request(app.getHttpServer())
        .get(`/public/media/academies/${a.academy.id}/${b.asset.id}.png`)
        .expect(404);
    });

    // S11 (master plan §D.5/§L) — range requests, so a browser can seek
    // within an audio/video asset instead of re-downloading it whole.
    it('advertises byte-range support on a full 200 response', async () => {
      const { asset } = await uploadPng('media-range-full');
      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .expect(200);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(Number(response.headers['content-length'])).toBe(REAL_PNG_BYTE_LENGTH);
    });

    it('serves a satisfiable range as 206 Partial Content with the right slice', async () => {
      const { asset } = await uploadPng('media-range-partial');
      const full = Buffer.from(REAL_PNG_BASE64, 'base64');

      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .set('Range', 'bytes=0-9')
        .expect(206);

      expect(response.headers['content-range']).toBe(`bytes 0-9/${REAL_PNG_BYTE_LENGTH}`);
      expect(response.headers['accept-ranges']).toBe('bytes');
      expect(Number(response.headers['content-length'])).toBe(10);
      expect(Buffer.compare(response.body, full.subarray(0, 10))).toBe(0);
    });

    it('serves an open-ended range to the last byte', async () => {
      const { asset } = await uploadPng('media-range-open');
      const full = Buffer.from(REAL_PNG_BASE64, 'base64');

      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .set('Range', `bytes=${REAL_PNG_BYTE_LENGTH - 5}-`)
        .expect(206);

      expect(response.headers['content-range']).toBe(
        `bytes ${REAL_PNG_BYTE_LENGTH - 5}-${REAL_PNG_BYTE_LENGTH - 1}/${REAL_PNG_BYTE_LENGTH}`,
      );
      expect(Buffer.compare(response.body, full.subarray(REAL_PNG_BYTE_LENGTH - 5))).toBe(
        0,
      );
    });

    it('answers an unsatisfiable range with 416 and the real size', async () => {
      const { asset } = await uploadPng('media-range-416');
      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .set('Range', `bytes=${REAL_PNG_BYTE_LENGTH + 100}-${REAL_PNG_BYTE_LENGTH + 200}`)
        .expect(416);
      expect(response.headers['content-range']).toBe(`bytes */${REAL_PNG_BYTE_LENGTH}`);
    });

    // -------------------------------------------------------------------
    // W1 — the route serves only what is public BY PURPOSE.
    // -------------------------------------------------------------------

    async function seedPublicObject(
      academyId: string,
      overrides: { uploadedByUserId?: string } = {},
    ) {
      const id = randomUUID();
      const storageKey = `academies/${academyId}/${id}.png`;
      await app
        .get<MediaStorageProvider>(MEDIA_STORAGE_PROVIDER)
        .putObject(storageKey, Buffer.from(REAL_PNG_BASE64, 'base64'), 'image/png');
      const row = await admin.mediaAsset.create({
        data: {
          id,
          academyId,
          type: 'image',
          fileName: 'legacy.png',
          storageKey,
          url: `/api/v1/public/media/${storageKey}`,
          mimeType: 'image/png',
          sizeBytes: BigInt(REAL_PNG_BYTE_LENGTH),
          access: 'public',
          provider: 'r2',
          ...overrides,
        },
      });
      return { row, path: `/public/media/${storageKey}` };
    }

    it('W1: only published branding is cached immutable', async () => {
      const { asset, academy } = await uploadPng('w1-branding');
      await admin.academy.update({
        where: { id: academy.id },
        data: { logoUrl: asset.url },
      });
      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .expect(200);
      expect(response.headers['cache-control']).toBe(
        'public, max-age=31536000, immutable',
      );
    });

    it('W1: an object with no asset row, or a purged or protected row, is never served', async () => {
      const { academy } = await seedManagedAcademy('w1-rowless');
      // Bytes in the bucket with no row at all.
      const orphanKey = `academies/${academy.id}/${randomUUID()}.png`;
      await app
        .get<MediaStorageProvider>(MEDIA_STORAGE_PROVIDER)
        .putObject(orphanKey, Buffer.from(REAL_PNG_BASE64, 'base64'), 'image/png');
      await request(app.getHttpServer()).get(`/public/media/${orphanKey}`).expect(404);

      const purged = await seedPublicObject(academy.id);
      await admin.mediaAsset.update({
        where: { id: purged.row.id },
        data: { deletedAt: new Date() },
      });
      await request(app.getHttpServer()).get(purged.path).expect(404);

      const flipped = await seedPublicObject(academy.id);
      await admin.mediaAsset.update({
        where: { id: flipped.row.id },
        data: { access: 'protected' },
      });
      await request(app.getHttpServer()).get(flipped.path).expect(404);
    });

    it("W1: a learner's legacy public submission attachment is refused anonymously and served only by a signed link", async () => {
      const { academy } = await seedManagedAcademy('w1-submission');
      const learner = await signUpAndSignIn(app, 'w1-submission-learner');
      const legacy = await seedPublicObject(academy.id, {
        uploadedByUserId: learner.userId,
      });

      // It used to be served to anyone, immutable for a year.
      await request(app.getHttpServer()).get(legacy.path).expect(404);

      const signed = await app.get(ContentGrantSigner).signFile(legacy.row);
      expect(signed.url).toMatch(
        /^\/api\/v1\/public\/media\/academies\/.+\?exp=\d+&sig=/,
      );
      const served = await request(app.getHttpServer())
        .get(stripApiPrefix(signed.url))
        .expect(200);
      expect(served.headers['cache-control']).toBe('private, no-store');
      expect(Buffer.compare(served.body, Buffer.from(REAL_PNG_BASE64, 'base64'))).toBe(0);

      // Tampered, moved to another object, or expired: the same 404.
      const url = new URL(signed.url, 'https://atlas.test');
      const sig = url.searchParams.get('sig')!;
      url.searchParams.set('sig', `${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`);
      await request(app.getHttpServer())
        .get(stripApiPrefix(url.pathname + url.search))
        .expect(404);
      const other = await seedPublicObject(academy.id, {
        uploadedByUserId: learner.userId,
      });
      await request(app.getHttpServer())
        .get(`${other.path}${new URL(signed.url, 'https://atlas.test').search}`)
        .expect(404);
      const expired = app.get(PublicMediaLinkSigner).sign(legacy.row.storageKey, 60, 0);
      await request(app.getHttpServer()).get(stripApiPrefix(expired.url)).expect(404);
    });

    it('W1: a legacy public lesson file is refused anonymously unless it is also published', async () => {
      const { academy } = await seedManagedAcademy('w1-lesson-file');
      const course = await seedCourse(admin, academy.id, 'w1-course');
      const section = await seedCourseSection(admin, course.id, 'w1-section', 0);
      const lesson = await seedCourseLesson(admin, section.id, course.id, 'w1-lesson', 0);
      const file = await seedPublicObject(academy.id);
      await admin.lessonContent.create({
        data: {
          lessonId: lesson.id,
          courseId: course.id,
          academyId: academy.id,
          kind: 'file',
          mediaAssetId: file.row.id,
        },
      });
      await request(app.getHttpServer()).get(file.path).expect(404);
      const signed = await app.get(ContentGrantSigner).signFile(file.row);
      await request(app.getHttpServer()).get(stripApiPrefix(signed.url)).expect(200);

      // The same asset deliberately used as the course cover stays public.
      await admin.course.update({
        where: { id: course.id },
        data: { thumbnailUrl: file.row.url },
      });
      const cover = await request(app.getHttpServer()).get(file.path).expect(200);
      expect(cover.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });

    it('ignores a malformed range header and serves the whole file (200)', async () => {
      const { asset } = await uploadPng('media-range-malformed');
      const response = await request(app.getHttpServer())
        .get(stripApiPrefix(asset.url))
        .set('Range', 'bytes=not-a-range')
        .expect(200);
      expect(Number(response.headers['content-length'])).toBe(REAL_PNG_BYTE_LENGTH);
    });
  });
});
