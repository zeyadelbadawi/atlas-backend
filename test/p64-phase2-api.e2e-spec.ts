/**
 * P64 Phase 2 — the BACKEND API SURFACE for protected content, the two
 * video tiers and the provider registry (master plan Phase 2 §D.4/§D.5,
 * §L, §V; decisions D5, D10, D11; architecture AD-7, AD-14, AD-15, AD-16).
 *
 * WHAT THIS FILE IS FOR. Everything asserted here is a claim the Master
 * Plan makes about the HTTP surface, proved against the real application:
 * real Postgres with RLS, real Redis, real MinIO-backed protected bucket,
 * real guards, real DTO validation. Three dependencies are swapped and
 * nothing else:
 *
 *   - `FeatureFlagsService` reads a mutable object instead of the process
 *     environment, so a test can canary `video.normal` and `video.premium`
 *     independently (Phase 2 §S) — the same shape
 *     `p64-surface-enforce-flag.e2e-spec.ts` already established.
 *   - `CloudflareStreamProvider`'s four NETWORK methods are overridden;
 *     `capabilities()`, `isConfigured()` and `issuePlaybackToken()` remain
 *     the real implementations, signing with a real RSA key generated in
 *     this file. The premium assertions below are therefore about the
 *     production adapter's own behaviour, not a stand-in's.
 *   - `BasicVideoProvider` is constructed with a delivery host and signing
 *     secret (the local environment configures neither), so the Normal
 *     tier is genuinely available. Every line of the adapter is the real
 *     one, and its presigned PUT/GET go to the real bucket.
 *
 * WHY THE FAKE ADAPTER IS NOT USED. `VideoProviderRegistry` falls back to
 * `FakeVideoProvider` for the `r2_worker` slot only while the Normal
 * adapter is unconfigured. Exercising the tiers through the fake one would
 * assert the stand-in's capabilities — `boundToSession: false` — and prove
 * nothing about either production tier, which is exactly the illusion
 * AD-16 exists to prevent.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { FeatureFlagsService } from '../src/common/flags/feature-flags.service';
import { CloudflareStreamProvider } from '../src/media/video/cloudflare-stream.provider';
import { BasicVideoProvider } from '../src/media/video/basic-video.provider';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import { ConfigService } from '@nestjs/config';
import type { PlanFamily, PlanTier, PrismaClient } from '@prisma/client';
import type {
  BasicVideoConfig,
  LearningFeatureFlags,
  VideoProviderConfig,
} from '../src/config/configuration';
import type {
  CreateDirectUploadInput,
  CreatedDirectUpload,
  ProviderVideoAsset,
} from '../src/media/video/video-provider.interface';

const PASSWORD = 'correct-horse-battery';

/** `basicVideo.playbackTtlSeconds` for this run — the Normal tier's real credential life. */
const BASIC_PLAYBACK_TTL_SECONDS = 600;

const BASIC_DELIVERY_HOST = 'video.atlas.test';

/**
 * MUTABLE on purpose.
 *
 * `BasicVideoProvider` reads this object once and then consults it on
 * every `capabilities()` call, so flipping a field here is exactly what
 * happens when an operator wires (or fails to wire) the gate's revocation
 * denylist and origin allowlist. AD-16 says the grant must report what is
 * ENFORCED, so both configurations have to be reachable from a test.
 */
const basicConfig: {
  deliveryHost?: string;
  signingSecret?: string;
  playbackTtlSeconds: number;
  revocationEndpoint?: string;
  revocationToken?: string;
  allowedOriginsConfigured: boolean;
} = {
  deliveryHost: BASIC_DELIVERY_HOST,
  signingSecret: 'p64-phase2-basic-video-signing-secret',
  playbackTtlSeconds: BASIC_PLAYBACK_TTL_SECONDS,
  revocationEndpoint: 'https://video.atlas.test/__revocations',
  revocationToken: 'p64-phase2-revocation-token',
  allowedOriginsConfigured: true,
};

/** The fully wired gate — revocation published, origins pushed. */
function wireBasicGate(): void {
  basicConfig.revocationEndpoint = 'https://video.atlas.test/__revocations';
  basicConfig.revocationToken = 'p64-phase2-revocation-token';
  basicConfig.allowedOriginsConfigured = true;
}

/** The half-configured gate: the Worker COULD enforce these; Atlas is not feeding it. */
function unwireBasicGate(): void {
  basicConfig.revocationEndpoint = undefined;
  basicConfig.revocationToken = undefined;
  basicConfig.allowedOriginsConfigured = false;
}

/** A throwaway RSA key — Stream token signing is local, so the test can hold the private half. */
const streamKeyPair = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const STREAM_PLAYBACK_TTL_SECONDS = 2 * 60 * 60;

const STREAM_CONFIG: VideoProviderConfig = {
  provider: 'cloudflare_stream',
  accountId: 'cf-account-id',
  apiToken: 'cf-api-token',
  signingKeyId: 'cf-signing-key-id',
  signingKeyPem: streamKeyPair.privateKey,
  webhookSecret: 'cf-webhook-secret',
  customerSubdomain: 'customer-p64.cloudflarestream.com',
  playbackTokenTtlSeconds: STREAM_PLAYBACK_TTL_SECONDS,
};

/**
 * The real `CloudflareStreamProvider` with ONLY its four HTTP calls
 * replaced.
 *
 * `capabilities()` — the thing AD-16 makes load-bearing — is inherited
 * untouched, so "a Premium grant reports `boundToDevice: false`" is
 * asserted against the production adapter rather than against a fixture
 * that could be made to say anything.
 */
class TestStreamProvider extends CloudflareStreamProvider {
  readonly directUploads: CreateDirectUploadInput[] = [];
  private readonly assets = new Map<string, ProviderVideoAsset>();

  createDirectUpload(input: CreateDirectUploadInput): Promise<CreatedDirectUpload> {
    if (!this.isConfigured()) {
      return Promise.reject(new Error('Cloudflare Stream is not configured.'));
    }
    this.directUploads.push(input);
    const providerId = `cfuid${randomUUID().replace(/-/g, '')}`;
    this.assets.set(providerId, {
      providerId,
      status: 'processing',
      durationSeconds: null,
    });
    return Promise.resolve({
      providerId,
      uploadUrl: `https://upload.videodelivery.net/${providerId}`,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    });
  }

  fetchAsset(providerId: string): Promise<ProviderVideoAsset | null> {
    return Promise.resolve(this.assets.get(providerId) ?? null);
  }

  deleteAsset(): Promise<void> {
    return Promise.resolve();
  }

  syncAllowedOrigins(): Promise<void> {
    return Promise.resolve();
  }
}

/** Mutated per test; read on every call, exactly as the real service reads configuration. */
const flags: { value: LearningFeatureFlags } = {
  value: {
    contentProtected: { mode: 'on', academyIds: [] },
    videoNormal: { mode: 'on', academyIds: [] },
    videoPremium: { mode: 'on', academyIds: [] },
    devicesPolicy: { mode: 'on', academyIds: [] },
    learnerDashboardV2: { mode: 'on', academyIds: [] },
    playerV2: { mode: 'on', academyIds: [] },
    quizEngineV2: { mode: 'on', academyIds: [] },
    quizIntegrity: { mode: 'on', academyIds: [] },
    certificates: { mode: 'on', academyIds: [] },
  },
};

function allFlags(mode: 'on' | 'off'): LearningFeatureFlags {
  return {
    contentProtected: { mode, academyIds: [] },
    videoNormal: { mode, academyIds: [] },
    videoPremium: { mode, academyIds: [] },
    devicesPolicy: { mode, academyIds: [] },
    learnerDashboardV2: { mode, academyIds: [] },
    playerV2: { mode, academyIds: [] },
    quizEngineV2: { mode, academyIds: [] },
    quizIntegrity: { mode, academyIds: [] },
    certificates: { mode, academyIds: [] },
  };
}

// --- MP4 fixtures ---------------------------------------------------------
// A faststart-shaped file whose `mvhd` really carries the duration Atlas is
// supposed to measure, built the same way `video-duration.util.spec.ts`
// builds one. Uploaded for real through the presigned PUT, so the
// completion endpoint parses bytes that actually exist in the bucket.

function isoBox(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, payload]);
}

