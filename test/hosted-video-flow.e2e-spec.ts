/**
 * B0-MED-11 — the course builder's hosted-video flow end to end, through
 * the same HTTP calls the builder makes, against the real application:
 * real Postgres with RLS, real Redis, real guards and DTO validation, and a
 * real S3-compatible protected bucket (CI's SeaweedFS; locally any S3 store
 * on `R2_ENDPOINT` — there is no in-process stand-in, so without one the
 * upload tests fail rather than pass on a fake).
 *
 *   HVF-01  upload ticket → PUT to storage → completion (ready, measured)
 *           → lesson saved with `videoAssetId` through the lesson API → an
 *           enrolled learner is granted a gate-signed URL with the forensic
 *           watermark; a learner who is not enrolled is refused
 *   HVF-02  minutes quota exceeded → refused with the localised error key,
 *           before any reservation or upload URL exists
 *   HVF-03  flag off → refused `videoNotEnabled`, nothing reserved
 *   HVF-04  Cancel releases the reservation and deletes the bytes;
 *           idempotent; a finished video, another academy's upload and an
 *           upload a lesson points at are refused
 *   HVF-05  a completion whose MEASURED length overruns the quota is
 *           refused, and the bytes and the reservation are discarded
 *   HVF-06  the maintenance sweep releases an upload abandoned for a day,
 *           never a fresh one and never one a lesson points at
 *   HVF-07  roles and scope: an assigned instructor attaches a library
 *           video but cannot upload; an archived video, or one uploaded for
 *           another course, is not attachable; the library can be narrowed
 *           to what this course may attach
 *
 * Swapped, as in `p64-phase2-api.e2e-spec.ts`: `FeatureFlagsService` reads a
 * mutable object, and `BasicVideoProvider` is the real adapter constructed
 * with a delivery host and a signing secret (the local environment has
 * neither), so the Normal tier is genuinely available and every presign
 * goes to the real bucket.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { ConfigService } from '@nestjs/config';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseInstructor,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import { BasicVideoProvider } from '../src/media/video/basic-video.provider';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import { VideoReconciliationService } from '../src/media/services/video-reconciliation.service';
import type { BasicVideoConfig, LearningFeatureFlags } from '../src/config/configuration';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery-hvf';
const DELIVERY_HOST = 'video.hvf.test';

const basicConfig: BasicVideoConfig = {
  deliveryHost: DELIVERY_HOST,
  signingSecret: 'hvf-basic-video-signing-secret-not-real',
  playbackTtlSeconds: 600,
  allowedOriginsConfigured: false,
} as BasicVideoConfig;

function flagsWith(videoNormal: 'on' | 'off'): LearningFeatureFlags {
  return {
    contentProtected: { mode: 'on', academyIds: [] },
    videoNormal: { mode: videoNormal, academyIds: [] },
    videoPremium: { mode: 'off', academyIds: [] },
    quizEngineV2: { mode: 'on', academyIds: [] },
    quizIntegrity: { mode: 'on', academyIds: [] },
  };
}
const flags: { value: LearningFeatureFlags } = { value: flagsWith('on') };

// A faststart MP4 whose `mvhd` carries the duration Atlas measures (the
// same construction as `video-duration.util.spec.ts`).
function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}
function faststartMp4(durationSeconds: number): Buffer {
  const timescale = 600;
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(durationSeconds * timescale, 16);
  return Buffer.concat([
    isoBox('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    isoBox('moov', isoBox('mvhd', mvhd)),
    isoBox('mdat', Buffer.alloc(1024)),
  ]);
}

describe('B0-MED-11 hosted video flow (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let storage: ProtectedMediaStorage;
  let gate: BasicVideoProvider;

  const http = () => request(app.getHttpServer());

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(FeatureFlagsService)
          .useValue(
            new FeatureFlagsService({
              get: () => flags.value,
            } as unknown as ConfigService),
          )
          .overrideProvider(BasicVideoProvider)
          .useFactory({
            factory: (s: ProtectedMediaStorage) =>
              new BasicVideoProvider(
                { getOrThrow: () => basicConfig } as unknown as ConfigService,
                s,
              ),
            inject: [ProtectedMediaStorage],
          }),
    });
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    storage = app.get(ProtectedMediaStorage, { strict: false });
    gate = app.get(BasicVideoProvider, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    flags.value = flagsWith('on');
    await flush();
  });

  // --- fixtures -------------------------------------------------------------

  async function account(label: string, academyId?: string) {
    await flush();
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({
        name: label,
        email,
        password: PASSWORD,
        ...(academyId ? { academyId } : {}),
      })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({
        email,
        password: PASSWORD,
        ...(academyId ? { surface: 'academy', academyId } : {}),
      })
      .expect(200);
    const setCookie =
      (signIn.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const device = setCookie.find((value) => value.startsWith('atlas_device='));
    return {
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
      cookie: device ? device.split(';')[0] : '',
    };
  }

  async function world(label: string, videoStorageMinutes = 600) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-plan`, {
      limits: {
        academies: 5,
        students: 100,
        instructors: 10,
        staff: 10,
        courses: 50,
        generalStorage: 10,
        videoStorage: 10,
        videoStorageMinutes,
      },
    });
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-unit`, 0);
    return { owner, org, academy, course, section };
  }
  type World = Awaited<ReturnType<typeof world>>;

  const uploadsPath = (w: World) => `/academies/${w.academy.id}/media/video-uploads`;
  const lessonsPath = (w: World) =>
    `/academies/${w.academy.id}/courses/${w.course.id}/sections/${w.section.id}/lessons`;

  function ticket(
    w: World,
    body: { maxDurationSeconds: number; sizeBytes?: number; courseId?: string },
    auth = w.owner.auth,
  ) {
    return http()
      .post(uploadsPath(w))
      .set(auth)
      .send({ fileName: 'lesson.mp4', courseId: w.course.id, ...body });
  }

  async function put(uploadUrl: string, body: Buffer): Promise<number> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': 'video/mp4' },
    });
    return response.status;
  }

  const complete = (w: World, assetId: string) =>
    http()
      .post(`${uploadsPath(w)}/${assetId}/complete`)
      .set(w.owner.auth);
  const cancel = (w: World, assetId: string, auth = w.owner.auth) =>
    http()
      .post(`${uploadsPath(w)}/${assetId}/cancel`)
      .set(auth);

  async function readyVideo(w: World, seconds: number) {
    const bytes = faststartMp4(seconds);
    const t = await ticket(w, {
      maxDurationSeconds: seconds + 30,
      sizeBytes: bytes.length,
    }).expect(201);
    expect(await put(t.body.uploadUrl, bytes)).toBe(200);
    await complete(w, t.body.assetId).expect(201);
    return t.body.assetId as string;
  }

  async function objectKeyOf(assetId: string): Promise<string> {
    const row = await admin.mediaAsset.findUniqueOrThrow({ where: { id: assetId } });
    return row.providerId!;
  }

  // --- tests ----------------------------------------------------------------

  it('HVF-01 — upload → ready → lesson saved with videoAssetId → enrolled learner granted with the watermark', async () => {
    const w = await world('hvf01');
    const bytes = faststartMp4(95);

    const t = await ticket(w, {
      maxDurationSeconds: 125,
      sizeBytes: bytes.length,
    }).expect(201);
    expect(t.body).toMatchObject({
      securityTier: 'normal',
      requiresCompletionCall: true,
      reservedMinutes: 3,
    });
    // Reserved before the URL exists, and `processing` once it does.
    const reserved = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: t.body.assetId },
    });
    expect(reserved).toMatchObject({
      processingStatus: 'processing',
      provider: 'r2_worker',
    });

    expect(await put(t.body.uploadUrl, bytes)).toBe(200);
    const done = await complete(w, t.body.assetId).expect(201);
    expect(done.body).toMatchObject({
      id: t.body.assetId,
      processingStatus: 'ready',
      durationSeconds: 95,
      durationSource: 'parsed',
    });

    // The builder saves the lesson through the lesson API.
    const lesson = await http()
      .post(lessonsPath(w))
      .set(w.owner.auth)
      .send({
        title: 'Hosted lesson',
        contentType: 'video',
        status: 'published',
        videoAssetId: t.body.assetId,
      })
      .expect(201);
    expect(lesson.body.videoAssetId).toBe(t.body.assetId);

    const learner = await account('hvf01-learner', w.academy.id);
    await seedEnrollment(admin, learner.userId, w.course.id, w.academy.id);
    await http().get(`/courses/${w.course.id}/progress`).set(learner.auth).expect(200);

    const grant = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${lesson.body.id}/content`)
      .set(learner.auth)
      .set('Cookie', learner.cookie)
      .expect(200);
    expect(grant.body.kind).toBe('video');
    expect(grant.body.protection).toMatchObject({ tier: 'normal', watermark: true });
    expect(grant.body.video).toMatchObject({ format: 'mp4', downloadable: false });
    const url = new URL(grant.body.video.url);
    expect(url.host).toBe(DELIVERY_HOST);
    // The token is one the gate honours, for exactly this object.
    const verified = gate.verifyGateToken(url.searchParams.get('t')!);
    expect(verified.valid).toBe(true);
    expect(verified.claims?.k).toBe(await objectKeyOf(t.body.assetId));
    expect(verified.claims?.u).toBe(learner.userId);
    // The forensic watermark the player draws over the video.
    expect(grant.body.watermark).toMatchObject({ enabled: true });
    expect(grant.body.watermark.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);

    // Not enrolled → no grant (indistinguishable from a missing lesson).
    const stranger = await account('hvf01-stranger', w.academy.id);
    const refused = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${lesson.body.id}/content`)
      .set(stranger.auth)
      .set('Cookie', stranger.cookie)
      .expect(404);
    expect(refused.body.video).toBeUndefined();
  });

  it('HVF-02 — over the minutes quota: refused with the localised key, nothing reserved', async () => {
    const w = await world('hvf02', 5);
    const before = await admin.mediaAsset.count({ where: { academyId: w.academy.id } });
    const refused = await ticket(w, { maxDurationSeconds: 6 * 60 }).expect(409);
    expect(refused.body.error).toMatchObject({
      messageKey: 'errors.entitlement.videoStorageMinutesExceeded',
      code: 'ENTITLEMENT_VIDEO_MINUTES_EXCEEDED',
    });
    expect(refused.body.uploadUrl).toBeUndefined();
    expect(await admin.mediaAsset.count({ where: { academyId: w.academy.id } })).toBe(
      before,
    );
    // Within the quota it is accepted.
    await ticket(w, { maxDurationSeconds: 5 * 60 }).expect(201);
  });

  it('HVF-03 — with the Normal flag off the upload is refused and nothing is reserved', async () => {
    const w = await world('hvf03');
    flags.value = flagsWith('off');
    const refused = await ticket(w, { maxDurationSeconds: 60 }).expect(403);
    expect(refused.body.error.messageKey).toBe('errors.media.videoNotEnabled');
    expect(await admin.mediaAsset.count({ where: { academyId: w.academy.id } })).toBe(0);
  });

  it('HVF-04 — Cancel releases the reservation and deletes the bytes; refusals', async () => {
    const w = await world('hvf04', 10);
    const bytes = faststartMp4(60);
    const t = await ticket(w, {
      maxDurationSeconds: 10 * 60,
      sizeBytes: bytes.length,
    }).expect(201);
    expect(await put(t.body.uploadUrl, bytes)).toBe(200);
    const key = await objectKeyOf(t.body.assetId);
    expect(await storage.headObject(key)).not.toBeNull();
    // The whole quota is held by this reservation.
    await ticket(w, { maxDurationSeconds: 60 }).expect(409);

    const cancelled = await cancel(w, t.body.assetId).expect(201);
    expect(cancelled.body).toMatchObject({
      processingStatus: 'failed',
      status: 'archived',
    });
    expect(await storage.headObject(key)).toBeNull();
    // Released: the minutes are available again. Idempotent.
    const next = await ticket(w, { maxDurationSeconds: 10 * 60 }).expect(201);
    await cancel(w, t.body.assetId).expect(201);

    // A finished video is a library asset, removed through the library.
    await cancel(w, next.body.assetId).expect(201);
    const ready = await readyVideoWithin(w);
    const refusedReady = await cancel(w, ready).expect(409);
    expect(refusedReady.body.error.messageKey).toBe('errors.media.uploadAlreadyComplete');

    // Another academy cannot cancel it.
    const other = await world('hvf04-other');
    const foreign = await ticket(other, { maxDurationSeconds: 60 }).expect(201);
    await http()
      .post(`${uploadsPath(w)}/${foreign.body.assetId}/cancel`)
      .set(w.owner.auth)
      .expect(404);
    expect(
      (await admin.mediaAsset.findUniqueOrThrow({ where: { id: foreign.body.assetId } }))
        .processingStatus,
    ).toBe('processing');

    // An unfinished upload a lesson already points at is never cancelled.
    const attached = await ticket(other, { maxDurationSeconds: 60 }).expect(201);
    await seedCourseLesson(
      admin,
      other.section.id,
      other.course.id,
      'hvf04-attached',
      0,
      {
        contentType: 'video',
        videoAssetId: attached.body.assetId,
      },
    );
    const inUse = await cancel(other, attached.body.assetId).expect(409);
    expect(inUse.body.error.messageKey).toBe('errors.media.inUse');
  });

  /** A ready video in a world whose quota may already be mostly used. */
  async function readyVideoWithin(w: World) {
    return readyVideo(w, 30);
  }

  it('HVF-05 — a completion whose measured length overruns the quota is refused and discarded', async () => {
    const w = await world('hvf05', 5);
    // Declares one minute, uploads ten.
    const bytes = faststartMp4(10 * 60);
    const t = await ticket(w, { maxDurationSeconds: 60, sizeBytes: bytes.length }).expect(
      201,
    );
    expect(await put(t.body.uploadUrl, bytes)).toBe(200);
    const key = await objectKeyOf(t.body.assetId);

    const refused = await complete(w, t.body.assetId).expect(409);
    expect(refused.body.error.messageKey).toBe(
      'errors.entitlement.videoStorageMinutesExceeded',
    );
    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: t.body.assetId },
    });
    expect(row).toMatchObject({ processingStatus: 'failed', status: 'archived' });
    expect(await storage.headObject(key)).toBeNull();
    // Nothing is left holding the quota.
    await ticket(w, { maxDurationSeconds: 5 * 60 }).expect(201);
  });

  it('HVF-06 — the sweep releases an upload abandoned for a day, and only that', async () => {
    const owners = await admin.user.count({ where: { isPlatformOwner: true } });
    if (owners === 0) {
      await admin.user.create({
        data: {
          email: uniqueTestEmail('hvf06-platform-owner'),
          name: 'hvf06 platform owner',
          isPlatformOwner: true,
        },
      });
    }
    const w = await world('hvf06');
    const bytes = faststartMp4(30);
    const stale = await ticket(w, {
      maxDurationSeconds: 60,
      sizeBytes: bytes.length,
    }).expect(201);
    expect(await put(stale.body.uploadUrl, bytes)).toBe(200);
    const fresh = await ticket(w, { maxDurationSeconds: 60 }).expect(201);
    const staleAttached = await ticket(w, { maxDurationSeconds: 60 }).expect(201);
    await seedCourseLesson(admin, w.section.id, w.course.id, 'hvf06-attached', 0, {
      contentType: 'video',
      videoAssetId: staleAttached.body.assetId,
    });
    const dayAgo = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await admin.mediaAsset.updateMany({
      where: { id: { in: [stale.body.assetId, staleAttached.body.assetId] } },
      data: { updatedAt: dayAgo },
    });
    const key = await objectKeyOf(stale.body.assetId);

    const expired = await app
      .get(VideoReconciliationService, { strict: false })
      .expireAbandonedUploads(24, 1000);
    expect(expired).toBeGreaterThanOrEqual(1);

    const status = async (id: string) =>
      admin.mediaAsset.findUniqueOrThrow({
        where: { id },
        select: { processingStatus: true, status: true },
      });
    expect(await status(stale.body.assetId)).toEqual({
      processingStatus: 'failed',
      status: 'archived',
    });
    expect(await storage.headObject(key)).toBeNull();
    expect(await status(fresh.body.assetId)).toEqual({
      processingStatus: 'processing',
      status: 'active',
    });
    expect(await status(staleAttached.body.assetId)).toEqual({
      processingStatus: 'processing',
      status: 'active',
    });
  });

  it('HVF-07 — roles and scope for attaching and listing', async () => {
    const w = await world('hvf07');
    const ready = await readyVideo(w, 40);

    // An instructor assigned to this course attaches a library video…
    const instructor = await account('hvf07-instructor');
    await seedAcademyMember(admin, w.academy.id, instructor.userId, 'instructor');
    await seedCourseInstructor(admin, w.course.id, instructor.userId);
    const attached = await http()
      .post(lessonsPath(w))
      .set(instructor.auth)
      .send({ title: 'By instructor', contentType: 'video', videoAssetId: ready })
      .expect(201);
    expect(attached.body.videoAssetId).toBe(ready);
    // …but uploading stays with owners, administrators and managers.
    const upload = await ticket(w, { maxDurationSeconds: 60 }, instructor.auth).expect(
      403,
    );
    expect(upload.body.error.messageKey).toBe('errors.media.insufficientRole');

    // A video uploaded for ANOTHER course of this academy is not attachable
    // here (the B0-MED-05 rule the content path already applies).
    const otherCourse = await seedCourse(admin, w.academy.id, 'hvf07 Other', {
      status: 'published',
    });
    const otherBytes = faststartMp4(20);
    const forOther = await ticket(w, {
      maxDurationSeconds: 60,
      sizeBytes: otherBytes.length,
      courseId: otherCourse.id,
    }).expect(201);
    expect(await put(forOther.body.uploadUrl, otherBytes)).toBe(200);
    await complete(w, forOther.body.assetId).expect(201);
    await http()
      .post(lessonsPath(w))
      .set(w.owner.auth)
      .send({
        title: 'Cross-course',
        contentType: 'video',
        videoAssetId: forOther.body.assetId,
      })
      .expect(404);

    // An archived (deleted) video is gone as far as attaching goes.
    const archived = await readyVideo(w, 20);
    await admin.mediaAsset.update({
      where: { id: archived },
      data: { status: 'archived' },
    });
    await http()
      .post(lessonsPath(w))
      .set(w.owner.auth)
      .send({ title: 'Archived', contentType: 'video', videoAssetId: archived })
      .expect(404);

    // The library narrowed to this course: its own and academy-wide videos.
    const academyWide = await admin.mediaAsset.create({
      data: {
        academyId: w.academy.id,
        type: 'video',
        fileName: 'academy-wide.mp4',
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(1024),
        access: 'protected',
        provider: 'r2_worker',
        processingStatus: 'ready',
        durationSeconds: 60,
      },
    });
    const list = await http()
      .get(
        `/academies/${w.academy.id}/media?type=video&access=protected&status=active&courseId=${w.course.id}&pageSize=100`,
      )
      .set(w.owner.auth)
      .expect(200);
    const ids = list.body.items.map((item: { id: string }) => item.id);
    expect(ids).toEqual(expect.arrayContaining([ready, academyWide.id]));
    expect(ids).not.toContain(forOther.body.assetId);
    expect(ids).not.toContain(archived);
    await http()
      .get(`/academies/${w.academy.id}/media?courseId=not-a-uuid`)
      .set(w.owner.auth)
      .expect(400);
  });
});
