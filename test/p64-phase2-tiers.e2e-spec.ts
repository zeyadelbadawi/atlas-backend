/**
 * P64 Phase 2 — the tier/provider resolution CHAIN, refusal forensics, and
 * the single-session lease.
 *
 * SCOPE, AND WHY IT IS NARROW. This file was written when Phase 2 had no
 * e2e coverage at all; four other Phase 2 suites landed alongside it
 * (`p64-phase2-api`, `-quota`, `-rls-tiers`, `-security`). Everything they
 * already assert at the same level has been REMOVED from here rather than
 * left as a second copy — the upload lifecycle, the quota arithmetic, the
 * playback capability reports, mixed-tier coexistence, cross-academy
 * refusal and the refresh endpoint all live in those files. What remains
 * is only what none of them asserts:
 *
 *   1. THE CHAIN AS THREE SEPARATE ANSWERS. §M (amended) asks for "tier
 *      resolution and provider resolution as separate, independently
 *      asserted steps". Asserted here at the SERVICE boundary —
 *      `entitledTier()`, then `resolve()`, then
 *      `VideoProviderRegistry.forTier()` — for all six commercial
 *      variants, against the real database and RLS. The HTTP-level
 *      version in `p64-phase2-api` necessarily conflates the last two,
 *      because one upload ticket carries both answers.
 *
 *   2. SEC-2 REGRESSION. A refusal for an IDENTIFIED learner reaching
 *      `content_access_log` at all. These three cases FAILED when first
 *      written, on two independent causes, and are kept because both
 *      failure modes are silent.
 *
 *   3. THE LEASE, not just the device cap. Renewal for the same browser,
 *      handover on a deliberate release, the conflict body the takeover
 *      dialog needs, and what a takeover actually moves and audits.
 *
 * WHY REAL ADAPTERS. Both tiers are configured through environment
 * variables read at boot, so `BasicVideoProvider` (not the local stand-in)
 * serves Normal and `CloudflareStreamProvider` mints real Premium tokens
 * against a throwaway key. Cloudflare's own HTTP API is never called —
 * asserting what Atlas sends would not assert what Cloudflare accepts — so
 * Premium ASSETS are seeded at the state that API would have left them in.
 *
 * WHY PLANS ARE CREATED HERE RATHER THAN THROUGH `seedPlan`. The shared
 * helper predates D10 and does not set `family`/`tier`, and those two
 * columns are this file's subject. `displayOrder` stays 0 for the same
 * reason the shared helper does: it keeps fixture plans out of the
 * customer-facing catalog permanently.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
  seedTenantSubscription,
} from './utils/db-admin';
import type {
  PlanFamily,
  PlanTier,
  PrismaClient,
  VideoSecurityTier,
} from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

/**
 * Both tiers configured BEFORE the application module is built, because
 * `configuration.ts` reads `process.env` once at boot. `dotenv` never
 * overwrites a variable that is already set, so these win over `.env`.
 */
const STREAM_KEY = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
}).privateKey;

const MUTATED_ENV_KEYS = [
  'FLAG_VIDEO_NORMAL_MODE',
  'FLAG_VIDEO_PREMIUM_MODE',
  'BASIC_VIDEO_DELIVERY_HOST',
  'BASIC_VIDEO_SIGNING_SECRET',
  'BASIC_VIDEO_PLAYBACK_TTL_SECONDS',
  'BASIC_VIDEO_REVOCATION_ENDPOINT',
  'BASIC_VIDEO_REVOCATION_TOKEN',
  'BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED',
  'CLOUDFLARE_STREAM_ACCOUNT_ID',
  'CLOUDFLARE_STREAM_API_TOKEN',
  'CLOUDFLARE_STREAM_SIGNING_KEY_ID',
  'CLOUDFLARE_STREAM_SIGNING_KEY_PEM',
  'CLOUDFLARE_STREAM_WEBHOOK_SECRET',
  'CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN',
] as const;

/**
 * Jest reuses one worker process across spec FILES, so a `process.env`
 * mutation made here would still be in force when the next file boots its
 * own application. Snapshotting first and restoring in `afterAll` keeps
 * this suite's two-tier configuration from leaking into anyone else's.
 */
const ENV_BEFORE = new Map<string, string | undefined>(
  MUTATED_ENV_KEYS.map((key) => [key, process.env[key]]),
);

