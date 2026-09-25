/**
 * VideoRetentionService — P64 Communications C6, the sweep-driven half of
 * `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md` §31/§32.
 *
 * One tick every fifteen minutes asks, for each candidate organisation,
 * "which retention steps are due right now?" and acts on the answer. It
 * sends the W1-W4 warnings itself; it never deletes anything. The
 * destructive work is a separate BullMQ job per asset, and this service's
 * last act for a tenant that has crossed its date is to ENQUEUE those
 * jobs — which then re-ask this same question before touching a byte.
 *
 * NOTHING IS SCHEDULED AHEAD, exactly as C5. A customer who pays stops
 * satisfying the condition on the next tick; there is no table of future
 * deletions to revoke. The one thing that does sit in a queue is the
 * per-asset job, and its first action is a full re-validation
 * (`VideoRetentionDeletionService`), so even that window is closed.
 *
 * THE FLAG. `FLAG_VIDEO_RETENTION_MODE` is `off` unless someone sets it.
 * `warn_only` runs everything in this file and refuses to enqueue a single
 * deletion job — it is not a dry run, the warnings are real, and it is
 * meant to be left on for a full retention window before `on` is
 * considered. Because the destructive step additionally requires all four
 * warnings to already exist (guard (2) in `video-retention.util.ts`), a
 * platform that has only ever run `warn_only` cannot delete anything on
 * the day it switches to `on` — the earliest possible deletion is thirty
 * days after the first W1 actually went out.
 *
 * CONTEXT. Reads run under a real platform-owner user context, C5's and
 * `SubscriptionExpiryService`'s established precedent, never
 * `runWithoutContext`.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../../communications/services/communication.service';
import type { CommunicationEventKey } from '../../communications/catalog/communication-catalog';
import type {
  CommunicationsConfig,
  VideoRetentionMode,
} from '../../config/configuration';
import { PLANS_CLOCK, type Clock } from '../../plans/utils/clock';
import { formatLifecycleInstant } from '../../plans/services/tenant-lifecycle.service';
import { SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE } from '../../plans/queue/subscription-sweep.types';
import {
  VideoRetentionRepository,
  type RetentionCandidate,
  type RetentionTally,
} from '../repositories/video-retention.repository';
import {
  evaluateRetentionSteps,
  resolveRetentionWindow,
  RETENTION_WARNING_STEPS,
  type DueRetentionStep,
  type RetentionEvaluationInput,
  type RetentionStepId,
} from '../utils/video-retention.util';
import { VideoRetentionProducer } from '../queue/video-retention.producer';
import {
  VIDEO_RETENTION_MAX_ASSETS_PER_TICK,
  VIDEO_RETENTION_MAX_ORGS_PER_TICK,
} from '../queue/video-retention.types';

/** Anonymised accounts keep a row but must never be mailed — the dispatcher's own rule, applied a layer earlier. */
const ANONYMISED_EMAIL_DOMAIN = '@account.invalid';

/**
 * How many course titles W2 names before it stops listing them.
 *
 * An academy with four hundred courses does not need four hundred lines;
 * it needs to recognise the ones it cares about and a count for the rest.
 */
const MAX_LISTED_COURSES = 10;

const STEP_EVENT_KEY: Record<RetentionStepId, CommunicationEventKey | null> = {
  retention_warning_30d: 'retention.video.warning_30d',
  retention_warning_14d: 'retention.video.warning_14d',
  retention_warning_7d: 'retention.video.warning_7d',
  retention_warning_24h: 'retention.video.warning_24h',
  // Not an email. The deletion step enqueues work; D is emitted by the
  // tenant-level job once the work has actually settled, because an email
  // that says "deleted" before anything was deleted is exactly the lie
  // this workstream exists to prevent.
  retention_delete: null,
};

export interface VideoRetentionSweepResult {
  readonly mode: VideoRetentionMode;
  readonly organizationsEvaluated: number;
  readonly organizationsHeld: number;
  readonly warningsEmitted: number;
  readonly warningsDeduped: number;
  readonly tenantsScheduledForDeletion: number;
  readonly assetsEnqueued: number;
}

@Injectable()
export class VideoRetentionService {
  private readonly logger = new Logger(VideoRetentionService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly repository: VideoRetentionRepository,
    private readonly communicationService: CommunicationService,
    private readonly producer: VideoRetentionProducer,
    private readonly configService: ConfigService,
    @Inject(PLANS_CLOCK) private readonly clock: Clock,
  ) {}

  get mode(): VideoRetentionMode {
    return this.configService.getOrThrow<CommunicationsConfig>('communications')
      .videoRetentionMode;
  }

  /** One sweep tick. Directly callable by the processor and by tests. */
  async run(now: Date = this.clock.now()): Promise<VideoRetentionSweepResult> {
    const mode = this.mode;
    const result: {
      mode: VideoRetentionMode;
      organizationsEvaluated: number;
      organizationsHeld: number;
      warningsEmitted: number;
      warningsDeduped: number;
      tenantsScheduledForDeletion: number;
      assetsEnqueued: number;
    } = {
      mode,
      organizationsEvaluated: 0,
      organizationsHeld: 0,
      warningsEmitted: 0,
      warningsDeduped: 0,
      tenantsScheduledForDeletion: 0,
      assetsEnqueued: 0,
    };
    if (mode === 'off') return result;

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn(
        'No platform owner account exists yet — skipping video-retention evaluation.',
      );
      return result;
    }
    const actorUserId = platformOwner.id;

