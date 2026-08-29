/**
 * TenantSubscriptionsRepository — `tenant_subscriptions` is organization-
 * scoped and RLS-protected; every method takes a `Prisma.TransactionClient`
 * obtained from `TenancyContextService`, never the raw `PrismaService`,
 * matching `OrganizationsRepository`'s established rule.
 *
 * `upsertForPlanPurchase` is a P12 addition (master plan §21 P12's own
 * Definition of Done: "correctly updates `tenant_subscriptions`") — P4
 * shipped this repository read-only because no real Payment existed yet to
 * change one; this is the exact "additive, narrow, non-invented write"
 * P4's own RLS migration comment anticipated (see the P12 migration's
 * header comment for the matching `tenant_subscriptions_tenant_update` RLS
 * policy this method relies on).
 *
 * Phase P19 fix (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-3): this was
 * originally `updateForPlanPurchase`, a bare `.update()` that threw
 * `P2025` for any Organization's first-ever subscription — real
 * Tenant-subscription CREATION was deferred to "Phase P14 provisioning"
 * by this file's own prior doc comment, but P14's own orchestrator never
 * implemented it either (its `'tenant'` step does no such work — see
 * `provisioning-orchestrator.service.ts`). Both phases' own documentation
 * agreed where responsibility belonged; neither phase put it there. Fixed
 * here, in the one place the codebase's own architecture already
 * documents as authoritative for this exact effect
 * (`PaymentApplicationService`'s doc comment: "the one and only
 * server-side trigger that turns a successful Payment into a real
 * subscription change") — try the update first (preserves 100% of the
 * existing plan-change/upgrade behavior for an Organization that already
 * has a subscription), and only create a new row on `P2025` (no existing
 * row — this Organization's very first successful payment). No new
 * migration needed: the P4 `tenant_subscriptions_insert` RLS policy
 * (`organization_id = app.current_organization_id`) already permits this
 * insert under the exact same tenant context every caller already runs
 * this method inside.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Plan, TenantSubscription } from '@prisma/client';

function isRecordNotFound(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025';
}

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

  async upsertForPlanPurchase(
    tx: Prisma.TransactionClient,
    organizationId: string,
    data: {
      readonly planId: string;
      readonly billingCycle: TenantSubscription['billingCycle'];
      readonly currentPeriodStart: Date;
      readonly currentPeriodEnd: Date;
    },
  ): Promise<TenantSubscription> {
    try {
      return await tx.tenantSubscription.update({
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
    } catch (error) {
      if (!isRecordNotFound(error)) throw error;

      // No existing row — this Organization's first-ever successful
      // payment. `create` (not `upsert`) deliberately: avoids the
      // RLS + `ON CONFLICT` interaction bug this codebase already hit and
      // fixed once before (Phase P17, `NotificationsRepository.create`'s
      // own doc comment) — a plain create/catch pair, never `INSERT ...
      // ON CONFLICT`.
      return tx.tenantSubscription.create({
        data: {
          organizationId,
          planId: data.planId,
          status: 'active',
          billingCycle: data.billingCycle,
          currentPeriodStart: data.currentPeriodStart,
          currentPeriodEnd: data.currentPeriodEnd,
        },
      });
    }
  }
}
