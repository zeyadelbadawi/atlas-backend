/**
 * TenantSubscriptionService — mirrors `TenantService` (atlas frontend)
 * exactly: `getSubscription`/`getUsage`/`getActiveAddOns`, read-only, no
 * write method (P4 is not the billing phase — no real payment/checkout
 * exists yet to change a subscription).
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching
 * `OrganizationsService.getById`'s "never trust the guard's own read"
 * discipline — `OrganizationMembershipGuard` (reused verbatim from P2,
 * unmodified) already proved organization membership before any of these
 * run; RLS proves it again, independently.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { TenantSubscriptionsRepository } from '../repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../repositories/tenant-add-ons.repository';
import { TenantUsageRepository } from '../repositories/tenant-usage.repository';
import { EntitlementService } from './entitlement.service';
import { toTenantSubscriptionResponse } from '../dto/tenant-subscription.contract';
import type { TenantSubscriptionResponse } from '../dto/tenant-subscription.contract';
import { toTenantAddOnResponse } from '../dto/tenant-add-on.contract';
import type { TenantAddOnResponse } from '../dto/tenant-add-on.contract';
import { toTenantUsageResponse } from '../dto/tenant-usage.contract';
import type { TenantUsageResponse } from '../dto/tenant-usage.contract';
import type {
  EntitlementAddOnInput,
  PlanFeatures,
  PlanResourceLimits,
} from '../dto/entitlement.types';

@Injectable()
export class TenantSubscriptionService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
    private readonly tenantUsageRepository: TenantUsageRepository,
    private readonly entitlementService: EntitlementService,
  ) {}

  async getSubscription(organizationId: string): Promise<TenantSubscriptionResponse> {
    const subscription = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.tenantSubscriptionsRepository.findByOrganizationId(tx, organizationId),
    );

    if (!subscription) {
      // Honest empty state — no subscription-creation endpoint exists in
      // P4 (real creation is Phase P14 provisioning), so an organization
      // seeded before one is created genuinely has none yet. Never
      // fabricated as a fake "trialing" default.
      throw new NotFoundException({ messageKey: 'errors.tenant.noSubscription' });
    }

    return toTenantSubscriptionResponse(subscription);
  }

  async getActiveAddOns(organizationId: string): Promise<TenantAddOnResponse[]> {
    const tenantAddOns = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.tenantAddOnsRepository.findManyForOrganization(tx, organizationId),
    );

    return tenantAddOns.map(toTenantAddOnResponse);
  }

  async getUsage(organizationId: string): Promise<TenantUsageResponse> {
    const { usage, subscription, tenantAddOns } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        const [usageRow, subscriptionRow, addOnRows] = await Promise.all([
          this.tenantUsageRepository.findByOrganizationId(tx, organizationId),
          this.tenantSubscriptionsRepository.findByOrganizationId(tx, organizationId),
          this.tenantAddOnsRepository.findManyForOrganization(tx, organizationId),
        ]);
        return {
          usage: usageRow,
          subscription: subscriptionRow,
          tenantAddOns: addOnRows,
        };
      });

    if (!usage) {
      // Honest empty state — the `tenant-usage-recompute` worker has never
      // run for this organization yet (master plan §5.6: "a computed/
      // cached row, refreshed by a scheduled job... never computed live on
      // every dashboard read"). Never computed synchronously here just to
      // avoid a 404 — that would violate the same rule.
      throw new NotFoundException({ messageKey: 'errors.tenant.usageNotAvailable' });
    }

    if (!subscription) {
      // A `limit` cannot be computed without a Plan to read it from —
      // surfaces the same honest "no subscription" state `getSubscription`
      // does, rather than guessing a limit.
      throw new NotFoundException({ messageKey: 'errors.tenant.noSubscription' });
    }

    const addOnInputs: EntitlementAddOnInput[] = tenantAddOns.map((row) => ({
      effect: row.addOn.effect as unknown as EntitlementAddOnInput['effect'],
      compatiblePlanKeys: row.addOn.compatiblePlanKeys,
    }));

    const entitlements = this.entitlementService.computeEffectiveEntitlements(
      organizationId,
      {
        key: subscription.plan.key,
        limits: subscription.plan.limits as unknown as PlanResourceLimits,
        features: subscription.plan.features as unknown as PlanFeatures,
      },
      addOnInputs,
    );

    return toTenantUsageResponse(usage, entitlements);
  }
}
