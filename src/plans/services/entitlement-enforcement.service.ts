/**
 * EntitlementEnforcementService — Phase 2 (master plan §21 Phase P22,
 * "Entitlement & Plan Enforcement", closing Decisions 4 and 6). The ONE
 * server-side authority every plan-limited write path calls BEFORE
 * performing its write — never the frontend, never the cached
 * `tenant_usage` snapshot, and never a per-call reimplementation of "is
 * this organization within its plan."
 *
 * Every method here takes an already-open `Prisma.TransactionClient` from
 * the caller's own `runInTenantContext`/`runInTenantAndUserContext` — it
 * never opens its own tenant context, matching
 * `EnrollmentsService.createEnrollmentInTransaction`'s identical rule ("a
 * step of a larger atomic transaction, never the whole of one"). This is
 * what makes the "live count, not the cached snapshot" requirement
 * structurally true rather than a documentation promise: the count query
 * and the write it is gating run inside the SAME transaction, on the SAME
 * already-verified tenant context, so there is no window for a second,
 * different read of "how many does this organization have" to sneak in
 * between the check and the write.
 *
 * Deliberately reuses, never duplicates:
 *   - `TenantUsageRecomputeService.computeLiveCounts` for the live count
 *     itself (see that method's own doc comment for why one formula must
 *     serve both the cached dashboard snapshot and this live check).
 *   - `EntitlementService.computeEffectiveEntitlements`/
 *     `getResourceLimitStatus` (Phase P4) for turning a Plan + active
 *     Add-ons into the actual numeric limit — the exact same computation
 *     `TenantSubscriptionService.getUsage` already performs for the
 *     read-only Usage page, never a second, parallel entitlement formula.
 *   - `isTrialPeriodOver` (`trial.util.ts`) for the "has this trial's
 *     clock already run out, even if the scheduled sweep hasn't flipped
 *     the row yet" fail-closed check (Decision 6).
 *
 * Every rejection is a real Nest `HttpException` carrying a `messageKey`
 * (and a stable `code`) — `AllExceptionsFilter` (already existing, no
 * change needed) shapes it into the exact `NormalizedApiError` contract
 * the frontend's `ApiError`/`normalizeResponseError` already knows how to
 * read (`kind: 'forbidden'`/`'conflict'`, never a raw 500, never a leaked
 * internal detail) — matching every other business-rule rejection already
 * in this codebase (e.g. `AcademiesService.assertCanManage`), not a new
 * error shape invented for Phase 2.
 */
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { resolveSubscriptionLimits } from '../utils/granted-limits.util';
import type { Prisma } from '@prisma/client';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../repositories/tenant-add-ons.repository';
import { EntitlementService } from './entitlement.service';
import { TenantUsageRecomputeService } from './tenant-usage-recompute.service';
import { isTrialPeriodOver } from '../utils/trial.util';
import { bytesToGb } from '../utils/storage-units.util';
import type {
  EffectiveEntitlements,
  EntitlementAddOnInput,
  LimitValue,
  PlanFeatures,
  PlanLimitKey,
} from '../dto/entitlement.types';
import type { TenantUsageCounts } from '../repositories/tenant-usage.repository';

/**
 * Which `TenantUsageCounts` field backs each count-based `PlanLimitKey`.
 * `generalStorage`/`videoStorage` are deliberately excluded here — they
 * are byte-precise, not integer-count limits, and go through
 * {@link EntitlementEnforcementService.assertStorageWithinLimit} instead
 * (see that method's own doc comment for why).
 *
 * `recordedSessions` (Phase 12) is excluded for a different reason: it is
 * not in `tenant_usage` at all. Its usage is the count of
 * `live_session_recordings` rows that have actually consumed quota, which
 * must be read and incremented inside ONE serialized transaction to stay
 * concurrency-safe — see `RecordingQuotaService`. Counting it from the
 * cached snapshot would reintroduce exactly the check-then-insert race
 * that service exists to close.
 */
const COUNT_LIMIT_FIELDS: Record<
  Exclude<PlanLimitKey, 'generalStorage' | 'videoStorage' | 'recordedSessions'>,
  keyof TenantUsageCounts
> = {
  academies: 'academies',
  students: 'students',
  instructors: 'instructors',
  staff: 'staff',
  courses: 'courses',
};

/**
 * Statuses under which a plan-limited write is never permitted, regardless
 * of the numeric limit — an inactive subscription has no entitlement to
 * consume, full stop.
 *
 * Phase 11 adds the two states split out of the old overloaded `expired`.
 * Both were already refused before this change (they WERE `expired`), so
 * naming them here preserves the exact enforcement behaviour rather than
 * altering it — the split was for communication, and this set is the
 * proof that it cost nothing in gating.
 */
