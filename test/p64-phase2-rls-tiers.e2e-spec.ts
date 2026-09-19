/**
 * P64 Phase 2 — the DATABASE half of the security review.
 *
 * Every test here runs against the real `atlas_app` role, which is
 * `NOBYPASSRLS`, so a policy that does not exist cannot be compensated for
 * by a service check. That is the whole point of the pairing the plan
 * states as "guard decides and RLS independently agrees": this file asks
 * only what the DATABASE answers, and `p64-phase2-security.e2e-spec.ts`
 * asks what the SERVICE answers. Where the two disagree, one of them is
 * wrong and the disagreement is the finding.
 *
 * WHY THE ADMIN CONNECTION SEEDS AND NEVER READS. `createAdminPrisma()`
 * connects as the migration superuser, for which Postgres never applies row
 * security. Using it for an assertion would make every test in this file
 * vacuously green. It builds fixtures; `TenancyContextService` (which runs
 * on the application's own `atlas_app` connection) makes every claim.
 *
 * Scope, in the order the plan lists it:
 *   §H  — zero `lesson_contents` rows without context, in a foreign
 *         tenant, and for a non-enrolled user, on PUBLISHED + PUBLIC
 *         fixtures (the shape finding S2 says the old spec never built).
 *   AD-3 — `lesson_contents` has no public policy, unlike `course_lessons`.
 *   AD-15/D11 — `security_tier` and `provider` are independent columns and
 *         neither is re-derived from the academy's current plan at read
 *         time; mixed Normal/Premium assets coexist in one academy.
 *   AD-7 — playback resolves the adapter from the ASSET's provider.
 */
import { INestApplication } from '@nestjs/common';
import { ContentAccessLogRepository } from '../src/learning/repositories/content-access-log.repository';
import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { VideoProviderRegistry } from '../src/media/video/video-provider.registry';
import { VideoTierService } from '../src/plans/services/video-tier.service';

