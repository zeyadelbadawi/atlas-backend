/**
 * Data access for the tenant lifecycle sequences — P64 Communications C5.
 *
 * Three narrow reads and one write, all taking the caller's `tx` so they
 * run under the platform-owner context `SubscriptionExpiryService` already
 * establishes for the sweep (the established cross-tenant precedent — see
 * that service's header; `tenant_lifecycle_state_platform_all` and
 * `organizations_platform_select` are the policies that make it legal).
 *
 * THE CANDIDATE SCAN IS BOUNDED BY THE SEQUENCES THEMSELVES. It would be
 * far simpler to hand the evaluator every subscription on the platform and
 * let a pure function say "nothing due" 99 % of the time — and that is
 * exactly the shape Phase 4.5.2 had to undo for the usage sweep, where
 * "every organization, every tick" grew without bound. So each status
 * carries the time window in which it can still produce a step (§26/§27
 * plus the lateness horizon), and an organisation outside every window is
 * never fetched at all. A trial that lapsed a year ago is not a row this
 * query returns.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import {
  LIFECYCLE_STEP_MAX_LATENESS_MS,
  RENEWAL_REMINDER_LEAD_MS,
  SUBSCRIPTION_FOLLOWUP_30D_MS,
  TRIAL_ENDING_SOON_LEAD_MS,
  TRIAL_REACTIVATION_45D_MS,
  GRACE_ENDING_LEAD_MS,
} from '../utils/lifecycle-steps.util';

/** Everything one organisation's evaluation needs, in one round trip. */
export type LifecycleCandidate = Prisma.TenantSubscriptionGetPayload<{
  select: {
    organizationId: true;
    status: true;
    trialEndsAt: true;
    currentPeriodEnd: true;
    currentPeriodStart: true;
    graceEndsAt: true;
    cancelAtPeriodEnd: true;
    grantedLimits: true;
    plan: { select: { name: true } };
    organization: {
      select: {
        id: true;
        status: true;
        ownerUserId: true;
        owner: { select: { id: true; email: true; status: true; deletedAt: true } };
        cancellations: { select: { kind: true; effectiveAt: true } };
      };
    };
  };
}>;

export interface LifecycleStateWrite {
  readonly organizationId: string;
  readonly phase: string;
  readonly origin: string | null;
  readonly anchorAt: Date | null;
  /**
   * Omitted entirely on a tick that emitted nothing — written as
   * `undefined`, never `null`, so a quiet tick cannot erase the record of
   * the last step this organisation actually received.
   */
  readonly lastStep?: string;
  readonly lastStepAt?: Date;
}

