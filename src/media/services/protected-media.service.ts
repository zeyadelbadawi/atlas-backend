/**
 * Staff-facing uploads for the PROTECTED tier and for provider-hosted
 * video (master plan Phase 2 §D.1/§D.4/§D.5, §L).
 *
 * Two upload paths, because the two are genuinely different problems:
 *
 *   FILES (`uploadProtectedFile`) go through Atlas, like every other
 *   media upload already does, and land in the protected bucket with no
 *   public URL. These are lesson PDFs, worksheets and images inside a
 *   lesson body — small, and already covered by the existing base64
 *   bridge.
 *
 *   VIDEO (`createVideoUpload`) never touches the VPS. AD-1 is explicit
 *   that video bytes are not proxied through the backend, and a single
 *   VPS carrying a customer's video uploads would be the platform's
 *   capacity ceiling. The browser uploads straight to the provider using
 *   a one-shot URL Atlas asked for; Atlas holds only the identifier.
 *
 * QUOTA IS RESERVED BEFORE THE UPLOAD URL IS ISSUED, never after. An
 * upload that succeeded and then failed a quota check would leave bytes
 * with the provider that Atlas has to delete — and a tenant who ignores
 * the error keeps the video. Reserving first means the refusal happens
 * while there is still nothing to clean up. The reservation IS the
 * `media_assets` row: `processing_status = 'pending'` with
 * `duration_seconds` holding the declared maximum, which is what makes
 * "usage = ready minutes + active reservations" one SUM over one column.
 */
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import type { MediaAsset, Prisma, VideoSecurityTier } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';
import { VideoProviderRegistry } from '../video/video-provider.registry';
import { VideoTierService } from '../../plans/services/video-tier.service';
import { FeatureFlagsService } from '../../common/flags/feature-flags.service';
import { AcademyOriginsService } from '../video/academy-origins.service';
import { detectFileKind, sanitizeFileName } from '../utils/file-validation.util';
import { parseMp4Duration } from './video-duration.util';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import type { ProtectedMediaConfig } from '../../config/configuration';

/** Same rule as `MediaService.MANAGING_ROLES` — one definition of "may manage this academy's media". */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

export interface CreateVideoUploadInput {
  readonly fileName: string;
  /** The ceiling the uploader declares, and the amount Atlas reserves. */
  readonly maxDurationSeconds: number;
  /** Optional, but strongly preferred: it is what prefixes the object key and what attributes the webhook. */
  readonly courseId?: string;
}

export interface VideoUploadTicket {
  readonly assetId: string;
  readonly uploadUrl: string;
  readonly expiresAt: string;
  readonly reservedMinutes: number;
  /** The tier this asset was created under (AD-15) — a fact about the asset, not about the academy. */
  readonly securityTier: VideoSecurityTier;
  /** True when the provider has no webhook and the client must call the completion endpoint (D-4). */
  readonly requiresCompletionCall: boolean;
}

export interface UploadProtectedFileInput {
  readonly fileName: string;
  /** `data:` URI or bare base64 — the same bridge `MediaService.upload` accepts. */
  readonly file: string;
  readonly courseId?: string;
}