    let cursor: string | undefined;
    let assetBudget = VIDEO_RETENTION_MAX_ASSETS_PER_TICK;
    for (;;) {
      const remaining = VIDEO_RETENTION_MAX_ORGS_PER_TICK - result.organizationsEvaluated;
      if (remaining <= 0) {
        this.logger.warn(
          { ceiling: VIDEO_RETENTION_MAX_ORGS_PER_TICK },
          'Video-retention evaluation hit its per-tick ceiling — the remainder is evaluated on the next tick, not skipped.',
        );
        break;
      }
      const take = Math.min(remaining, SUBSCRIPTION_SWEEP_QUERY_PAGE_SIZE);
      const page = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
        this.repository.findCandidates(tx, now, cursor, take),
      );
      if (page.length === 0) break;

      for (const candidate of page) {
        result.organizationsEvaluated++;
        const one = await this.evaluateOne(
          candidate,
          now,
          actorUserId,
          mode,
          assetBudget,
        );
        if (one.held) result.organizationsHeld++;
        result.warningsEmitted += one.emitted;
        result.warningsDeduped += one.deduped;
        result.tenantsScheduledForDeletion += one.scheduled ? 1 : 0;
        result.assetsEnqueued += one.assetsEnqueued;
        assetBudget -= one.assetsEnqueued;
      }

      cursor = page[page.length - 1].organizationId;
      if (page.length < take) break;
    }

    if (result.warningsEmitted > 0 || result.assetsEnqueued > 0) {
      this.logger.log(result, 'Video-retention tick complete.');
    }
    return result;
  }

  private async evaluateOne(
    candidate: RetentionCandidate,
    now: Date,
    actorUserId: string,
    mode: VideoRetentionMode,
    assetBudget: number,
  ): Promise<{
    held: boolean;
    emitted: number;
    deduped: number;
    scheduled: boolean;
    assetsEnqueued: number;
  }> {
    const counts = {
      held: false,
      emitted: 0,
      deduped: 0,
      scheduled: false,
      assetsEnqueued: 0,
    };
    const organizationId = candidate.organizationId;

    /*
      RECIPIENT FIRST. An organisation whose owner account is deleted,
      suspended-into-deletion or anonymised cannot be warned — and a
      customer who cannot be warned must never be deleted. Returning here
      is therefore not only about not sending mail: it is the first of the
      several independent reasons such a tenant is unreachable by the
      destructive step (guard (2) would also refuse it, because no
      warnings exist).
    */
    const owner = candidate.organization.owner;
    if (
      !owner ||
      owner.deletedAt !== null ||
      owner.status === 'deleted' ||
      owner.email.toLowerCase().endsWith(ANONYMISED_EMAIL_DOMAIN)
    ) {
      return counts;
    }

    const lifecycleInput = toEvaluationInput(candidate);
    const window = resolveRetentionWindow(lifecycleInput, now);
    if (!window) return counts;

    const hold = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.repository.resolveHold(
        tx,
        organizationId,
        candidate.organization.lifecycleState ?? null,
      ),
    );
    if (hold.held) {
      counts.held = true;
      this.logger.log(
        { organizationId, reason: hold.reason, deletionAt: window.deletionAt },
        'Video retention is frozen for this organisation — no warning and no deletion.',
      );
      return counts;
    }

    /*
      Guard (2)'s evidence is only fetched once the deletion date has
      actually passed. Before then the destructive step cannot be due
      whatever the answer is (`isWithinRetentionWindow` requires
      `now >= deletionAt`), so asking would be one query per organisation
      per tick, forever, to reach a foregone conclusion.
    */
    const warningsAlreadySent =
      now.getTime() >= window.deletionAt.getTime()
        ? await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
            this.repository.findWarningsSent(
              tx,
              owner.id,
              organizationId,
              window.anchorAt,
            ),
          )
        : new Set<RetentionStepId>();

    const input: RetentionEvaluationInput = {
      ...lifecycleInput,
      held: false,
      warningsAlreadySent,
    };
    const due = evaluateRetentionSteps(input, now);
    if (due.length === 0) return counts;

    const warnings = due.filter((step) => step.step !== 'retention_delete');
    const deletion = due.find((step) => step.step === 'retention_delete');

    // The tally is one query, paid only when something is actually going
    // to be said or done with it.
    const tally = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.repository.tally(tx, organizationId),
    );

    for (const step of warnings) {
      const key = STEP_EVENT_KEY[step.step];
      if (!key) continue;
      const emitted = await this.tenancyContextService.runInUserContext(
        actorUserId,
        (tx) =>
          this.communicationService.emit(tx, {
            key,
            recipientUserId: owner.id,
            organizationId,
            entity: { type: 'tenant_subscription', id: organizationId },
            values: buildWarningValues(step, tally),
          }),
      );
      if (emitted.created) counts.emitted++;
      else counts.deduped++;
      await this.communicationService.enqueueAfterCommit(emitted.outboxId);
    }

    // Recorded for the owner dashboard and the Platform Owner's retention
    // view whether or not a deletion is due today — the date is what the
    // customer needs to see from W1 onward, not only on the last day.
    await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.repository.setDeletionScheduledAt(tx, organizationId, window.deletionAt),
    );

    if (!deletion) return counts;

    /*
      THE DESTRUCTIVE BRANCH.

      `warn_only` stops here, and that is the whole point of the mode: the
      evaluator said the date has passed and all four warnings went out,
      and nothing is enqueued anyway. Nothing downstream can be reached by
      accident, because the per-asset job re-reads this same flag before it
      calls the provider.
    */
    if (mode !== 'on') {
      this.logger.log(
        {
          organizationId,
          deletionAt: window.deletionAt.toISOString(),
          assetCount: tally.assetCount,
          mode,
        },
        'Video retention: deletion is due but the mode is warn_only — nothing enqueued, nothing deleted.',
      );
      return counts;
    }

    if (assetBudget <= 0) {
      this.logger.warn(
        { organizationId },
        'Video-retention asset ceiling reached for this tick — this organisation is deferred to the next tick.',
      );
      return counts;
    }

    const assets = await this.tenancyContextService.runInUserContext(actorUserId, (tx) =>
      this.repository.findDeletableAssets(tx, organizationId, assetBudget),
    );
    if (assets.length === 0) return counts;

    for (const asset of assets) {
      await this.producer.enqueueAsset({
        assetId: asset.id,
        organizationId,
        anchorAt: window.anchorAt.toISOString(),
        reason: `retention_${window.origin}`,
      });
    }
    await this.producer.enqueueTenantSettlement({
      organizationId,
      anchorAt: window.anchorAt.toISOString(),
      assetIds: assets.map((asset) => asset.id),
    });

    counts.scheduled = true;
    counts.assetsEnqueued = assets.length;
    this.logger.log(
      {
        organizationId,
        anchorAt: window.anchorAt.toISOString(),
        assets: assets.length,
        origin: window.origin,
      },
      'Video retention: deletion enqueued after the complete four-warning sequence.',
    );
    return counts;
  }
}

