/**
 * RecordingQuotaService — the ONE place a recorded session is ever charged
 * against the organization's `recordedSessions` allowance.
 *
 * WHAT IS BEING COUNTED, AND WHAT IS NOT. The unit is a recorded SESSION,
 * never a recording file. Zoom routinely produces several files for one
 * meeting (shared screen, active speaker, audio-only, transcript); all of
 * them hang off ONE `live_session_recordings` row, and `live_session_id`
 * is UNIQUE on that table, so the arithmetic cannot drift no matter how
 * many files arrive. Unrecorded sessions are not counted at all — they are
 * gated by the `liveSessions` FEATURE, which is a different question.
 *
 * WHY THE OBVIOUS IMPLEMENTATION IS WRONG. "Count the rows, compare to the
 * limit, insert" is a textbook check-then-act race: two recordings
 * starting in the same instant both read 4-of-5, both conclude there is
 * room, and both insert. The customer ends up at 6/5 and the plan has been
 * quietly oversold. Nothing about running the three statements inside one
 * transaction fixes this on its own — under Postgres's default READ
 * COMMITTED they simply do not see each other's uncommitted insert.
 *
 * HOW THIS CLOSES IT. Before counting, the transaction takes a row-level
 * lock on the organization's own `tenant_subscriptions` row:
 *
 *     SELECT 1 FROM tenant_subscriptions
 *      WHERE organization_id = $1 FOR UPDATE
 *
 * That row is the natural serialization point — it is the thing that
 * defines the allowance, exactly one exists per organization (PK = FK),
 * and every recording start for that organization must pass through it.
 * The second concurrent request blocks until the first commits, then
 * counts and sees the truth. Concurrency is serialized per organization
 * and nowhere else, so two different tenants never contend.
 *
 * This deliberately reuses an existing row rather than introducing a
 * counter table or an advisory-lock convention: it is the smallest correct
 * mechanism that fits the schema already here.
 *
 * IDEMPOTENCY IS SEPARATE FROM LOCKING, and both are needed. The lock stops
 * two DIFFERENT sessions from overspending; `quota_consumed_at` stops the
 * SAME session from being charged twice when a provider redelivers
 * `recording.started`, when a host stops and restarts recording mid-meeting,
 * or when a retry replays the call. A session already carrying a
 * consumption timestamp is a no-op, not a second charge.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { EntitlementService } from '../../plans/services/entitlement.service';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';
import type {
  EntitlementAddOnInput,
  LimitValue,
} from '../../plans/dto/entitlement.types';

/** Stable codes the frontend switches on, matching the existing entitlement vocabulary. */
export const RECORDING_QUOTA_EXCEEDED_CODE = 'RECORDING_QUOTA_EXCEEDED';
export const RECORDING_NOT_ENTITLED_CODE = 'RECORDING_NOT_ENTITLED';

export interface RecordingQuotaUsage {
  readonly used: number;
  readonly limit: LimitValue;
  /** `null` when the limit is `'unlimited'` — never a sentinel number. */
  readonly remaining: number | null;
}

@Injectable()
export class RecordingQuotaService {
  private readonly logger = new Logger(RecordingQuotaService.name);

  constructor(
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly entitlementService: EntitlementService,
  ) {}

