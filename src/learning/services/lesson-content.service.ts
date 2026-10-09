/**
 * `LessonContentService` — THE POLICY DECISION POINT for every byte of
 * lesson content (master plan Phase 2 §D.2, AD-1, AD-2; findings S1–S3).
 *
 * Everything this phase is for converges here. Before P64, a curriculum
 * response handed out a durable `contentUrl` for every lesson in the
 * course at once, and that URL was the whole authorization check: it
 * outlived refunds, revocations, expiries and the enrollment itself, and
 * it worked for anyone it was forwarded to. This service replaces that
 * with a decision taken AT THE MOMENT the bytes are asked for, for ONE
 * lesson, that expires on its own.
 *
 * THE SEVEN CONDITIONS, in the order they are checked and why:
 *
 *   1. identity + session   — who is asking, and on which session/device.
 *   2. academy context      — the lesson's academy must be the academy the
 *                             request host actually resolved to, so a
 *                             session minted for academy A cannot fetch
 *                             academy B's content by id.
 *   3. active enrollment    — enrolled/completed, unrevoked, unexpired,
 *                             with an active unblocked academy membership.
 *   4. published course     — an unpublished or archived course delivers
 *                             nothing, even to someone who enrolled while
 *                             it was live.
 *   5. deliverable lesson   — published, drip date passed, and content
 *                             that actually exists — or a preview lesson,
 *                             which is the one documented short-circuit.
 *   6. device + lease       — a registered device within the cap, holding
 *                             the single-session lease.
 *   7. no suspension        — a suspended account delivers nothing.
 *
 * Ordering is deliberate: the cheap identity checks come first, the
 * refusals that reveal the least come before the ones that reveal more,
 * and the lease — the only condition with a side effect — is taken LAST,
 * so a request that was going to be refused anyway never steals another
 * device's lease on the way out.
 *
 * WHAT STAFF GET. An instructor or academy manager previewing their own
 * course passes conditions 3–6 by role instead of by enrollment (they
 * must be able to check their own content), and takes no lease: staff are
 * not subject to a learner device policy, and treating a manager's
 * preview as a concurrent learning session would lock out the learner
 * they were helping.
 *
 * RLS INDEPENDENTLY AGREES. `can_access_lesson()` encodes the row-shaped
 * half of this (preview / enrolled / instructor / manager) and every read
 * below runs in the caller's own user context, so a bug in this service
 * still yields zero rows rather than another tenant's content. Guard
 * decides, RLS independently agrees.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type {
  LessonContentKind,
  MediaAsset,
  MediaAssetProvider,
  Prisma,
  VideoSecurityTier,
} from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { AccessPolicyService } from '../../tenancy/services/access-policy.service';
import { StudentDeviceService } from '../../tenancy/services/student-device.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseSequenceService } from './course-sequence.service';
import { ContentAccessLogRepository } from '../repositories/content-access-log.repository';
import { ContentGrantSigner } from './content-grant.signer';
import { AcademyOriginsService } from '../../media/video/academy-origins.service';
import { LearningLeaseService } from './learning-lease.service';
import { ContentGrantRateLimiter } from './content-grant.rate-limiter';
import { isEnrollmentActive } from './learning-access.util';
import { resolveContentProtection } from '../dto/content-protection.contract';
import { MINIMUM_WATCHED_RATIO } from '../dto/learning.constants';
import { classifyExternalEmbed } from './external-embed.util';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { CommunicationService } from '../../communications/services/communication.service';
import type {
  ContentAccessReason,
  ContentProtectionReport,
  GrantedResourceContract,
  LessonContentGrantResponse,
  OfflineReadingPermission,
} from '../dto/lesson-content.contract';
import { OFFLINE_READING_TTL_SECONDS } from '../dto/lesson-content.contract';
import type { VideoProviderCapabilities } from '../../media/video/video-provider.interface';

export interface ContentRequestContext {
  readonly userId: string | null;
  readonly sessionId: string | null;
  /** The academy the request HOST resolved to. Null on the platform host (staff preview) and in local development. */
  readonly hostAcademyId: string | null;
  readonly deviceCookie?: string | null;
  readonly userAgent?: string | null;
  /**
   * Writes a NEW device identity to the response. The grant is the other
   * place a device is registered, so it must be able to hand the browser
   * its identity — without this, a row it registered was unreachable (see
   * `StudentDeviceService.resolveForSession`).
   */
  readonly onDeviceCookie?: (value: string) => void;
}

