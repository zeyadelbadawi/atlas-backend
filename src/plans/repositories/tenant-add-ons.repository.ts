/**
 * TenantAddOnsRepository — see `TenantSubscriptionsRepository`'s doc
 * comment for the shared rule. `activate` is a P12 addition: reuses P4's
 * existing `tenant_add_ons_insert` RLS policy verbatim (no RLS change
 * needed here, unlike `tenant_subscriptions`) — `upsert` on the
 * `(organizationId, addOnId)` unique constraint makes re-purchasing an
 * already-active add-on a safe no-op rather than a duplicate-row error.
 *
 * PHASE 12 — ENABLED IS NOT MERELY PRESENT. Now that `tenant_add_ons`
 * carries a real lifecycle, "which add-ons does this tenant have" and
 * "which add-ons currently GRANT anything" are different questions, and
 * conflating them would mean a disabled or half-installed add-on silently
 * kept handing out its entitlement. The two are separate methods below,
 * and every entitlement path uses the enabled-only one.
 */
import { Injectable } from '@nestjs/common';
import type { AddOn, Prisma, TenantAddOn } from '@prisma/client';

/**
 * The only status whose effect counts toward entitlements.
 *
 * Deliberately a single status rather than a set: `installed` means the
 * tenant has it but has turned it off, `installing`/`uninstalling` are
 * mid-transition, and `failed` never completed. None of those should grant
 * a capability, and listing them individually here is what makes that
 * decision visible rather than implied.
 */
const ENTITLING_STATUS = 'enabled' as const;

@Injectable()
export class TenantAddOnsRepository {
  /**
   * Add-ons that currently GRANT their effect.
   *
   * This is what every entitlement computation must use. Its name says
   * "active" because that is the question being asked — not "which rows
   * exist".
   */
  findManyForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<(TenantAddOn & { addOn: AddOn })[]> {
    return tx.tenantAddOn.findMany({
      where: { organizationId, status: ENTITLING_STATUS },
      include: { addOn: true },
      orderBy: { activatedAt: 'asc' },
    });
  }

  /**
   * Every add-on this tenant holds, whatever its lifecycle state — for the
   * add-on management screen, which must show a disabled or failed add-on
   * precisely so it can be re-enabled or retried. Never used to decide
   * entitlement.
   */
  findAllForOrganization(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<(TenantAddOn & { addOn: AddOn })[]> {
    return tx.tenantAddOn.findMany({
      where: { organizationId },
      include: { addOn: true },
      orderBy: { activatedAt: 'asc' },
    });
  }

  findOne(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnId: string,
  ): Promise<(TenantAddOn & { addOn: AddOn }) | null> {
    return tx.tenantAddOn.findUnique({
      where: { organizationId_addOnId: { organizationId, addOnId } },
      include: { addOn: true },
    });
  }

  activate(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnId: string,
  ): Promise<TenantAddOn> {
    const now = new Date();
    return tx.tenantAddOn.upsert({
      where: { organizationId_addOnId: { organizationId, addOnId } },
      // Re-activating something already enabled stays a no-op; re-activating
      // one that was disabled or uninstalled brings it back, which is the
      // behaviour a customer expects from "install" on a thing they once had.
      update: { status: 'enabled', enabledAt: now, failureReason: null },
      create: {
        organizationId,
        addOnId,
        status: 'enabled',
        installedAt: now,
        enabledAt: now,
      },
    });
  }

  /**
   * Moves one add-on to a new lifecycle state, stamping the matching
   * timestamp. Returns whether a row actually changed, so a caller can
   * distinguish "done" from "was already in that state".
   */
  async setStatus(
    tx: Prisma.TransactionClient,
    organizationId: string,
    addOnId: string,
    status: TenantAddOn['status'],
    failureReason?: string | null,
  ): Promise<boolean> {
    const now = new Date();
    const stamps: Partial<Record<string, Date>> = {};
    if (status === 'installed') stamps.installedAt = now;
    if (status === 'enabled') stamps.enabledAt = now;
    if (status === 'disabled') stamps.disabledAt = now;
    if (status === 'uninstalled') stamps.uninstalledAt = now;

    const result = await tx.tenantAddOn.updateMany({
      where: { organizationId, addOnId, status: { not: status } },
      data: {
        status,
        ...stamps,
        // Clearing on any successful transition keeps a stale error from
        // haunting an add-on that has since been fixed.
        failureReason: failureReason ?? null,
      },
    });
    return result.count === 1;
  }
}