  /**
   * Read-only usage, for dashboards and the session form.
   *
   * Takes no lock: a displayed number may be a moment stale without
   * consequence, and blocking a dashboard read behind a write lock would
   * be a real cost for no benefit. The authoritative decision happens in
   * {@link consumeForSession}, never here.
   */
  async describeUsage(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<RecordingQuotaUsage> {
    const limit = await this.resolveLimit(tx, organizationId);
    const used = await this.countConsumed(tx, organizationId);
    return {
      used,
      limit,
      remaining: limit === 'unlimited' ? null : Math.max(0, limit - used),
    };
  }

  /**
   * Charges ONE recorded session, or refuses.
   *
   * MUST be called inside the caller's existing transaction — the lock it
   * takes is only meaningful for as long as that transaction lives, and
   * committing before the recording row is written would reopen the race
   * it exists to close.
   *
   * @returns `true` when this call consumed the quota, `false` when the
   *          session had already consumed it (a duplicate event, not an
   *          error).
   */
  async consumeForSession(
    tx: Prisma.TransactionClient,
    args: {
      readonly organizationId: string;
      readonly liveSessionId: string;
      readonly academyId: string;
      readonly providerRecordingId?: string;
    },
  ): Promise<boolean> {
    const { organizationId, liveSessionId, academyId } = args;

    // Idempotency first, and cheaply: a redelivered `recording.started`
    // for a session already charged must not even take the lock.
    const existing = await tx.liveSessionRecording.findUnique({
      where: { liveSessionId },
      select: { id: true, quotaConsumedAt: true },
    });
    if (existing?.quotaConsumedAt) return false;

    /*
      THE SERIALIZATION POINT. Everything below runs while this
      organization's subscription row is locked, so a concurrent recording
      start for the same organization waits here rather than racing us to
      the same allowance. `$queryRaw` because Prisma has no first-class
      `FOR UPDATE`; parameterized, never interpolated.
    */
    // No `::uuid` cast: Prisma maps `String` ids to TEXT columns in this
    // schema, and casting the parameter made Postgres reject the
    // comparison outright (`operator does not exist: text = uuid`) — which
    // failed CLOSED, refusing every recording rather than overselling. A
    // real-database concurrency test caught it; a mocked one could not
    // have, since the lock is the entire mechanism.
    await tx.$queryRaw`
      SELECT 1 FROM "tenant_subscriptions"
      WHERE "organization_id" = ${organizationId}
      FOR UPDATE
    `;

    const limit = await this.resolveLimit(tx, organizationId);

    // A plan that grants zero recorded sessions is not "at its limit" —
    // it is not entitled to record at all, which is a different message
    // and a different fix (upgrade vs. wait for next period).
    if (limit !== 'unlimited' && limit <= 0) {
      throw new ForbiddenException({
        messageKey: 'errors.liveSessions.recordingNotEntitled',
        code: RECORDING_NOT_ENTITLED_CODE,
      });
    }

    if (limit !== 'unlimited') {
      const used = await this.countConsumed(tx, organizationId);
      if (used + 1 > limit) {
        throw new ConflictException({
          messageKey: 'errors.liveSessions.recordingQuotaExceeded',
          code: RECORDING_QUOTA_EXCEEDED_CODE,
          details: { used, limit },
        });
      }
    }

    const now = new Date();

    if (existing) {
      // The row existed but had never been charged (e.g. `requested` was
      // written when the host ticked the box, and the provider has only
      // now actually started recording).
      await tx.liveSessionRecording.update({
        where: { liveSessionId },
        data: {
          status: 'processing',
          quotaConsumedAt: now,
          startedAt: now,
          ...(args.providerRecordingId
            ? { providerRecordingId: args.providerRecordingId }
            : {}),
        },
      });
    } else {
      await tx.liveSessionRecording.create({
        data: {
          liveSessionId,
          academyId,
          organizationId,
          status: 'processing',
          quotaConsumedAt: now,
          startedAt: now,
          ...(args.providerRecordingId
            ? { providerRecordingId: args.providerRecordingId }
            : {}),
        },
      });
    }

    this.logger.log(
      { organizationId, liveSessionId },
      'Recorded session charged against the plan allowance.',
    );
    return true;
  }

  /**
   * How many recorded sessions this organization has actually consumed.
   *
   * Counts rows that carry `quota_consumed_at`, NOT every recording row:
   * a session whose host ticked "record" but whose provider never started
   * recording has a `requested` row and has cost nothing.
   *
   * DELIBERATELY NOT FILTERED BY DATE. A plan's recorded-session allowance
   * is a lifetime-of-subscription total in this model, so a downgrade
   * never retroactively deletes or invalidates recordings the customer
   * already made — it only changes what they may do next. If a future
   * product decision makes the allowance periodic, this is the one method
   * that changes.
   */
  private countConsumed(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<number> {
    return tx.liveSessionRecording.count({
      where: { organizationId, quotaConsumedAt: { not: null } },
    });
  }

  /**
   * The effective `recordedSessions` limit — the plan's value plus any
   * ENABLED add-on that raises it.
   *
   * Reuses `EntitlementService.computeEffectiveEntitlements`, the same
   * single formula the Usage page and every other limit check already go
   * through. A second calculation here is exactly how a customer ends up
   * being told two different numbers on two screens.
   */
  private async resolveLimit(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<LimitValue> {
    const subscription = await this.tenantSubscriptionsRepository.findByOrganizationId(
      tx,
      organizationId,
    );
    if (!subscription) return 0;

    const tenantAddOns = await this.tenantAddOnsRepository.findManyForOrganization(
      tx,
      organizationId,
    );

    const addOnInputs: EntitlementAddOnInput[] = tenantAddOns.map((tenantAddOn) => ({
      effect: tenantAddOn.addOn.effect as unknown as EntitlementAddOnInput['effect'],
      compatiblePlanKeys: tenantAddOn.addOn.compatiblePlanKeys,
    }));

    const entitlements = this.entitlementService.computeEffectiveEntitlements(
      organizationId,
      {
        key: subscription.plan.key,
        limits: subscription.plan.limits as never,
        features: subscription.plan.features as never,
      },
      addOnInputs,
    );

    return entitlements.limits.recordedSessions;
  }
}