function restoreEnv(): void {
  for (const [key, value] of ENV_BEFORE) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

process.env.FLAG_VIDEO_NORMAL_MODE = 'on';
process.env.FLAG_VIDEO_PREMIUM_MODE = 'on';
process.env.BASIC_VIDEO_DELIVERY_HOST = 'video.atlas.test';
process.env.BASIC_VIDEO_SIGNING_SECRET = 'p64-phase2-basic-signing-secret';
process.env.BASIC_VIDEO_PLAYBACK_TTL_SECONDS = '600';
process.env.BASIC_VIDEO_REVOCATION_ENDPOINT = 'https://worker.atlas.test/revocations';
process.env.BASIC_VIDEO_REVOCATION_TOKEN = 'p64-phase2-revocation-token';
process.env.BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED = 'true';
process.env.CLOUDFLARE_STREAM_ACCOUNT_ID = 'p64-phase2-account';
process.env.CLOUDFLARE_STREAM_API_TOKEN = 'p64-phase2-api-token';
process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID = 'p64-phase2-signing-key';
process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM = STREAM_KEY;
process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = 'p64-phase2-webhook-secret';
process.env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN = 'customer-p64.cloudflarestream.com';

// Imported AFTER the environment is set, so nothing reads a stale value.
import { VideoTierService } from '../src/plans/services/video-tier.service';
import { VideoProviderRegistry } from '../src/media/video/video-provider.registry';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { DEVICE_COOKIE_NAME } from '../src/tenancy/services/student-device.service';

describe('P64 Phase 2 — video security tiers, providers and quota (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let videoTiers: VideoTierService;
  let providers: VideoProviderRegistry;
  let tenancy: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    videoTiers = app.get(VideoTierService);
    providers = app.get(VideoProviderRegistry);
    tenancy = app.get(TenancyContextService);
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  afterAll(() => {
    restoreEnv();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // -------------------------------------------------------------------
  // fixtures
  // -------------------------------------------------------------------

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
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /**
   * A learner AND the browser they are using.
   *
   * The `atlas_device` cookie is issued at SIGN-IN and nowhere else
   * (`auth.controller.ts`), so a real browser presents the same device on
   * every subsequent request. A test that forgot to send it would
   * register a fresh device per call and then collide with its own
   * lease — which is the single-session rule working correctly, not a
   * bug, and would make every multi-request test assert the wrong thing.
   */
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
    return {
      email,
      userId: signIn.body.user.id as string,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
      device: readDeviceCookie(signIn),
    };
  }

  /** A SECOND browser for the same learner — another academy-surface sign-in registers another device. */
  async function anotherBrowser(email: string, academyId: string) {
    await flushRateLimitKeys();
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    return {
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
      device: readDeviceCookie(signIn),
    };
  }

  /** A plan row that actually carries D10's `family`/`tier`, which `seedPlan` predates. */
  async function seedVariantPlan(
    label: string,
    family: PlanFamily,
    tier: PlanTier,
    videoStorageMinutes: number | 'unlimited' = 5000,
  ) {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        status: 'active',
        family,
        tier,
        // Deliberately 0 — keeps every fixture plan out of `GET /plans`.
        displayOrder: 0,
        limits: {
          academies: 5,
          students: 500,
          instructors: 50,
          staff: 50,
          courses: 200,
          generalStorage: 100,
          videoStorage: 100,
          videoStorageMinutes,
        },
        features: { liveSessions: false },
        pricing: { amount: 49, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  }

  interface World {
    readonly ownerUserId: string;
    readonly ownerAuth: Record<string, string>;
    readonly organizationId: string;
    readonly academyId: string;
    readonly courseId: string;
    readonly sectionId: string;
  }

  async function seedWorld(
    label: string,
    options: {
      readonly family?: PlanFamily;
      readonly tier?: PlanTier;
      readonly videoStorageMinutes?: number | 'unlimited';
      readonly academyTier?: VideoSecurityTier;
    } = {},
  ): Promise<World> {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const plan = await seedVariantPlan(
      `${label}-plan`,
      options.family ?? 'normal',
      options.tier ?? 'growth',
      options.videoStorageMinutes ?? 5000,
    );
    await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    if (options.academyTier) {
      await admin.academy.update({
        where: { id: academy.id },
        data: { videoSecurityTier: options.academyTier },
      });
    }
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label} Section`, 1);
    return {
      ownerUserId: owner.userId,
      ownerAuth: owner.auth,
      organizationId: org.id,
      academyId: academy.id,
      courseId: course.id,
      sectionId: section.id,
    };
  }

  /**
   * A video asset at the exact state each provider's upload path leaves
   * it in once processing is finished. `provider` and `securityTier` are
   * set independently on purpose: AD-15 treats them as two different
   * facts, and several tests below rely on being able to make them
   * disagree with the academy's current plan.
   */
  async function seedVideoAsset(args: {
    readonly academyId: string;
    readonly courseId: string;
    readonly provider: 'r2_worker' | 'cloudflare_stream';
    readonly securityTier: VideoSecurityTier;
    readonly durationSeconds: number;
    readonly processingStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  }) {
    return admin.mediaAsset.create({
      data: {
        academyId: args.academyId,
        courseId: args.courseId,
        type: 'video',
        fileName: `fixture-${randomUUID()}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(1024),
        access: 'protected',
        provider: args.provider,
        securityTier: args.securityTier,
        providerId:
          args.provider === 'cloudflare_stream'
            ? randomUUID().replace(/-/g, '')
            : `academies/${args.academyId}/courses/${args.courseId}/${randomUUID()}.mp4`,
        processingStatus: args.processingStatus ?? 'ready',
        durationSeconds: args.durationSeconds,
        durationSource: 'measured',
      },
    });
  }

  /** A published video lesson wired to an asset, with the `lesson_contents` row the grant path reads. */
  async function seedVideoLesson(
    world: World,
    title: string,
    order: number,
    videoAssetId: string,
  ) {
    const lesson = await seedCourseLesson(
      admin,
      world.sectionId,
      world.courseId,
      title,
      order,
      { contentType: 'video', status: 'published' },
    );
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: { videoAssetId },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: lesson.id,
        courseId: world.courseId,
        academyId: world.academyId,
        kind: 'video',
      },
    });
    return lesson;
  }

  async function enrolledLearner(label: string, world: World) {
    // `POST /auth/register` with an `academyId` creates the
    // `academy_students` row itself, so seeding one here would collide on
    // its own unique constraint — the membership condition the grant path
    // checks is already satisfied by having registered at the academy.
    const learner = await learnerAccount(label, world.academyId);
    await seedEnrollment(admin, learner.userId, world.courseId, world.academyId);
    return learner;
  }

  interface Actor {
    readonly auth: Record<string, string>;
    readonly device?: string | null;
  }

  /** Reads a grant as one browser — its `atlas_device` cookie included, exactly as a browser would. */
  function getContent(world: World, lessonId: string, actor: Actor) {
    const req = request(app.getHttpServer())
      .get(`/learning/courses/${world.courseId}/lessons/${lessonId}/content`)
      .set(actor.auth);
    return actor.device
      ? req.set('Cookie', `${DEVICE_COOKIE_NAME}=${actor.device}`)
      : req;
  }

  // ===================================================================
  // 1. plan → entitlement → security tier → provider, as INDEPENDENT steps
  // ===================================================================

  describe('the six plan variants (D10)', () => {
    const variants: { family: PlanFamily; tier: PlanTier }[] = [
      { family: 'normal', tier: 'basic' },
      { family: 'normal', tier: 'growth' },
      { family: 'normal', tier: 'enterprise' },
      { family: 'premium', tier: 'basic' },
      { family: 'premium', tier: 'growth' },
      { family: 'premium', tier: 'enterprise' },
    ];

    it.each(variants)(
      '$family/$tier resolves entitlement → tier → provider as three separate answers',
      async ({ family, tier }) => {
        const world = await seedWorld(`tiers-${family}-${tier}`, { family, tier });
        const expectedTier: VideoSecurityTier =
          family === 'premium' ? 'premium' : 'normal';

        // STEP 1 — the plan FAMILY decides the entitlement ceiling. The
        // commercial tier must not enter into it: D10 makes the two
        // columns independent, and a `basic` Premium plan is entitled to
        // exactly what an `enterprise` Premium plan is.
        const entitled = await tenancy.runInTenantContext(world.organizationId, (tx) =>
          videoTiers.entitledTier(tx, world.organizationId),
        );
        expect(entitled).toBe(expectedTier);

        // STEP 2 — the tier NEW uploads land on, resolved from the
        // entitlement and the academy's own (here unset) choice.
        const resolved = await tenancy.runInTenantContext(world.organizationId, (tx) =>
          videoTiers.resolve(tx, {
            academyId: world.academyId,
            organizationId: world.organizationId,
          }),
        );
        expect(resolved).toEqual({
          tier: expectedTier,
          entitled: expectedTier,
          source: 'plan',
        });

        // STEP 3 — and only now, one layer down, does anything name a
        // provider. `premium` is nowhere hard-wired to a provider class
        // in the authorization layer (D10, §V).
        expect(providers.forTier(resolved.tier).storedAs).toBe(
          expectedTier === 'premium' ? 'cloudflare_stream' : 'r2_worker',
        );
      },
    );

    it('refuses to infer `premium` from anything but the family — an org with no subscription is normal', async () => {
      const owner = await staffAccount('tiers-nosub-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'tiers-nosub-org');
      const academy = await seedAcademy(admin, org.id, 'tiers-nosub-academy');

      const entitled = await tenancy.runInTenantContext(org.id, (tx) =>
        videoTiers.entitledTier(tx, org.id),
      );
      const resolved = await tenancy.runInTenantContext(org.id, (tx) =>
        videoTiers.resolve(tx, { academyId: academy.id, organizationId: org.id }),
      );
      // An entitlement nobody can prove was purchased must never be
      // granted by a lookup that found nothing.
      expect(entitled).toBe('normal');
      expect(resolved.tier).toBe('normal');
    });
  });

  // ===================================================================
  // 2. regression for security finding SEC-2
  // ===================================================================

  /**
   * REGRESSION — a refusal for an IDENTIFIED learner must reach
   * `content_access_log`.
   *
   * These three cases were written against the behaviour §V requires and
   * FAILED when first run, on two independent causes. Both have since
   * been fixed (security finding SEC-2), so this block is now the
   * regression that keeps them fixed. The failure modes are recorded
   * because each one is silent, and a test that only asserts the happy
   * path would not notice either coming back:
   *
   *   CAUSE 1 — RLS rejected the write. `content_access_log_insert`
   *     admitted a row only when `user_id = current_setting(
   *     'app.current_user_id')`, and `LessonContentService.logRefusal`
   *     writes OUTSIDE any context on purpose (a learner who was just
   *     refused may have no rows visible to them at all). Out of context
   *     the comparison is `user_id = NULL` → NULL → not TRUE, so
   *     Postgres refused it with 42501 and
   *     `ContentAccessLogRepository.record` swallowed it — correctly, since
   *     an audit write must never fail the request it audits, and exactly
   *     why it went unnoticed. Fixed in
   *     `20261009000300_p64_phase2_media_asset_learner_select`.
   *
   *   CAUSE 2 — the session-conflict row was rolled back. It was logged
   *     inside the caller's transaction and the `ConflictException` was
   *     then thrown from the same callback, aborting it. The refusal is
   *     now carried on the exception and logged outside the transaction
   *     (`lesson-content.service.ts:303`, `:375`).
   *
   * WHY IT MATTERS ENOUGH TO PIN: §V requires the log to record every
   * decision, §U requires a per-student grant rate and structured logs
   * for every refusal, and §R expects a grant flood to be visible. With
   * either cause present the table holds grants and anonymous refusals
   * only — so a sharing or abuse investigation sees every success and no
   * failure, which is the opposite of what it needs.
   */
  describe('SEC-2 regression — refusals for an identified learner are recorded', () => {
    /** Short, because the write happens within the request itself rather than on a queue. */
    const LOG_WAIT = { timeoutMs: 3000 };

    it('records a `notEnrolled` refusal (cause 1 — the RLS insert policy)', async () => {
      const world = await seedWorld('tiers-log-refuse', { family: 'normal' });
      const asset = await seedVideoAsset({
        academyId: world.academyId,
        courseId: world.courseId,
        provider: 'r2_worker',
        securityTier: 'normal',
        durationSeconds: 300,
      });
      const lesson = await seedVideoLesson(world, 'Refused lesson', 1, asset.id);
      // Registered at the academy, but never enrolled on the course.
      const outsider = await learnerAccount('tiers-log-refuse-learner', world.academyId);

      await getContent(world, lesson.id, outsider).expect(404);

      const entry = await waitForAsync(
        async () =>
          (await admin.contentAccessLog.findFirst({
            where: { lessonId: lesson.id, userId: outsider.userId, result: 'refused' },
            orderBy: { createdAt: 'desc' },
          })) ?? undefined,
        LOG_WAIT,
      );
      expect(entry.reason).toBe('notEnrolled');
      expect(entry.securityTier).toBeNull();
      expect(entry.provider).toBeNull();
    });

    it('records a `deviceLimit` refusal (cause 1)', async () => {
      const world = await seedWorld('tiers-log-devicelimit', { family: 'normal' });
      const asset = await seedVideoAsset({
        academyId: world.academyId,
        courseId: world.courseId,
        provider: 'r2_worker',
        securityTier: 'normal',
        durationSeconds: 300,
      });
      const lesson = await seedVideoLesson(world, 'Device limited', 1, asset.id);
      const learner = await enrolledLearner('tiers-log-devicelimit-learner', world);
      await anotherBrowser(learner.email, world.academyId);
      const third = await anotherBrowser(learner.email, world.academyId);

      await getContent(world, lesson.id, third).expect(403);

      // The refusal a device-sharing investigation most needs to see.
      const entry = await waitForAsync(
        async () =>
          (await admin.contentAccessLog.findFirst({
            where: { lessonId: lesson.id, userId: learner.userId, result: 'refused' },
            orderBy: { createdAt: 'desc' },
          })) ?? undefined,
        LOG_WAIT,
      );
      expect(entry.reason).toBe('deviceLimit');
    });

    it('records a `sessionConflict` refusal (cause 2 — the transaction rollback)', async () => {
      const world = await seedWorld('tiers-log-conflict', { family: 'normal' });
      const asset = await seedVideoAsset({
        academyId: world.academyId,
        courseId: world.courseId,
        provider: 'r2_worker',
        securityTier: 'normal',
        durationSeconds: 300,
      });
      const lesson = await seedVideoLesson(world, 'Conflicted', 1, asset.id);
      const learner = await enrolledLearner('tiers-log-conflict-learner', world);
      const second = await anotherBrowser(learner.email, world.academyId);

      await getContent(world, lesson.id, learner).expect(200);
      await getContent(world, lesson.id, second).expect(409);

      const entry = await waitForAsync(
        async () =>
          (await admin.contentAccessLog.findFirst({
            where: { lessonId: lesson.id, userId: learner.userId, result: 'refused' },
            orderBy: { createdAt: 'desc' },
          })) ?? undefined,
        LOG_WAIT,
      );
      expect(entry.reason).toBe('sessionConflict');
    });
  });

  // ===================================================================
  // 3. the single-session lease, and what a takeover moves (AD-10, D4)
  // ===================================================================

  describe('device and session policy', () => {
    /** A learner, a video lesson and an enrolment — the common fixture for all three. */
    async function deviceWorld(label: string) {
      const world = await seedWorld(label, { family: 'normal' });
      const asset = await seedVideoAsset({
        academyId: world.academyId,
        courseId: world.courseId,
        provider: 'r2_worker',
        securityTier: 'normal',
        durationSeconds: 600,
      });
      const lesson = await seedVideoLesson(world, `${label} lesson`, 1, asset.id);
      const learner = await enrolledLearner(`${label}-learner`, world);
      return { world, lesson, learner };
    }

    it('registers one device per sign-in and refuses the browser that would be the third', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-devices');
      expect(learner.device).toBeTruthy();

      // A second browser: another academy-surface sign-in, which is the
      // only thing that registers a device.
      const second = await anotherBrowser(learner.email, world.academyId);
      expect(second.device).toBeTruthy();
      expect(second.device).not.toBe(learner.device);

      const registered = await admin.studentDevice.count({
        where: { userId: learner.userId, academyId: world.academyId, revokedAt: null },
      });
      expect(registered).toBe(2);

      // A THIRD browser. At the cap, sign-in still succeeds — a device
      // limit must never lock a learner out of their account — but no
      // device is issued, so the browser arrives at the content path
      // with nothing to present.
      const third = await anotherBrowser(learner.email, world.academyId);
      expect(third.device).toBeNull();

      const refused = await getContent(world, lesson.id, third).expect(403);
      expect(refused.body.error.messageKey).toBe('errors.learning.deviceLimit');
      // Refused rather than registered: the cap is what makes it a cap.
      expect(
        await admin.studentDevice.count({
          where: { userId: learner.userId, academyId: world.academyId, revokedAt: null },
        }),
      ).toBe(2);
    });

    it('lets the SAME device reload without telling the learner they are competing with themselves', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-reload');

      const first = await getContent(world, lesson.id, learner).expect(200);
      const second = await getContent(world, lesson.id, learner).expect(200);

      // A renewal, not a conflict — otherwise refreshing the player page
      // would lock a learner out of their own lesson for 60 seconds.
      expect(second.body.playbackLease.leaseId).toBe(first.body.playbackLease.leaseId);
    });

    it('refuses a second CONCURRENT device with a conflict the takeover dialog can name', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-conflict');
      const second = await anotherBrowser(learner.email, world.academyId);

      const held = await getContent(world, lesson.id, learner).expect(200);
      expect(held.body.playbackLease.leaseId).toBeTruthy();

      const conflict = await getContent(world, lesson.id, second).expect(409);
      expect(conflict.body.error.messageKey).toBe('errors.learning.sessionConflict');
      // The dialog has to be able to name the other device and say since
      // when — a bare 409 would leave the learner guessing.
      expect(conflict.body.error.details).toHaveProperty('since');
      expect(conflict.body.error.details).toHaveProperty('deviceLabel');
    });

    it('hands the lease over on a deliberate release, without a takeover', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-release');
      const second = await anotherBrowser(learner.email, world.academyId);

      const held = await getContent(world, lesson.id, learner).expect(200);
      await request(app.getHttpServer())
        .post(`/learning/courses/${world.courseId}/playback/release`)
        .set(learner.auth)
        .set(`Cookie`, `${DEVICE_COOKIE_NAME}=${learner.device as string}`)
        .send({ leaseId: held.body.playbackLease.leaseId })
        .expect(204);

      // The learner closed the tab properly, so the handover is
      // immediate rather than waiting out the 60-second TTL.
      await getContent(world, lesson.id, second).expect(200);
    });

    it('moves the lease on an explicit takeover and audits both sides', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-takeover');
      const second = await anotherBrowser(learner.email, world.academyId);

      await getContent(world, lesson.id, learner).expect(200);
      await getContent(world, lesson.id, second).expect(409);

      await request(app.getHttpServer())
        .post(`/learning/session/takeover?academyId=${world.academyId}`)
        .set(second.auth)
        .set('Cookie', `${DEVICE_COOKIE_NAME}=${second.device as string}`)
        .send({ courseId: world.courseId, lessonId: lesson.id })
        .expect(200);

      // The displaced device is not simply asked nicely: the second
      // device now holds the lease and gets a grant.
      await getContent(world, lesson.id, second).expect(200);

      const audit = await waitForAsync(
        async () =>
          (await admin.auditLogEntry.findFirst({
            where: {
              action: 'learning.device_session_takeover',
              actorUserId: learner.userId,
            },
            orderBy: { occurredAt: 'desc' },
          })) ?? undefined,
      );
      // Both sides named, so a sharing investigation can follow the
      // sequence rather than only see that something happened.
      expect(audit.academyId).toBe(world.academyId);
      expect(audit.context).toMatchObject({
        courseId: world.courseId,
        lessonId: lesson.id,
      });
    });

    it('refuses a takeover from a browser that is not a registered device', async () => {
      const { world, lesson, learner } = await deviceWorld('tiers-takeover-unknown');
      await getContent(world, lesson.id, learner).expect(200);

      // Otherwise takeover would be a way around the device cap: every
      // refused browser could simply take the lease instead.
      const response = await request(app.getHttpServer())
        .post(`/learning/session/takeover?academyId=${world.academyId}`)
        .set(learner.auth)
        .set('Cookie', `${DEVICE_COOKIE_NAME}=not-a-registered-device-cookie`)
        .send({ courseId: world.courseId, lessonId: lesson.id });
      expect(response.status).toBeGreaterThanOrEqual(400);
    });
  });

  // -------------------------------------------------------------------
  // helper used by the device tests
  // -------------------------------------------------------------------

  function readDeviceCookie(response: request.Response): string | null {
    const raw = response.headers['set-cookie'] as unknown as string[] | undefined;
    if (!raw) return null;
    for (const cookie of raw) {
      if (cookie.startsWith(`${DEVICE_COOKIE_NAME}=`)) {
        return cookie.slice(DEVICE_COOKIE_NAME.length + 1).split(';')[0];
      }
    }
    return null;
  }
});