/**
 * A refusal, carrying the asset context WHEN IT IS KNOWN.
 *
 * §V asks the access log to record the tier and provider for every
 * decision, not only grants — "was this refusal on a Premium lesson or a
 * Normal one?" is a real forensic question once the two coexist in one
 * academy (D11). Many refusals genuinely happen before any asset is in
 * hand (`notEnrolled`, `notAuthenticated`), and for those the honest
 * answer is null rather than a guess.
 */
/**
 * What `buildGrant` actually needs to deliver a lesson's content — a subset
 * of a `lesson_contents` row that a synthesised legacy descriptor can also
 * satisfy.
 */
interface EffectiveLessonContent {
  readonly kind: LessonContentKind;
  readonly bodyHtml: string | null;
  readonly externalUrl: string | null;
  readonly mediaAsset: MediaAsset | null;
}

/**
 * The content to deliver for a lesson, reconciling the TWO representations
 * that coexist in the product.
 *
 * The course BUILDER (dashboard) writes only the legacy
 * `course_lessons.contentType` / `contentUrl` (and attaches a hosted video
 * via `video_asset_id`) — its own comment says student consumption is "a
 * separate, future module", and it never creates a `lesson_contents` row.
 * The learner's unified player reads `lesson_contents`. So every lesson an
 * author built in the dashboard — a YouTube link most visibly (P4 Issue 2),
 * but also a hosted video — arrived at the player with no `lesson_contents`
 * row and was refused as `noContent`.
 *
 * Rather than a second authoring step the builder never performs, or a
 * migration that would still leave the two writers able to drift, the
 * learner grant path understands BOTH: an authored `lesson_contents` row
 * wins; otherwise the legacy fields are read into the same grant shape —
 * a hosted `video_asset` is a video lesson, and a single opaque
 * `content_url` becomes a YouTube embed (via `classifyExternalEmbed`) or an
 * honest external link-out. No new model, no durable second copy: one
 * read-time reconciliation onto the one grant contract.
 */
function effectiveLessonContent(lesson: {
  content: EffectiveLessonContent | null;
  videoAsset: { id: string } | null;
  contentType: string | null;
  contentUrl: string | null;
}): EffectiveLessonContent | null {
  if (lesson.content) return lesson.content;

  // A hosted video is a video lesson; `buildGrant` signs it from
  // `lesson.videoAsset`, so the descriptor only has to pass the guard.
  if (lesson.videoAsset) {
    return { kind: 'video', bodyHtml: null, externalUrl: null, mediaAsset: null };
  }

  const url = lesson.contentUrl?.trim();
  if (url) {
    // The builder stores every non-hosted source in one opaque URL. A
    // YouTube link becomes an embed in `buildGrant`; anything else stays a
    // link-out. Either way it is an unprotected external embed, reported
    // honestly as such.
    return { kind: 'external', bodyHtml: null, externalUrl: url, mediaAsset: null };
  }

  return null;
}

class ContentRefusal extends Error {
  constructor(
    readonly reason: ContentAccessReason,
    readonly assetContext: {
      readonly securityTier: VideoSecurityTier | null;
      readonly provider: MediaAssetProvider | null;
    } = { securityTier: null, provider: null },
    /**
     * P64 Communications C3 (plan §8 B3) — the academy and its device cap,
     * carried OUT of the transaction on the refusal for the same reason
     * `atlasRefusal` carries the session-conflict detail: the transaction
     * this was thrown in is about to roll back, so anything the caller
     * needs afterwards has to travel on the exception.
     */
    readonly deviceLimit: {
      readonly academyId: string;
      readonly maxDevices: number;
    } | null = null,
  ) {
    super(reason);
  }
}

@Injectable()
export class LessonContentService {
  private readonly logger = new Logger(LessonContentService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly accessPolicyService: AccessPolicyService,
    private readonly studentDeviceService: StudentDeviceService,
    private readonly leaseService: LearningLeaseService,
    private readonly signer: ContentGrantSigner,
    private readonly originsService: AcademyOriginsService,
    private readonly accessLog: ContentAccessLogRepository,
    private readonly rateLimiter: ContentGrantRateLimiter,
    private readonly metrics: LearningMetricsService,
    private readonly courseSequence: CourseSequenceService,
    private readonly communications: CommunicationService,
  ) {}

