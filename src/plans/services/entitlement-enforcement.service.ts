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
  PlanResourceLimits,
} from '../dto/entitlement.types';
import type { TenantUsageCounts } from '../repositories/tenant-usage.repository';

/**
 * Which `TenantUsageCounts` field backs each count-based `PlanLimitKey`.
 * `generalStorage`/`videoStorage` are deliberately excluded here — they
 * are byte-precise, not integer-count limits, and go through
 * {@link EntitlementEnforcementService.assertStorageWithinLimit} instead
 * (see that method's own doc comment for why).
 */
const COUNT_LIMIT_FIELDS: Record<
  Exclude<PlanLimitKey, 'generalStorage' | 'videoStorage'>,
  keyof TenantUsageCounts
> = {
  academies: 'academies',
  students: 'students',
  instructors: 'instructors',
  staff: 'staff',
  courses: 'courses',
};

/** Statuses under which a plan-limited write is never permitted, regardless of the numeric limit — an inactive subscription has no entitlement to consume, full stop. */
const INACTIVE_STATUSES = new Set(['expired', 'cancelled']);

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
    limitKey: Exclude<PlanLimitKey, 'generalStorage' | 'videoStorage'>,
    additionalAmount = 1,
  ): Promise<void> {
    const entitlements = await this.loadActiveEntitlements(tx, organizationId);
    const limit = entitlements.limits[limitKey];
    if (limit === 'unlimited') return;

    const counts = await this.tenantUsageRecomputeService.computeLiveCounts(
      tx,
      organizationId,
    );
    const used = counts[COUNT_LIMIT_FIELDS[limitKey]];

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
        limits: subscription.plan.limits as unknown as PlanResourceLimits,
        features: subscription.plan.features as unknown as PlanFeatures,
      },
      addOnInputs,
    );
  }
}