function faststartMp4(durationSeconds: number): Buffer {
  const timescale = 600;
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(durationSeconds * timescale, 16);
  return Buffer.concat([
    isoBox('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    isoBox('moov', isoBox('mvhd', mvhd)),
    isoBox('mdat', Buffer.alloc(1024)),
  ]);
}

/** `moov` at the END — the real non-faststart case the parser cannot read from the head. */
function trailingMoovMp4(durationSeconds: number): Buffer {
  const timescale = 600;
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt8(0, 0);
  mvhd.writeUInt32BE(timescale, 12);
  mvhd.writeUInt32BE(durationSeconds * timescale, 16);
  return Buffer.concat([
    isoBox('ftyp', Buffer.from('isomiso2avc1mp41', 'latin1')),
    // Larger than the 512 KB ranged read the completion endpoint performs.
    isoBox('mdat', Buffer.alloc(700 * 1024)),
    isoBox('moov', isoBox('mvhd', mvhd)),
  ]);
}

/** Decodes the `e` (expiry, unix seconds) claim from a Normal-tier gate token. */
function basicTokenExpiry(playbackUrl: string): number {
  const token = new URL(playbackUrl).searchParams.get('t');
  if (!token) throw new Error(`No gate token in ${playbackUrl}`);
  const claims = JSON.parse(
    Buffer.from(token.split('.')[0], 'base64url').toString('utf8'),
  ) as { e: number };
  return claims.e;
}

/** Decodes the `exp` claim from a Cloudflare Stream playback URL's embedded JWT. */
function streamTokenExpiry(playbackUrl: string): number {
  const token = new URL(playbackUrl).pathname.split('/')[1];
  const claims = JSON.parse(
    Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
  ) as { exp: number; downloadable: boolean };
  return claims.exp;
}

describe('P64 Phase 2 — protected content, video tiers and the provider registry (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let stream: TestStreamProvider;

  beforeAll(async () => {
    stream = new TestStreamProvider({
      getOrThrow: () => STREAM_CONFIG,
    } as unknown as ConfigService);

    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(FeatureFlagsService)
          .useValue(
            new FeatureFlagsService({
              get: () => flags.value,
            } as unknown as ConfigService),
          )
          .overrideProvider(CloudflareStreamProvider)
          .useValue(stream)
          .overrideProvider(BasicVideoProvider)
          .useFactory({
            factory: (storage: ProtectedMediaStorage) =>
              new BasicVideoProvider(
                {
                  getOrThrow: () => basicConfig as BasicVideoConfig,
                } as unknown as ConfigService,
                storage,
              ),
            inject: [ProtectedMediaStorage],
          }),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    flags.value = allFlags('on');
    wireBasicGate();
    await flushRateLimitKeys();
  });

  // --- fixtures -----------------------------------------------------------

  async function staffAccount(label: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  async function learnerAccount(label: string, academyId: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    // The `atlas_device` cookie is a server-issued credential (§G). Carrying
    // it means every grant in a test resolves to ONE registered device
    // rather than burning a slot from the 2-device cap on each call.
    const setCookie = signIn.headers['set-cookie'] as unknown as string[] | undefined;
    const deviceCookie = (setCookie ?? []).find((value) =>
      value.startsWith('atlas_device='),
    );
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
      cookie: deviceCookie ? deviceCookie.split(';')[0] : '',
    };
  }

  /**
   * One organization on ONE of the six commercial variants (D10), with an
   * academy, a published course and an owner who may upload.
   */
  async function world(
    label: string,
    variant: { family: PlanFamily; tier: PlanTier; videoStorageMinutes?: number },
  ) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedPlan(admin, `${label}-${variant.family}-${variant.tier}`, {
      limits: {
        academies: 50,
        students: 500,
        instructors: 50,
        staff: 50,
        courses: 200,
        generalStorage: 100,
        videoStorage: 100,
        videoStorageMinutes: variant.videoStorageMinutes ?? 5_000,
      },
    });
    await admin.plan.update({
      where: { id: plan.id },
      data: { family: variant.family, tier: variant.tier },
    });
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-section`, 0);
    return { owner, org, plan, academy, course, section };
  }

  /** `POST /academies/:id/media/video-uploads` — the real staff upload ticket. */
  async function createUpload(
    w: { academy: { id: string }; owner: { auth: Record<string, string> } },
    body: Record<string, unknown>,
    expectStatus = 201,
  ) {
    return request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .set(w.owner.auth)
      .send(body)
      .expect(expectStatus);
  }

  /** Uploads real bytes through the presigned PUT the ticket handed back. */
  async function putBytes(uploadUrl: string, body: Buffer): Promise<number> {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': 'video/mp4' },
    });
    return response.status;
  }

  /**
   * Attaches a ready video asset to a published lesson.
   *
   * Direct-DB, because Phase 2's staff authoring UI — and with it the only
   * write path for `course_lessons.video_asset_id` — is explicitly still
   * outstanding (investigation §2.3). The lesson row is otherwise exactly
   * what the authoring UI would write.
   */
  async function attachVideoLesson(
    w: { academy: { id: string }; course: { id: string }; section: { id: string } },
    assetId: string,
    label: string,
    overrides: { order?: number; isPreview?: boolean } = {},
  ) {
    const lesson = await seedCourseLesson(
      admin,
      w.section.id,
      w.course.id,
      label,
      overrides.order ?? 0,
      { contentType: 'video', status: 'published' },
    );
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: {
        videoAssetId: assetId,
        isPreview: overrides.isPreview ?? false,
        completionRule: 'watched_ratio',
      },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: lesson.id,
        courseId: w.course.id,
        academyId: w.academy.id,
        kind: 'video',
      },
    });
    return lesson;
  }

  async function enrolledLearner(
    w: { academy: { id: string }; course: { id: string } },
    label: string,
  ) {
    const student = await learnerAccount(label, w.academy.id);
    await seedEnrollment(admin, student.userId, w.course.id, w.academy.id);
    // The real client opens the course before the player, and that read is
    // what materialises this enrollment's `lesson_progress` rows.
    await request(app.getHttpServer())
      .get(`/courses/${w.course.id}/progress`)
      .set(student.auth)
      .expect(200);
    return student;
  }

  function getContent(
    student: { auth: Record<string, string>; cookie: string },
    courseId: string,
    lessonId: string,
  ) {
    return request(app.getHttpServer())
      .get(`/learning/courses/${courseId}/lessons/${lessonId}/content`)
      .set(student.auth)
      .set('Cookie', student.cookie);
  }

  function refreshGrant(
    student: { auth: Record<string, string>; cookie: string },
    courseId: string,
    lessonId: string,
  ) {
    return request(app.getHttpServer())
      .post(`/learning/courses/${courseId}/lessons/${lessonId}/playback/refresh`)
      .set(student.auth)
      .set('Cookie', student.cookie)
      .send({});
  }

  /** A ready Normal-tier asset: real ticket → real PUT → real completion. */
  async function readyNormalAsset(
    w: Parameters<typeof createUpload>[0] & { course: { id: string } },
    seconds: number,
  ) {
    const ticket = await createUpload(w, {
      fileName: 'lesson.mp4',
      maxDurationSeconds: seconds,
      courseId: w.course.id,
    });
    expect(await putBytes(ticket.body.uploadUrl, faststartMp4(seconds))).toBe(200);
    const completed = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(201);
    return { ticket: ticket.body, completed: completed.body };
  }

  // =========================================================================
  // 1. The upload path resolves the TIER, then the PROVIDER — never a
  //    process-wide setting (AD-7, D10).
  // =========================================================================

  const VARIANTS: ReadonlyArray<{
    family: PlanFamily;
    tier: PlanTier;
    name: string;
    expectedTier: 'normal' | 'premium';
    expectedProvider: 'r2_worker' | 'cloudflare_stream';
  }> = [
    {
      family: 'normal',
      tier: 'basic',
      name: 'NORMAL_BASIC',
      expectedTier: 'normal',
      expectedProvider: 'r2_worker',
    },
    {
      family: 'normal',
      tier: 'growth',
      name: 'NORMAL_GROWTH',
      expectedTier: 'normal',
      expectedProvider: 'r2_worker',
    },
    {
      family: 'normal',
      tier: 'enterprise',
      name: 'NORMAL_ENTERPRISE',
      expectedTier: 'normal',
      expectedProvider: 'r2_worker',
    },
    {
      family: 'premium',
      tier: 'basic',
      name: 'PREMIUM_BASIC',
      expectedTier: 'premium',
      expectedProvider: 'cloudflare_stream',
    },
    {
      family: 'premium',
      tier: 'growth',
      name: 'PREMIUM_GROWTH',
      expectedTier: 'premium',
      expectedProvider: 'cloudflare_stream',
    },
    {
      family: 'premium',
      tier: 'enterprise',
      name: 'PREMIUM_ENTERPRISE',
      expectedTier: 'premium',
      expectedProvider: 'cloudflare_stream',
    },
  ];

  it.each(VARIANTS)(
    '$name resolves the right entitlement, security tier and provider (D10, §V)',
    async (variant) => {
      const w = await world(`variant-${variant.name.toLowerCase()}`, {
        family: variant.family,
        tier: variant.tier,
      });

      // The ENTITLEMENT, read on its own — plan resolution as a step
      // distinct from tier resolution (§M "as separate, independently
      // asserted steps").
      const tierSetting = await request(app.getHttpServer())
        .get(`/academies/${w.academy.id}/video-tier`)
        .set(w.owner.auth)
        .expect(200);
      expect(tierSetting.body).toMatchObject({
        academyId: w.academy.id,
        entitled: variant.expectedTier,
        videoSecurityTier: variant.expectedTier,
        // Nothing was chosen at the academy level, so the PLAN decided.
        source: 'plan',
      });

      const ticket = await createUpload(w, {
        fileName: 'variant.mp4',
        maxDurationSeconds: 120,
        courseId: w.course.id,
      });
      expect(ticket.body).toMatchObject({
        securityTier: variant.expectedTier,
        reservedMinutes: 2,
        // The Normal tier has no webhook and must be finalised by the
        // completion endpoint (finding D-4); Premium reports readiness
        // itself.
        requiresCompletionCall: variant.expectedTier === 'normal',
      });
      expect(typeof ticket.body.uploadUrl).toBe('string');
      // FINDING D-2 — a ticket with no upload URL in it is not a ticket.
      expect(ticket.body.uploadUrl.length).toBeGreaterThan(0);

      const row = await admin.mediaAsset.findUniqueOrThrow({
        where: { id: ticket.body.assetId },
      });
      // AD-15 — WHERE THE BYTES ARE (the ACTING adapter, finding D-1) …
      expect(row.provider).toBe(variant.expectedProvider);
      // … and WHAT ATLAS PROMISED, as two separate columns.
      expect(row.securityTier).toBe(variant.expectedTier);
      expect(row.processingStatus).toBe('processing');
      expect(row.providerId).toBeTruthy();
      expect(row.durationSeconds).toBe(120);
      // A reservation is not a measurement: provenance stays null until the
      // real figure is known (D5).
      expect(row.durationSource).toBeNull();
    },
  );

  it('the provider comes from the resolved TIER, not from the process-wide VIDEO_PROVIDER setting (AD-7)', async () => {
    // The process is configured with the LOCAL adapter — `VIDEO_PROVIDER`
    // is unset in this environment, so `video.provider` is `fake`. Under
    // the pre-registry wiring that one setting decided every upload. Two
    // academies in this same process now land on two different real
    // adapters, which is only possible if the tier decided.
    const processWide = app
      .get<ConfigService>(ConfigService, { strict: false })
      .getOrThrow<VideoProviderConfig>('video');
    expect(processWide.provider).toBe('fake');

    const normal = await world('process-wide-normal', {
      family: 'normal',
      tier: 'basic',
    });
    const premium = await world('process-wide-premium', {
      family: 'premium',
      tier: 'basic',
    });

    const normalTicket = await createUpload(normal, {
      fileName: 'n.mp4',
      maxDurationSeconds: 60,
      courseId: normal.course.id,
    });
    const premiumTicket = await createUpload(premium, {
      fileName: 'p.mp4',
      maxDurationSeconds: 60,
      courseId: premium.course.id,
    });

    const normalRow = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: normalTicket.body.assetId },
    });
    const premiumRow = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: premiumTicket.body.assetId },
    });
    expect(normalRow.provider).toBe('r2_worker');
    expect(premiumRow.provider).toBe('cloudflare_stream');
    // Neither recorded the process-wide adapter, and `fake` is never
    // written to the column at all — it is not a place bytes can live.
    expect([normalRow.provider, premiumRow.provider]).not.toContain(processWide.provider);
  });

  it('the ACADEMY choice, not the plan, decides the tier within the entitlement — three separate steps (D10)', async () => {
    const w = await world('three-steps', { family: 'premium', tier: 'growth' });

    // Step 1 (plan) — the family entitles Premium.
    // Step 2 (tier) — the academy deliberately selects Normal anyway.
    const chosen = await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({ videoSecurityTier: 'normal' })
      .expect(200);
    expect(chosen.body).toMatchObject({
      videoSecurityTier: 'normal',
      entitled: 'premium',
      source: 'academy',
    });

    // Step 3 (provider) — the registry resolves the adapter from the tier
    // that was resolved, not from the plan family.
    const ticket = await createUpload(w, {
      fileName: 'chosen.mp4',
      maxDurationSeconds: 60,
      courseId: w.course.id,
    });
    expect(ticket.body.securityTier).toBe('normal');
    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId },
    });
    expect(row.provider).toBe('r2_worker');
    expect(row.securityTier).toBe('normal');

    // The plan is untouched by the academy's choice.
    const subscription = await admin.tenantSubscription.findUniqueOrThrow({
      where: { organizationId: w.org.id },
      include: { plan: true },
    });
    expect(subscription.plan.family).toBe('premium');
  });

  it('a Normal-family plan cannot select Premium — refused, never silently lowered (D10)', async () => {
    const w = await world('not-entitled', { family: 'normal', tier: 'growth' });

    const refused = await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({ videoSecurityTier: 'premium' })
      .expect(403);
    expect(refused.body.error).toMatchObject({
      status: 403,
      messageKey: 'errors.entitlement.videoTierNotEntitled',
      code: 'ENTITLEMENT_VIDEO_TIER',
      details: { requested: 'premium', entitled: 'normal' },
    });
  });

  it('a tier whose per-academy rollout flag is off is refused, per tier (Phase 2 §S)', async () => {
    const premium = await world('flag-premium', { family: 'premium', tier: 'basic' });

    flags.value = { ...allFlags('on'), videoPremium: { mode: 'off', academyIds: [] } };
    const refused = await createUpload(
      premium,
      { fileName: 'flagged.mp4', maxDurationSeconds: 60, courseId: premium.course.id },
      403,
    );
    expect(refused.body.error).toMatchObject({
      messageKey: 'errors.media.videoNotEnabled',
    });

    // The OTHER tier's flag is untouched — Normal canaries independently.
    flags.value = { ...allFlags('on'), videoNormal: { mode: 'off', academyIds: [] } };
    await createUpload(premium, {
      fileName: 'premium-still-works.mp4',
      maxDurationSeconds: 60,
      courseId: premium.course.id,
    });
  });

  // =========================================================================
  // 2. The completion endpoint — the Normal tier's synchronous readiness
  //    path (finding D-4, §D.4, §L).
  // =========================================================================

  it('completes a Normal upload by VERIFYING the object and PARSING its real duration (D5)', async () => {
    const w = await world('complete-normal', { family: 'normal', tier: 'growth' });

    // Declared as 10 minutes; the file is really 4.
    const ticket = await createUpload(w, {
      fileName: 'lecture.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    });
    expect(ticket.body.requiresCompletionCall).toBe(true);
    expect(await putBytes(ticket.body.uploadUrl, faststartMp4(240))).toBe(200);

    const completed = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(201);
    expect(completed.body).toMatchObject({ id: ticket.body.assetId });

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId },
    });
    expect(row.processingStatus).toBe('ready');
    // MEASURED, not believed — the declared 600 is replaced by the parsed 240.
    expect(row.durationSeconds).toBe(240);
    expect(row.durationSource).toBe('parsed');
    expect(Number(row.sizeBytes)).toBeGreaterThan(0);
  });

  it('records `declared` provenance — never silently trusting it — when the duration cannot be parsed (D5)', async () => {
    const w = await world('complete-declared', { family: 'normal', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'not-faststart.mp4',
      maxDurationSeconds: 300,
      courseId: w.course.id,
    });
    expect(await putBytes(ticket.body.uploadUrl, trailingMoovMp4(120))).toBe(200);

    await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(201);

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId },
    });
    expect(row.durationSource).toBe('declared');
    expect(row.durationSeconds).toBe(300);
  });

  it('is idempotent — a retried completion returns the same ready asset', async () => {
    const w = await world('complete-idempotent', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 180);

    const second = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads/${ticket.assetId}/complete`)
      .set(w.owner.auth)
      .expect(201);
    expect(second.body).toMatchObject({ id: ticket.assetId });

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.assetId },
    });
    expect(row.durationSeconds).toBe(180);
    expect(row.durationSource).toBe('parsed');
  });

  it('refuses completion when the object never landed', async () => {
    const w = await world('complete-missing', { family: 'normal', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'never-uploaded.mp4',
      maxDurationSeconds: 120,
      courseId: w.course.id,
    });

    const refused = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(400);
    expect(refused.body.error).toMatchObject({
      messageKey: 'errors.media.uploadNotFound',
    });

    const row = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId },
    });
    expect(row.processingStatus).toBe('processing');
  });

  it('refuses completion for a provider that reports readiness ASYNCHRONOUSLY (§D.4)', async () => {
    const w = await world('complete-async', { family: 'premium', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'premium.mp4',
      maxDurationSeconds: 120,
      courseId: w.course.id,
    });
    expect(ticket.body.requiresCompletionCall).toBe(false);

    const refused = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(400);
    expect(refused.body.error).toMatchObject({
      messageKey: 'errors.media.completionNotApplicable',
    });
  });

  it('refuses completion before the upload was ever started, and for an unknown asset', async () => {
    const w = await world('complete-guards', { family: 'normal', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'no-provider-id.mp4',
      maxDurationSeconds: 60,
      courseId: w.course.id,
    });
    await admin.mediaAsset.update({
      where: { id: ticket.body.assetId },
      data: { providerId: null, processingStatus: 'pending' },
    });

    const notStarted = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(400);
    expect(notStarted.body.error).toMatchObject({
      messageKey: 'errors.media.uploadNotStarted',
    });

    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads/${randomUUID()}/complete`)
      .set(w.owner.auth)
      .expect(404);
  });

  it("never lets one academy complete another academy's upload", async () => {
    const a = await world('complete-tenant-a', { family: 'normal', tier: 'growth' });
    const b = await world('complete-tenant-b', { family: 'normal', tier: 'growth' });
    const ticket = await createUpload(a, {
      fileName: 'private.mp4',
      maxDurationSeconds: 60,
      courseId: a.course.id,
    });

    // B's owner, B's academy in the path, A's asset id: refused as
    // not-found, the established "unreachable looks absent" shape.
    await request(app.getHttpServer())
      .post(
        `/academies/${b.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(b.owner.auth)
      .expect(404);
    // B's owner against A's academy is refused at the scope guard.
    await request(app.getHttpServer())
      .post(
        `/academies/${a.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(b.owner.auth)
      .expect(403);
  });

  // =========================================================================
  // 3. `GET …/content` returns the AD-16 capability object, and
  //    `expiresInSeconds` never exceeds the real credential lifetime (D-3).
  // =========================================================================

  it('the completion response tells the caller the asset is READY (§D.4 synchronous readiness)', async () => {
    const w = await world('complete-contract', { family: 'normal', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'contract.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    });
    expect(await putBytes(ticket.body.uploadUrl, faststartMp4(240))).toBe(200);

    const completed = await request(app.getHttpServer())
      .post(
        `/academies/${w.academy.id}/media/video-uploads/${ticket.body.assetId}/complete`,
      )
      .set(w.owner.auth)
      .expect(201);

    // THE WHOLE POINT of a SYNCHRONOUS readiness endpoint is that the
    // caller learns the outcome from the call. A staff UI that has to
    // re-poll something else to find out whether the upload became ready,
    // what duration was measured and how it was established, has not been
    // told anything the asynchronous path would not also have told it.
    expect(completed.body.processingStatus).toBe('ready');
    expect(completed.body.durationSeconds).toBe(240);
    expect(completed.body.durationSource).toBe('parsed');
    expect(completed.body.securityTier).toBe('normal');
    // A protected, provider-hosted asset has no public address, and the
    // response must not advertise one (finding S1's whole subject).
    //
    // STRENGTHENED after this test caught the original defect: the fix did
    // not sanitise the `url` field, it REMOVED it. There is no durable
    // address for a protected asset, so reporting one at all — even a
    // harmless-looking one — would be the dishonest option. Asserting
    // absence is therefore strictly stronger than asserting the string
    // does not contain `public/media`, which is what this line used to do
    // and which would still pass if some other public path appeared.
    expect(completed.body.url).toBeUndefined();
  });

  it('a learner can actually SEE the video asset behind their lesson (§V, AD-16)', async () => {
    const w = await world('asset-visibility', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 300);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'visibility-lesson');
    const student = await enrolledLearner(w, 'visibility-student');

    const grant = await getContent(student, w.course.id, lesson.id).expect(200);

    // ISOLATES ONE ROOT CAUSE. `LessonContentService` resolves the lesson
    // in the CALLER'S user context, and `media_assets` has no user-context
    // SELECT policy — only the organization-scoped
    // `media_assets_tenant_select` from P8. The lesson is visible (Phase 2
    // added `can_access_lesson`); the asset it points at is not, so the
    // `videoAsset` include silently yields null and a VIDEO lesson is
    // delivered as a grant with no video and a null tier — the exact
    // dishonest report AD-16 exists to prevent.
    expect(grant.body.kind).toBe('video');
    expect(grant.body.video).toBeDefined();
    expect(grant.body.protection.tier).toBe('normal');
  });

  it('a NORMAL grant reports the capabilities the Worker gate actually enforces (AD-16)', async () => {
    const w = await world('grant-normal', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 300);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'normal-lesson');
    const student = await enrolledLearner(w, 'grant-normal-student');

    const grant = await getContent(student, w.course.id, lesson.id).expect(200);

    expect(grant.body.protection).toMatchObject({
      tier: 'normal',
      signedUrl: true,
      // FALSE, and deliberately so. The delivery host is Atlas-owned and
      // cross-site from the academy, so no Atlas session reaches the gate:
      // a token lifted from one browser plays in another until it expires
      // or is revoked. This is the same shape as finding D-5, and
      // asserting `true` here would reproduce D-5 on the tier the plan
      // presents as the stronger of the two.
      boundToSession: false,
      boundToDevice: false,
      // TRUE only because this run wires the denylist and the origin list.
      // The half-configured case is asserted below.
      revocableBeforeExpiry: true,
      originRestricted: true,
      adaptiveBitrate: false,
      drm: false,
    });
    expect(grant.body.video).toMatchObject({ format: 'mp4', downloadable: false });
    expect(grant.body.video.url).toContain(BASIC_DELIVERY_HOST);

    // FINDING D-3 — the advertised expiry may never outlive the credential
    // inside the response.
    const tokenExpiry = basicTokenExpiry(grant.body.video.url);
    const grantExpiry = Math.floor(new Date(grant.body.expiresAt).getTime() / 1000);
    expect(grantExpiry).toBeLessThanOrEqual(tokenExpiry);
    expect(grant.body.protection.expiresInSeconds).toBeLessThanOrEqual(
      tokenExpiry - Math.floor(Date.now() / 1000) + 1,
    );
    expect(grant.body.protection.expiresInSeconds).toBeLessThanOrEqual(
      BASIC_PLAYBACK_TTL_SECONDS,
    );
    expect(grant.body.protection.expiresInSeconds).toBeGreaterThan(0);

    // §I — grants are never cached and never leak a referrer.
    expect(grant.headers['cache-control']).toBe('private, no-store');
    expect(grant.headers['referrer-policy']).toBe('no-referrer');
  });

  it('an UNWIRED Normal gate reports revocation and origin restriction as FALSE (AD-16)', async () => {
    const w = await world('grant-unwired', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 300);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'unwired-lesson');
    const student = await enrolledLearner(w, 'grant-unwired-student');

    // The denylist has nowhere to be published and no origin list was
    // pushed: the Worker COULD enforce both, and Atlas is not feeding it.
    // A capability is a statement about what is enforced.
    unwireBasicGate();
    const grant = await getContent(student, w.course.id, lesson.id).expect(200);
    expect(grant.body.protection).toMatchObject({
      tier: 'normal',
      signedUrl: true,
      revocableBeforeExpiry: false,
      originRestricted: false,
      drm: false,
    });

    // Wiring it is the only thing that turns the claim back on.
    wireBasicGate();
    const rewired = await getContent(student, w.course.id, lesson.id).expect(200);
    expect(rewired.body.protection).toMatchObject({
      revocableBeforeExpiry: true,
      originRestricted: true,
    });
  });

  it('a PREMIUM grant reports boundToDevice: false rather than inheriting an aspiration (finding D-5, AD-16)', async () => {
    const w = await world('grant-premium', { family: 'premium', tier: 'growth' });
    const ticket = await createUpload(w, {
      fileName: 'premium-lesson.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    });
    // Premium readiness arrives from the provider, not the client.
    await admin.mediaAsset.update({
      where: { id: ticket.body.assetId },
      data: {
        processingStatus: 'ready',
        durationSeconds: 540,
        durationSource: 'measured',
      },
    });
    const lesson = await attachVideoLesson(w, ticket.body.assetId, 'premium-lesson');
    const student = await enrolledLearner(w, 'grant-premium-student');

    const grant = await getContent(student, w.course.id, lesson.id).expect(200);

    expect(grant.body.protection).toMatchObject({
      tier: 'premium',
      signedUrl: true,
      // THE POINT OF FINDING D-5. Cloudflare mints `accessRules: any/allow`
      // and ignores Atlas's custom claims, so a token lifted from one
      // browser works in another. Saying `true` here would sell a
      // protection that is not in force.
      boundToSession: false,
      boundToDevice: false,
      revocableBeforeExpiry: false,
      originRestricted: true,
      adaptiveBitrate: true,
      drm: false,
    });
    expect(grant.body.video).toMatchObject({ format: 'hls', downloadable: false });

    const tokenExpiry = streamTokenExpiry(grant.body.video.url);
    const grantExpiry = Math.floor(new Date(grant.body.expiresAt).getTime() / 1000);
    expect(grantExpiry).toBeLessThanOrEqual(tokenExpiry);
    expect(grant.body.protection.expiresInSeconds).toBeLessThanOrEqual(
      STREAM_PLAYBACK_TTL_SECONDS,
    );
  });

  it('content with no hosted video reports a null tier and no video-shaped claims', async () => {
    const w = await world('grant-text', { family: 'premium', tier: 'basic' });
    const textLesson = await seedCourseLesson(
      admin,
      w.section.id,
      w.course.id,
      'text-lesson',
      1,
      { contentType: 'text', status: 'published' },
    );
    await admin.lessonContent.create({
      data: {
        lessonId: textLesson.id,
        courseId: w.course.id,
        academyId: w.academy.id,
        kind: 'text',
        bodyHtml: '<p>Reading material.</p>',
      },
    });
    const externalLesson = await seedCourseLesson(
      admin,
      w.section.id,
      w.course.id,
      'external-lesson',
      2,
      { contentType: 'text', status: 'published' },
    );
    await admin.lessonContent.create({
      data: {
        lessonId: externalLesson.id,
        courseId: w.course.id,
        academyId: w.academy.id,
        kind: 'external',
        externalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      },
    });
    const student = await enrolledLearner(w, 'grant-text-student');

    const text = await getContent(student, w.course.id, textLesson.id).expect(200);
    expect(text.body.protection).toMatchObject({
      tier: null,
      signedUrl: true,
      boundToSession: false,
      boundToDevice: false,
      adaptiveBitrate: false,
      drm: false,
    });
    expect(text.body.video).toBeUndefined();
    expect(text.body.bodyHtml).toContain('Reading material');

    const external = await getContent(student, w.course.id, externalLesson.id).expect(
      200,
    );
    // Atlas hosts nothing here and protects nothing — said plainly rather
    // than left for the learner to assume.
    expect(external.body.protection).toMatchObject({
      tier: null,
      signedUrl: false,
      expiresInSeconds: 0,
      drm: false,
    });
    // A supported YouTube link is classified SERVER-SIDE into the one
    // shape the player may embed: the vetted 11-character id, never the
    // raw URL. The URL itself is still returned for the link-out.
    expect(external.body.externalEmbed).toEqual({
      provider: 'youtube',
      videoId: 'dQw4w9WgXcQ',
    });
    expect(external.body.externalUrl).toBe('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  // =========================================================================
  // 4. `POST …/playback/refresh` re-runs the FULL decision (§L).
  // =========================================================================

  it('refresh re-issues a live credential and re-runs every entitlement condition', async () => {
    const w = await world('refresh', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 300);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'refresh-lesson');
    const student = await enrolledLearner(w, 'refresh-student');

    const first = await getContent(student, w.course.id, lesson.id).expect(200);
    const refreshed = await refreshGrant(student, w.course.id, lesson.id).expect(200);
    expect(refreshed.body.lessonId).toBe(lesson.id);
    expect(refreshed.body.protection.tier).toBe('normal');
    expect(refreshed.body.protection.expiresInSeconds).toBeGreaterThan(0);
    // A credential minted NOW, so its life never runs down across a
    // refresh — which is the whole reason the endpoint is mandatory for a
    // tier whose credential is shorter than a long lesson. (It can be
    // byte-identical to the first when both are minted inside the same
    // second, because the gate token's expiry has second granularity;
    // what must never happen is the expiry moving backwards.)
    expect(basicTokenExpiry(refreshed.body.video.url)).toBeGreaterThanOrEqual(
      basicTokenExpiry(first.body.video.url),
    );
    expect(refreshed.headers['cache-control']).toBe('private, no-store');

    // CONDITION 3 — revoke the enrollment mid-lesson. A cheaper refresh
    // that only re-signed would keep serving; the full decision refuses.
    await admin.enrollment.updateMany({
      where: { studentId: student.userId, courseId: w.course.id },
      data: { status: 'unavailable', revokedAt: new Date(), revokeReason: 'refund' },
    });
    const afterRevoke = await refreshGrant(student, w.course.id, lesson.id).expect(403);
    expect(afterRevoke.body.error).toMatchObject({
      messageKey: 'errors.learning.accessEnded',
    });

    // CONDITION 4 — an unpublished course delivers nothing either.
    await admin.enrollment.updateMany({
      where: { studentId: student.userId, courseId: w.course.id },
      data: { status: 'enrolled', revokedAt: null, revokeReason: null },
    });
    await refreshGrant(student, w.course.id, lesson.id).expect(200);
    await admin.course.update({ where: { id: w.course.id }, data: { status: 'draft' } });
    await refreshGrant(student, w.course.id, lesson.id).expect(404);
    await admin.course.update({
      where: { id: w.course.id },
      data: { status: 'published' },
    });

    // CONDITION 5 — a drip date in the future.
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: { availableAt: new Date(Date.now() + 86_400_000) },
    });
    const scheduled = await refreshGrant(student, w.course.id, lesson.id).expect(403);
    expect(scheduled.body.error).toMatchObject({
      messageKey: 'errors.learning.lessonScheduled',
    });
  });

  it('refresh requires a session, where the initial grant may be anonymous for a preview lesson', async () => {
    const w = await world('refresh-auth', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 120);
    const preview = await attachVideoLesson(w, ticket.assetId, 'preview-lesson', {
      isPreview: true,
    });

    // §V — "preview lessons open without enrollment".
    const anonymous = await request(app.getHttpServer())
      .get(`/learning/courses/${w.course.id}/lessons/${preview.id}/content`)
      .expect(200);
    expect(anonymous.body.isPreview).toBe(true);
    expect(anonymous.body.playbackLease).toBeNull();

    // …but the refresh endpoint is behind `JwtAuthGuard`.
    await request(app.getHttpServer())
      .post(`/learning/courses/${w.course.id}/lessons/${preview.id}/playback/refresh`)
      .send({})
      .expect(401);
  });

  // =========================================================================
  // 5. Mixed tiers in one academy, and a downgrade that migrates NOTHING
  //    (D11, AD-15).
  // =========================================================================

  it('Normal and Premium assets coexist in one academy and each reports its own tier (D11)', async () => {
    const w = await world('mixed', { family: 'premium', tier: 'enterprise' });

    // A Premium asset, created while Premium is the default.
    const premiumTicket = await createUpload(w, {
      fileName: 'premium.mp4',
      maxDurationSeconds: 300,
      courseId: w.course.id,
    });
    await admin.mediaAsset.update({
      where: { id: premiumTicket.body.assetId },
      data: {
        processingStatus: 'ready',
        durationSeconds: 300,
        durationSource: 'measured',
      },
    });

    // The academy then switches its DEFAULT to Normal.
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({ videoSecurityTier: 'normal' })
      .expect(200);
    const { ticket: normalTicket } = await readyNormalAsset(w, 180);

    const premiumRow = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: premiumTicket.body.assetId },
    });
    const normalRow = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: normalTicket.assetId },
    });
    expect(premiumRow.provider).toBe('cloudflare_stream');
    expect(premiumRow.securityTier).toBe('premium');
    expect(normalRow.provider).toBe('r2_worker');
    expect(normalRow.securityTier).toBe('normal');
    expect(premiumRow.academyId).toBe(normalRow.academyId);

    // Both play, each through its own adapter, in the same academy.
    const premiumLesson = await attachVideoLesson(
      w,
      premiumTicket.body.assetId,
      'mixed-premium',
      { order: 0 },
    );
    const normalLesson = await attachVideoLesson(
      w,
      normalTicket.assetId,
      'mixed-normal',
      {
        order: 1,
      },
    );
    const student = await enrolledLearner(w, 'mixed-student');

    const premiumGrant = await getContent(student, w.course.id, premiumLesson.id).expect(
      200,
    );
    const normalGrant = await getContent(student, w.course.id, normalLesson.id).expect(
      200,
    );
    expect(premiumGrant.body.protection.tier).toBe('premium');
    expect(premiumGrant.body.video.format).toBe('hls');
    expect(normalGrant.body.protection.tier).toBe('normal');
    expect(normalGrant.body.video.format).toBe('mp4');

    // §V — the access log says WHICH tier and provider delivered each one.
    const logs = await admin.contentAccessLog.findMany({
      where: { lessonId: { in: [premiumLesson.id, normalLesson.id] }, result: 'granted' },
      orderBy: { createdAt: 'asc' },
    });
    const byLesson = new Map(logs.map((row) => [row.lessonId, row]));
    expect(byLesson.get(premiumLesson.id)).toMatchObject({
      securityTier: 'premium',
      provider: 'cloudflare_stream',
    });
    expect(byLesson.get(normalLesson.id)).toMatchObject({
      securityTier: 'normal',
      provider: 'r2_worker',
    });
  });

  it('a Premium → Normal DOWNGRADE migrates nothing; only new uploads change (D11)', async () => {
    const w = await world('downgrade', { family: 'premium', tier: 'growth' });
    const premiumTicket = await createUpload(w, {
      fileName: 'legacy-premium.mp4',
      maxDurationSeconds: 600,
      courseId: w.course.id,
    });
    await admin.mediaAsset.update({
      where: { id: premiumTicket.body.assetId },
      data: {
        processingStatus: 'ready',
        durationSeconds: 600,
        durationSource: 'measured',
      },
    });
    const premiumLesson = await attachVideoLesson(
      w,
      premiumTicket.body.assetId,
      'legacy-premium-lesson',
    );

    // THE DOWNGRADE: the organization moves to a Normal-family plan.
    const normalPlan = await seedPlan(admin, 'downgrade-normal-plan', {
      limits: {
        academies: 50,
        students: 500,
        instructors: 50,
        staff: 50,
        courses: 200,
        generalStorage: 100,
        videoStorage: 100,
        videoStorageMinutes: 5_000,
      },
    });
    await admin.plan.update({
      where: { id: normalPlan.id },
      data: { family: 'normal', tier: 'growth' },
    });
    await admin.tenantSubscription.update({
      where: { organizationId: w.org.id },
      data: { planId: normalPlan.id },
    });

    // NOTHING about the existing asset changed.
    const unchanged = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: premiumTicket.body.assetId },
    });
    expect(unchanged.provider).toBe('cloudflare_stream');
    expect(unchanged.securityTier).toBe('premium');

    // The entitlement ceiling did change, and Premium can no longer be selected.
    const tierSetting = await request(app.getHttpServer())
      .get(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .expect(200);
    expect(tierSetting.body).toMatchObject({
      entitled: 'normal',
      videoSecurityTier: 'normal',
    });
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({ videoSecurityTier: 'premium' })
      .expect(403);

    // A NEW upload uses the newly entitled tier …
    const newTicket = await createUpload(w, {
      fileName: 'after-downgrade.mp4',
      maxDurationSeconds: 120,
      courseId: w.course.id,
    });
    expect(newTicket.body.securityTier).toBe('normal');
    const newRow = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: newTicket.body.assetId },
    });
    expect(newRow.provider).toBe('r2_worker');

    // … and the OLD Premium asset still plays through Premium, reporting
    // the truth about ITSELF rather than about the academy's subscription.
    const student = await enrolledLearner(w, 'downgrade-student');
    const grant = await getContent(student, w.course.id, premiumLesson.id).expect(200);
    expect(grant.body.protection.tier).toBe('premium');
    expect(grant.body.protection.adaptiveBitrate).toBe(true);
    expect(grant.body.video.format).toBe('hls');
  });

  // =========================================================================
  // 6. The rest of the Phase 2 surface still works under the new provider
  //    architecture (§L).
  // =========================================================================

  it('the unified sequence endpoint answers within the learner request budget (§D.3)', async () => {
    const w = await world('sequence', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 600);
    await attachVideoLesson(w, ticket.assetId, 'sequence-lesson');
    const student = await enrolledLearner(w, 'sequence-student');

    /*
     * A 500 HERE IS NOT A FLAKE — see the report's P2-API-4.
     *
     * Every read of `course_lessons` in a LEARNER context plans as a
     * sequential scan (the RLS quals are `SECURITY DEFINER` and therefore
     * not leakproof, so they are evaluated before the `course_id`
     * condition can be pushed to an index). The resulting plan costs
     * ~600,000, which is above all three of Postgres's JIT thresholds, so
     * the server spends ~6.5 s compiling a 627-function expression tree
     * before executing a query that takes 4 ms without JIT. That exceeds
     * the 5 s interactive-transaction ceiling this endpoint runs inside,
     * and the learner gets a 500 on their own course page.
     *
     * `ALTER ROLE atlas_app SET jit = off` removes it. Until then this
     * assertion is the canary.
     */
    const sequence = await request(app.getHttpServer())
      .get(`/learning/courses/${w.course.id}/sequence`)
      .set(student.auth)
      .expect(200);

    expect(Array.isArray(sequence.body.items)).toBe(true);
    expect(sequence.body.items.length).toBeGreaterThan(0);
    expect(sequence.body.items[0]).toHaveProperty('state');
  });

  it('playback, undo, dashboard aggregates, devices and takeover all still work', async () => {
    const w = await world('surface', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 600);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'surface-lesson');
    const student = await enrolledLearner(w, 'surface-student');

    const grant = await getContent(student, w.course.id, lesson.id).expect(200);
    expect(grant.body.playbackLease).not.toBeNull();

    const heartbeat = await request(app.getHttpServer())
      .post(`/learning/courses/${w.course.id}/playback`)
      .set(student.auth)
      .set('Cookie', student.cookie)
      .send({
        lessonId: lesson.id,
        positionSeconds: 45,
        leaseId: grant.body.playbackLease.leaseId,
      })
      .expect(200);
    expect(heartbeat.body).toMatchObject({ lessonId: lesson.id, leaseHeld: true });
    expect(heartbeat.body.lastPositionSeconds).toBe(45);

    // Resume position survives into the next grant.
    const resumed = await getContent(student, w.course.id, lesson.id).expect(200);
    expect(resumed.body.resumePositionSeconds).toBeGreaterThan(0);

    await request(app.getHttpServer())
      .delete(`/learning/courses/${w.course.id}/progress/complete-lesson/${lesson.id}`)
      .set(student.auth)
      .expect(200);

    const overview = await request(app.getHttpServer())
      .get('/learning/overview')
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .expect(200);
    expect(overview.body).toMatchObject({ academyId: w.academy.id });
    expect(overview.body.courseCounts.all).toBeGreaterThan(0);
    expect(overview.body.continueLearning[0]).toMatchObject({
      courseId: w.course.id,
      nextItemId: lesson.id,
    });

    await request(app.getHttpServer())
      .get('/learning/quizzes')
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .expect(200);
    await request(app.getHttpServer())
      .get('/learning/assignments')
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .expect(200);

    const devices = await request(app.getHttpServer())
      .get('/learning/devices')
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .expect(200);
    expect(devices.body.devices.length).toBeGreaterThan(0);

    const takeover = await request(app.getHttpServer())
      .post('/learning/session/takeover')
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .set('Cookie', student.cookie)
      .send({ courseId: w.course.id, lessonId: lesson.id })
      .expect(200);
    expect(takeover.body).toBeTruthy();

    await request(app.getHttpServer())
      .delete(`/learning/devices/${devices.body.devices[0].id}`)
      .query({ academyId: w.academy.id })
      .set(student.auth)
      .expect(204);
  });

  // =========================================================================
  // 7. DTO validation, guards and error shapes (§L, §V).
  // =========================================================================

  it('the video-upload DTO refuses out-of-range, missing and unknown fields', async () => {
    const w = await world('dto-upload', { family: 'normal', tier: 'growth' });

    await createUpload(w, { fileName: 'x.mp4' }, 400);
    await createUpload(w, { fileName: 'x.mp4', maxDurationSeconds: 0 }, 400);
    await createUpload(w, { fileName: 'x.mp4', maxDurationSeconds: -60 }, 400);
    await createUpload(w, { fileName: 'x.mp4', maxDurationSeconds: 1.5 }, 400);
    // 12 hours is the ceiling on ONE reservation.
    await createUpload(
      w,
      { fileName: 'x.mp4', maxDurationSeconds: 12 * 60 * 60 + 1 },
      400,
    );
    await createUpload(w, { maxDurationSeconds: 60 }, 400);
    await createUpload(w, { fileName: 'y'.repeat(256), maxDurationSeconds: 60 }, 400);
    // `forbidNonWhitelisted` — a caller cannot smuggle in a tier or provider.
    await createUpload(
      w,
      { fileName: 'x.mp4', maxDurationSeconds: 60, securityTier: 'premium' },
      400,
    );
    await createUpload(
      w,
      { fileName: 'x.mp4', maxDurationSeconds: 60, provider: 'cloudflare_stream' },
      400,
    );
    // A course from ANOTHER academy is not a course this academy may use.
    const other = await world('dto-upload-other', { family: 'normal', tier: 'basic' });
    await createUpload(
      w,
      { fileName: 'x.mp4', maxDurationSeconds: 60, courseId: other.course.id },
      404,
    );
  });

  it('the playback and tier DTOs bound what a client may report', async () => {
    const w = await world('dto-playback', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 300);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'dto-lesson');
    const student = await enrolledLearner(w, 'dto-student');

    const heartbeat = (body: Record<string, unknown>) =>
      request(app.getHttpServer())
        .post(`/learning/courses/${w.course.id}/playback`)
        .set(student.auth)
        .set('Cookie', student.cookie)
        .send(body);

    await heartbeat({ lessonId: lesson.id, positionSeconds: -1 }).expect(400);
    await heartbeat({ lessonId: lesson.id, positionSeconds: 24 * 60 * 60 + 1 }).expect(
      400,
    );
    await heartbeat({ lessonId: lesson.id, positionSeconds: 10.5 }).expect(400);
    await heartbeat({ positionSeconds: 10 }).expect(400);
    // The client may report a POSITION and nothing else — a watched-seconds
    // field would make the completion rule decorative.
    await heartbeat({
      lessonId: lesson.id,
      positionSeconds: 10,
      watchedSeconds: 9_999,
    }).expect(400);

    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({ videoSecurityTier: 'gold' })
      .expect(400);
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(w.owner.auth)
      .send({})
      .expect(400);
  });

  it('the staff upload endpoints are guarded by session, surface, academy scope and role', async () => {
    const w = await world('guards', { family: 'normal', tier: 'growth' });

    // No session at all.
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .send({ fileName: 'x.mp4', maxDurationSeconds: 60 })
      .expect(401);

    // A LEARNER session is refused at the management-surface boundary,
    // before any media code runs.
    const student = await enrolledLearner(w, 'guards-student');
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .set(student.auth)
      .send({ fileName: 'x.mp4', maxDurationSeconds: 60 })
      .expect(403);

    // Staff of a DIFFERENT organization.
    const outsider = await staffAccount('guards-outsider');
    await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .set(outsider.auth)
      .send({ fileName: 'x.mp4', maxDurationSeconds: 60 })
      .expect(403);

    // An INSTRUCTOR of this academy is not a managing role for media.
    const instructor = await staffAccount('guards-instructor');
    await admin.organizationMembership.create({
      data: { organizationId: w.org.id, userId: instructor.userId, role: 'instructor' },
    });
    await seedAcademyMember(admin, w.academy.id, instructor.userId, 'instructor');
    const refused = await request(app.getHttpServer())
      .post(`/academies/${w.academy.id}/media/video-uploads`)
      .set(instructor.auth)
      .send({ fileName: 'x.mp4', maxDurationSeconds: 60, courseId: w.course.id })
      .expect(403);
    expect(refused.body.error).toMatchObject({
      messageKey: 'errors.media.insufficientRole',
    });

    // The owner-only settings (D8) refuse a manager.
    const manager = await staffAccount('guards-manager');
    await admin.organizationMembership.create({
      data: { organizationId: w.org.id, userId: manager.userId, role: 'manager' },
    });
    await seedAcademyMember(admin, w.academy.id, manager.userId, 'manager');
    await request(app.getHttpServer())
      .patch(`/academies/${w.academy.id}/video-tier`)
      .set(manager.auth)
      .send({ videoSecurityTier: 'normal' })
      .expect(403);
  });

  it('an anonymous caller gets nothing for a non-preview lesson, and a refusal is logged', async () => {
    const w = await world('anon', { family: 'normal', tier: 'growth' });
    const { ticket } = await readyNormalAsset(w, 120);
    const lesson = await attachVideoLesson(w, ticket.assetId, 'anon-lesson');

    const refused = await request(app.getHttpServer())
      .get(`/learning/courses/${w.course.id}/lessons/${lesson.id}/content`)
      .expect(404);
    expect(refused.body.error).toMatchObject({ messageKey: 'errors.notFound' });
    expect(JSON.stringify(refused.body)).not.toContain(BASIC_DELIVERY_HOST);

    const logged = await admin.contentAccessLog.findFirst({
      where: { lessonId: lesson.id, result: 'refused' },
      orderBy: { createdAt: 'desc' },
    });
    expect(logged?.reason).toBe('notAuthenticated');
  });

  /**
   * P64 Phase 2 — the `lesson_contents` AUTHORING path.
   *
   * These cases exist because of a production failure, not a hypothesis.
   * The Normal tier was configured end to end on the real deployment —
   * protected R2 reachable, upload reserved, bytes PUT, completion parsing
   * a real 3-second duration, `videoAssetId` attached, `can_access_lesson`
   * returning true for the enrolled learner — and the grant still answered
   * 404. The cause was that `lesson_contents` had RLS, a backfill and a
   * reader, but no writer: every lesson created after the migration had no
   * content row, and `LessonContentService` correctly refuses without one.
   *
   * Every other video test in this file seeds that row with the admin
   * client. These do not: they drive the real `PUT .../content` endpoint,
   * which is the only way this regression could have been caught.
   */
  describe('lesson content authoring (PUT .../lessons/:lessonId/content)', () => {
    function putContent(
      w: { academy: { id: string }; course: { id: string }; section: { id: string } },
      auth: Record<string, string>,
      lessonId: string,
      body: Record<string, unknown>,
    ) {
      return request(app.getHttpServer())
        .put(
          `/academies/${w.academy.id}/courses/${w.course.id}/sections/${w.section.id}/lessons/${lessonId}/content`,
        )
        .set(auth)
        .send(body);
    }

    /** A published video lesson with its asset attached but NO content row — the exact production state that returned 404. */
    async function lessonAwaitingContent(
      w: Awaited<ReturnType<typeof world>>,
      label: string,
    ) {
      const { ticket } = await readyNormalAsset(w, 30);
      const lesson = await seedCourseLesson(admin, w.section.id, w.course.id, label, 0, {
        contentType: 'video',
        status: 'published',
      });
      await request(app.getHttpServer())
        .patch(
          `/academies/${w.academy.id}/courses/${w.course.id}/sections/${w.section.id}/lessons/${lesson.id}`,
        )
        .set(w.owner.auth)
        .send({ videoAssetId: ticket.assetId })
        .expect(200);
      return { lesson, assetId: ticket.assetId };
    }

    it('THE REGRESSION: a lesson with a video asset but no content row is refused, and authoring content makes the learner grant succeed', async () => {
      const w = await world('authoring-regression', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'awaiting-content');
      const student = await enrolledLearner(w, 'authoring-regression-student');

      // Exactly what production did: entitled learner, attached asset, no
      // content row. Still a 404 — but for a learner who has passed every
      // entitlement check it names the real state, so the player says "no
      // content yet" instead of guessing "still processing".
      const refused = await getContent(student, w.course.id, lesson.id).expect(404);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.learning.lessonNoContent',
      });

      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);

      // The same request, unchanged, now succeeds.
      const grant = await getContent(student, w.course.id, lesson.id).expect(200);
      expect(grant.body.video.url).toContain(BASIC_DELIVERY_HOST);
      expect(grant.body.protection).toMatchObject({ tier: 'normal', drm: false });
    });

    it('writes exactly one row per lesson, however many times it is called', async () => {
      const w = await world('authoring-idempotent', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'idempotent');

      const first = await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);
      const second = await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);

      // Same row, not a second one — the UNIQUE lessonId is what makes
      // "one body per lesson" a database fact rather than a convention.
      expect(second.body.id).toBe(first.body.id);
      expect(await admin.lessonContent.count({ where: { lessonId: lesson.id } })).toBe(1);
    });

    it('switching kind clears the field the previous kind owned, leaving no dangling asset reference', async () => {
      const w = await world('authoring-switch', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'switch');

      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);
      const swapped = await putContent(w, w.owner.auth, lesson.id, {
        kind: 'external',
        externalUrl: 'https://example.com/embed/lesson',
      }).expect(200);

      expect(swapped.body.kind).toBe('external');
      expect(swapped.body.mediaAssetId).toBeUndefined();
      const row = await admin.lessonContent.findUnique({
        where: { lessonId: lesson.id },
      });
      expect(row?.mediaAssetId).toBeNull();
    });

    it('an external URL that is not a supported YouTube link stays a link-out: no embed descriptor, no iframe door', async () => {
      const w = await world('unsup-ext', {
        family: 'normal',
        tier: 'growth',
      });
      const { lesson } = await lessonAwaitingContent(w, 'unsup-ext');
      const student = await enrolledLearner(w, 'unsup-ext-student');

      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'external',
        externalUrl: 'https://example.com/embed/lesson',
      }).expect(200);

      const grant = await getContent(student, w.course.id, lesson.id).expect(200);
      expect(grant.body.kind).toBe('external');
      expect(grant.body.externalUrl).toBe('https://example.com/embed/lesson');
      expect(grant.body.externalEmbed).toBeUndefined();
      // A YouTube-looking host that is not YouTube must not be promoted either.
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'external',
        externalUrl: 'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ',
      }).expect(200);
      const spoofed = await getContent(student, w.course.id, lesson.id).expect(200);
      expect(spoofed.body.externalEmbed).toBeUndefined();
    });

    it('a lesson whose video asset has not finished processing is refused as PROCESSING, distinct from having no content', async () => {
      const w = await world('authoring-processing', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'processing');
      const student = await enrolledLearner(w, 'authoring-processing-student');
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);
      await getContent(student, w.course.id, lesson.id).expect(200);

      // The provider has not finished with it (a Stream webhook that never
      // arrived, a re-upload in flight): the grant refuses, still 404, and
      // names the state so the player can say "processing" honestly.
      await admin.mediaAsset.update({
        where: { id: assetId },
        data: { processingStatus: 'processing' },
      });
      const refused = await getContent(student, w.course.id, lesson.id).expect(404);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.learning.lessonProcessing',
      });
      expect(JSON.stringify(refused.body)).not.toContain(BASIC_DELIVERY_HOST);

      // An outsider still learns nothing either way.
      await request(app.getHttpServer())
        .get(`/learning/courses/${w.course.id}/lessons/${lesson.id}/content`)
        .expect(404)
        .expect((res) => {
          expect(res.body.error).toMatchObject({ messageKey: 'errors.notFound' });
        });
    });

    it('never returns the stored body back to the author', async () => {
      const w = await world('authoring-no-echo', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'no-echo');
      const saved = await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(200);
      expect(saved.body.bodyHtml).toBeUndefined();
    });

    it('refuses a learner, on the guard AND on the surface — writing content is not a learner capability', async () => {
      const w = await world('authoring-learner', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'learner-write');
      const student = await enrolledLearner(w, 'authoring-learner-student');

      await putContent(w, student.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: assetId,
      }).expect(403);

      expect(await admin.lessonContent.count({ where: { lessonId: lesson.id } })).toBe(0);
    });

    it('refuses an asset belonging to ANOTHER academy, and says only "not found"', async () => {
      const mine = await world('authoring-mine', { family: 'normal', tier: 'growth' });
      const theirs = await world('authoring-theirs', {
        family: 'normal',
        tier: 'growth',
      });
      const { lesson } = await lessonAwaitingContent(mine, 'cross-academy');
      const foreign = await readyNormalAsset(theirs, 30);

      // 404, not 403: a distinct "wrong academy" answer would confirm the
      // id exists somewhere, which is the disclosure the refusal avoids.
      await putContent(mine, mine.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: foreign.ticket.assetId,
      }).expect(404);

      expect(await admin.lessonContent.count({ where: { lessonId: lesson.id } })).toBe(0);
    });

    it('refuses a non-video asset for a video body', async () => {
      const w = await world('authoring-not-video', { family: 'normal', tier: 'growth' });
      const { lesson } = await lessonAwaitingContent(w, 'not-video');
      const doc = await admin.mediaAsset.create({
        data: {
          academyId: w.academy.id,
          type: 'document',
          access: 'protected',
          storageKey: `academies/${w.academy.id}/${randomUUID()}.pdf`,
          mimeType: 'application/pdf',
          fileName: 'notes.pdf',
          sizeBytes: 10,
          url: '',
        },
      });
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'video',
        mediaAssetId: doc.id,
      }).expect(400);
    });

    it('refuses a PUBLIC asset for a file body — a durable public URL is the problem this phase removes', async () => {
      const w = await world('authoring-public-file', {
        family: 'normal',
        tier: 'growth',
      });
      const { lesson } = await lessonAwaitingContent(w, 'public-file');
      const publicDoc = await admin.mediaAsset.create({
        data: {
          academyId: w.academy.id,
          type: 'document',
          access: 'public',
          storageKey: `academies/${w.academy.id}/${randomUUID()}.pdf`,
          mimeType: 'application/pdf',
          fileName: 'public.pdf',
          sizeBytes: 10,
          url: 'https://cdn.example.test/public.pdf',
        },
      });
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'file',
        mediaAssetId: publicDoc.id,
      }).expect(400);
    });

    it('refuses kind: text with a reason, and cannot be sent a body at all', async () => {
      const w = await world('authoring-text', { family: 'normal', tier: 'growth' });
      const { lesson } = await lessonAwaitingContent(w, 'text-refused');

      // The kind itself is refused with a reason the caller can act on:
      // the field is legitimate, the authoring path for it is not built,
      // and no sanitiser was invented to pretend otherwise.
      const res = await putContent(w, w.owner.auth, lesson.id, { kind: 'text' }).expect(
        400,
      );
      expect(res.body.error.messageKey).toBe('errors.lessonContent.textNotYetSupported');

      // And `bodyHtml` is not a field this DTO has, so `forbidNonWhitelisted`
      // rejects it before any handler runs. That is the stronger guarantee:
      // unsanitised HTML cannot reach the column even by mistake, because
      // there is no parameter that carries it.
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'text',
        bodyHtml: '<p>hello</p>',
      }).expect(400);

      expect(await admin.lessonContent.count({ where: { lessonId: lesson.id } })).toBe(0);
    });

    it('refuses an incomplete payload for each kind', async () => {
      const w = await world('authoring-incomplete', { family: 'normal', tier: 'growth' });
      const { lesson, assetId } = await lessonAwaitingContent(w, 'incomplete');

      await putContent(w, w.owner.auth, lesson.id, { kind: 'video' }).expect(400);
      await putContent(w, w.owner.auth, lesson.id, { kind: 'external' }).expect(400);
      // `external` names a third party; an asset id alongside it is a
      // contradiction, not an extra.
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'external',
        externalUrl: 'https://example.com/e',
        mediaAssetId: assetId,
      }).expect(400);
      // http is refused at the DTO: the learner surface is TLS, so it
      // would be a mixed-content block at playback rather than here.
      await putContent(w, w.owner.auth, lesson.id, {
        kind: 'external',
        externalUrl: 'http://example.com/e',
      }).expect(400);
    });
  });
});
