/**
 * TenantSubscriptionsRepository — `tenant_subscriptions` is organization-
 * scoped and RLS-protected; every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching `OrganizationsRepository`'s established rule.
 *
 * `updateForPlanPurchase` is a P12 addition (master plan §21 P12's own
 * Definition of Done: "correctly updates `tenant_subscriptions`") — P4
 * shipped this repository read-only because no real Payment existed yet to
 * change one; this is the exact "additive, narrow, non-invented write"
 * P4's own RLS migration comment anticipated (see the P12 migration's
 * header comment for the matching `tenant_subscriptions_tenant_update` RLS
 * policy this method relies on). `Prisma.update` throws `P2025` if no row
 * exists — real Tenant-subscription CREATION remains explicitly out of
 * scope (Phase P14 provisioning, per both P4's and this phase's own doc
 * comments), so `CheckoutService`/`PaymentApplicationService` surface that
 * as a real, honest error rather than fabricating a subscription row here.
 */
import { Injectable } from '@nestjs/common';
import type { Plan, Prisma, TenantSubscription } from '@prisma/client';

@Injectable()
export class TenantSubscriptionsRepository {
  findByOrganizationId(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<(TenantSubscription & { plan: Plan }) | null> {
    return tx.tenantSubscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
  }

  /**
   * Phase P15 — `PlatformOrganizationsService.listOrganizations`'s
   * `planName`/`subscriptionStatus` columns, resolved for a WHOLE PAGE of
   * organizations in one query (master plan §27's N+1-avoidance) rather
   * than one `TenantSubscriptionService.getSubscription` call per row.
   * Meaningful only inside `runInUserContext(platformOwnerId)` (the
   * `tenant_subscriptions_platform_select` policy — a genuine
   * cross-organization batch read, unlike this repository's other
   * methods' single-tenant-context use).
   */
  findManyByOrganizationIds(
    tx: Prisma.TransactionClient,
    organizationIds: readonly string[],
  ): Promise<(TenantSubscription & { plan: Plan })[]> {
    if (organizationIds.length === 0) return Promise.resolve([]);
    return tx.tenantSubscription.findMany({
      where: { organizationId: { in: [...organizationIds] } },
      include: { plan: true },
    });
  }

  updateForPlanPurchase(
    tx: Prisma.TransactionClient,
    organizationId: string,
    data: {
      readonly planId: string;
      readonly billingCycle: TenantSubscription['billingCycle'];
      readonly currentPeriodStart: Date;
      readonly currentPeriodEnd: Date;
    },
  ): Promise<TenantSubscription> {
    return tx.tenantSubscription.update({
      where: { organizationId },
      data: {
        planId: data.planId,
        status: 'active',
        billingCycle: data.billingCycle,
        currentPeriodStart: data.currentPeriodStart,
        currentPeriodEnd: data.currentPeriodEnd,
        trialEndsAt: null,
        graceEndsAt: null,
        cancelAtPeriodEnd: false,
      },
    });
  }
}
