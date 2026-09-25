/**
 * VideoRetentionDeletionService — P64 Communications C6, the half that
 * destroys data. `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`
 * §31 "Execution".
 *
 * TWO JOB BODIES, both driven by the single `video-retention` processor:
 *
 *   `deleteAsset`   — one asset. Re-validate, delete at the provider,
 *                     VERIFY, and only then write the tombstone.
 *   `settleTenant`  — one tenant. Waits for that run's assets to settle
 *                     and emits D, honestly.
 *
 * ---------------------------------------------------------------------
 * THE ORDER IS THE SAFETY PROPERTY
 * ---------------------------------------------------------------------
 *
 * delete → VERIFY → tombstone. Never delete → tombstone, and never
 * tombstone → delete. A tombstone is Atlas telling a customer, and its own
 * quota accounting, and any future auditor, that these bytes are gone. If
 * the provider quietly refused and the row says `deleted`, the lesson
 * shows "removed after inactivity" while the file is still sitting there
 * being billed for — the customer has been told something false about
 * their own data, and nothing in the system will ever notice. So the
 * tombstone is written from POSITIVE EVIDENCE OF ABSENCE and from nothing
 * else. On exhaustion the asset stays `active` with `deletionFailedAt`
 * set, the Platform Owner is told, and a person decides.
 *
 * ---------------------------------------------------------------------
 * THE RACE WITH REACTIVATION RESOLVES IN FAVOUR OF THE CUSTOMER
 * ---------------------------------------------------------------------
 *
 * These jobs sit in a queue for seconds or, on a retry, minutes. In that
 * time a customer can pay. `revalidate` therefore re-derives the ENTIRE
 * decision from the live subscription row at execution time — inactive,
 * same anchor, past the deletion date, inside the horizon, unheld, all
 * four warnings present, flag still `on` — and any one of those failing
 * SKIPS the asset. Not fails: skips, quietly and permanently for this run.
 * A tenant who paid while their job was queued keeps their video.
 *
 * ---------------------------------------------------------------------
 * IDEMPOTENCE
 * ---------------------------------------------------------------------
 *
 * A 404 from the provider on delete is SUCCESS. The bytes being already
 * absent is the outcome being asked for; treating it as an error would
 * turn every retry of a partially-completed job into a permanent failure
 * and would leave `deletionFailedAt` on assets that are genuinely gone.
 * The verification step runs either way, so "it was already deleted" and
 * "we just deleted it" converge on the same tombstone.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../../communications/services/communication.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { VideoProviderRegistry } from '../../media/video/video-provider.registry';
import { ProtectedMediaStorage } from '../../media/storage/protected-media-storage.provider';
import type { VideoProvider } from '../../media/video/video-provider.interface';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import type {
  CommunicationsConfig,
  VideoRetentionMode,
} from '../../config/configuration';
import {
  VideoRetentionRepository,
  type RetentionAsset,
} from '../repositories/video-retention.repository';
import {
  evaluateRetentionSteps,
  resolveRetentionWindow,
  type RetentionEvaluationInput,
} from '../utils/video-retention.util';
import { toEvaluationInput } from './video-retention.service';
import {
  VIDEO_RETENTION_ASSET_ATTEMPTS,
  type VideoRetentionAssetJobPayload,
  type VideoRetentionTenantJobPayload,
} from '../queue/video-retention.types';

export type AssetDeletionOutcome = 'deleted' | 'skipped' | 'already_deleted';

/**
 * A 404 (or an object-store "no such key") means the thing we were asked
 * to remove is not there. That is the goal, not a failure.
 *
 * Matched on both a numeric status and the message, because the three
 * adapters surface it differently and none of them share an error type:
 * Cloudflare Stream throws from its own `request` helper, the S3 client
 * throws `NoSuchKey`/`NotFound`, and a future adapter will do something
 * else again.
 */
