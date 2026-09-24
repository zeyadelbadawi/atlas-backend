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

  /**
   * Phase 2 — the trial-expiry sweep's own platform-wide read: every
   * organization still `trialing` whose clock has already run out,
   * regardless of which organization it belongs to. Meaningful only
   * inside `runInUserContext(<a real platform-owner id>)`, relying on the
   * `tenant_subscriptions_platform_select` policy (P15) exactly like
   * `findManyByOrganizationIds` above — the one difference being this
   * query has no known organization id set to seed a normal tenant
   * context with at all (a genuine, periodic, cross-tenant sweep, not a
   * request acting on behalf of one known organization).
   */
  findManyDueForTrialExpiry(
    tx: Prisma.TransactionClient,
    now: Date,
  ): Promise<TenantSubscription[]> {
    return tx.tenantSubscription.findMany({
      where: { status: 'trialing', trialEndsAt: { lte: now } },
    });
  }

  /**
   * Expiry enforcement — the paid-period sweep's platform-wide reads.
   *
   * Cursor-paginated by `organizationId` (the primary key, so the order
   * is total and a page never skips or repeats a row), mirroring
   * `OrganizationsRepository.findStaleUsageOrganizationIds`. Meaningful
   * only inside `runInUserContext(<a real platform-owner id>)` — the
   * `tenant_subscriptions_platform_select` policy — for the same reason as
   * `findManyDueForTrialExpiry`: a periodic cross-tenant sweep has no one
   * organization to seed a tenant context with.
   *
   * `findManyDueForPeriodEnd` returns every `active` row whose paid period
   * is over (`currentPeriodEnd <= now`); what it becomes — `grace_period`,
   * `cancelled` or, if the sweep is very late, straight to `expired` — is
   * decided by `resolveEffectiveSubscriptionStatus`, never here.
   * `findManyDueForGraceExpiry` returns every `grace_period` row whose
   * window has closed (`graceEndsAt <= now`).
   */
  findManyDueForPeriodEnd(
    tx: Prisma.TransactionClient,
    now: Date,
    cursor: string | undefined,
    take: number,
  ): Promise<TenantSubscription[]> {
    return tx.tenantSubscription.findMany({
      where: {
        status: 'active',
        currentPeriodEnd: { lte: now },
        ...(cursor ? { organizationId: { gt: cursor } } : {}),
      },
      orderBy: { organizationId: 'asc' },
      take,
    });
  }

  findManyDueForGraceExpiry(
    tx: Prisma.TransactionClient,
    now: Date,
    cursor: string | undefined,
    take: number,
  ): Promise<TenantSubscription[]> {
    return tx.tenantSubscription.findMany({
      where: {
        status: 'grace_period',
        graceEndsAt: { lte: now },
        ...(cursor ? { organizationId: { gt: cursor } } : {}),
      },
      orderBy: { organizationId: 'asc' },
      take,
    });
  }

  /**
   * Expiry enforcement — the sweep's write half for PAID periods, relying
   * on the `tenant_subscriptions_platform_update` policy (P22 migration)
   * exactly as `markTrialExpired` does.
   *
   * Every transition is a GUARDED `updateMany` — the predicate names the
   * exact stored state the transition leaves from, so a row a concurrent
   * sweep tick (or a renewal landing mid-tick) has already moved on
   * matches zero rows and reports `false`, and no transition is ever
   * applied twice or applied on top of a newer state. That predicate, not
   * a lock, is what makes the sweep idempotent.
   *
   * `trialEndsAt` is never touched by any of these: it is the historical
   * record of a trial this customer may once have had, and clearing it
   * would make the row look eligible for `startTrial` again.
   */
  async markGraceStarted(
    tx: Prisma.TransactionClient,
    organizationId: string,
    graceEndsAt: Date,
  ): Promise<boolean> {
    const result = await tx.tenantSubscription.updateMany({
      where: { organizationId, status: 'active', cancelAtPeriodEnd: false },
      data: { status: 'grace_period', graceEndsAt },
    });
    return result.count === 1;
  }

  /** `active` + `cancelAtPeriodEnd` past `currentPeriodEnd` → `cancelled`. No grace: the customer asked for it to end. */
  async markCancelledAtPeriodEnd(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<boolean> {
    const result = await tx.tenantSubscription.updateMany({
      where: { organizationId, status: 'active', cancelAtPeriodEnd: true },
      data: { status: 'cancelled' },
    });
    return result.count === 1;
  }

  /**
   * `grace_period` (or an `active` row whose derived grace window is
   * ALSO already over — a sweep that has not run for more than the grace
   * length) → `expired`. `graceEndsAt` is written so the row records when
   * access actually ended, even when the sweep skipped the intermediate
   * `grace_period` write.
   *
   * REPAIRED: this method existed since Phase 2 (`status: 'expired',
   * trialEndsAt: null`, unguarded) and was never called by anything once
   * Phase 11 moved trials to `markTrialExpired` — the paid half of the
   * lifecycle had no writer at all.
   */
  async markExpired(
    tx: Prisma.TransactionClient,
    organizationId: string,
    graceEndsAt: Date,
  ): Promise<boolean> {
    const result = await tx.tenantSubscription.updateMany({
      where: {
        organizationId,
        OR: [{ status: 'grace_period' }, { status: 'active', cancelAtPeriodEnd: false }],
      },
      data: { status: 'expired', graceEndsAt },
    });
    return result.count === 1;
  }

  /**
   * Phase 11 — ends a TRIAL that has run its course.
   *
   * Replaces the previous `markExpired` call in the trial sweep, which
   * set `status='expired', trialEndsAt=null` and in doing so destroyed
   * the only two facts the recovery screen needs: that what ended was a
   * trial, and when. A customer whose trial lapsed then saw the same
   * "your subscription has ended" as a lapsed payer, with no way to offer
   * "continue with the plan you were trialing".
   *
   * `trialEndsAt` is deliberately PRESERVED. It is the historical record
   * of when the trial ran out, and keeping it also means this row can
   * never match `startTrial` again (which requires `trialEndsAt: null`) —
   * so preserving history and preventing a second trial are the same
   * mechanism, not two that could drift apart.
   *
   * `planId` is untouched: it is the plan that was trialed, and it is
   * what makes the recovery CTA specific.
   */
  markTrialExpired(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<TenantSubscription> {
    return tx.tenantSubscription.update({
      where: { organizationId },
      data: { status: 'trial_expired' },
    });
  }

  /**
   * Phase 2 — the ONE place a brand-new Organization's real trial
   * subscription row is created (`OrganizationSubscriptionBootstrapService`,
   * called from `OrganizationsService.create`'s `onCreated` hook, inside
   * that same transaction/tenant context). A plain `create`, never an
   * `upsert`: an organization this fresh cannot already have a
   * subscription row (its id was only just generated), so there is
   * nothing to race against — matching `OrganizationsRepository.create`'s
   * own "caller-supplied id, opened inside its own brand-new tenant
   * context" precedent.
   */
  create(
    tx: Prisma.TransactionClient,
    data: {
      readonly organizationId: string;
      readonly planId: string;
      /** `null` for a new Organization — Phase 10.2 grants no trial on creation. */
      readonly trialEndsAt: Date | null;
      /** Explicit since Phase 10.2. Was hardcoded to `'trialing'` back when every new Organization was auto-granted a trial. */
      readonly status: TenantSubscription['status'];
    },
  ): Promise<TenantSubscription> {
    return tx.tenantSubscription.create({
      data: {
        organizationId: data.organizationId,
        planId: data.planId,
        status: data.status,
        trialEndsAt: data.trialEndsAt,
      },
    });
  }

  /**
   * Phase 10.2 — starts a trial on an existing subscription row.
   *
   * Guarded by `status: 'no_plan'` and `trialEndsAt: null`, so it can only
   * ever move a subscription that has never had a plan or a trial. A row
   * already `trialing`, `active`, `trial_expired`, `cancelled` or
   * `expired` matches zero rows and reports `false` — meaning this is safe
   * to call concurrently even before the redemption claim is considered.
   *
   * NARROWED IN PHASE 11 from `status IN ('expired','cancelled')`. That
   * older predicate was written when `expired` was also what a brand-new
   * Organization got, so it had to accept `expired` in order for any trial
   * to start at all. With `no_plan` modelling the new-customer state
   * directly, accepting `expired`/`cancelled` would now mean something
   * quite different and quite wrong: a customer whose PAID subscription
   * lapsed, or who cancelled one, could take a free trial afterwards. The
   * account-level redemption record usually stops that anyway, but relying
   * on it would be relying on a second mechanism to cover this one's
   * mistake. A trial is for a customer who has never had a plan, and that
   * is now exactly what the predicate says.
   *
   * @returns whether this call actually started the trial.
   */
  async startTrial(
    tx: Prisma.TransactionClient,
    organizationId: string,
    planId: string,
    trialEndsAt: Date,
    grantedLimits: Prisma.InputJsonValue,
  ): Promise<boolean> {
    const result = await tx.tenantSubscription.updateMany({
      where: {
        organizationId,
        trialEndsAt: null,
        status: 'no_plan',
      },
      // P61 — a trial IS an entitlement grant, so it records what it
      // granted. Written in the SAME `updateMany` as `planId`, so the two
      // are set by one statement and no window exists in which the
      // subscription names a plan it has no grant for.
      data: { planId, status: 'trialing', trialEndsAt, grantedLimits },
    });
    return result.count === 1;
  }

  /**
   * Phase 10.2 — ends a trial immediately on cancellation.
   *
   * `trialEndsAt` is deliberately LEFT IN PLACE rather than nulled: it is
   * the historical record of when the trial would have run out, and
   * clearing it would also make the row look eligible to `startTrial`
   * again. Status alone ends access, since `cancelled` is already in
   * `INACTIVE_STATUSES`.
   */
  async markTrialCancelled(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    await tx.tenantSubscription.updateMany({
      where: { organizationId, status: 'trialing' },
      data: { status: 'cancelled' },
    });
  }

  /**
   * Phase 10.2 — schedules a paid subscription to end at the close of the
   * period the customer has already paid for.
   *
   * Sets `cancelAtPeriodEnd` rather than flipping status immediately:
   * cancelling must never forfeit time already purchased. The existing
   * expiry sweep is what eventually transitions the row.
   */
  async markPaidCancelAtPeriodEnd(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<void> {
    await tx.tenantSubscription.updateMany({
      where: { organizationId, status: { in: ['active', 'past_due', 'grace_period'] } },
      data: { cancelAtPeriodEnd: true },
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
      /**
       * P61 — the plan's limits AT PURCHASE, frozen. Required, not
       * optional: every path that reaches here is granting an entitlement,
       * and one that forgot to record what it granted would silently leave
       * the subscription following the catalog again.
       */
      readonly grantedLimits: Prisma.InputJsonValue;
    },
  ): Promise<TenantSubscription> {
    try {
      return await tx.tenantSubscription.update({
        where: { organizationId },
        data: {
          planId: data.planId,
          // Set in the SAME statement as `planId` — an upgrade, a
          // downgrade and a first purchase all move both facts together or
          // neither, so the row can never name one plan while holding
          // another's grant.
          grantedLimits: data.grantedLimits,
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
          grantedLimits: data.grantedLimits,
          status: 'active',
          billingCycle: data.billingCycle,
          currentPeriodStart: data.currentPeriodStart,
          currentPeriodEnd: data.currentPeriodEnd,
        },
      });
    }
  }
}