  async getContent(
    courseId: string,
    lessonId: string,
    context: ContentRequestContext,
  ): Promise<LessonContentGrantResponse> {
    // An anonymous caller may still open a PREVIEW lesson, so identity is
    // resolved rather than required here; condition 1 is enforced per
    // branch below, once we know whether this is a preview.
    const userId = context.userId;

    // The whole decision runs in the caller's own user context (or none at
    // all, for an anonymous preview), so `can_access_lesson()` is the
    // policy in force for every read inside it.
    const run = <T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> =>
      userId
        ? this.tenancyContextService.runInUserContext(userId, fn)
        : this.tenancyContextService.runWithoutContext(fn);

    // P64 Communications C3 (plan §8 B1) — set inside the transaction
    // below, enqueued once it has committed.
    let deviceRegisteredOutboxId: string | null = null;

    try {
      const grant = await run(async (tx) => {
        const lesson = await tx.courseLesson.findFirst({
          where: { id: lessonId, courseId },
          include: {
            content: { include: { mediaAsset: true } },
            resources: { include: { mediaAsset: true }, orderBy: { order: 'asc' } },
            videoAsset: true,
            section: { select: { courseId: true } },
          },
        });
        // Zero rows here is already RLS refusing, not just "no such
        // lesson": the two are indistinguishable to the caller on purpose,
        // matching the established "unreachable content looks like it does
        // not exist" rule.
        if (!lesson) throw new ContentRefusal('lessonUnavailable');

        const course = await tx.course.findUnique({
          where: { id: courseId },
          select: { id: true, academyId: true, status: true, title: true },
        });
        if (!course) throw new ContentRefusal('courseUnavailable');

        // --- condition 2: academy context -----------------------------
        // A host that resolves to an academy MUST match the content's
        // academy. A null host (platform dashboard, local dev) is not a
        // free pass — it simply means the host carried no academy claim,
        // and conditions 3–7 still decide everything.
        if (context.hostAcademyId && context.hostAcademyId !== course.academyId) {
          throw new ContentRefusal('notAuthenticated');
        }

        const staffPreview = userId
          ? await this.isStaffPreviewer(tx, userId, courseId, course.academyId)
          : false;

        // --- condition 5 (partial): preview short-circuit --------------
        const isOpenPreview =
          lesson.isPreview &&
          lesson.status === 'published' &&
          course.status === 'published';

        if (!staffPreview && !isOpenPreview) {
          // --- condition 1: identity ---------------------------------
          if (!userId) throw new ContentRefusal('notAuthenticated');

          // --- condition 7: suspension -------------------------------
          const account = await tx.user.findUnique({
            where: { id: userId },
            select: { status: true },
          });
          if (!account || account.status !== 'active') {
            throw new ContentRefusal('suspended');
          }

          // --- condition 3: active enrollment ------------------------
          const enrollment = await this.enrollmentsRepository.findByStudentAndCourse(
            tx,
            userId,
            courseId,
          );
          if (!enrollment) throw new ContentRefusal('notEnrolled');
          if (!isEnrollmentActive(enrollment)) throw new ContentRefusal('accessEnded');

          const membership = await this.academyStudentsRepository.findForUserInAcademy(
            tx,
            course.academyId,
            userId,
          );
          if (!membership || membership.status !== 'active' || membership.blockedAt) {
            throw new ContentRefusal('accessEnded');
          }

          // --- condition 4: published course -------------------------
          if (course.status !== 'published') {
            throw new ContentRefusal('courseUnavailable');
          }

          // --- condition 5: deliverable lesson -----------------------
          if (lesson.status !== 'published') {
            throw new ContentRefusal('lessonUnavailable');
          }
          if (lesson.availableAt && lesson.availableAt.getTime() > Date.now()) {
            throw new ContentRefusal('scheduled');
          }

          // --- condition 6: sequential progression -------------------
          // Entitled and published, but the curriculum may still gate it
          // behind an unfinished earlier item. The player sidebar already
          // shows this from `CourseSequenceService`; refusing the CONTENT
          // grant from the same derivation is what makes the lock real
          // rather than cosmetic — otherwise a deep link or a direct API
          // call fetched a signed URL for a lesson the learner has not
          // reached. A preview lesson and a staff previewer never get here.
          const sequence = await this.courseSequence.getSequenceItems(
            tx,
            userId,
            courseId,
          );
          const sequenceItem = sequence.find((item) => item.id === lessonId);
          if (sequenceItem?.state === 'locked') {
            throw new ContentRefusal('locked');
          }
        }

        // Past this line the caller is entitled to the lesson, so the two
        // "nothing to deliver" cases may be named: an unauthored lesson and
        // an unprocessed asset are different facts with different fixes,
        // and calling both "unavailable" left the player guessing
        // "processing" for a lesson nobody had written yet. Both still 404.
        //
        // Content is read from the authored `lesson_contents` row OR, for a
        // lesson the dashboard builder created (which never writes that row),
        // reconciled from the legacy fields — see `effectiveLessonContent`.
        const effectiveContent = effectiveLessonContent(lesson);
        if (!effectiveContent) throw new ContentRefusal('noContent');

        // SEC-3 — the ASSET-READINESS refusal is hoisted above the lease.
        //
        // This file's own rule is that the lease is taken last, "so a
        // request that was going to be refused anyway never steals
        // another device's lease on the way out". That held for every
        // condition except this one, which sat further down in
        // `buildGrant` — so a learner opening a still-processing video
        // took the academy's single learning lease and held it for its
        // full 60-second TTL, locking their other device out of a lesson
        // that would have worked.
        if (lesson.videoAsset && lesson.videoAsset.processingStatus !== 'ready') {
          throw new ContentRefusal('processing', {
            securityTier: lesson.videoAsset.securityTier,
            provider: lesson.videoAsset.provider,
          });
        }

        // --- rate limit --------------------------------------------------
        // Counted per learner, not per lesson: the abuse this catches is
        // one account pulling grants for a whole catalogue, which looks
        // perfectly normal lesson-by-lesson (Phase 2 §U).
        if (userId && !staffPreview) {
          const allowed = await this.rateLimiter.consume(userId);
          if (!allowed) throw new ContentRefusal('rateLimited');
        }

        // --- conditions 6: device + lease --------------------------------
        let deviceId: string | null = null;
        let lease: LessonContentGrantResponse['playbackLease'] = null;

        if (userId && !staffPreview) {
          const policy = await this.accessPolicyService.resolveForAcademy(
            tx,
            course.academyId,
          );
          const resolution = await this.studentDeviceService.resolveForSession(tx, {
            userId,
            academyId: course.academyId,
            cookieValue: context.deviceCookie,
            userAgent: context.userAgent,
            maxDevices: policy.maxDevices,
          });
          // Given even when the answer below is `deviceLimit`: a browser
          // holding an identity registers itself as soon as a slot frees.
          if (resolution.issueCookieValue) {
            context.onDeviceCookie?.(resolution.issueCookieValue);
          }
          if (resolution.atCapacity || !resolution.device) {
            throw new ContentRefusal('deviceLimit', undefined, {
              academyId: course.academyId,
              maxDevices: policy.maxDevices,
            });
          }
          deviceId = resolution.device.id;

          // A session minted while the learner was at their cap carries no
          // device. Bind it to the device it is now using, so removing that
          // device ends this session too (termination revokes by device).
          if (context.sessionId) {
            await tx.refreshToken.updateMany({
              where: {
                userId,
                sessionId: context.sessionId,
                deviceId: null,
                revokedAt: null,
              },
              data: { deviceId },
            });
          }

          // P64 Communications C3 (plan §8 B1) — the OTHER place a device
          // is registered. `created` is true on the INSERT alone, so a
          // recognised device being touched emits nothing, and the
          // catalogue's dedupe (the device id) means the sign-in path and
          // this one can never both announce the same row.
          if (resolution.created) {
            // No academy NAME: a learner's own context cannot SELECT
            // `academies` (there is no `academies_student_select`), and
            // the brand name is resolved by the dispatcher anyway.
            const registered = await this.communications.emit(tx, {
              key: 'device.registered',
              recipientUserId: userId,
              academyId: course.academyId,
              entity: { type: 'student_device', id: resolution.device.id },
              values: { deviceLabel: resolution.device.label },
            });
            deviceRegisteredOutboxId = registered.outboxId;
          }

          // Taken last, and only when everything else already passed.
          const outcome = await this.leaseService.acquire({
            userId,
            academyId: course.academyId,
            deviceId,
            sessionId: context.sessionId ?? deviceId,
            courseId,
            lessonId,
          });
          if (outcome.status === 'held_by_other') {
            const holder = await tx.studentDevice.findUnique({
              where: { id: outcome.holder.deviceId },
              select: { label: true },
            });
            // SEC-2 — NOT written here. This runs inside the
            // transaction that is about to throw `ConflictException`, so
            // the insert was rolled back with it and not one session
            // conflict was ever recorded. The refusal is carried on the
            // exception instead and logged outside the transaction, the
            // same way every other refusal is.
            throw new ConflictException({
              messageKey: 'errors.learning.sessionConflict',
              details: {
                deviceLabel: holder?.label ?? null,
                since: outcome.holder.acquiredAt,
              },
              // Read by the catch block below, which logs outside the
              // transaction so the record survives the rollback.
              atlasRefusal: {
                reason: 'sessionConflict' as const,
                securityTier: lesson.videoAsset?.securityTier ?? null,
                provider: lesson.videoAsset?.provider ?? null,
                deviceId,
              },
            });
          }
          if (outcome.status === 'acquired') {
            lease = {
              leaseId: outcome.lease.leaseId,
              ttlSeconds: outcome.ttlSeconds,
              heartbeatSeconds: outcome.heartbeatSeconds,
            };
          } else {
            // Redis is unreachable. Delivering content is the right call:
            // the lease is a sharing DETERRENT, not the authorization
            // boundary, and every other condition has already passed.
            // Refusing here would turn a cache outage into a platform-wide
            // learning outage. Logged at warn so it is visible.
            this.logger.warn(
              { userId, academyId: course.academyId, courseId, lessonId },
              'Learning lease unavailable; content delivered without a lease.',
            );
          }
        }

        const grant = await this.buildGrant(tx, {
          lesson,
          content: effectiveContent,
          course,
          userId,
          sessionId: context.sessionId,
          deviceId,
          lease,
          staffPreview,
        });

        await this.log(tx, {
          userId,
          academyId: course.academyId,
          courseId,
          lessonId,
          result: 'granted',
          reason: grant.kind,
          deviceId,
          sessionId: context.sessionId,
          // D10 — Normal and Premium assets coexist in one academy, so
          // "was this delivered under the protection we sold them?" has to
          // be answerable from the log alone.
          securityTier: grant.protection.tier,
          provider: lesson.videoAsset?.provider ?? null,
        });

        this.metrics.recordGrant(grant.kind, grant.protection.tier);
        return grant;
      });

      // Step 2, after the transaction above has committed.
      await this.communications.enqueueAfterCommit(deviceRegisteredOutboxId);
      return grant;
    } catch (error) {
      // A conflict is a refusal too, and its record has to outlive the
      // transaction that produced it (SEC-2).
      if (error instanceof ConflictException) {
        const refusal = (
          error.getResponse() as {
            atlasRefusal?: {
              reason: ContentAccessReason;
              securityTier: VideoSecurityTier | null;
              provider: MediaAssetProvider | null;
              deviceId: string | null;
            };
          }
        ).atlasRefusal;
        if (refusal) {
          this.metrics.recordRefusal(refusal.reason, refusal.securityTier);
          await this.logRefusal(courseId, lessonId, context, refusal.reason, {
            securityTier: refusal.securityTier,
            provider: refusal.provider,
          });
        }
        throw error;
      }

      if (error instanceof ContentRefusal) {
        this.metrics.recordRefusal(error.reason, error.assetContext.securityTier);
        // Refusals are logged OUTSIDE the caller's context: a learner who
        // was just refused may well have no rows visible to them, and the
        // record of the refusal is exactly what a sharing investigation
        // needs to exist regardless.
        await this.logRefusal(
          courseId,
          lessonId,
          context,
          error.reason,
          error.assetContext,
        );
        if (error.deviceLimit && userId) {
          await this.notifyDeviceLimit(userId, error.deviceLimit);
        }
        throw refusalToHttp(error.reason);
      }
      throw error;
    }
  }