const INACTIVE_STATUSES = new Set(['expired', 'cancelled', 'no_plan', 'trial_expired']);

@Injectable()
export class EntitlementEnforcementService {
  constructor(
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly entitlementService: EntitlementService,
    private readonly tenantUsageRecomputeService: TenantUsageRecomputeService,
  ) {}

  /**
   * Asserts a count-based resource (`academies`/`students`/`instructors`/
   * `staff`/`courses`) has room for `additionalAmount` more before the
   * caller's write proceeds. Throws `ForbiddenException` when the
   * organization has no active entitlement at all (no subscription, or an
   * expired/cancelled/trial-run-out one), and `ConflictException` when the
   * subscription is active but the specific limit is already reached —
   * two distinct, structured outcomes the frontend already knows how to
   * render differently (`kind: 'forbidden'` vs `'conflict'`).
   */
  async assertWithinLimit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    limitKey: Exclude<
      PlanLimitKey,
      'generalStorage' | 'videoStorage' | 'recordedSessions'
    >,
    additionalAmount = 1,
  ): Promise<void> {
    // The ACTIVE-ENTITLEMENT half always runs, including for a zero-delta
    // call: an expired or cancelled subscription may not perform the write
    // at all, however little it consumes.
    const entitlements = await this.loadActiveEntitlements(tx, organizationId);

    // A CALL THAT CONSUMES NOTHING IS NEVER REFUSED FOR CAPACITY.
    //
    // Callers pass 0 to mean "this write occupies no new unit of the
    // limit" — `EnrollmentsService` does exactly that when the student is
    // already counted, so a second or third course enrollment costs no
    // extra seat. That intent used to be expressed only through the
    // arithmetic below, and the arithmetic quietly lost it: the check is
    // `used + additional > limit`, so once `used` exceeded `limit` the
    // `+ 0` stopped mattering and every zero-delta call was refused too.
    //
    // `used > limit` is not a state a customer can reach by consuming —
    // consumption is refused at the boundary. It is reached when the
    // ceiling MOVES DOWN underneath them: a Platform Owner reduces the
    // catalog limit (or a granted snapshot is absent and the catalog has
    // since shrunk). Refusing zero-delta work in that state takes away
    // something the customer already has rather than declining to sell
    // them more, which is precisely what this service must never do.
    //
    // Returning here also skips a live count that could not change the
    // answer.
    if (additionalAmount <= 0) return;

    const limit = entitlements.limits[limitKey];
    if (limit === 'unlimited') return;

    await this.lockSubscription(tx, organizationId);

    const counts = await this.tenantUsageRecomputeService.computeLiveCounts(
      tx,
      organizationId,
    );
    const used = counts[COUNT_LIMIT_FIELDS[limitKey]];

    // Unchanged for real consumption: still the live count, still inside
    // the caller's transaction, still strictly greater-than.
    this.assertNotReached(used + additionalAmount, limit, limitKey);
  }

  /**
   * The storage counterpart of {@link assertWithinLimit} — byte-precise
   * rather than integer-count, so it is NOT expressed as "used GB +
   * additional GB > limit" (which would round the existing total up
   * BEFORE adding the new file, silently over-counting): instead it sums
   * the organization's real current byte total for this storage bucket,
   * adds the new upload's real byte size, and rounds the COMBINED total up
   * to whole GB exactly once — the same `bytesToGb` conversion
   * `TenantUsageRecomputeService.computeLiveCounts` uses for the cached
   * snapshot, so a live check and the next recompute can never disagree
   * about whether a given upload was within limit.
   */
  async assertStorageWithinLimit(
    tx: Prisma.TransactionClient,
    organizationId: string,
    storageKey: 'generalStorage' | 'videoStorage',
    additionalBytes: number,
  ): Promise<void> {
    const entitlements = await this.loadActiveEntitlements(tx, organizationId);
    const limit = entitlements.limits[storageKey];
    if (limit === 'unlimited') return;

    await this.lockSubscription(tx, organizationId);

    const mediaType = storageKey === 'videoStorage' ? 'video' : undefined;
    const existing = await tx.mediaAsset.aggregate({
      where: {
        status: 'active',
        ...(mediaType ? { type: mediaType } : { type: { not: 'video' as const } }),
        academy: { organizationId, status: { not: 'archived' } },
      },
      _sum: { sizeBytes: true },
    });

    const existingBytes =
      existing._sum.sizeBytes != null ? Number(existing._sum.sizeBytes) : 0;
    const projectedGb = bytesToGb(existingBytes + additionalBytes);

    this.assertNotReached(projectedGb, limit, storageKey);
  }

  /**
   * Serializes this organization's limit consumption.
   *
   * WHY THE SAME-TRANSACTION COUNT WAS NOT ENOUGH. Counting and inserting
   * inside one transaction stops the count from going stale between the two
   * statements, which is what this service's header describes. It does NOT
   * stop two CONCURRENT transactions from both counting the same "2 of 2
   * used", both concluding there is room for one more, and both inserting —
   * PostgreSQL's default READ COMMITTED gives each its own snapshot, and
   * neither sees the other's uncommitted row. A real-database concurrency
   * test caught exactly that: four simultaneous enrollments against a
   * 2-seat allowance produced 3 students.
   *
   * Locking the organization's `tenant_subscriptions` row makes the second
   * transaction WAIT here instead of racing, so the count it then performs
   * already includes the first one's committed insert.
   *
   * This is not a new mechanism: it is the identical serialization point
   * `RecordingQuotaService.consumeForSession` already takes, on the same
   * row, for the same check-then-insert shape. Every caller locks the same
   * single row per organization, so there is no lock-ordering deadlock to
   * reason about. `$queryRaw` because Prisma has no first-class `FOR
   * UPDATE`; parameterized, never interpolated. No `::uuid` cast — Prisma
   * maps `String` ids to TEXT here, and casting makes Postgres reject the
   * comparison outright (see that service's own note on the same trap).
   */
  private async lockSubscription(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT 1 FROM "tenant_subscriptions"
      WHERE "organization_id" = ${organizationId}
      FOR UPDATE
    `;
  }

  private assertNotReached(
    projectedUsed: number,
    limit: LimitValue,
    limitKey: string,
  ): void {
    if (limit === 'unlimited') return;
    if (projectedUsed > limit) {
      throw new ConflictException({
        messageKey: 'errors.entitlement.limitReached',
        code: 'ENTITLEMENT_LIMIT_REACHED',
        values: { limitKey, limit, used: projectedUsed },
      });
    }
  }

  /**
   * Loads the organization's real, current subscription and computes its
   * effective entitlements — the exact same read
   * `TenantSubscriptionService.getUsage` already performs for the Usage
   * page, reused verbatim rather than reimplemented. Also enforces the
   * subscription-status half of Decision 6/4: no subscription, or one
   * that is `expired`/`cancelled`/a `trialing` row whose clock has
   * already run out (see `isTrialPeriodOver`'s own doc comment for why
   * this is checked live here, not only by the scheduled sweep), can
   * never pass — a plan-limited write requires an ACTIVE entitlement to
   * consume, not merely "some limit number greater than the current
   * count."
   */
  private async loadActiveEntitlements(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<EffectiveEntitlements> {
    const subscription = await this.tenantSubscriptionsRepository.findByOrganizationId(
      tx,
      organizationId,
    );

    if (!subscription) {
      throw new ForbiddenException({
        messageKey: 'errors.entitlement.noSubscription',
        code: 'ENTITLEMENT_NO_SUBSCRIPTION',
      });
    }

    if (
      INACTIVE_STATUSES.has(subscription.status) ||
      isTrialPeriodOver(subscription, new Date())
    ) {
      throw new ForbiddenException({
        messageKey: 'errors.entitlement.subscriptionInactive',
        code: 'ENTITLEMENT_SUBSCRIPTION_INACTIVE',
      });
    }

    const tenantAddOns = await this.tenantAddOnsRepository.findManyForOrganization(
      tx,
      organizationId,
    );
    const addOnInputs: EntitlementAddOnInput[] = tenantAddOns.map((row) => ({
      effect: row.addOn.effect as unknown as EntitlementAddOnInput['effect'],
      compatiblePlanKeys: row.addOn.compatiblePlanKeys,
    }));

    return this.entitlementService.computeEffectiveEntitlements(
      organizationId,
      {
        key: subscription.plan.key,
        // P61 — the GRANT, not the catalog. A subscription that recorded
        // what it was sold keeps it; one that never recorded a grant
        // (every row predating P61) falls back to the catalog, exactly as
        // it behaved before.
        limits: resolveSubscriptionLimits(subscription),
        features: subscription.plan.features as unknown as PlanFeatures,
      },
      addOnInputs,
    );
  }
}