@Injectable()
export class TenantLifecycleStateRepository {
  /**
   * The organisations that COULD have a step due at `now`, ordered by id
   * for stable cursor pagination.
   *
   * Each clause is one status plus the outer bound of the last step that
   * status can still produce. `trial_expired` stops being a candidate 45
   * days (T6) plus the horizon after the trial ended; `expired` stops 30
   * days (S10b) plus the horizon after access ended; an `active` row only
   * becomes one a week before its period ends (S3). Nothing here decides
   * whether a step is actually due — `evaluateLifecycleSteps` does, and it
   * is deliberately stricter than this filter.
   */
  findCandidates(
    tx: Prisma.TransactionClient,
    now: Date,
    cursor: string | undefined,
    take: number,
  ): Promise<LifecycleCandidate[]> {
    const at = now.getTime();
    const horizon = LIFECYCLE_STEP_MAX_LATENESS_MS;
    const trialTail = new Date(at - (TRIAL_REACTIVATION_45D_MS + horizon));
    const paidTail = new Date(at - (SUBSCRIPTION_FOLLOWUP_30D_MS + horizon));

    return tx.tenantSubscription.findMany({
      where: {
        // Never mail an organisation the platform has taken out of
        // service; `suspended`/`archived` are administrative states, and
        // a lifecycle nudge is not the way someone should learn about one.
        organization: { status: 'active' },
        OR: [
          // T2 — from one day before the trial ends until it ends.
          {
            status: 'trialing',
            trialEndsAt: { lte: new Date(at + TRIAL_ENDING_SOON_LEAD_MS) },
          },
          // T3–T6 — the trial tail.
          { status: 'trial_expired', trialEndsAt: { gte: trialTail } },
          // T3 for a cancelled trial, and S9 for a cancelled paid period.
          // One clause: a cancelled row is cheap to evaluate and the two
          // cases are told apart by `subscription_cancellations.kind`,
          // which this query returns anyway.
          {
            status: 'cancelled',
            OR: [
              { trialEndsAt: { gte: trialTail } },
              { currentPeriodEnd: { gte: new Date(at - horizon) } },
            ],
          },
          // S3/S4, and S5 for a row the sweep has not transitioned yet.
          {
            status: 'active',
            currentPeriodEnd: { lte: new Date(at + RENEWAL_REMINDER_LEAD_MS) },
          },
          // S5/S6/S7 — anywhere inside or just past the grace window.
          {
            status: 'grace_period',
            graceEndsAt: { lte: new Date(at + GRACE_ENDING_LEAD_MS) },
          },
          // S7/S10 — the paid tail.
          { status: 'expired', graceEndsAt: { gte: paidTail } },
        ],
        ...(cursor ? { organizationId: { gt: cursor } } : {}),
      },
      select: {
        organizationId: true,
        status: true,
        trialEndsAt: true,
        currentPeriodEnd: true,
        currentPeriodStart: true,
        graceEndsAt: true,
        cancelAtPeriodEnd: true,
        grantedLimits: true,
        plan: { select: { name: true } },
        organization: {
          select: {
            id: true,
            status: true,
            ownerUserId: true,
            owner: { select: { id: true, email: true, status: true, deletedAt: true } },
            cancellations: { select: { kind: true, effectiveAt: true } },
          },
        },
      },
      orderBy: { organizationId: 'asc' },
      take,
    });
  }

  /**
   * §26 T5/T6 — "the org has content (≥1 course or ≥1 student)".
   *
   * The two definitions are `TenantUsageRecomputeService`'s own, verbatim
   * (non-archived course in a non-archived academy; a student holding an
   * enrollment that is not `unavailable`), so "has content" here and the
   * `courses`/`students` numbers the owner sees on the Usage page can
   * never disagree. Counted live rather than read from `tenant_usage`,
   * which is a cache that may never have been computed for an
   * organisation that lapsed early — and an uncomputed cache would
   * silently downgrade a real academy to "empty" and cost it the rest of
   * its sequence.
   *
   * `findFirst` on each, not `count`: the question is existence.
   */
  async hasContent(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<boolean> {
    const [course, enrollment] = await Promise.all([
      tx.course.findFirst({
        where: {
          status: { not: 'archived' },
          academy: { organizationId, status: { not: 'archived' } },
        },
        select: { id: true },
      }),
      tx.enrollment.findFirst({
        where: {
          status: { not: 'unavailable' },
          course: { academy: { organizationId, status: { not: 'archived' } } },
        },
        select: { id: true },
      }),
    ]);
    return course !== null || enrollment !== null;
  }

  /**
   * Records where the organisation stands, for the Lifecycle panel and
   * for the retention work (C6) to build on.
   *
   * NOT a dedupe mechanism, and deliberately so: one `last_step` column
   * cannot remember thirteen independent steps, and treating it as a
   * cursor would make a step that failed to insert block every later one.
   * The `(recipient_user_id, dedupe_key)` unique index is what stops a
   * re-send; this row is observability.
   *
   * `legal_hold`/`hold_reason`/`deletion_scheduled_at` are never written
   * here — they belong to C6 and to a Platform Owner action, and an
   * upsert that blanked them would quietly release a hold.
   */
  async upsertState(
    tx: Prisma.TransactionClient,
    write: LifecycleStateWrite,
  ): Promise<void> {
    const { organizationId, ...fields } = write;
    await tx.tenantLifecycleState.upsert({
      where: { organizationId },
      create: { organizationId, ...fields },
      update: fields,
    });
  }
}
