/**
 * B0-OPS-10 — the Platform Owner's subscription payment-proof backlog as
 * Prometheus gauges.
 *
 * A submitted proof notifies every Platform Owner once (B0-SUP-01), but a
 * missed notification left the customer waiting with nothing to remind
 * anyone. These gauges are read at scrape time from the same rows the
 * Platform payment review queue lists (`checkoutId IS NOT NULL` and
 * `reviewStatus = 'pending'`), and `AtlasSubscriptionProofWaiting` fires
 * when the oldest one has waited more than 24 hours.
 *
 * Age runs from the payment's LATEST proof, so a resubmission after a
 * rejection is new work and starts the clock again.
 *
 * Counts only: no organization, payment or user ever becomes a label.
 *
 * CONTEXT. Read under a real Platform Owner user context, as the lifecycle
 * and expiry sweeps do, never `runWithoutContext`, so the query stays
 * policy-bound. With no Platform Owner account, or on any error, the gauges
 * expose no sample at all rather than a reassuring zero.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { gauge } from '../../observability/metrics/learning-metrics.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';

/** Labelled so that "could not read" renders no sample (a label-less gauge renders 0). */
const LABELS = { queue: 'subscription' } as const;

/** One query per scrape, shared by both gauges. */
const READ_TTL_MS = 5_000;

export interface SubscriptionProofBacklog {
  readonly pending: number;
  /** Seconds the oldest pending proof has waited; 0 when nothing is pending. */
  readonly oldestPendingSeconds: number;
}

@Injectable()
export class SubscriptionProofBacklogMetrics {
  private readonly logger = new Logger(SubscriptionProofBacklogMetrics.name);
  private cached: { at: number; value: Promise<SubscriptionProofBacklog | null> } | null =
    null;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
  ) {
    const pending = gauge(
      'atlas_subscription_proofs_pending',
      'Subscription payments with a proof awaiting Platform Owner review.',
      ['queue'],
    );
    const oldest = gauge(
      'atlas_subscription_proof_oldest_pending_seconds',
      'Seconds the oldest subscription payment proof has waited for review (0 = none pending).',
      ['queue'],
    );
    const bind = (
      target: ReturnType<typeof gauge>,
      fill: (backlog: SubscriptionProofBacklog) => void,
    ): void => {
      (target as unknown as { collect?: () => Promise<void> }).collect = async () => {
        const backlog = await this.read();
        target.reset();
        if (backlog) fill(backlog);
      };
    };
    bind(pending, (backlog) => pending.set(LABELS, backlog.pending));
    bind(oldest, (backlog) => oldest.set(LABELS, backlog.oldestPendingSeconds));
  }

  /** The backlog, or `null` when it cannot be read. Never throws. */
  read(now: number = Date.now()): Promise<SubscriptionProofBacklog | null> {
    if (this.cached && now - this.cached.at < READ_TTL_MS) return this.cached.value;
    const value = this.query().catch((error: unknown) => {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Could not read the subscription proof backlog; the gauges expose no sample.',
      );
      return null;
    });
    this.cached = { at: now, value };
    return value;
  }

  private async query(): Promise<SubscriptionProofBacklog | null> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) return null;
    const rows = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) =>
        tx.$queryRaw<{ pending: number; oldest_seconds: number | null }[]>(Prisma.sql`
        SELECT count(*)::int AS pending,
               extract(epoch FROM now() - min(waiting_since))::float8 AS oldest_seconds
        FROM (
          SELECT coalesce(max(pp.uploaded_at), p.updated_at) AS waiting_since
          FROM payments p
          LEFT JOIN payment_proofs pp ON pp.payment_id = p.id
          WHERE p.checkout_id IS NOT NULL AND p.review_status = 'pending'
          GROUP BY p.id, p.updated_at
        ) waiting
      `),
    );
    const row = rows[0];
    return {
      pending: Number(row?.pending ?? 0),
      oldestPendingSeconds: Math.max(0, Math.floor(Number(row?.oldest_seconds ?? 0))),
    };
  }
}