/**
 * The interpolation values for one warning.
 *
 * `anchorAt` is the ISO instant and is the ONLY value the dedupe key
 * reads; the dated strings beside it are copy. That separation is C5's and
 * it matters for the same reason: changing how a date is rendered must
 * never change an idempotency key, and here an idempotency key that moved
 * would re-send a deletion warning.
 */
function buildWarningValues(
  step: DueRetentionStep,
  tally: RetentionTally,
): Record<string, unknown> {
  const listed = tally.courseTitles.slice(0, MAX_LISTED_COURSES);
  const remainder = tally.courseTitles.length - listed.length;
  const courseList =
    listed.length === 0
      ? ''
      : remainder > 0
        ? `${listed.join(', ')} (+${remainder} more)`
        : listed.join(', ');
  return {
    anchorAt: step.anchorAt.toISOString(),
    anchorAtDate: formatLifecycleInstant(step.anchorAt),
    deletionAtDate: formatLifecycleInstant(step.deletionAt),
    origin: step.origin,
    videoCount: tally.assetCount,
    videoMinutes: tally.totalMinutes,
    courseCount: tally.courseTitles.length,
    courseList,
  };
}

/**
 * The candidate row as the pure evaluator wants it.
 *
 * The cancellation KIND is load-bearing here for a reason C5 does not
 * have: it decides which retention WINDOW applies. `markTrialCancelled`
 * and `markCancelledAtPeriodEnd` both write the same `cancelled` status,
 * and §31 gives those two customers 90 days and 180 days respectively.
 * `subscription_cancellations.kind` is the only fact that separates them,
 * so getting it wrong would delete a paying customer's video three months
 * early.
 */
export function toEvaluationInput(candidate: RetentionCandidate): {
  subscription: {
    status: RetentionCandidate['status'];
    trialEndsAt: Date | null;
    currentPeriodEnd: Date | null;
    graceEndsAt: Date | null;
    cancelAtPeriodEnd: boolean;
  };
  trialCancelledAt: Date | null;
  paidCancelledAt: Date | null;
} {
  const cancellations = candidate.organization.cancellations;
  return {
    subscription: {
      status: candidate.status,
      trialEndsAt: candidate.trialEndsAt,
      currentPeriodEnd: candidate.currentPeriodEnd,
      graceEndsAt: candidate.graceEndsAt,
      cancelAtPeriodEnd: candidate.cancelAtPeriodEnd,
    },
    trialCancelledAt:
      cancellations.find((row) => row.kind === 'trial')?.effectiveAt ?? null,
    paidCancelledAt:
      cancellations.find((row) => row.kind === 'paid')?.effectiveAt ?? null,
  };
}

export { RETENTION_WARNING_STEPS };