@Injectable()
export class ProtectedMediaService {
  private readonly logger = new Logger(ProtectedMediaService.name);
  private readonly config: ProtectedMediaConfig;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly storage: ProtectedMediaStorage,
    private readonly videoProviders: VideoProviderRegistry,
    private readonly videoTierService: VideoTierService,
    private readonly featureFlags: FeatureFlagsService,
    private readonly originsService: AcademyOriginsService,
    private readonly metrics: LearningMetricsService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<ProtectedMediaConfig>('protectedMedia');
  }

  async uploadProtectedFile(
    academyId: string,
    organizationId: string,
    userId: string,
    input: UploadProtectedFileInput,
  ): Promise<MediaAsset> {
    const buffer = decodeBase64Payload(input.file);
    if (buffer.length > this.config.maxUploadBytes) {
      throw new BadRequestException({
        messageKey: 'errors.media.fileTooLarge',
        details: { maxBytes: this.config.maxUploadBytes },
      });
    }
    // Real magic-byte detection, not the declared extension — the same
    // validator the public tier uses, so a "protected" upload is not a
    // weaker path into the platform's storage.
    const kind = detectFileKind(buffer);
    if (!kind) {
      throw new BadRequestException({ messageKey: 'errors.media.unsupportedFileType' });
    }

    // Authorization and the storage entitlement BEFORE any real I/O,
    // extending `MediaService.upload`'s own established rule: an
    // unauthorized or over-limit caller must never cause a real write.
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.entitlementEnforcementService.assertStorageWithinLimit(
        tx,
        organizationId,
        kind.assetType === 'video' ? 'videoStorage' : 'generalStorage',
        buffer.length,
      );
    });

    const id = randomUUID();
    const storageKey = ProtectedMediaStorage.objectKey({
      academyId,
      courseId: input.courseId,
      assetId: id,
      extension: kind.extension,
    });
    await this.storage.putObject(storageKey, buffer, kind.mimeType);

    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.mediaAsset.create({
          data: {
            id,
            academyId,
            type: kind.assetType,
            fileName: sanitizeFileName(input.fileName),
            storageKey,
            // No durable URL exists for a protected object, and inventing
            // one would be the exact mistake this tier removes. The empty
            // string says "there is no public address" rather than
            // pretending there is; every read goes through a presign.
            url: '',
            mimeType: kind.mimeType,
            sizeBytes: BigInt(buffer.length),
            access: 'protected',
            provider: 'r2',
            processingStatus: 'ready',
            courseId: input.courseId ?? null,
          },
        }),
    );

    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
    return asset;
  }

  async createVideoUpload(
    academyId: string,
    organizationId: string,
    userId: string,
    input: CreateVideoUploadInput,
  ): Promise<VideoUploadTicket> {
    if (!Number.isInteger(input.maxDurationSeconds) || input.maxDurationSeconds <= 0) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }

    // Rounded UP, matching how usage is counted — a 90-second video
    // reserves two minutes, so the reservation and the usage figure can
    // never disagree about the same asset.
    const reservedMinutes = Math.ceil(input.maxDurationSeconds / 60);
    const assetId = randomUUID();

    const { origins, tier } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        // D10 — the tier this academy's NEW uploads land on, resolved from
        // the plan family and the academy's own choice. Nothing here names
        // a provider: the registry one layer down owns that mapping, which
        // is what keeps `premium` from being hard-wired to a provider
        // class in the authorization layer.
        const resolved = await this.videoTierService.resolve(tx, {
          academyId,
          organizationId,
        });
        const tierProvider = this.videoProviders.forTier(resolved.tier);

        // Phase 2 §S — the per-academy rollout flag for THIS tier. Kept
        // separate per tier because the Normal tier can canary immediately
        // while Premium waits for provider onboarding (DL-19).
        const flag = resolved.tier === 'premium' ? 'videoPremium' : 'videoNormal';
        if (!this.featureFlags.isEnabledForAcademy(flag, academyId)) {
          throw new ForbiddenException({ messageKey: 'errors.media.videoNotEnabled' });
        }
        if (!this.videoProviders.isTierAvailable(resolved.tier)) {
          throw new ForbiddenException({ messageKey: 'errors.media.videoNotEnabled' });
        }
        if (input.courseId) {
          const course = await tx.course.findFirst({
            where: { id: input.courseId, academyId },
            select: { id: true },
          });
          // A course id from another academy would put this academy's
          // video under that academy's key prefix and metadata.
          if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        await this.entitlementEnforcementService.assertVideoMinutesWithinQuota(
          tx,
          organizationId,
          reservedMinutes,
        );

        // The RESERVATION, written inside the same transaction that
        // checked the quota. Doing it after the provider call would leave
        // a window in which two uploads both pass a check neither has
        // consumed yet.
        await tx.mediaAsset.create({
          data: {
            id: assetId,
            academyId,
            type: 'video',
            fileName: sanitizeFileName(input.fileName),
            // No object of Atlas's own: the provider holds the bytes.
            storageKey: '',
            url: '',
            mimeType: 'video/mp4',
            sizeBytes: BigInt(0),
            access: 'protected',
            // FINDING D-1. This was the hardcoded literal
            // `'cloudflare_stream'`, so the column recorded a constant
            // rather than a fact — with `VIDEO_PROVIDER=fake` the row
            // still claimed Cloudflare. Playback resolves the adapter
            // from exactly this column (AD-7), so a column that lies
            // routes an asset to the wrong edge.
            provider: tierProvider.storedAs,
            // AD-15 — what Atlas PROMISED for this asset, recorded once at
            // creation and never rewritten when the academy's plan
            // changes (D11).
            // `resolved.tier`, NOT the outer `tier` binding: this runs
            // inside the callback that PRODUCES that binding, so the
            // outer `const` is still in its temporal dead zone here and
            // referencing it throws `ReferenceError` at runtime. The
            // reference sits inside a closure, so TypeScript cannot see
            // it — the whole upload path was dead and the typecheck was
            // green. Found in review; keep this comment, the mistake is
            // easy to reintroduce.
            securityTier: resolved.tier,
            processingStatus: 'pending',
            // A RESERVED maximum, not a measurement: `durationSource`
            // stays null until the real figure is known (D5).
            durationSeconds: reservedMinutes * 60,
            courseId: input.courseId ?? null,
          },
        });

        return {
          origins: await this.originsService.forAcademy(tx, academyId),
          tier: resolved.tier,
        };
      },
    );

    // Resolved AFTER the tier, and by the tier — never from a
    // process-wide setting. This is the upload half of AD-7's two axes.
    const provider = this.videoProviders.forTier(tier);

    try {
      const upload = await provider.createDirectUpload({
        maxDurationSeconds: input.maxDurationSeconds,
        allowedOrigins: origins,
        // Opaque to the provider; Atlas uses them to attribute the webhook
        // and to refuse a cross-academy token later (Phase 2 §H).
        metadata: {
          academyId,
          ...(input.courseId ? { courseId: input.courseId } : {}),
          assetId,
        },
      });

      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        tx.mediaAsset.update({
          where: { id: assetId },
          data: { providerId: upload.providerId, processingStatus: 'processing' },
        }),
      );
      await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);

      return {
        assetId,
        uploadUrl: upload.uploadUrl,
        expiresAt: upload.expiresAt.toISOString(),
        reservedMinutes,
        securityTier: tier,
        // FINDING D-4 — an adapter with no webhook will never be told the
        // upload finished, so the client has to say so. Reported here
        // rather than inferred, so the uploader knows which call to make.
        requiresCompletionCall: !provider.capabilities().reportsReadinessAsynchronously,
      };
    } catch (error) {
      // RELEASE THE RESERVATION. The quota was consumed for an upload that
      // never started; leaving the row would permanently deduct minutes
      // the tenant never used, and a tenant cannot see or delete a
      // reservation themselves.
      await this.releaseReservation(organizationId, assetId);
      throw error;
    }
  }

  /**
   * Finalises an upload for a provider that has no webhook (finding D-4,
   * §D.4).
   *
   * WHY A SECOND CALL AT ALL. Cloudflare Stream tells Atlas when a video
   * finished processing. An object in Atlas's own bucket tells nobody
   * anything — the PUT completes at the browser, and the server never
   * hears about it. Without this endpoint a Normal-tier asset would sit
   * at `processing` forever and `LessonContentService` would refuse to
   * sign it, so every Normal upload would be invisible to learners.
   *
   * WHAT IT VERIFIES, rather than believes:
   *   - the object actually landed (a `HEAD`, not the client's word);
   *   - its real duration, parsed from the container's own metadata.
   *     The declared figure is only kept when parsing genuinely fails,
   *     and the provenance is recorded either way so an operator can see
   *     how much of the quota rests on an uploader's word (D5).
   *
   * Idempotent: completing an already-ready asset re-reads and returns
   * rather than erroring, because a client that retried a timed-out call
   * has done nothing wrong.
   */
  async completeVideoUpload(
    academyId: string,
    organizationId: string,
    userId: string,
    assetId: string,
  ): Promise<MediaAsset> {
    const asset = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const row = await tx.mediaAsset.findFirst({ where: { id: assetId, academyId } });
        if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return row;
      },
    );

    if (asset.processingStatus === 'ready') return asset;
    if (!asset.providerId) {
      throw new BadRequestException({ messageKey: 'errors.media.uploadNotStarted' });
    }

    const provider = this.videoProviders.forProvider(asset.provider);
    if (provider.capabilities().reportsReadinessAsynchronously) {
      // A provider that reports readiness itself must not be short-circuited
      // by a client claiming the upload is done — that would let an
      // uploader mark an asset ready before the provider had finished
      // processing it, and the first learner would get a broken player.
      throw new BadRequestException({
        messageKey: 'errors.media.completionNotApplicable',
      });
    }

    const head = await this.storage.headObject(asset.providerId);
    if (!head || head.sizeBytes <= 0) {
      throw new BadRequestException({ messageKey: 'errors.media.uploadNotFound' });
    }

    const measured = await this.resolveDuration(asset.providerId, asset.durationSeconds);

    // AD-14's SECOND enforcement point: "enforcement happens before a
    // direct-upload URL is issued AND AGAIN when the provider reports the
    // real duration."
    //
    // This is not belt-and-braces. `BasicVideoProvider` reports
    // `enforcesMaxDuration: false` because a presigned PUT can bound
    // `Content-Length` but not runtime minutes — so an uploader can
    // declare one minute, reserve one minute, and upload three hours.
    // Without this check the over-run would simply be written into the
    // quota and the tenant would be over their entitlement with nothing
    // refused anywhere.
    //
    // Only the DELTA is charged: the reservation already consumed what
    // was declared, so re-checking the whole duration would double-count
    // it and refuse an upload that actually fits.
    const reservedMinutes = Math.ceil((asset.durationSeconds ?? 0) / 60);
    const measuredMinutes = Math.ceil(measured.durationSeconds / 60);
    const overrunMinutes = Math.max(0, measuredMinutes - reservedMinutes);
    if (overrunMinutes > 0) {
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        this.entitlementEnforcementService.assertVideoMinutesWithinQuota(
          tx,
          organizationId,
          overrunMinutes,
        ),
      );
    }

    const updated = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        tx.mediaAsset.update({
          where: { id: assetId },
          data: {
            processingStatus: 'ready',
            sizeBytes: BigInt(head.sizeBytes),
            durationSeconds: measured.durationSeconds,
            durationSource: measured.source,
          },
        }),
    );

    // The lesson's own duration is the watched-ratio denominator, so it
    // must match the real video — but only where an author has not set
    // one deliberately.
    await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      tx.courseLesson.updateMany({
        where: { videoAssetId: assetId, durationSeconds: null },
        data: { durationSeconds: measured.durationSeconds },
      }),
    );

    // The reservation held a declared maximum; the real figure may be
    // smaller, so usage can legitimately go DOWN here. That is D5's
    // reconciliation step.
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
    this.metrics.recordUploadCompletion(asset.securityTier ?? 'normal', true);
    // §D.5 — a rise in `declared` is the signal that the quota is
    // drifting toward self-reported, which D5 says must never happen
    // silently. It is a metric because it is a trend, not an event.
    this.metrics.recordDurationProvenance(measured.source);
    return updated;
  }

  /**
   * The real duration, or an honest record that it could not be measured.
   *
   * Never silently trusts the declared value: when parsing fails the
   * declared figure is kept *and labelled* `declared`, which is what makes
   * the drift visible in the duration-provenance metric rather than
   * invisible in the quota.
   */
  private async resolveDuration(
    objectKey: string,
    reservedSeconds: number | null,
  ): Promise<{
    readonly durationSeconds: number;
    readonly source: 'parsed' | 'declared';
  }> {
    // 512 KB: comfortably more than a faststart `moov` needs, small
    // enough that it is one cheap ranged read rather than a download.
    const head = await this.storage.readHead(objectKey, 512 * 1024);
    const parsed = head ? parseMp4Duration(head) : null;
    if (parsed) {
      return { durationSeconds: parsed.durationSeconds, source: 'parsed' };
    }
    this.logger.warn(
      { objectKey },
      'Could not parse a duration from the uploaded video; keeping the declared value and recording it as such.',
    );
    return { durationSeconds: reservedSeconds ?? 0, source: 'declared' };
  }

  /** Marks a failed reservation as `failed` so it stops counting against the quota. */
  private async releaseReservation(
    organizationId: string,
    assetId: string,
  ): Promise<void> {
    try {
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        tx.mediaAsset.update({
          where: { id: assetId },
          data: { processingStatus: 'failed', status: 'archived' },
        }),
      );
      await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
    } catch (error) {
      this.logger.error(
        { assetId, error: error instanceof Error ? error.message : String(error) },
        'Could not release a video-upload reservation; quota may be overstated until reconciliation.',
      );
    }
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.media.insufficientRole' });
    }
  }
}

/** Accepts a `data:` URI or bare base64, exactly like the public upload bridge. */
function decodeBase64Payload(value: string): Buffer {
  const comma = value.indexOf(',');
  const base64 = value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
  return Buffer.from(base64, 'base64');
}