export function isProviderNotFound(error: unknown): boolean {
  if (!error) return false;
  const status =
    (error as { status?: number }).status ??
    (error as { statusCode?: number }).statusCode ??
    (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  if (status === 404) return true;
  const name = (error as { name?: string }).name ?? '';
  if (/^(NotFound|NoSuchKey|ResourceNotFound)/i.test(name)) return true;
  const message = error instanceof Error ? error.message : String(error);
  return (
    /\b404\b/.test(message) ||
    /not[\s_-]?found/i.test(message) ||
    /NoSuchKey/i.test(message)
  );
}

@Injectable()
export class VideoRetentionDeletionService {
  private readonly logger = new Logger(VideoRetentionDeletionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly repository: VideoRetentionRepository,
    private readonly communicationService: CommunicationService,
    private readonly auditLogWriter: AuditLogWriterService,
    private readonly videoProviders: VideoProviderRegistry,
    private readonly protectedStorage: ProtectedMediaStorage,
    private readonly usageRecompute: TenantUsageRecomputeProducer,
    private readonly configService: ConfigService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  private get mode(): VideoRetentionMode {
    return this.configService.getOrThrow<CommunicationsConfig>('communications')
      .videoRetentionMode;
  }

  // =====================================================================
  // ONE ASSET
  // =====================================================================

  /**
   * @param attemptsMade BullMQ's `job.attemptsMade` — used only to decide
   *   whether this failure is the one that escalates to the Platform
   *   Owner. Never to decide whether to delete.
   */
  async deleteAsset(
    payload: VideoRetentionAssetJobPayload,
    attemptsMade = 0,
    now: Date = this.clock.now(),
  ): Promise<AssetDeletionOutcome> {
    /*
      THE FLAG, RE-READ AT EXECUTION. Not a belt-and-braces check: a job
      enqueued while the mode was `on` can be drained minutes later after
      an operator set it back. `warn_only` and `off` must delete nothing,
      including work that is already in flight.
    */
    if (this.mode !== 'on') {
      this.logger.warn(
        { assetId: payload.assetId, mode: this.mode },
        'Video-retention deletion job reached the worker while the mode is not `on` — skipped, nothing deleted.',
      );
      return 'skipped';
    }

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return 'skipped';
    const actorUserId = platformOwner.id;

    const state = await this.tenancyContextService.runInUserContext(
      actorUserId,
      async (tx) => {
        const candidate = await this.repository.findCandidate(tx, payload.organizationId);
        const asset = await this.repository.findAsset(
          tx,
          payload.assetId,
          payload.organizationId,
        );
        if (!candidate || !asset) return null;
        const hold = await this.repository.resolveHold(
          tx,
          payload.organizationId,
          candidate.organization.lifecycleState ?? null,
        );
        const lifecycleInput = toEvaluationInput(candidate);
        const window = resolveRetentionWindow(lifecycleInput, now);
        const warningsAlreadySent = candidate.organization.owner
          ? await this.repository.findWarningsSent(
              tx,
              candidate.organization.owner.id,
              payload.organizationId,
              window?.anchorAt ?? new Date(payload.anchorAt),
            )
          : new Set<never>();
        return { candidate, asset, hold, lifecycleInput, window, warningsAlreadySent };
      },
    );

    if (!state) {
      this.logger.warn(
        { assetId: payload.assetId, organizationId: payload.organizationId },
        'Video-retention deletion job found no subscription or no asset — skipped.',
      );
      return 'skipped';
    }

    // A retry after a successful run: the tombstone is already there.
    if (state.asset.status === 'deleted') return 'already_deleted';

    const skipReason = this.revalidate(payload, state, now);
    if (skipReason) {
      this.logger.log(
        {
          assetId: payload.assetId,
          organizationId: payload.organizationId,
          reason: skipReason,
        },
        'Video-retention deletion skipped at execution time — the customer keeps their video.',
      );
      return 'skipped';
    }

    try {
      await this.destroyAndVerify(state.asset);
    } catch (error) {
      await this.recordFailure(
        payload,
        state.asset,
        error,
        attemptsMade,
        actorUserId,
        now,
      );
      // Rethrown so BullMQ retries. The asset is still `active`.
      throw error;
    }

    await this.writeTombstone(payload, state.asset, actorUserId, now);
    await this.usageRecompute
      .enqueueOne(payload.organizationId)
      .catch((error: unknown) => {
        // A stale usage figure is a display defect; failing the job here
        // would re-run a deletion that has already happened.
        this.logger.warn(
          { organizationId: payload.organizationId, error: String(error) },
          'Could not enqueue usage recompute after a retention deletion.',
        );
      });
    return 'deleted';
  }

  /**
   * Every reason this deletion must NOT happen, re-derived from live rows.
   * Returns the reason, or `null` when the deletion is still authorised.
   *
   * Order is chosen so the cheapest and most likely reason — the customer
   * came back — is named first in the log.
   */
  private revalidate(
    payload: VideoRetentionAssetJobPayload,
    state: {
      hold: { held: boolean; reason: string | null };
      lifecycleInput: ReturnType<typeof toEvaluationInput>;
      window: ReturnType<typeof resolveRetentionWindow>;
      warningsAlreadySent: ReadonlySet<string>;
      asset: RetentionAsset;
    },
    now: Date,
  ): string | null {
    if (!state.window) return 'tenant_reactivated';
    if (state.window.anchorAt.toISOString() !== payload.anchorAt) {
      // The anchor moved: the tenant paid and lapsed again, so this job
      // was authorised against a window that no longer exists.
      return 'anchor_moved';
    }
    if (state.hold.held) return `held:${state.hold.reason ?? 'unknown'}`;

    const input = {
      ...state.lifecycleInput,
      held: false,
      warningsAlreadySent: state.warningsAlreadySent,
    } as RetentionEvaluationInput;
    const due = evaluateRetentionSteps(input, now);
    if (!due.some((step) => step.step === 'retention_delete')) {
      // Covers every remaining case at once — before the date, past the
      // horizon, or the four warnings are not all there — because it is
      // the same function that authorised the job in the first place.
      return 'not_due_at_execution_time';
    }
    if (state.asset.status !== 'active') return `asset_status:${state.asset.status}`;
    return null;
  }

  /**
   * Delete at the provider and prove it. Throws unless absence was
   * positively established.
   */
  private async destroyAndVerify(asset: RetentionAsset): Promise<void> {
    const adapter = this.videoProviders.forProvider(asset.provider);
    const ref = providerRef(asset);

    try {
      await adapter.deleteAsset(ref);
    } catch (error) {
      if (!isProviderNotFound(error)) throw error;
      this.logger.log(
        { assetId: asset.id, ref },
        'Provider reported the asset as already absent on delete — treated as success.',
      );
    }

    const absent = await this.verifyAbsent(adapter, asset, ref);
    if (!absent) {
      throw new Error(
        `Video retention: ${asset.id} was not verifiably absent after deleteAsset — no tombstone written.`,
      );
    }
  }

  /**
   * POSITIVE EVIDENCE OF ABSENCE, per adapter.
   *
   * The probe is chosen by the ADAPTER's own identity, not by the asset's
   * `provider` column, and the distinction is the whole point:
   * `BasicVideoProvider.fetchAsset` returns `null` unconditionally — it
   * documents itself as having no remote asset API — so using it as an
   * absence probe would report every asset on that tier as verified
   * without asking anything. Its bytes live in the protected bucket, so
   * that is what gets probed instead.
   *
   *   `r2_worker`         → HEAD the protected object. Absent iff missing.
   *   `cloudflare_stream` → GET the asset. Absent iff the provider has no
   *                         record of it.
   *   `fake`              → its in-process record, which is a real
   *                         present-then-absent transition and is what the
   *                         test suite exercises.
   *
   * KNOWN LIMIT, recorded rather than papered over: both remote probes
   * currently swallow transport errors into "no asset", so a network
   * failure at exactly the wrong moment could read as absence. Closing
   * that means distinguishing 404 from 503 inside the two real adapters,
   * which is real-provider work this workstream is explicitly not the one
   * to do (BL-2). The local adapter's probe has no such gap, which is why
   * the guarantee is genuinely tested rather than merely asserted.
   */
  private async verifyAbsent(
    adapter: VideoProvider,
    asset: RetentionAsset,
    ref: string,
  ): Promise<boolean> {
    if (adapter.key === 'r2_worker') {
      const head = await this.protectedStorage.headObject(asset.storageKey);
      return head === null;
    }
    const remote = await adapter.fetchAsset(ref);
    return remote === null;
  }

  /** The tombstone and its audit row, in ONE transaction, in the tenant's own RLS context. */
  private async writeTombstone(
    payload: VideoRetentionAssetJobPayload,
    asset: RetentionAsset,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    const minutes = Math.round((asset.durationSeconds ?? 0) / 60);
    const changed = await this.tenancyContextService.runInTenantAndUserContext(
      payload.organizationId,
      actorUserId,
      async (tx) => {
        const count = await this.repository.writeTombstone(tx, {
          assetId: asset.id,
          organizationId: payload.organizationId,
          deletedAt: now,
          reason: payload.reason,
          bytesFreed: asset.sizeBytes,
        });
        if (count === 0) return 0;
        await this.auditLogWriter.write(tx, {
          actorUserId,
          organizationId: payload.organizationId,
          academyId: asset.academyId,
          role: 'platform_owner',
          action: 'media.video.deleted',
          targetType: 'media_asset',
          targetId: asset.id,
          targetLabel: asset.fileName,
          context: {
            assetId: asset.id,
            bytes: Number(asset.sizeBytes),
            minutes,
            reason: payload.reason,
          },
        });
        return count;
      },
    );

    if (changed === 0) {
      /*
        Zero rows changed means the UPDATE matched no row — another job
        tombstoned it first, or (the reason this is checked at all) RLS
        refused the write silently. An RLS-refused UPDATE does not raise;
        it affects nothing. The bytes are gone and the row does not say so,
        which is the one state worth shouting about.
      */
      this.logger.error(
        { assetId: asset.id, organizationId: payload.organizationId },
        'Video retention: the provider delete was verified but the tombstone UPDATE changed no row. The bytes are gone and the asset row does not record it.',
      );
      throw new Error(
        `Video retention: tombstone for ${asset.id} changed no row after a verified provider delete.`,
      );
    }
  }

  private async recordFailure(
    payload: VideoRetentionAssetJobPayload,
    asset: RetentionAsset,
    error: unknown,
    attemptsMade: number,
    actorUserId: string,
    now: Date,
  ): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    await this.tenancyContextService
      .runInTenantAndUserContext(payload.organizationId, actorUserId, (tx) =>
        this.repository.markDeletionFailed(tx, asset.id, payload.organizationId, now),
      )
      .catch((markError: unknown) => {
        this.logger.error(
          { assetId: asset.id, error: String(markError) },
          'Could not record deletionFailedAt for a failed retention deletion.',
        );
      });

    const isLastAttempt = attemptsMade + 1 >= VIDEO_RETENTION_ASSET_ATTEMPTS;
    this.logger.error(
      {
        assetId: asset.id,
        organizationId: payload.organizationId,
        attempt: attemptsMade + 1,
        of: VIDEO_RETENTION_ASSET_ATTEMPTS,
        error: message,
      },
      'Video-retention deletion attempt failed — the asset is still active and has NOT been tombstoned.',
    );
    if (!isLastAttempt) return;

    // K3 — a person has to look at this one.
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!owner) return;
    const emitted = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.communicationService.emit(tx, {
        key: 'retention.video.deletion_failed',
        recipientUserId: owner.id,
        organizationId: payload.organizationId,
        entity: { type: 'media_asset', id: asset.id },
        values: {
          anchorAt: payload.anchorAt,
          assetId: asset.id,
          organizationId: payload.organizationId,
          organizationName: '',
          provider: asset.provider,
          fileName: asset.fileName,
          attempts: VIDEO_RETENTION_ASSET_ATTEMPTS,
          lastError: message.slice(0, 500),
        },
      }),
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
  }

  // =====================================================================
  // ONE TENANT — the D email
  // =====================================================================

  /**
   * Emits §31's D once every asset of THIS run has settled.
   *
   * "Settled" means each asset is either a tombstone or carries
   * `deletionFailedAt`. While any is still in flight this throws, so
   * BullMQ retries it later — D must describe a finished state, and an
   * email that says "3 files were deleted" while two more are still being
   * retried would be wrong within the minute.
   *
   * If NOTHING was deleted, nothing is sent. A tenant whose every asset
   * was skipped because they reactivated must not receive a deletion
   * receipt for a deletion that did not happen.
   */
  async settleTenant(
    payload: VideoRetentionTenantJobPayload,
    now: Date = this.clock.now(),
  ): Promise<'sent' | 'deduped' | 'nothing_deleted' | 'pending'> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return 'nothing_deleted';
    const actorUserId = platformOwner.id;

    const state = await this.tenancyContextService.runInUserContext(
      actorUserId,
      async (tx) => {
        const candidate = await this.repository.findCandidate(tx, payload.organizationId);
        const settlement = await this.repository.settlement(
          tx,
          payload.organizationId,
          payload.assetIds,
        );
        return { candidate, settlement };
      },
    );

    if (state.settlement.pending.length > 0) {
      throw new Error(
        `Video retention: ${state.settlement.pending.length} asset(s) of ${payload.organizationId} have not settled yet.`,
      );
    }
    if (state.settlement.deleted.length === 0) return 'nothing_deleted';

    const owner = state.candidate?.organization.owner;
    if (!owner) return 'nothing_deleted';

    const deletedMinutes = state.settlement.deleted.reduce(
      (total, asset) => total + Math.round((asset.durationSeconds ?? 0) / 60),
      0,
    );
    const emitted = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.communicationService.emit(tx, {
        key: 'retention.video.deleted',
        recipientUserId: owner.id,
        organizationId: payload.organizationId,
        entity: { type: 'tenant_subscription', id: payload.organizationId },
        values: {
          anchorAt: payload.anchorAt,
          deletedCount: state.settlement.deleted.length,
          deletedMinutes,
          // The honesty this email exists for. Zero is the ordinary case
          // and the template says nothing about it; anything else is
          // stated plainly rather than rounded away.
          failedCount: state.settlement.failed.length,
          deletedAtDate: formatLifecycleInstant(now),
        },
      }),
    );
    await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    return emitted.created ? 'sent' : 'deduped';
  }
}

/**
 * Which identifier this asset's adapter expects.
 *
 * Cloudflare Stream owns a `uid` and stores it in `provider_id`. The R2
 * tiers have no provider-side identity at all — the schema says so — and
 * `BasicVideoProvider.deleteAsset` passes its argument straight to
 * `deleteObject`, i.e. it expects the object KEY. Getting this wrong would
 * ask the object store to delete a key that does not exist, get a cheerful
 * 404, and then fail verification — safe, but permanently stuck.
 */
function providerRef(asset: RetentionAsset): string {
  return asset.providerId ?? asset.storageKey;
}
