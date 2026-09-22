/**
 * P64 Phase 2 — the SERVICE half of the security review.
 *
 * `p64-phase2-rls-tiers.e2e-spec.ts` asks what the database answers. This
 * file asks what `LessonContentService` — the policy decision point of
 * Phase 2 §D.2 — answers, plus the two things only a real HTTP request can
 * show: the guard stack on the grant route, and that a tenancy claim
 * cannot be moved from the `Host` header into a query parameter.
 *
 * WHAT IS DELIBERATELY REAL HERE
 *
 *   - The object store. "Anonymous access to a protected object" is
 *     asserted against the running S3-compatible endpoint with an actual
 *     unsigned `GET`, not against a mock that was written to return 403.
 *     A presign test that never touches the store proves the URL's SHAPE
 *     and nothing about its enforcement.
 *   - The seven conditions, driven through the service itself with the
 *     request context a controller would have built, so ordering — which
 *     refusal happens before which side effect — is observable.
 *   - The `atlas_app` role. `createAdminPrisma()` seeds; nothing asserts
 *     through it.
 *
 * Tests whose name begins `FINDING` assert the behaviour the master plan
 * requires and currently FAIL. They are written that way on purpose: the
 * repository rule is that a real failure is a finding, never something to
 * be assert-weakened into green. Each carries the finding id, the cause,
 * and the patch — in a file this worker does not own.
 */