  /** An instructor of this course, or an owner/administrator/manager of its academy. */
  private async isStaffPreviewer(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
    academyId: string,
  ): Promise<boolean> {
    const [instructor, member] = await Promise.all([
      tx.courseInstructor.findFirst({ where: { courseId, userId } }),
      tx.academyMember.findFirst({
        where: {
          academyId,
          userId,
          status: 'active',
          role: { in: ['owner', 'administrator', 'manager'] },
        },
      }),
    ]);
    return Boolean(instructor ?? member);
  }

  private async buildGrant(
    tx: Prisma.TransactionClient,
    args: {
      readonly lesson: Prisma.CourseLessonGetPayload<{
        include: {
          content: { include: { mediaAsset: true } };
          resources: { include: { mediaAsset: true } };
          videoAsset: true;
        };
      }>;
      readonly content: EffectiveLessonContent;
      readonly course: { id: string; academyId: string; status: string; title: string };
      readonly userId: string | null;
      readonly sessionId: string | null;
      readonly deviceId: string | null;
      readonly lease: LessonContentGrantResponse['playbackLease'];
      readonly staffPreview: boolean;
    },
  ): Promise<LessonContentGrantResponse> {
    const { lesson, course, content } = args;

    const academy = await tx.academy.findUnique({
      where: { id: course.academyId },
      select: { contentProtection: true, name: true },
    });
    const protection = resolveContentProtection(academy?.contentProtection);

    const expiryCandidates: number[] = [];
    let bodyHtml: string | undefined;
    let fileUrl: string | undefined;
    let fileName: string | undefined;
    let externalUrl: string | undefined;
    let externalEmbed: LessonContentGrantResponse['externalEmbed'] | null = null;
    let video: LessonContentGrantResponse['video'];
    let videoCapabilities: VideoProviderCapabilities | null = null;
    let assetTier: VideoSecurityTier | null = null;

    if (content.kind === 'text') {
      bodyHtml = content.bodyHtml ?? '';
    } else if (content.kind === 'external') {
      externalUrl = content.externalUrl ?? undefined;
      // A supported YouTube link becomes an embeddable descriptor; every
      // other address stays a link-out. The player embeds from `videoId`,
      // never from the URL, so this is the only door into an iframe.
      externalEmbed = classifyExternalEmbed(externalUrl);
    } else if (content.kind === 'file' && content.mediaAsset) {
      const signed = await this.signer.signFile(content.mediaAsset);
      fileUrl = signed.url;
      fileName = content.mediaAsset.fileName;
      expiryCandidates.push(signed.expiresAt.getTime());
    }

    if (lesson.videoAsset) {
      // Already refused above, before the lease was taken (SEC-3). Kept
      // as a defence in depth: `buildGrant` must never sign an asset the
      // provider has not finished processing, whatever path reached it.
      if (lesson.videoAsset.processingStatus !== 'ready') {
        throw new ContentRefusal('processing', {
          securityTier: lesson.videoAsset.securityTier,
          provider: lesson.videoAsset.provider,
        });
      }
      const origins = await this.originsService.forAcademy(tx, course.academyId);
      const signed = await this.signer.signVideo(lesson.videoAsset, {
        userId: args.userId ?? 'anonymous',
        sessionId: args.sessionId ?? 'anonymous',
        deviceId: args.deviceId ?? 'anonymous',
        academyId: course.academyId,
        allowedOrigins: origins,
      });
      video = signed.video;
      // AD-16 — what the DELIVERING adapter actually enforces, read from
      // it rather than assumed from the tier's name.
      videoCapabilities = signed.capabilities;
      assetTier = lesson.videoAsset.securityTier;
      expiryCandidates.push(signed.expiresAt.getTime());
    }

    const resources: GrantedResourceContract[] = [];
    for (const resource of lesson.resources) {
      if (resource.mediaAsset) {
        const signed = await this.signer.signFile(resource.mediaAsset);
        expiryCandidates.push(signed.expiresAt.getTime());
        resources.push({ id: resource.id, title: resource.title, url: signed.url });
      } else if (resource.externalUrl) {
        resources.push({
          id: resource.id,
          title: resource.title,
          externalUrl: resource.externalUrl,
        });
      }
    }

    // The grant expires with its SHORTEST credential. A grant that claimed
    // to outlive one of its own URLs would send the player to a dead link
    // and call it a network error.
    const expiresAt = new Date(
      expiryCandidates.length > 0
        ? Math.min(...expiryCandidates)
        : Date.now() + this.signer.fileTtlSeconds * 1000,
    );

    const resume = args.userId
      ? await tx.lessonProgress.findFirst({
          where: { lessonId: lesson.id, enrollment: { studentId: args.userId } },
          select: { lastPositionSeconds: true },
        })
      : null;

    return {
      lessonId: lesson.id,
      courseId: course.id,
      academyId: course.academyId,
      title: lesson.title,
      kind: content.kind,
      isPreview: lesson.isPreview,
      durationSeconds:
        lesson.durationSeconds ?? lesson.videoAsset?.durationSeconds ?? null,
      completionRule: lesson.completionRule,
      minimumWatchedRatio:
        lesson.completionRule === 'watched_ratio' ? MINIMUM_WATCHED_RATIO : null,
      protection: buildProtectionReport({
        kind: content.kind,
        capabilities: videoCapabilities,
        tier: assetTier,
        expiresAt,
        watermarkEnabled: protection.watermark && Boolean(video),
      }),
      bodyHtml,
      fileUrl,
      fileName,
      video,
      externalUrl,
      ...(externalEmbed ? { externalEmbed } : {}),
      resources,
      watermark: {
        enabled: protection.watermark && Boolean(video),
        text: protection.watermark
          ? buildWatermarkText(protection.watermarkText, args.userId)
          : '',
      },
      playbackLease: args.lease,
      resumePositionSeconds: resume?.lastPositionSeconds ?? 0,
      expiresAt: expiresAt.toISOString(),
      offlineReading: offlineReadingFor({
        kind: content.kind,
        hasVideo: Boolean(lesson.videoAsset),
        signedIn: args.userId !== null,
        staffPreview: args.staffPreview,
      }),
    };
  }

