/**
 * P64 Phase 2 — PREMIUM → NORMAL DOWNGRADE MIGRATES NOTHING (D11).
 *
 * Master plan §V: *"Mixed Normal and Premium assets coexist correctly in
 * one academy, and a downgrade migrates **nothing** (D11)."* §T adds the
 * commercial reason: *"Rollback of a tier change costs nothing because
 * existing assets keep their provider and tier."*
 *
 * THE FAILURE THIS FILE EXISTS TO CATCH is a silent one, which is why it
 * gets its own suite rather than a case inside the tier matrix. A system
 * that re-derived an asset's tier from the academy's CURRENT plan would
 * pass every test about uploads, every test about playback, and every
 * test about entitlement — and would still, the moment a customer
 * downgraded, either (a) tell their learners a two-year-old Premium video
 * is now Normal, or (b) refuse to play it at all because it looked for it
 * on the wrong provider. Neither is visible until a real downgrade
 * happens, and by then the wrong answer is already in the access log.
 *
 * So every assertion below is written about state that existed BEFORE the
 * plan changed, read AFTER it changed:
 *
 *   1. the asset rows are byte-identical across the downgrade;
 *   2. an old Premium lesson still plays, still through Cloudflare, and
 *      still REPORTS `premium` — the learner is not quietly moved down;
 *   3. new uploads land on Normal, so the downgrade does take effect
 *      where it should (otherwise "migrates nothing" would be satisfied
 *      by a no-op);
 *   4. the academy's stored PREFERENCE survives, so upgrading restores
 *      it rather than making the owner re-choose;
 *   5. the old Premium minutes keep consuming quota — a downgrade is not
 *      a way to stop paying for storage already in use;
 *   6. upgrading back does not migrate the Normal assets created in the
 *      meantime either. The rule is symmetric, and a system that only
 *      got one direction right would still corrupt the other.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import { generateKeyPairSync } from 'node:crypto';
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
  seedTenantSubscription,
} from './utils/db-admin';
import type { PlanFamily, PrismaClient, VideoSecurityTier } from '@prisma/client';
import { DEVICE_COOKIE_NAME } from '../src/tenancy/services/student-device.service';

const PASSWORD = 'correct-horse-battery';

// Same boot configuration as `p64-phase2-tiers.e2e-spec.ts`, and for the
// same reason: both tiers have to be genuinely available for "the
// downgrade changed nothing" to be a meaningful claim rather than an
// artefact of Premium being unconfigured.
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
process.env.BASIC_VIDEO_SIGNING_SECRET = 'p64-phase2-downgrade-secret';
process.env.BASIC_VIDEO_PLAYBACK_TTL_SECONDS = '600';
process.env.BASIC_VIDEO_REVOCATION_ENDPOINT = 'https://worker.atlas.test/revocations';
process.env.BASIC_VIDEO_REVOCATION_TOKEN = 'p64-phase2-downgrade-revocation';
process.env.BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED = 'true';
process.env.CLOUDFLARE_STREAM_ACCOUNT_ID = 'p64-phase2-downgrade-account';
process.env.CLOUDFLARE_STREAM_API_TOKEN = 'p64-phase2-downgrade-token';
process.env.CLOUDFLARE_STREAM_SIGNING_KEY_ID = 'p64-phase2-downgrade-key';
process.env.CLOUDFLARE_STREAM_SIGNING_KEY_PEM = STREAM_KEY;
process.env.CLOUDFLARE_STREAM_WEBHOOK_SECRET = 'p64-phase2-downgrade-webhook';
process.env.CLOUDFLARE_STREAM_CUSTOMER_SUBDOMAIN = 'customer-dg.cloudflarestream.com';

import { VideoTierService } from '../src/plans/services/video-tier.service';
import { EntitlementEnforcementService } from '../src/plans/services/entitlement-enforcement.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('P64 Phase 2 — a Premium → Normal downgrade migrates nothing (D11, e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let videoTiers: VideoTierService;
  let entitlements: EntitlementEnforcementService;
  let tenancy: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    videoTiers = app.get(VideoTierService);
    entitlements = app.get(EntitlementEnforcementService);
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

  async function seedFamilyPlan(label: string, family: PlanFamily) {
    return admin.plan.create({
      data: {
        key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: label,
        status: 'active',
        family,
        tier: 'growth',
        displayOrder: 0,
        limits: {
          academies: 5,
          students: 500,
          instructors: 50,
          staff: 50,
          courses: 200,
          generalStorage: 100,
          videoStorage: 100,
          videoStorageMinutes: 2000,
        },
        features: { cms: true, themes: true },
        pricing: { amount: 99, currency: 'USD', billingCycle: 'monthly' },
      },
    });
  }

  /**
   * An academy that BOUGHT Premium, CHOSE Premium and has a real Premium
   * asset already in place — the only starting state from which
   * "migrates nothing" says anything.
   */
  async function premiumAcademy(label: string) {
    const owner = await staffAccount(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    const premiumPlan = await seedFamilyPlan(`${label}-premium-plan`, 'premium');
    const normalPlan = await seedFamilyPlan(`${label}-normal-plan`, 'normal');
    await seedTenantSubscription(admin, org.id, premiumPlan.id, { status: 'active' });
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label} Section`, 1);

    // The owner's own deliberate choice, made through the real endpoint
    // while they were entitled to make it.
    await request(app.getHttpServer())
      .patch(`/academies/${academy.id}/video-tier`)
      .set(owner.auth)
      .send({ videoSecurityTier: 'premium' })
      .expect(200);

    return {
      owner,
      organizationId: org.id,
      academyId: academy.id,
      courseId: course.id,
      sectionId: section.id,
      premiumPlanId: premiumPlan.id,
      normalPlanId: normalPlan.id,
    };
  }

  type World = Awaited<ReturnType<typeof premiumAcademy>>;

  async function seedVideoAsset(
    world: World,
    provider: 'r2_worker' | 'cloudflare_stream',
    securityTier: VideoSecurityTier,
    durationSeconds: number,
  ) {
    return admin.mediaAsset.create({
      data: {
        academyId: world.academyId,
        courseId: world.courseId,
        type: 'video',
        fileName: `fixture-${randomUUID()}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(2048),
        access: 'protected',
        provider,
        securityTier,
        providerId:
          provider === 'cloudflare_stream'
            ? randomUUID().replace(/-/g, '')
            : `academies/${world.academyId}/${randomUUID()}.mp4`,
        processingStatus: 'ready',
        durationSeconds,
        durationSource: 'measured',
      },
    });
  }

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
    await admin.courseLesson.update({ where: { id: lesson.id }, data: { videoAssetId } });
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

  /**
   * A learner AND the browser they use.
   *
   * The `atlas_device` cookie is issued at sign-in and nowhere else, so
   * every request below presents the same device. Without it each call
   * would register a new one and then collide with its own single-session
   * lease — which would make "the grant before the downgrade" and "the
   * grant after it" two different devices rather than the same learner
   * continuing.
   */
  async function enrolledLearner(label: string, world: World) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD, academyId: world.academyId })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD, surface: 'academy', academyId: world.academyId })
      .expect(200);
    const userId = signIn.body.user.id as string;
    // `POST /auth/register` with an `academyId` already created the
    // `academy_students` row; seeding a second would collide on its own
    // unique constraint.
    await seedEnrollment(admin, userId, world.courseId, world.academyId);
    const raw = signIn.headers['set-cookie'] as unknown as string[] | undefined;
    const device =
      raw
        ?.find((cookie) => cookie.startsWith(`${DEVICE_COOKIE_NAME}=`))
        ?.slice(DEVICE_COOKIE_NAME.length + 1)
        .split(';')[0] ?? null;
    return {
      userId,
      device,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  /** The commercial event under test: the same subscription, now pointing at a Normal-family plan. */
  async function downgradeToNormal(world: World): Promise<void> {
    // `tenant_subscriptions` is one row per organization, so the
    // downgrade is the same repoint the billing path performs: the same
    // subscription, now on a Normal-family plan.
    await admin.tenantSubscription.update({
      where: { organizationId: world.organizationId },
      data: { planId: world.normalPlanId },
    });
  }

  async function upgradeToPremium(world: World): Promise<void> {
    await admin.tenantSubscription.update({
      where: { organizationId: world.organizationId },
      data: { planId: world.premiumPlanId },
    });
  }

  function grantFor(
    world: World,
    lessonId: string,
    learner: { readonly auth: Record<string, string>; readonly device: string | null },
  ) {
    const req = request(app.getHttpServer())
      .get(`/learning/courses/${world.courseId}/lessons/${lessonId}/content`)
      .set(learner.auth);
    return learner.device
      ? req.set('Cookie', `${DEVICE_COOKIE_NAME}=${learner.device}`)
      : req;
  }

  // ===================================================================

  it('leaves every existing asset row exactly as it was', async () => {
    const world = await premiumAcademy('dg-rows');
    const premiumAsset = await seedVideoAsset(
      world,
      'cloudflare_stream',
      'premium',
      1800,
    );
    const normalAsset = await seedVideoAsset(world, 'r2_worker', 'normal', 600);
    const before = await admin.mediaAsset.findMany({
      where: { id: { in: [premiumAsset.id, normalAsset.id] } },
      orderBy: { id: 'asc' },
    });

    await downgradeToNormal(world);

    const after = await admin.mediaAsset.findMany({
      where: { id: { in: [premiumAsset.id, normalAsset.id] } },
      orderBy: { id: 'asc' },
    });
    // Not "the tier is still premium" — the WHOLE ROW, because a
    // migration that rewrote `provider`, `provider_id` or
    // `duration_source` on the way past would be just as destructive as
    // one that rewrote the tier, and rather harder to notice.
    expect(after).toEqual(before);
  });

  it('still plays an old Premium lesson, through Premium, and still says so', async () => {
    const world = await premiumAcademy('dg-playback');
    const premiumAsset = await seedVideoAsset(
      world,
      'cloudflare_stream',
      'premium',
      1800,
    );
    const lesson = await seedVideoLesson(
      world,
      'Bought under Premium',
      1,
      premiumAsset.id,
    );
    const learner = await enrolledLearner('dg-playback-learner', world);

    const beforeGrant = (await grantFor(world, lesson.id, learner).expect(200)).body;
    expect(beforeGrant.protection.tier).toBe('premium');

    await downgradeToNormal(world);

    const afterGrant = (await grantFor(world, lesson.id, learner).expect(200)).body;
    // The learner paid for this course and this video has not changed.
    // Refusing it, or quietly serving it as something else, are both
    // worse than the downgrade itself.
    expect(afterGrant.protection.tier).toBe('premium');
    expect(afterGrant.video.format).toBe('hls');
    expect(afterGrant.protection.adaptiveBitrate).toBe(true);
    // And the honest Premium report is unchanged too (D-5 does not stop
    // being true because the plan changed).
    expect(afterGrant.protection.boundToDevice).toBe(false);
    expect(afterGrant.protection.drm).toBe(false);
  });

  it('records the OLD tier and provider in the access log after the downgrade', async () => {
    const world = await premiumAcademy('dg-log');
    const premiumAsset = await seedVideoAsset(
      world,
      'cloudflare_stream',
      'premium',
      1800,
    );
    const lesson = await seedVideoLesson(
      world,
      'Logged after downgrade',
      1,
      premiumAsset.id,
    );
    const learner = await enrolledLearner('dg-log-learner', world);

    await downgradeToNormal(world);
    await grantFor(world, lesson.id, learner).expect(200);

    const entry = await admin.contentAccessLog.findFirst({
      where: { lessonId: lesson.id, userId: learner.userId, result: 'granted' },
      orderBy: { createdAt: 'desc' },
    });
    // §Q — the log has to answer "was this delivered under the
    // protection we sold them?". Writing the academy's CURRENT plan here
    // would make that question permanently unanswerable for exactly the
    // tenants where it matters most.
    expect(entry?.securityTier).toBe('premium');
    expect(entry?.provider).toBe('cloudflare_stream');
  });

  it('does put NEW uploads on Normal, so the downgrade is not a no-op', async () => {
    const world = await premiumAcademy('dg-new-uploads');

    const resolvedBefore = await tenancy.runInTenantContext(world.organizationId, (tx) =>
      videoTiers.resolve(tx, {
        academyId: world.academyId,
        organizationId: world.organizationId,
      }),
    );
    expect(resolvedBefore).toEqual({
      tier: 'premium',
      entitled: 'premium',
      source: 'academy',
    });

    await downgradeToNormal(world);

    const ticket = await request(app.getHttpServer())
      .post(`/academies/${world.academyId}/media/video-uploads`)
      .set(world.owner.auth)
      .send({
        fileName: 'after-downgrade.mp4',
        maxDurationSeconds: 300,
        courseId: world.courseId,
      })
      .expect(201);

    expect(ticket.body.securityTier).toBe('normal');
    const asset = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: ticket.body.assetId as string },
    });
    // The two columns move together for a NEW asset, and both record the
    // Normal tier — the downgrade takes effect exactly where D11 says it
    // should, and nowhere else.
    expect(asset.securityTier).toBe('normal');
    expect(asset.provider).toBe('r2_worker');
  });

  it('ignores the stored Premium preference without erasing it', async () => {
    const world = await premiumAcademy('dg-preference');
    await downgradeToNormal(world);

    const resolved = await tenancy.runInTenantContext(world.organizationId, (tx) =>
      videoTiers.resolve(tx, {
        academyId: world.academyId,
        organizationId: world.organizationId,
      }),
    );
    // Ignored, because the plan no longer supports it...
    expect(resolved).toEqual({ tier: 'normal', entitled: 'normal', source: 'plan' });

    // ...but NOT cleared, so re-subscribing restores the owner's original
    // choice instead of silently leaving them on Normal after they paid
    // for Premium again.
    const academy = await admin.academy.findUniqueOrThrow({
      where: { id: world.academyId },
    });
    expect(academy.videoSecurityTier).toBe('premium');
  });

  it('reports the real ceiling to the settings screen rather than offering a choice it would refuse', async () => {
    const world = await premiumAcademy('dg-settings');
    await downgradeToNormal(world);

    const response = await request(app.getHttpServer())
      .get(`/academies/${world.academyId}/video-tier`)
      .set(world.owner.auth)
      .expect(200);

    expect(response.body).toMatchObject({
      academyId: world.academyId,
      videoSecurityTier: 'normal',
      entitled: 'normal',
      source: 'plan',
    });

    // And the endpoint now refuses what it happily accepted before the
    // downgrade — the same refusal, from the same rule.
    const refused = await request(app.getHttpServer())
      .patch(`/academies/${world.academyId}/video-tier`)
      .set(world.owner.auth)
      .send({ videoSecurityTier: 'premium' })
      .expect(403);
    expect(refused.body.error.messageKey).toBe('errors.entitlement.videoTierNotEntitled');
  });

  it('keeps charging the old Premium minutes against the new plan’s quota', async () => {
    const world = await premiumAcademy('dg-quota');
    await seedVideoAsset(world, 'cloudflare_stream', 'premium', 45 * 60);

    const before = await tenancy.runInTenantContext(world.organizationId, (tx) =>
      entitlements.videoMinutesSnapshot(tx, world.organizationId),
    );
    await downgradeToNormal(world);
    const after = await tenancy.runInTenantContext(world.organizationId, (tx) =>
      entitlements.videoMinutesSnapshot(tx, world.organizationId),
    );

    // AD-14 counts every provider, so the Premium minutes do not vanish
    // from the quota when the plan family changes — a downgrade is not a
    // way to stop paying for storage that is still in use.
    expect(before.usedMinutes).toBe(45);
    expect(after.usedMinutes).toBe(45);
  });

  it('is symmetric — upgrading back does not migrate the Normal assets created in between', async () => {
    const world = await premiumAcademy('dg-symmetric');
    const premiumAsset = await seedVideoAsset(world, 'cloudflare_stream', 'premium', 900);

    await downgradeToNormal(world);
    const normalTicket = await request(app.getHttpServer())
      .post(`/academies/${world.academyId}/media/video-uploads`)
      .set(world.owner.auth)
      .send({
        fileName: 'while-downgraded.mp4',
        maxDurationSeconds: 120,
        courseId: world.courseId,
      })
      .expect(201);
    const normalAssetId = normalTicket.body.assetId as string;

    await upgradeToPremium(world);

    const [premiumAfter, normalAfter] = await Promise.all([
      admin.mediaAsset.findUniqueOrThrow({ where: { id: premiumAsset.id } }),
      admin.mediaAsset.findUniqueOrThrow({ where: { id: normalAssetId } }),
    ]);
    expect(premiumAfter.securityTier).toBe('premium');
    expect(premiumAfter.provider).toBe('cloudflare_stream');
    // The asset created while downgraded stays Normal. An upgrade that
    // "promoted" it would be claiming a protection its bytes have never
    // been delivered under.
    expect(normalAfter.securityTier).toBe('normal');
    expect(normalAfter.provider).toBe('r2_worker');

    // The owner's original preference comes back on its own, which is
    // the whole reason it was not cleared.
    const resolved = await tenancy.runInTenantContext(world.organizationId, (tx) =>
      videoTiers.resolve(tx, {
        academyId: world.academyId,
        organizationId: world.organizationId,
      }),
    );
    expect(resolved).toEqual({
      tier: 'premium',
      entitled: 'premium',
      source: 'academy',
    });
  });

  it('serves both tiers side by side for the rest of the assets’ lives', async () => {
    const world = await premiumAcademy('dg-coexist');
    const premiumAsset = await seedVideoAsset(world, 'cloudflare_stream', 'premium', 900);
    const premiumLesson = await seedVideoLesson(world, 'Premium era', 1, premiumAsset.id);
    await downgradeToNormal(world);
    const normalAsset = await seedVideoAsset(world, 'r2_worker', 'normal', 600);
    const normalLesson = await seedVideoLesson(world, 'Normal era', 2, normalAsset.id);
    const learner = await enrolledLearner('dg-coexist-learner', world);

    const premiumGrant = (await grantFor(world, premiumLesson.id, learner).expect(200))
      .body;
    // Sequential progression is now enforced on the content grant: the normal
    // lesson sits after the premium one, so finish the predecessor before
    // fetching it (this test is about tier coexistence, not gating). The
    // enrollment is seeded directly, so the progress row is created here.
    const learnerEnrollment = await admin.enrollment.findFirstOrThrow({
      where: { studentId: learner.userId, courseId: world.courseId },
    });
    await admin.lessonProgress.upsert({
      where: {
        enrollmentId_lessonId: {
          enrollmentId: learnerEnrollment.id,
          lessonId: premiumLesson.id,
        },
      },
      create: {
        enrollmentId: learnerEnrollment.id,
        lessonId: premiumLesson.id,
        sectionId: premiumLesson.sectionId,
        courseId: world.courseId,
        status: 'completed',
        completedAt: new Date(),
      },
      update: { status: 'completed', completedAt: new Date() },
    });
    const normalGrant = (await grantFor(world, normalLesson.id, learner).expect(200))
      .body;

    // One academy, one course, one learner, two tiers — which D11 calls
    // the normal and expected state rather than an edge case.
    expect(premiumGrant.protection.tier).toBe('premium');
    expect(normalGrant.protection.tier).toBe('normal');
    expect(premiumGrant.video.format).toBe('hls');
    expect(normalGrant.video.format).toBe('mp4');
  });
});