import { INestApplication, ConflictException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { MediaAsset, Prisma, PrismaClient } from '@prisma/client';
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
import {
  LessonContentService,
  buildProtectionReport,
} from '../src/learning/services/lesson-content.service';
import type { ContentRequestContext } from '../src/learning/services/lesson-content.service';
import { ContentGrantSigner } from '../src/learning/services/content-grant.signer';
import { ContentAccessLogRepository } from '../src/learning/repositories/content-access-log.repository';
import { LearnerSessionService } from '../src/learning/services/learner-session.service';
import { LearningLeaseService } from '../src/learning/services/learning-lease.service';
import { ProtectedMediaStorage } from '../src/media/storage/protected-media-storage.provider';
import { VideoProviderRegistry } from '../src/media/video/video-provider.registry';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { hashDeviceCookie } from '../src/tenancy/services/student-device.service';

const PASSWORD = 'correct-horse-battery';

describe('P64 Phase 2 — entitlement, grants, devices and tenancy (service + HTTP)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let contentService: LessonContentService;
  let signer: ContentGrantSigner;
  let accessLog: ContentAccessLogRepository;
  let learnerSessions: LearnerSessionService;
  let leases: LearningLeaseService;
  let storage: ProtectedMediaStorage;
  let registry: VideoProviderRegistry;
  let tenancy: TenancyContextService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    contentService = app.get(LessonContentService, { strict: false });
    signer = app.get(ContentGrantSigner, { strict: false });
    accessLog = app.get(ContentAccessLogRepository, { strict: false });
    learnerSessions = app.get(LearnerSessionService, { strict: false });
    leases = app.get(LearningLeaseService, { strict: false });
    storage = app.get(ProtectedMediaStorage, { strict: false });
    registry = app.get(VideoProviderRegistry, { strict: false });
    tenancy = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ==========================================================================
  // Fixtures
  // ==========================================================================

  async function createUser(label: string, status: 'active' | 'suspended' = 'active') {
    return admin.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label, status },
    });
  }

  async function seedVideoAsset(args: {
    readonly academyId: string;
    readonly courseId: string;
    readonly securityTier: 'normal' | 'premium';
    readonly provider: 'r2_worker' | 'cloudflare_stream';
    readonly processingStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  }) {
    const id = randomUUID();
    return admin.mediaAsset.create({
      data: {
        id,
        academyId: args.academyId,
        courseId: args.courseId,
        type: 'video',
        fileName: `${id}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider: args.provider,
        providerId: `academies/${args.academyId}/courses/${args.courseId}/${id}.mp4`,
        processingStatus: args.processingStatus ?? 'ready',
        durationSeconds: 600,
        durationSource: 'parsed',
        securityTier: args.securityTier,
      },
    });
  }

  /**
   * One academy, one published + public course, four lessons covering the
   * cases the grant path branches on: a protected video, a protected file,
   * an open preview, and a drip-scheduled lesson.
   */
  async function world(label: string) {
    const owner = await createUser(`${label}-owner`);
    const manager = await createUser(`${label}-manager`);
    const instructor = await createUser(`${label}-instructor`);
    const learner = await createUser(`${label}-learner`);
    const outsider = await createUser(`${label}-outsider`);

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

    const videoAsset = await seedVideoAsset({
      academyId: academy.id,
      courseId: course.id,
      securityTier: 'normal',
      provider: 'r2_worker',
    });

    const videoLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-video`,
      0,
      { status: 'published', contentType: 'video' },
    );
    await admin.courseLesson.update({
      where: { id: videoLesson.id },
      data: { videoAssetId: videoAsset.id, durationSeconds: 600 },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: videoLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'video',
      },
    });

    const fileAssetId = randomUUID();
    const fileStorageKey = ProtectedMediaStorage.objectKey({
      academyId: academy.id,
      courseId: course.id,
      assetId: fileAssetId,
      extension: 'pdf',
    });
    const fileAsset = await admin.mediaAsset.create({
      data: {
        id: fileAssetId,
        academyId: academy.id,
        courseId: course.id,
        type: 'document',
        fileName: 'worksheet.pdf',
        storageKey: fileStorageKey,
        url: '',
        mimeType: 'application/pdf',
        sizeBytes: BigInt(11),
        access: 'protected',
        provider: 'r2',
        processingStatus: 'ready',
      },
    });
    const fileLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-file`,
      1,
      { status: 'published', contentType: 'file' },
    );
    await admin.lessonContent.create({
      data: {
        lessonId: fileLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'file',
        mediaAssetId: fileAsset.id,
      },
    });

    const previewLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-preview`,
      2,
      { status: 'published', contentType: 'text' },
    );
    await admin.courseLesson.update({
      where: { id: previewLesson.id },
      data: { isPreview: true },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: previewLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'text',
        bodyHtml: '<p>free sample</p>',
      },
    });

    const drippedLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label}-drip`,
      3,
      { status: 'published', contentType: 'text' },
    );
    await admin.courseLesson.update({
      where: { id: drippedLesson.id },
      data: { availableAt: new Date(Date.now() + 60 * 60 * 1000) },
    });
    await admin.lessonContent.create({
      data: {
        lessonId: drippedLesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'text',
        bodyHtml: '<p>next week</p>',
      },
    });

    await admin.academyStudent.create({
      data: {
        academyId: academy.id,
        userId: learner.id,
        status: 'active',
        source: 'staff_created',
      },
    });
    const enrollment = await seedEnrollment(admin, learner.id, course.id, academy.id);

    return {
      org,
      academy,
      course,
      videoLesson,
      videoAsset,
      fileLesson,
      fileAsset,
      fileStorageKey,
      previewLesson,
      drippedLesson,
      enrollment,
      owner,
      manager,
      instructor,
      learner,
      outsider,
    };
  }

  /**
   * Marks a lesson complete for the world's learner (creating the
   * `lesson_progress` row `seedEnrollment` does not materialise), so a LATER
   * lesson is not held behind it by the now-enforced sequential progression.
   * These grant-shape tests are about the grant, not gating.
   */
  async function completeLessonForLearner(
    w: { enrollment: { id: string }; course: { id: string } },
    lesson: { id: string; sectionId: string },
  ): Promise<void> {
    await admin.lessonProgress.upsert({
      where: {
        enrollmentId_lessonId: { enrollmentId: w.enrollment.id, lessonId: lesson.id },
      },
      create: {
        enrollmentId: w.enrollment.id,
        lessonId: lesson.id,
        sectionId: lesson.sectionId,
        courseId: w.course.id,
        status: 'completed',
        completedAt: new Date(),
      },
      update: { status: 'completed', completedAt: new Date() },
    });
  }

  /** The context a controller builds: identity from the token, academy from the HOST, device from the cookie. */
  function context(
    overrides: Partial<ContentRequestContext> = {},
  ): ContentRequestContext {
    return {
      userId: null,
      sessionId: null,
      hostAcademyId: null,
      deviceCookie: null,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/120',
      ...overrides,
    };
  }

  async function expectRefusal(
    promise: Promise<unknown>,
    status: number,
    messageKey?: string,
  ) {
    await expect(promise).rejects.toMatchObject(
      messageKey
        ? { status, response: expect.objectContaining({ messageKey }) }
        : { status },
    );
  }

  // ==========================================================================
  // 1. The protected object tier (finding S1)
  // ==========================================================================

  describe('the protected object store', () => {
    it('refuses an unsigned read and honours a signed one — asserted against the real store', async () => {
      const key = `academies/${randomUUID()}/${randomUUID()}.pdf`;
      await storage.putObject(key, Buffer.from('protected!'), 'application/pdf');

      const signed = await storage.presignGet(key);
      const signedUrl = new URL(signed);

      // ANONYMOUS: the same object, same host, no credential.
      const anonymous = await fetch(`${signedUrl.origin}${signedUrl.pathname}`);
      expect(anonymous.status).toBe(403);

      // The signature covers the KEY, so swapping it invalidates the URL.
      const swapped = new URL(signed);
      swapped.pathname = swapped.pathname.replace(/[^/]+\.pdf$/, `${randomUUID()}.pdf`);
      const tampered = await fetch(swapped.toString());
      expect(tampered.status).toBeGreaterThanOrEqual(400);

      const authorized = await fetch(signed);
      expect(authorized.status).toBe(200);
      expect(await authorized.text()).toBe('protected!');
    });

    it('never mints a credential longer than the store’s own ceiling', async () => {
      const key = `academies/${randomUUID()}/${randomUUID()}.pdf`;
      await storage.putObject(key, Buffer.from('x'), 'application/pdf');

      // Asking for a day gets the configured ceiling, not a day.
      const generous = new URL(await storage.presignGet(key, 86_400));
      expect(Number(generous.searchParams.get('X-Amz-Expires'))).toBe(
        storage.maxTtlSeconds,
      );
    });

    it('the protected bucket is a different bucket from the public one', () => {
      const publicKey = ProtectedMediaStorage.objectKey({
        academyId: 'a',
        assetId: 'b',
        extension: 'pdf',
      });
      // Keys are prefixed by academy from verified context (Phase 2 §H).
      expect(publicKey).toBe('academies/a/b.pdf');
      expect(
        ProtectedMediaStorage.objectKey({
          academyId: 'a',
          courseId: 'c',
          assetId: 'b',
          extension: 'mp4',
        }),
      ).toBe('academies/a/courses/c/b.mp4');
    });
  });

  // ==========================================================================
  // 2. The seven conditions
  // ==========================================================================

  describe('the seven entitlement conditions', () => {
    it('refuses an anonymous caller on a non-preview lesson, and opens a preview one', async () => {
      const w = await world('p2sec-anon');

      await expectRefusal(
        contentService.getContent(w.course.id, w.videoLesson.id, context()),
        404,
      );

      const preview = await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context(),
      );
      expect(preview.isPreview).toBe(true);
      expect(preview.bodyHtml).toBe('<p>free sample</p>');
    });

    it('refuses a signed-in user who is not enrolled', async () => {
      const w = await world('p2sec-not-enrolled');
      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.outsider.id, sessionId: 'session-1' }),
        ),
        404,
      );
    });

    it('refuses a revoked, an expired and a refunded enrollment', async () => {
      const cases: {
        readonly label: string;
        readonly data: Prisma.EnrollmentUncheckedUpdateInput;
      }[] = [
        { label: 'revoked', data: { revokedAt: new Date(), revokeReason: 'manual' } },
        { label: 'expired', data: { expiresAt: new Date(Date.now() - 1_000) } },
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
        const w = await world(`p2sec-${testCase.label}`);
        const before = await contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: `s-${testCase.label}` }),
        );
        expect(before.lessonId).toBe(w.videoLesson.id);

        await admin.enrollment.update({
          where: { id: w.enrollment.id },
          data: testCase.data,
        });

        await expectRefusal(
          contentService.getContent(
            w.course.id,
            w.videoLesson.id,
            context({ userId: w.learner.id, sessionId: `s-${testCase.label}` }),
          ),
          403,
          'errors.learning.accessEnded',
        );
      }
    });

    it('refuses a suspended account even while the enrollment is perfectly valid', async () => {
      const w = await world('p2sec-suspended');
      await admin.user.update({
        where: { id: w.learner.id },
        data: { status: 'suspended' },
      });

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: 's-susp' }),
        ),
        403,
        'errors.auth.accountSuspended',
      );
    });

    it('refuses a blocked academy membership, which ends every course at once', async () => {
      const w = await world('p2sec-blocked');
      await admin.academyStudent.updateMany({
        where: { academyId: w.academy.id, userId: w.learner.id },
        data: { blockedAt: new Date(), status: 'inactive' },
      });

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: 's-block' }),
        ),
        403,
        'errors.learning.accessEnded',
      );
    });

    it('refuses an unpublished course even to someone who enrolled while it was live', async () => {
      const w = await world('p2sec-unpublished');
      await admin.course.update({
        where: { id: w.course.id },
        data: { status: 'archived' },
      });

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: 's-arch' }),
        ),
        404,
      );
    });

    it('refuses a lesson whose drip date has not passed, with a distinguishable reason', async () => {
      const w = await world('p2sec-drip');
      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.drippedLesson.id,
          context({ userId: w.learner.id, sessionId: 's-drip' }),
        ),
        403,
        'errors.learning.lessonScheduled',
      );
    });

    it('refuses content of another academy when the request host resolved to this one', async () => {
      const a = await world('p2sec-host-a');
      const b = await world('p2sec-host-b');

      // A perfectly valid learner of B, asking for B's lesson, on A's host.
      await expectRefusal(
        contentService.getContent(
          b.course.id,
          b.videoLesson.id,
          context({
            userId: b.learner.id,
            sessionId: 's-cross',
            hostAcademyId: a.academy.id,
          }),
        ),
        404,
      );

      // The same request on B's own host is allowed, so the refusal above
      // is the host check and not something else.
      const allowed = await contentService.getContent(
        b.course.id,
        b.videoLesson.id,
        context({
          userId: b.learner.id,
          sessionId: 's-cross',
          hostAcademyId: b.academy.id,
        }),
      );
      expect(allowed.academyId).toBe(b.academy.id);
    });

    it('lets an instructor and an academy manager preview without an enrollment, and without taking a lease', async () => {
      const w = await world('p2sec-staff');

      for (const staff of [w.instructor, w.manager, w.owner]) {
        const grant = await contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: staff.id, sessionId: `s-${staff.id}` }),
        );
        expect(grant.lessonId).toBe(w.videoLesson.id);
        // Staff are not subject to the learner device policy: treating a
        // manager's preview as a concurrent learning session would lock out
        // the learner they were helping.
        expect(grant.playbackLease).toBeNull();
        expect(await leases.current(staff.id, w.academy.id)).toBeNull();
      }
    });

    it('a refused request never takes the lease on its way out', async () => {
      const w = await world('p2sec-lease-order');
      await admin.enrollment.update({
        where: { id: w.enrollment.id },
        data: { revokedAt: new Date(), revokeReason: 'manual' },
      });

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: 's-refused' }),
        ),
        403,
      );

      expect(await leases.current(w.learner.id, w.academy.id)).toBeNull();
      // …and no device was registered on the way to the refusal either.
      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id },
        }),
      ).toBe(0);
    });

    it('FINDING SEC-3: a lesson whose video is still processing is refused without holding the lease', async () => {
      const w = await world('p2sec-processing');
      await admin.mediaAsset.update({
        where: { id: w.videoAsset.id },
        data: { processingStatus: 'processing' },
      });

      // `LessonContentService` acquires the lease at line ~250 and only
      // then calls `buildGrant`, whose `processingStatus !== 'ready'` check
      // (line ~410) throws `ContentRefusal`. The catch logs the refusal and
      // rethrows; nothing releases the lease, so a learner who opened a
      // still-processing lesson holds their single learning lease for the
      // full 60s TTL and is told "another device is already learning" on
      // their real device.
      //
      // This test additionally documents SEC-1's downstream effect: because
      // `media_assets` is invisible in the learner's user context, the
      // `processing` state is never seen at all and the refusal does not
      // happen — the learner is handed a grant with no video in it.
      //
      // Proposed fix (owned by src/learning/services/ — NOT applied here):
      // move the asset-readiness check above the lease acquisition (it needs
      // only `lesson.videoAsset`, already loaded), or release the lease in
      // `getContent`'s `ContentRefusal` catch.
      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.learner.id, sessionId: 's-processing' }),
        ),
        404,
      );
      expect(await leases.current(w.learner.id, w.academy.id)).toBeNull();
    });
  });

  // ==========================================================================
  // 3. What the grant actually contains (S1, S3, AD-16)
  // ==========================================================================

  describe('the grant', () => {
    it('carries no durable URL and expires with its shortest credential', async () => {
      const w = await world('p2sec-grant-shape');
      await completeLessonForLearner(w, w.videoLesson);
      const grant = await contentService.getContent(
        w.course.id,
        w.fileLesson.id,
        context({ userId: w.learner.id, sessionId: 's-shape' }),
      );

      const expiresInMs = new Date(grant.expiresAt).getTime() - Date.now();
      expect(expiresInMs).toBeGreaterThan(0);
      // Never longer than the protected store's own ceiling, whatever the
      // caller asked for (finding D-3).
      expect(expiresInMs).toBeLessThanOrEqual((storage.maxTtlSeconds + 5) * 1_000);
      expect(grant.protection.expiresInSeconds).toBeLessThanOrEqual(
        storage.maxTtlSeconds,
      );
    });

    it('FINDING SEC-1: an entitled learner’s grant actually contains the file it signed', async () => {
      const w = await world('p2sec-file-grant');
      await completeLessonForLearner(w, w.videoLesson);
      const grant = await contentService.getContent(
        w.course.id,
        w.fileLesson.id,
        context({ userId: w.learner.id, sessionId: 's-file' }),
      );

      expect(grant.kind).toBe('file');
      // `lesson_contents.media_asset_id` resolves through `media_assets`,
      // whose only SELECT policy keys on `app.current_organization_id` —
      // never set on the grant path. `content.mediaAsset` is therefore NULL
      // and the `kind === 'file'` branch is skipped entirely: the learner
      // receives a grant that reports `signedUrl: true` and carries no URL.
      // See `p64-phase2-rls-tiers.e2e-spec.ts` FINDING SEC-1 for the patch.
      expect(grant.fileUrl).toBeDefined();
      expect(grant.fileName).toBe('worksheet.pdf');
    });

    it('FINDING SEC-1: an entitled learner’s grant actually contains the video it signed', async () => {
      const w = await world('p2sec-video-grant');
      const grant = await contentService.getContent(
        w.course.id,
        w.videoLesson.id,
        context({ userId: w.learner.id, sessionId: 's-video' }),
      );

      expect(grant.kind).toBe('video');
      expect(grant.video).toBeDefined();
      expect(grant.video?.downloadable).toBe(false);
      // AD-15: the tier reported is the ASSET's, not the academy's plan.
      expect(grant.protection.tier).toBe('normal');
    });

    it('FINDING SEC-1: the access log records which tier and provider served a decision (D10, §F)', async () => {
      const w = await world('p2sec-log-tier');
      await contentService.getContent(
        w.course.id,
        w.videoLesson.id,
        context({ userId: w.learner.id, sessionId: 's-log' }),
      );

      const entry = await admin.contentAccessLog.findFirst({
        where: { lessonId: w.videoLesson.id, result: 'granted' },
        orderBy: { createdAt: 'desc' },
      });
      expect(entry).not.toBeNull();
      // Both are null today for the same reason: the asset the log reads
      // them from was invisible to the transaction that built the grant.
      expect(entry?.securityTier).toBe('normal');
      expect(entry?.provider).toBe('r2_worker');
    });

    it('an external embed is reported as protecting nothing, rather than as "protected"', () => {
      const report = buildProtectionReport({
        kind: 'external',
        capabilities: null,
        tier: null,
        expiresAt: new Date(Date.now() + 3_600_000),
        watermarkEnabled: true,
      });
      expect(report).toMatchObject({
        tier: null,
        signedUrl: false,
        expiresInSeconds: 0,
        boundToSession: false,
        boundToDevice: false,
        revocableBeforeExpiry: false,
        watermark: false,
        drm: false,
      });
    });

    it('a PREMIUM grant reports boundToDevice/boundToSession false (D-5, AD-16)', () => {
      const premium = registry.forProvider('cloudflare_stream');
      const capabilities = premium.capabilities();
      expect(capabilities.boundToSession).toBe(false);
      expect(capabilities.boundToDevice).toBe(false);
      expect(capabilities.revocableBeforeExpiry).toBe(false);
      expect(capabilities.drm).toBe(false);

      // And the grant contract repeats the adapter's answer verbatim rather
      // than inferring anything from the tier's NAME — which is the exact
      // mistake D-5 recorded.
      const report = buildProtectionReport({
        kind: 'video',
        capabilities,
        tier: 'premium',
        expiresAt: new Date(Date.now() + 7_200_000),
        watermarkEnabled: true,
      });
      expect(report.tier).toBe('premium');
      expect(report.boundToDevice).toBe(false);
      expect(report.boundToSession).toBe(false);
      expect(report.drm).toBe(false);
    });

    it('no adapter claims DRM, and no adapter ever reports a downloadable descriptor', () => {
      for (const provider of ['cloudflare_stream', 'r2_worker'] as const) {
        expect(registry.forProvider(provider).capabilities().drm).toBe(false);
      }
    });
  });

  // ==========================================================================
  // 4. The signer (Phase 2 §H, finding D-3)
  // ==========================================================================

  describe('ContentGrantSigner', () => {
    function assetFor(overrides: Partial<MediaAsset>): MediaAsset {
      return {
        id: randomUUID(),
        academyId: 'academy-a',
        courseId: null,
        type: 'video',
        status: 'active',
        fileName: 'v.mp4',
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider: 'r2_worker',
        providerId: 'academies/academy-a/v.mp4',
        processingStatus: 'ready',
        durationSeconds: 600,
        durationSource: 'parsed',
        securityTier: 'normal',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides,
      } as MediaAsset;
    }

    const binding = {
      userId: 'user-1',
      sessionId: 'session-1',
      deviceId: 'device-1',
      academyId: 'academy-a',
      allowedOrigins: ['https://a.example'],
    };

    it('refuses to sign an asset belonging to another academy (Phase 2 §H)', async () => {
      await expect(
        signer.signVideo(assetFor({ academyId: 'academy-b' }), binding),
      ).rejects.toThrow(/different academy/i);
    });

    it('refuses to sign an asset with no provider id', async () => {
      await expect(
        signer.signVideo(assetFor({ providerId: null }), binding),
      ).rejects.toThrow(/no provider id/i);
    });

    it('the cross-academy refusal cannot be bypassed by any binding the caller controls', async () => {
      const foreign = assetFor({ academyId: 'academy-b' });
      for (const academyId of ['academy-a', '', 'academy-b '.trim() + ' ']) {
        await expect(
          signer.signVideo(foreign, { ...binding, academyId }),
        ).rejects.toThrow();
      }
      // It succeeds only when the two genuinely match — so the refusal is
      // the equality check and not an unconditional throw.
      const ownAcademy = await signer.signVideo(assetFor({}), binding);
      expect(ownAcademy.video.downloadable).toBe(false);
    });

    it('never advertises an expiry the credential inside it does not have (D-3)', async () => {
      const signed = await signer.signVideo(assetFor({}), binding);
      const advertisedMs = signed.expiresAt.getTime() - Date.now();

      // The grant's own ceiling, whatever `videoTtlSeconds` asked for.
      expect(advertisedMs).toBeGreaterThan(0);
      expect(advertisedMs).toBeLessThanOrEqual((signer.videoTtlSeconds + 5) * 1_000);

      // If the URL carries its own expiry, the advertised one must not
      // outlive it. A presigned S3 URL states `X-Amz-Date` + `X-Amz-Expires`.
      const url = new URL(signed.video.url);
      const amzExpires = url.searchParams.get('X-Amz-Expires');
      const amzDate = url.searchParams.get('X-Amz-Date');
      if (amzExpires && amzDate) {
        const issued = Date.parse(
          amzDate.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/,
            '$1-$2-$3T$4:$5:$6Z',
          ),
        );
        // `X-Amz-Date` has SECOND granularity and is truncated downwards, so
        // the deadline computed from it can sit up to 999 ms before the real
        // signing instant. One second of tolerance is that truncation and
        // nothing else — the property under test is that the grant never
        // advertises a life the credential does not have, which a
        // sub-second formatting artefact cannot express.
        const credentialDeadline = issued + Number(amzExpires) * 1_000;
        expect(signed.expiresAt.getTime()).toBeLessThanOrEqual(
          credentialDeadline + 1_000,
        );
      }
    });

    it('returns a public asset’s durable URL unsigned, and never signs a protected one into one', async () => {
      const publicAsset = assetFor({
        access: 'public',
        url: 'https://cdn.example/logo.png',
        storageKey: 'academies/a/logo.png',
      });
      const signedPublic = await signer.signFile(publicAsset);
      expect(signedPublic.url).toBe('https://cdn.example/logo.png');

      const protectedAsset = assetFor({
        access: 'protected',
        storageKey: `academies/${randomUUID()}/${randomUUID()}.pdf`,
      });
      const signedProtected = await signer.signFile(protectedAsset);
      expect(signedProtected.url).toContain('X-Amz-Signature');
      expect(signedProtected.expiresAt.getTime()).toBeLessThanOrEqual(
        Date.now() + (signer.fileTtlSeconds + 5) * 1_000,
      );
    });
  });

  // ==========================================================================
  // 5. Devices, lease and takeover (AD-10, D4)
  // ==========================================================================

  describe('devices, lease and takeover', () => {
    async function policyFor(academyId: string, maxDevices: number) {
      await admin.accessPolicy.create({
        data: { scope: 'academy', academyId, maxDevices, maxConcurrentSessions: 1 },
      });
    }

    /**
     * A device cookie value that is unique to this RUN.
     *
     * `student_devices.cookie_hash` carries a GLOBAL unique constraint, and
     * these specs seed rows with a hash they choose so that a later lookup
     * by the same value succeeds. A fixed literal would therefore pass once
     * and collide on the next run against the same database, which is a
     * fixture bug that reads exactly like a product one.
     */
    const cookieRun = randomUUID();
    const deviceCookie = (label: string) => `${label}-${cookieRun}`;

    it('refuses a browser beyond the cap, and registers nothing on the way to the refusal', async () => {
      const w = await world('p2sec-device-cap');
      await policyFor(w.academy.id, 2);

      // Each of these is an UNRECOGNISED cookie, so each asks for a new
      // registration — which is the case the cap has to govern, because the
      // server mints its own cookie value and a browser that never received
      // one looks exactly like a brand-new browser.
      const cookies = ['cookie-one', 'cookie-two', 'cookie-three'];
      for (const cookie of cookies.slice(0, 2)) {
        const grant = await contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({
            userId: w.learner.id,
            sessionId: 's-dev',
            deviceCookie: cookie,
          }),
        );
        expect(grant.lessonId).toBe(w.previewLesson.id);
        await leases.revokeAll(w.learner.id, w.academy.id);
      }

      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id, revokedAt: null },
        }),
      ).toBe(2);

      // The third browser is refused with a reason the learner can act on
      // — 403 rather than the blanket 404 the other refusals use.
      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({
            userId: w.learner.id,
            sessionId: 's-dev',
            deviceCookie: cookies[2],
          }),
        ),
        403,
        'errors.learning.deviceLimit',
      );

      // And it did not register a third device on the way to the refusal.
      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id, revokedAt: null },
        }),
      ).toBe(2);
    });

    it('a RECOGNISED device is still subject to a cap the owner lowered afterwards', async () => {
      const w = await world('p2sec-device-rank');
      // Three devices registered while the cap allowed them.
      const cookies = ['rank-one', 'rank-two', 'rank-three'].map(deviceCookie);
      for (const cookie of cookies) {
        await admin.studentDevice.create({
          data: {
            userId: w.learner.id,
            academyId: w.academy.id,
            cookieHash: hashDeviceCookie(cookie),
            label: `Browser ${cookie}`,
          },
        });
      }
      // The owner then lowers it — the action they take when they suspect
      // sharing. Checking the cap only at registration would make that a
      // no-op for everyone who already has devices.
      await policyFor(w.academy.id, 2);

      // Oldest-first is the ordering: the two earliest keep working.
      for (const cookie of cookies.slice(0, 2)) {
        const grant = await contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({ userId: w.learner.id, sessionId: 's-rank', deviceCookie: cookie }),
        );
        expect(grant.lessonId).toBe(w.previewLesson.id);
        await leases.revokeAll(w.learner.id, w.academy.id);
      }

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({
            userId: w.learner.id,
            sessionId: 's-rank',
            deviceCookie: cookies[2],
          }),
        ),
        403,
        'errors.learning.deviceLimit',
      );

      // Refusing a recognised device must not quietly register another one.
      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id, revokedAt: null },
        }),
      ).toBe(3);
    });

    it('an unknown or tampered device cookie re-registers under the cap rather than bypassing it', async () => {
      const w = await world('p2sec-device-tamper');
      await policyFor(w.academy.id, 1);

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.learner.id, sessionId: 's-t', deviceCookie: 'real-cookie' }),
      );
      await leases.revokeAll(w.learner.id, w.academy.id);

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({
            userId: w.learner.id,
            sessionId: 's-t',
            deviceCookie: 'forged-cookie-value',
          }),
        ),
        403,
        'errors.learning.deviceLimit',
      );
      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id, revokedAt: null },
        }),
      ).toBe(1);
    });

    it('a device cookie is not a bearer credential for another learner’s device row', async () => {
      const w = await world('p2sec-device-steal');
      await policyFor(w.academy.id, 2);
      const cookie = deviceCookie('shared-cookie');
      await admin.studentDevice.create({
        data: {
          userId: w.learner.id,
          academyId: w.academy.id,
          cookieHash: hashDeviceCookie(cookie),
          label: 'Chrome on macOS',
        },
      });

      // The outsider presents the learner's cookie. It must register a NEW
      // device for them, never adopt the learner's row.
      await admin.academyStudent.create({
        data: {
          academyId: w.academy.id,
          userId: w.outsider.id,
          status: 'active',
          source: 'staff_created',
        },
      });
      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.outsider.id, sessionId: 's-steal', deviceCookie: cookie }),
      );

      const rows = await admin.studentDevice.findMany({
        where: { academyId: w.academy.id, cookieHash: hashDeviceCookie(cookie) },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(w.learner.id);
    });

    it('a second device conflicts on the single-session lease rather than sharing it', async () => {
      const w = await world('p2sec-lease-conflict');
      await policyFor(w.academy.id, 2);

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.learner.id, sessionId: 's-one', deviceCookie: 'dev-one' }),
      );

      await expect(
        contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({ userId: w.learner.id, sessionId: 's-two', deviceCookie: 'dev-two' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('FINDING SEC-2: the session-conflict refusal is recorded, not rolled back with the exception that caused it', async () => {
      const w = await world('p2sec-lease-conflict-log');
      await policyFor(w.academy.id, 2);

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.learner.id, sessionId: 's-one', deviceCookie: 'dev-one' }),
      );
      await expect(
        contentService.getContent(
          w.course.id,
          w.previewLesson.id,
          context({ userId: w.learner.id, sessionId: 's-two', deviceCookie: 'dev-two' }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);

      // This is the ONE refusal `LessonContentService` writes inside the
      // caller's own context (`lesson-content.service.ts:263-272`), so the
      // insert policy admits it — and it still never lands, because the
      // `ConflictException` on the next line is thrown from inside the same
      // `$transaction` callback, and Prisma rolls the transaction back.
      //
      // Together with the contextless path, that means NO content-access
      // refusal of any kind is ever recorded.
      //
      // Proposed fix (owned by src/learning/services/lesson-content.service.ts
      // — NOT applied here): record the conflict the way `logRefusal` records
      // the others, i.e. after the transaction has unwound, rather than
      // inside the transaction the refusal aborts.
      const conflicts = await admin.contentAccessLog.count({
        where: { lessonId: w.previewLesson.id, reason: 'sessionConflict' },
      });
      expect(conflicts).toBeGreaterThanOrEqual(1);
    });

    it('a takeover never creates a device, so it cannot be used around the cap (D4)', async () => {
      const w = await world('p2sec-takeover');
      await policyFor(w.academy.id, 1);

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({
          userId: w.learner.id,
          sessionId: 's-first',
          deviceCookie: 'dev-first',
        }),
      );
      const before = await admin.studentDevice.count({
        where: { userId: w.learner.id, academyId: w.academy.id },
      });
      expect(before).toBe(1);

      // An unregistered browser asking to "take over" is refused.
      await expect(
        learnerSessions.takeover(w.learner.id, w.academy.id, {
          sessionId: 's-second',
          deviceCookie: 'dev-never-seen',
        }),
      ).rejects.toMatchObject({ status: 403 });

      // With no cookie at all, likewise.
      await expect(
        learnerSessions.takeover(w.learner.id, w.academy.id, {
          sessionId: 's-second',
          deviceCookie: null,
        }),
      ).rejects.toMatchObject({ status: 403 });

      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id },
        }),
      ).toBe(before);
    });

    it('a takeover by a registered device displaces the previous session and is audited', async () => {
      const w = await world('p2sec-takeover-ok');
      await policyFor(w.academy.id, 2);

      // Registered with KNOWN cookie hashes. `StudentDeviceService` mints its
      // own opaque cookie value and returns it for the controller to set, so
      // a device registered through `getContent` cannot afterwards be
      // addressed by the string the test passed in — only by the value the
      // server generated, which this test does not receive.
      for (const cookie of [deviceCookie('dev-a'), deviceCookie('dev-b')]) {
        await admin.studentDevice.create({
          data: {
            userId: w.learner.id,
            academyId: w.academy.id,
            cookieHash: hashDeviceCookie(cookie),
            label: `Browser ${cookie}`,
          },
        });
      }

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({
          userId: w.learner.id,
          sessionId: 's-b',
          deviceCookie: deviceCookie('dev-b'),
        }),
      );
      const devicesBefore = await admin.studentDevice.count({
        where: { userId: w.learner.id, academyId: w.academy.id },
      });
      expect(devicesBefore).toBe(2);

      const result = await learnerSessions.takeover(w.learner.id, w.academy.id, {
        sessionId: 's-a',
        deviceCookie: deviceCookie('dev-a'),
        courseId: w.course.id,
        lessonId: w.previewLesson.id,
      });
      expect(result.leaseId).toBeTruthy();

      expect(
        await admin.studentDevice.count({
          where: { userId: w.learner.id, academyId: w.academy.id },
        }),
      ).toBe(devicesBefore);

      const audit = await admin.auditLogEntry.findFirst({
        where: {
          academyId: w.academy.id,
          action: 'learning.device_session_takeover',
          actorUserId: w.learner.id,
        },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit).not.toBeNull();
    });

    it('a removed device loses its sessions and its lease immediately', async () => {
      const w = await world('p2sec-device-remove');
      await policyFor(w.academy.id, 2);

      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.learner.id, sessionId: 's-r', deviceCookie: 'dev-r' }),
      );
      const device = await admin.studentDevice.findFirstOrThrow({
        where: { userId: w.learner.id, academyId: w.academy.id },
      });
      expect(await leases.current(w.learner.id, w.academy.id)).not.toBeNull();

      await learnerSessions.removeDevice(w.learner.id, w.academy.id, device.id);

      const after = await admin.studentDevice.findUniqueOrThrow({
        where: { id: device.id },
      });
      expect(after.revokedAt).not.toBeNull();
      expect(await leases.current(w.learner.id, w.academy.id)).toBeNull();
    });

    it('a learner cannot remove another learner’s device by naming its id', async () => {
      const w = await world('p2sec-device-foreign');
      const theirs = await admin.studentDevice.create({
        data: {
          userId: w.outsider.id,
          academyId: w.academy.id,
          cookieHash: hashDeviceCookie(deviceCookie('theirs')),
          label: 'Safari on iOS',
        },
      });

      await expect(
        learnerSessions.removeDevice(w.learner.id, w.academy.id, theirs.id),
      ).rejects.toMatchObject({ status: 404 });

      const still = await admin.studentDevice.findUniqueOrThrow({
        where: { id: theirs.id },
      });
      expect(still.revokedAt).toBeNull();
    });
  });

  // ==========================================================================
  // 6. The HTTP surface
  // ==========================================================================

  describe('the grant route', () => {
    it('answers 404 for an anonymous caller and never caches a grant', async () => {
      const w = await world('p2sec-http');

      const refused = await request(app.getHttpServer())
        .get(`/learning/courses/${w.course.id}/lessons/${w.videoLesson.id}/content`)
        .expect(404);
      expect(refused.headers['cache-control']).toBe('private, no-store');
      expect(refused.headers['referrer-policy']).toBe('no-referrer');

      const preview = await request(app.getHttpServer())
        .get(`/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/content`)
        .expect(200);
      expect(preview.headers['cache-control']).toBe('private, no-store');
      expect(preview.headers['referrer-policy']).toBe('no-referrer');
      expect(preview.body.isPreview).toBe(true);
    });

    it('the refresh route requires a session — an anonymous refresh is 401, not a free grant', async () => {
      const w = await world('p2sec-http-refresh');
      await request(app.getHttpServer())
        .post(
          `/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/playback/refresh`,
        )
        .expect(401);
    });

    it('the learner dashboard refuses a bare academyId when the host resolved to nothing', async () => {
      await request(app.getHttpServer()).get('/learning/overview').expect(401);
    });

    it('a resolvable academy host wins over any academyId the caller sends', async () => {
      const a = await world('p2sec-host-param-a');
      const b = await world('p2sec-host-param-b');
      const baseDomain = process.env.PLATFORM_BASE_DOMAIN;
      if (!baseDomain) {
        // Without a platform base domain there is no hostname that CAN
        // resolve, so the property under test is not expressible here.
        // Recorded rather than silently skipped.
        expect(baseDomain).toBeUndefined();
        return;
      }

      const label = `p2sec-${Date.now().toString(36)}`;
      await admin.subdomainAllocation.create({
        data: {
          academyId: a.academy.id,
          subdomain: label,
          fullHost: `${label}.${baseDomain}`,
          status: 'assigned',
        },
      });

      const learner = await signInLearner(a);
      const response = await request(app.getHttpServer())
        .get('/learning/devices')
        .query({ academyId: b.academy.id })
        .set('Host', `${label}.${baseDomain}`)
        .set(learner.auth)
        .expect(200);

      // The learner holds a device in academy A only. If the query
      // parameter had won, the list would be academy B's (empty) instead.
      expect(response.body).toHaveProperty('maxDevices');
      const devicesOfA = await admin.studentDevice.count({
        where: { userId: learner.userId, academyId: a.academy.id, revokedAt: null },
      });
      expect(response.body.devices).toHaveLength(devicesOfA);
      expect(devicesOfA).toBeGreaterThan(0);
    });
  });

  async function signInLearner(w: Awaited<ReturnType<typeof world>>) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail('p2sec-signin');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({
        name: 'Learner',
        email,
        password: PASSWORD,
        academyId: w.academy.id,
      })
      .expect(201);
    await flushRateLimitKeys();
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({
        email,
        password: PASSWORD,
        surface: 'academy',
        academyId: w.academy.id,
      })
      .expect(200);
    const userId = signIn.body.user.id as string;

    await admin.enrollment.create({
      data: {
        studentId: userId,
        courseId: w.course.id,
        academyId: w.academy.id,
        status: 'enrolled',
        enrolledAt: new Date(),
      },
    });
    await admin.studentDevice.create({
      data: {
        userId,
        academyId: w.academy.id,
        cookieHash: hashDeviceCookie(randomUUID()),
        label: 'Chrome on macOS',
      },
    });

    return {
      userId,
      auth: { Authorization: `Bearer ${signIn.body.accessToken as string}` },
    };
  }

  // ==========================================================================
  // 7. The audit trail
  // ==========================================================================

  describe('content_access_log', () => {
    it('records a granted decision under the caller’s own context', async () => {
      const w = await world('p2sec-log-grant');
      await contentService.getContent(
        w.course.id,
        w.previewLesson.id,
        context({ userId: w.learner.id, sessionId: 's-lg' }),
      );

      expect(
        await admin.contentAccessLog.count({
          where: { lessonId: w.previewLesson.id, result: 'granted' },
        }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('FINDING SEC-2: a refused learner leaves a refusal in the log', async () => {
      const w = await world('p2sec-log-refusal');

      await expectRefusal(
        contentService.getContent(
          w.course.id,
          w.videoLesson.id,
          context({ userId: w.outsider.id, sessionId: 's-lr' }),
        ),
        404,
      );

      // `logRefusal` runs `runWithoutContext` on purpose — a refused learner
      // may have no rows of their own — but `content_access_log_insert`'s
      // WITH CHECK is `user_id IS NULL OR user_id = current_setting(...)`,
      // and with no context that setting is NULL. The insert raises 42501,
      // `ContentAccessLogRepository.record` swallows it, and the refusal is
      // never recorded. Phase 2 §U requires a structured record of every
      // refusal; §R's adversarial checks read this table.
      //
      // Proposed fix (owned by prisma/ and src/learning/services/ — NOT
      // applied here): either write refusals through a SECURITY DEFINER
      // function, or add an audit-insert policy that admits a row whose
      // `academy_id` exists, plus a SELECT tier so Prisma's
      // `INSERT ... RETURNING` succeeds for the anonymous case.
      expect(
        await admin.contentAccessLog.count({
          where: { lessonId: w.videoLesson.id, result: 'refused' },
        }),
      ).toBeGreaterThanOrEqual(1);
    });

    it('FINDING SEC-2: the repository can record a refusal without a user context at all', async () => {
      const w = await world('p2sec-log-repo');

      await tenancy.runWithoutContext((tx) =>
        accessLog.record(tx, {
          userId: w.learner.id,
          academyId: w.academy.id,
          courseId: w.course.id,
          lessonId: w.videoLesson.id,
          result: 'refused',
          reason: 'notEnrolled',
          deviceId: null,
          sessionId: 'session-x',
        }),
      );

      expect(
        await admin.contentAccessLog.count({
          where: { lessonId: w.videoLesson.id, result: 'refused' },
        }),
      ).toBe(1);
    });
  });
});