  private async log(
    tx: Prisma.TransactionClient,
    entry: Parameters<ContentAccessLogRepository['record']>[1],
  ): Promise<void> {
    await this.accessLog.record(tx, entry);
  }

  /**
   * P64 Communications C3 (plan §8 B3, §10 "B3 device limit ... yes
   * (urgent) | never") — the learner was refused a lesson because they
   * are over their academy's device cap.
   *
   * OUTSIDE the refused transaction, in its own, for the reason SEC-2
   * records a few lines up: the transaction this refusal came from is
   * rolled back, so anything written inside it was never there. It is
   * also best-effort — a notification must never turn a clean 403 into a
   * 500 — and it damps itself, because the catalogue keys this event on
   * (academy, calendar day): a learner clicking a locked lesson twenty
   * times gets one feed row, and gets a fresh one tomorrow.
   */
  private async notifyDeviceLimit(
    userId: string,
    deviceLimit: { readonly academyId: string; readonly maxDevices: number },
  ): Promise<void> {
    try {
      const emitted = await this.tenancyContextService.runInUserContext(userId, (tx) =>
        this.communications.emit(tx, {
          key: 'device.limit_reached',
          recipientUserId: userId,
          academyId: deviceLimit.academyId,
          entity: { type: 'academy', id: deviceLimit.academyId },
          values: {
            // The UTC calendar day, so the key is stable for everyone
            // reading the same row and cannot drift with a timezone.
            occurredOn: new Date().toISOString().slice(0, 10),
            maxDevices: deviceLimit.maxDevices,
          },
        }),
      );
      await this.communications.enqueueAfterCommit(emitted.outboxId);
    } catch (error) {
      this.logger.warn(
        {
          userId,
          academyId: deviceLimit.academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not record a device-limit notification for a refused grant.',
      );
    }
  }

  private async logRefusal(
    courseId: string,
    lessonId: string,
    context: ContentRequestContext,
    reason: ContentAccessReason,
    assetContext: {
      readonly securityTier: VideoSecurityTier | null;
      readonly provider: MediaAssetProvider | null;
    } = { securityTier: null, provider: null },
  ): Promise<void> {
    try {
      const academyId =
        context.hostAcademyId ??
        (await this.tenancyContextService.runWithoutContext((tx) =>
          tx.course
            .findUnique({ where: { id: courseId }, select: { academyId: true } })
            .then((course) => course?.academyId ?? null),
        ));
      if (!academyId) return;
      await this.tenancyContextService.runWithoutContext((tx) =>
        this.accessLog.record(tx, {
          userId: context.userId,
          academyId,
          courseId,
          lessonId,
          result: 'refused',
          reason,
          deviceId: null,
          sessionId: context.sessionId,
          securityTier: assetContext.securityTier,
          provider: assetContext.provider,
        }),
      );
    } catch (error) {
      // Never let the audit trail turn a clean refusal into a 500.
      this.logger.warn(
        {
          courseId,
          lessonId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not record a content-access refusal.',
      );
    }
  }
}

/**
 * Refusal → HTTP.
 *
 * Almost everything is 404. That is the established rule for unreachable
 * content in this codebase, and it matters more here than anywhere else:
 * a 403 for `notEnrolled` versus a 404 for "no such lesson" would let an
 * unauthenticated crawler map every lesson id in a paid catalogue.
 *
 * The exceptions are the two states a learner can actually DO something
 * about — the device cap and the rate limit — where hiding the reason
 * would leave them stuck with no explanation.
 */
function refusalToHttp(reason: ContentAccessReason): Error {
  switch (reason) {
    case 'deviceLimit':
      return new ForbiddenException({ messageKey: 'errors.learning.deviceLimit' });
    case 'rateLimited':
      return new ForbiddenException({ messageKey: 'errors.learning.grantRateLimited' });
    case 'suspended':
      return new ForbiddenException({ messageKey: 'errors.auth.accountSuspended' });
    case 'accessEnded':
      return new ForbiddenException({ messageKey: 'errors.learning.accessEnded' });
    case 'scheduled':
      return new ForbiddenException({ messageKey: 'errors.learning.lessonScheduled' });
    case 'locked':
      return new ForbiddenException({ messageKey: 'errors.learning.lessonLocked' });
    // Still 404s — the posture that unreachable content is indistinguishable
    // from non-existent content is kept, because these two are raised only
    // for a learner who has already passed every entitlement check. The key
    // lets the player say what is true instead of what is likely.
    case 'noContent':
      return new NotFoundException({ messageKey: 'errors.learning.lessonNoContent' });
    case 'processing':
      return new NotFoundException({ messageKey: 'errors.learning.lessonProcessing' });
    default:
      return new NotFoundException({ messageKey: 'errors.notFound' });
  }
}

/**
 * Builds the honest protection report (AD-16).
 *
 * Every flag comes from the delivering adapter's own `capabilities()`.
 * Nothing is inferred from the tier's NAME — that is precisely the
 * mistake finding D-5 recorded, where "premium" was assumed to mean
 * device-bound and the provider's edge was in fact checking nothing of
 * the sort.
 *
 * Content with no hosted video reports a null tier and no video-shaped
 * claims: a text lesson is delivered over the same authenticated,
 * entitlement-checked channel, but calling it "watermarked" or
 * "origin-restricted" would be meaningless.
 */
export function buildProtectionReport(args: {
  readonly kind: LessonContentKind;
  readonly capabilities: VideoProviderCapabilities | null;
  readonly tier: VideoSecurityTier | null;
  readonly expiresAt: Date;
  readonly watermarkEnabled: boolean;
}): ContentProtectionReport {
  const expiresInSeconds = Math.max(
    0,
    Math.round((args.expiresAt.getTime() - Date.now()) / 1000),
  );

  // An external embed is the one case where Atlas hosts nothing and
  // therefore protects nothing. Saying so plainly is the honest option;
  // the learner is told rather than left to assume.
  if (args.kind === 'external') {
    return {
      tier: null,
      signedUrl: false,
      expiresInSeconds: 0,
      boundToSession: false,
      boundToDevice: false,
      revocableBeforeExpiry: false,
      originRestricted: false,
      watermark: false,
      adaptiveBitrate: false,
      drm: false,
    };
  }

  if (!args.capabilities) {
    // Text, files and resources: signed and short-lived, with no video
    // capabilities to report.
    return {
      tier: null,
      signedUrl: true,
      expiresInSeconds,
      boundToSession: false,
      boundToDevice: false,
      // A protected file's URL dies with its presign and cannot be
      // withdrawn earlier — stated rather than glossed over.
      revocableBeforeExpiry: false,
      originRestricted: false,
      watermark: false,
      adaptiveBitrate: false,
      drm: false,
    };
  }

  return {
    tier: args.tier,
    signedUrl: args.capabilities.signedPlayback,
    expiresInSeconds,
    boundToSession: args.capabilities.boundToSession,
    boundToDevice: args.capabilities.boundToDevice,
    revocableBeforeExpiry: args.capabilities.revocableBeforeExpiry,
    originRestricted: args.capabilities.originRestricted,
    // The academy must have asked for it AND the player must actually be
    // drawing one.
    watermark: args.watermarkEnabled,
    adaptiveBitrate: args.capabilities.adaptiveBitrate,
    // Neither tier has DRM, and Cloudflare Stream does not offer it at
    // all (D1). Typed as the literal `false` so it cannot drift.
    drm: false,
  };
}

/**
 * The overlay text.
 *
 * The academy's own template wins when it set one; otherwise the viewer's
 * user id, which is stable, unique, and — unlike an email address —
 * discloses nothing extra to anyone standing behind the learner.
 */
function buildWatermarkText(template: string | null, userId: string | null): string {
  if (template) return template;
  return userId ? `ID ${userId.slice(0, 8).toUpperCase()}` : '';
}

/**
 * Academy offline work — the server's answer to "may this browser keep this
 * lesson's text for offline reading" (see `OfflineReadingPermission`). Only
 * plain text, only for a signed-in learner's own read, never a preview.
 */
export function offlineReadingFor(args: {
  readonly kind: LessonContentKind;
  readonly hasVideo: boolean;
  readonly signedIn: boolean;
  readonly staffPreview: boolean;
  readonly now?: number;
}): OfflineReadingPermission {
  const allowed =
    args.kind === 'text' && !args.hasVideo && args.signedIn && !args.staffPreview;
  return {
    allowed,
    until: allowed
      ? new Date(
          (args.now ?? Date.now()) + OFFLINE_READING_TTL_SECONDS * 1000,
        ).toISOString()
      : null,
  };
}