describe('P64 Phase 2 — RLS, tenancy and the tier/provider split', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let registry: VideoProviderRegistry;
  let videoTier: VideoTierService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService, { strict: false });
    registry = app.get(VideoProviderRegistry, { strict: false });
    videoTier = app.get(VideoTierService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function createUser(label: string, status: 'active' | 'suspended' = 'active') {
    return admin.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label, status },
    });
  }

  /**
   * A published + PUBLIC course with a protected body, a Normal-tier video
   * and a protected resource — i.e. exactly the shape the public-discovery
   * policies do admit for `course_lessons`, so any zero-row result below is
   * `lesson_contents`' own doing rather than the course being invisible.
   */
  async function world(label: string) {
    const owner = await createUser(`${label}-owner`);
    const manager = await createUser(`${label}-manager`);
    const instructor = await createUser(`${label}-instructor`);
    const enrolled = await createUser(`${label}-enrolled`);
    const stranger = await createUser(`${label}-stranger`);

    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.id, 'owner');
    await seedAcademyMember(admin, academy.id, manager.id, 'manager');

    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    await admin.courseInstructor.create({
      data: { courseId: course.id, userId: instructor.id },
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);

    const lesson = await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
      contentType: 'video',
    });
    const previewLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-preview`,
      1,
      { status: 'published', contentType: 'text' },
    );
    await admin.courseLesson.update({
      where: { id: previewLesson.id },
      data: { isPreview: true },
    });

    const videoAsset = await seedVideoAsset(academy.id, course.id, 'normal', 'r2_worker');
    await admin.courseLesson.update({
      where: { id: lesson.id },
      data: { videoAssetId: videoAsset.id },
    });

    const content = await admin.lessonContent.create({
      data: {
        lessonId: lesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'video',
      },
    });
    const previewContent = await admin.lessonContent.create({
      data: {
        lessonId: previewLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'text',
        bodyHtml: '<p>free sample</p>',
      },
    });
    const resource = await admin.lessonResource.create({
      data: {
        lessonId: lesson.id,
        courseId: course.id,
        academyId: academy.id,
        title: 'Worksheet',
        externalUrl: 'https://example.test/worksheet',
        order: 0,
      },
    });

    await admin.academyStudent.create({
      data: {
        academyId: academy.id,
        userId: enrolled.id,
        status: 'active',
        source: 'staff_created',
      },
    });
    const enrollment = await seedEnrollment(admin, enrolled.id, course.id, academy.id);

    // A learner of the SAME academy who never enrolled in this course.
    await admin.academyStudent.create({
      data: {
        academyId: academy.id,
        userId: stranger.id,
        status: 'active',
        source: 'staff_created',
      },
    });

    return {
      org,
      academy,
      course,
      section,
      lesson,
      previewLesson,
      content,
      previewContent,
      resource,
      videoAsset,
      enrollment,
      owner,
      manager,
      instructor,
      enrolled,
      stranger,
    };
  }

  /** `provider` and `security_tier` are set INDEPENDENTLY, which is the property AD-15 exists to protect. */
  async function seedVideoAsset(
    academyId: string,
    courseId: string,
    securityTier: 'normal' | 'premium',
    provider: 'r2_worker' | 'cloudflare_stream',
  ) {
    const id = randomUUID();
    return admin.mediaAsset.create({
      data: {
        id,
        academyId,
        courseId,
        type: 'video',
        fileName: `${id}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider,
        providerId: `academies/${academyId}/courses/${courseId}/${id}.mp4`,
        processingStatus: 'ready',
        durationSeconds: 600,
        durationSource: 'parsed',
        securityTier,
      },
    });
  }

  // -------------------------------------------------------------------------
  // §H / AD-3 — lesson_contents has no public policy
  // -------------------------------------------------------------------------

  it('the course and its lessons are publicly discoverable, but the BODY is not (AD-3)', async () => {
    const w = await world('p2rls-public');

    const seen = await tenancy.runWithoutContext(async (tx) => ({
      courses: await tx.course.count({ where: { id: w.course.id } }),
      lessons: await tx.courseLesson.count({ where: { id: w.lesson.id } }),
      contents: await tx.lessonContent.count({ where: { id: w.content.id } }),
      resources: await tx.lessonResource.count({ where: { id: w.resource.id } }),
    }));

    // The pre-P64 exposure, still true and deliberately asserted so a
    // future change to the discovery tier is visible here.
    expect(seen.courses).toBe(1);
    expect(seen.lessons).toBe(1);
    // The Phase 2 fix: no public tier on the body or its resources.
    expect(seen.contents).toBe(0);
    expect(seen.resources).toBe(0);
  });

  it('a foreign tenant context sees zero lesson_contents rows', async () => {
    const a = await world('p2rls-tenant-a');
    const b = await world('p2rls-tenant-b');

    const seen = await tenancy.runInTenantAndUserContext(
      b.org.id,
      b.owner.id,
      async (tx) => ({
        contents: await tx.lessonContent.count({ where: { id: a.content.id } }),
        resources: await tx.lessonResource.count({ where: { id: a.resource.id } }),
        assets: await tx.mediaAsset.count({ where: { id: a.videoAsset.id } }),
      }),
    );

    expect(seen.contents).toBe(0);
    expect(seen.resources).toBe(0);
    expect(seen.assets).toBe(0);
  });

  it('a learner of the same academy who is NOT enrolled sees zero rows', async () => {
    const w = await world('p2rls-not-enrolled');

    const seen = await tenancy.runInUserContext(w.stranger.id, async (tx) => ({
      contents: await tx.lessonContent.count({ where: { id: w.content.id } }),
      resources: await tx.lessonResource.count({ where: { id: w.resource.id } }),
    }));

    expect(seen.contents).toBe(0);
    expect(seen.resources).toBe(0);
  });

  it('the enrolled learner, the course instructor and the academy manager each see the body', async () => {
    const w = await world('p2rls-admits');

    for (const reader of [w.enrolled, w.instructor, w.manager, w.owner]) {
      const seen = await tenancy.runInUserContext(reader.id, (tx) =>
        tx.lessonContent.count({ where: { id: w.content.id } }),
      );
      expect(seen).toBe(1);
    }
  });

  it('revocation, expiry, refund and a block each close the body immediately', async () => {
    const cases: {
      readonly label: string;
      readonly data: Prisma.EnrollmentUncheckedUpdateInput;
    }[] = [
      { label: 'revoked', data: { revokedAt: new Date(), revokeReason: 'manual' } },
      { label: 'expired', data: { expiresAt: new Date(Date.now() - 1000) } },
      {
        label: 'refunded',
        data: {
          status: 'unavailable',
          revokedAt: new Date(),
          revokeReason: 'refund',
        },
      },
    ];

    for (const testCase of cases) {
      const w = await world(`p2rls-${testCase.label}`);
      const before = await tenancy.runInUserContext(w.enrolled.id, (tx) =>
        tx.lessonContent.count({ where: { id: w.content.id } }),
      );
      expect(before).toBe(1);

      await admin.enrollment.update({
        where: { id: w.enrollment.id },
        data: testCase.data,
      });

      const after = await tenancy.runInUserContext(w.enrolled.id, (tx) =>
        tx.lessonContent.count({ where: { id: w.content.id } }),
      );
      expect(after).toBe(0);
    }

    // A blocked academy membership ends every course of that academy at
    // once, independently of the enrollment's own lifecycle columns.
    const blocked = await world('p2rls-blocked');
    await admin.academyStudent.updateMany({
      where: { academyId: blocked.academy.id, userId: blocked.enrolled.id },
      data: { blockedAt: new Date(), status: 'inactive' },
    });
    const afterBlock = await tenancy.runInUserContext(blocked.enrolled.id, (tx) =>
      tx.lessonContent.count({ where: { id: blocked.content.id } }),
    );
    expect(afterBlock).toBe(0);
  });

  it('a drip-scheduled lesson stays closed until its date passes', async () => {
    const w = await world('p2rls-drip');
    await admin.courseLesson.update({
      where: { id: w.lesson.id },
      data: { availableAt: new Date(Date.now() + 60 * 60 * 1000) },
    });

    const seen = await tenancy.runInUserContext(w.enrolled.id, (tx) =>
      tx.lessonContent.count({ where: { id: w.content.id } }),
    );
    expect(seen).toBe(0);
  });

  it('a PREVIEW lesson is the one documented short-circuit, and it opens only itself', async () => {
    const w = await world('p2rls-preview');

    const seen = await tenancy.runWithoutContext(async (tx) => ({
      preview: await tx.lessonContent.count({ where: { id: w.previewContent.id } }),
      paid: await tx.lessonContent.count({ where: { id: w.content.id } }),
    }));

    expect(seen.preview).toBe(1);
    expect(seen.paid).toBe(0);
  });

  it('a learner can never write a lesson body, only read one', async () => {
    const w = await world('p2rls-no-write');

    await expect(
      tenancy.runInUserContext(w.enrolled.id, (tx) =>
        tx.lessonContent.update({
          where: { id: w.content.id },
          data: { bodyHtml: '<p>tampered</p>' },
        }),
      ),
    ).rejects.toBeDefined();

    const row = await admin.lessonContent.findUnique({ where: { id: w.content.id } });
    expect(row?.bodyHtml).toBeNull();
  });

  // -------------------------------------------------------------------------
  // FINDING SEC-1 — media_assets is invisible in the context the grant path uses
  // -------------------------------------------------------------------------

  it('FINDING SEC-1: an entitled learner can read the lesson body but NOT the media asset the grant is built from', async () => {
    const w = await world('p2rls-asset-visibility');

    const seen = await tenancy.runInUserContext(w.enrolled.id, async (tx) => {
      const lesson = await tx.courseLesson.findFirst({
        where: { id: w.lesson.id, courseId: w.course.id },
        include: {
          content: { include: { mediaAsset: true } },
          resources: { include: { mediaAsset: true } },
          videoAsset: true,
        },
      });
      return {
        contentRows: await tx.lessonContent.count({ where: { id: w.content.id } }),
        assetRows: await tx.mediaAsset.count({ where: { id: w.videoAsset.id } }),
        videoAssetResolved: lesson?.videoAsset != null,
      };
    });

    // The lesson body IS reachable — `can_access_lesson()` admits this
    // learner, so the entitlement itself is correct.
    expect(seen.contentRows).toBe(1);

    // `media_assets` has exactly one SELECT policy, `media_assets_tenant_select`,
    // and it keys on `app.current_organization_id`. `LessonContentService`
    // runs the whole grant decision in `runInUserContext`, which sets only
    // `app.current_user_id` — so `lesson.videoAsset` resolves to NULL for
    // every learner, every staff previewer and every anonymous preview.
    // The grant is then built from an asset it cannot see: no video is
    // signed, `processingStatus !== 'ready'` can never fire, the signer's
    // cross-academy refusal is unreachable, and `content_access_log.provider`
    // is always null.
    //
    // Proposed fix (owned by prisma/ — NOT applied here): add a
    // `can_access_media_asset(asset_id, user_id)` SECURITY DEFINER predicate
    // resolving the asset through `course_lessons.video_asset_id`,
    // `lesson_contents.media_asset_id` and `lesson_resources.media_asset_id`
    // to `can_access_lesson()`, and a matching
    // `media_assets_lesson_access_select` policy.
    expect(seen.assetRows).toBe(1);
    expect(seen.videoAssetResolved).toBe(true);
  });

  // -------------------------------------------------------------------------
  // AD-15 / D11 — the tier is not the provider, and neither follows the plan
  // -------------------------------------------------------------------------

  it('an asset keeps the tier it was created under after the academy downgrades (D11)', async () => {
    const w = await world('p2rls-downgrade');
    const premiumAsset = await seedVideoAsset(
      w.academy.id,
      w.course.id,
      'premium',
      'cloudflare_stream',
    );

    // The academy is on a Normal-family plan (the fixture plan has no
    // `family`, so `entitledTier` answers `normal`).
    const entitled = await tenancy.runInTenantContext(w.org.id, (tx) =>
      videoTier.entitledTier(tx, w.org.id),
    );
    expect(entitled).toBe('normal');

    const stored = await admin.mediaAsset.findUniqueOrThrow({
      where: { id: premiumAsset.id },
      select: { securityTier: true, provider: true },
    });
    // Neither column is recomputed from the plan at read time.
    expect(stored.securityTier).toBe('premium');
    expect(stored.provider).toBe('cloudflare_stream');
  });

  it('Normal and Premium assets coexist in one academy, each routing to its own adapter (AD-7, D11)', async () => {
    const w = await world('p2rls-mixed');
    const premiumAsset = await seedVideoAsset(
      w.academy.id,
      w.course.id,
      'premium',
      'cloudflare_stream',
    );

    const rows = await admin.mediaAsset.findMany({
      where: { id: { in: [w.videoAsset.id, premiumAsset.id] } },
      select: { id: true, provider: true, securityTier: true },
      orderBy: { securityTier: 'asc' },
    });
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.provider))).toEqual(
      new Set(['r2_worker', 'cloudflare_stream']),
    );

    // Playback resolves by the ASSET's provider, never by the academy's
    // current plan: the same academy gets two different adapters.
    for (const row of rows) {
      const adapter = registry.forProvider(row.provider);
      expect(adapter.storedAs).toBe(row.provider);
    }
  });

  it('a tier value the plan does not entitle is refused rather than silently downgraded', async () => {
    const w = await world('p2rls-entitlement');
    await expect(
      tenancy.runInTenantContext(w.org.id, (tx) =>
        videoTier.assertEntitled(tx, w.org.id, 'premium'),
      ),
    ).rejects.toMatchObject({ status: 403 });

    // And an academy that stored `premium` while unentitled resolves back
    // to `normal` for NEW uploads rather than being honoured.
    await admin.academy.update({
      where: { id: w.academy.id },
      data: { videoSecurityTier: 'premium' },
    });
    const resolved = await tenancy.runInTenantContext(w.org.id, (tx) =>
      videoTier.resolve(tx, { academyId: w.academy.id, organizationId: w.org.id }),
    );
    expect(resolved.tier).toBe('normal');
  });

  it('the registry refuses an unknown provider instead of guessing an adapter', () => {
    expect(() =>
      registry.forProvider('r2' as unknown as Parameters<typeof registry.forProvider>[0]),
    ).toThrow(/No video provider adapter is registered/);
  });

  // -------------------------------------------------------------------------
  // Devices and the access log
  // -------------------------------------------------------------------------

  it('a learner sees only their own devices, and never another learner’s', async () => {
    const w = await world('p2rls-devices');
    const mine = await admin.studentDevice.create({
      data: {
        userId: w.enrolled.id,
        academyId: w.academy.id,
        cookieHash: randomUUID(),
        label: 'Chrome on macOS',
      },
    });
    const theirs = await admin.studentDevice.create({
      data: {
        userId: w.stranger.id,
        academyId: w.academy.id,
        cookieHash: randomUUID(),
        label: 'Safari on iOS',
      },
    });

    const seen = await tenancy.runInUserContext(w.enrolled.id, async (tx) => ({
      own: await tx.studentDevice.count({ where: { id: mine.id } }),
      other: await tx.studentDevice.count({ where: { id: theirs.id } }),
    }));
    expect(seen.own).toBe(1);
    expect(seen.other).toBe(0);

    // A learner cannot revoke somebody else's device even by naming its id.
    const attempted = await tenancy.runInUserContext(w.enrolled.id, (tx) =>
      tx.studentDevice.updateMany({
        where: { id: theirs.id },
        data: { revokedAt: new Date() },
      }),
    );
    expect(attempted.count).toBe(0);
  });

  it('FINDING SEC-2: a refusal for an authenticated learner is recorded in content_access_log', async () => {
    const w = await world('p2rls-refusal-log');

    // `LessonContentService.logRefusal` writes the refusal OUTSIDE the
    // caller's context on purpose — a refused learner may have no rows of
    // their own — so this reproduces that exact call shape.
    //
    // `content_access_log_insert`'s WITH CHECK is
    // `user_id IS NULL OR user_id = current_setting('app.current_user_id')`,
    // and with no context that setting is NULL, so `user_id = NULL` was
    // NULL rather than TRUE and every authenticated refusal was rejected
    // with 42501. `ContentAccessLogRepository.record` swallows the error,
    // so no request failed — and no refusal was ever recorded either.
    //
    // FIXED, in two parts (migration 20261009000300 and the repository):
    //
    //   1. The INSERT policy now also admits the no-context case, which is
    //      the case `logRefusal` deliberately writes in: a learner who was
    //      just refused may have no rows visible to them at all, and the
    //      record of the refusal has to exist regardless.
    //   2. The repository writes with `createMany`, not `create`. Prisma's
    //      `create` emits `INSERT … RETURNING`, and RETURNING additionally
    //      requires a SELECT tier that an uncontextualised caller does not
    //      have. Verified directly: the identical INSERT succeeds without
    //      RETURNING and fails with it. Nothing here ever needed the row
    //      back, so the RETURNING was pure cost and a silent failure mode.
    //
    // This exercises the PRODUCTION path — the repository — rather than a
    // raw `create()`. Asserting that `create()` works would be asserting
    // something the system deliberately does not support: giving the audit
    // log a SELECT tier wide enough for RETURNING would widen read access
    // to every learner's access history, which is a worse outcome than
    // dropping a RETURNING nobody reads.
    const log = app.get(ContentAccessLogRepository);
    await tenancy.runWithoutContext((tx) =>
      log.record(tx, {
        userId: w.enrolled.id,
        academyId: w.academy.id,
        courseId: w.course.id,
        lessonId: w.lesson.id,
        result: 'refused',
        reason: 'notEnrolled',
        deviceId: null,
        sessionId: null,
      }),
    );

    const recorded = await admin.contentAccessLog.count({
      where: { lessonId: w.lesson.id, result: 'refused' },
    });
    expect(recorded).toBe(1);
  });

  it('the retention policy refuses to delete anything inside the 90-day window', async () => {
    const w = await world('p2rls-retention');
    const fresh = await admin.contentAccessLog.create({
      data: {
        userId: w.enrolled.id,
        academyId: w.academy.id,
        courseId: w.course.id,
        lessonId: w.lesson.id,
        result: 'granted',
        reason: 'video',
      },
    });

    const deleted = await tenancy.runInUserContext(w.enrolled.id, (tx) =>
      tx.contentAccessLog.deleteMany({ where: { id: fresh.id } }),
    );
    expect(deleted.count).toBe(0);
    expect(await admin.contentAccessLog.count({ where: { id: fresh.id } })).toBe(1);
  });
});
