/**
 * PlatformCommunicationsHealthService — the numbers behind C7's console.
 *
 * Runs every read under the CALLING platform owner's own user context, not
 * under a looked-up "some platform owner" id. That matters: the guard has
 * already established that this caller is the Platform Owner, and running
 * as them makes the RLS policy prove it a second time and independently.
 * Borrowing another owner's identity would collapse the two gates into
 * one, and would make the audit trail say the wrong thing.
 *
 * Everything here is an aggregate. No recipient address, no subject, no
 * message body and no credential leaves this service — the console
 * answers "is the pipeline healthy", and the questions that need a
 * specific person are answered by the separately-paginated management
 * endpoints, which are explicit about returning rows.
 */
import { Injectable } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EmailProviderRegistry } from '../providers/email-provider.registry';
import { EmailQuotaService } from './email-quota.service';
import type {
  CommunicationsProviderQuota,
  PlatformCommunicationsHealthResponse,
} from '../dto/platform-communications-health.contract';

/**
 * A due row still waiting longer than this is not "busy", it is stuck.
 * The dispatch sweep runs every 60 s, so anything past several sweep
 * intervals means the worker is not draining the queue.
 */
const OVERDUE_AFTER_SECONDS = 15 * 60;

/** Reported even when zero, so a dashboard never renders a missing row as "unknown". */
const OUTBOX_STATES = [
  'pending',
  'dispatched',
  'deferred',
  'suppressed',
  'failed',
] as const;
const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'bounced',
  'complained',
  'failed',
  'suppressed',
  'deferred',
] as const;
const SUPPRESSION_REASONS = [
  'hard_bounce',
  'soft_bounce',
  'complaint',
  'manual',
  'invalid',
] as const;
/** A terminal delivery outcome that went wrong — the numerator of `failureRatio`. */
const FAILED_STATUSES = new Set(['bounced', 'complained', 'failed']);
/** Terminal outcomes, good or bad — the denominator. `queued`/`deferred` are still in flight. */
const TERMINAL_STATUSES = new Set([...FAILED_STATUSES, 'sent', 'delivered']);

function zeroed(keys: readonly string[]): Record<string, number> {
  return Object.fromEntries(keys.map((k) => [k, 0]));
}

@Injectable()
export class PlatformCommunicationsHealthService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly registry: EmailProviderRegistry,
    private readonly quota: EmailQuotaService,
  ) {}

  async getHealth(
    platformOwnerUserId: string,
    windowDays: number,
  ): Promise<PlatformCommunicationsHealthResponse> {
    const now = new Date();
    const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const db = await this.tenancyContextService.runInUserContext(
      platformOwnerUserId,
      async (tx) => {
        const [
          outboxByState,
          deliveryByStatus,
          deliveryByProvider,
          suppression,
          digests,
        ] = await Promise.all([
          tx.communicationOutbox.groupBy({
            by: ['state'],
            where: { createdAt: { gte: since } },
            _count: true,
          }),
          tx.communicationDelivery.groupBy({
            by: ['status'],
            where: { createdAt: { gte: since } },
            _count: true,
          }),
          tx.communicationDelivery.groupBy({
            by: ['provider'],
            where: { createdAt: { gte: since }, provider: { not: null } },
            _count: true,
          }),
          tx.communicationSuppression.groupBy({ by: ['reason'], _count: true }),
          tx.communicationDigest.groupBy({ by: ['state'], _count: true }),
        ]);

        // The liveness signal, deliberately NOT limited to the window: a
        // row stuck since before it would otherwise disappear from view
        // exactly when it matters most.
        const oldestDue = await tx.communicationOutbox.findFirst({
          where: { state: { in: ['pending', 'deferred'] }, availableAt: { lte: now } },
          orderBy: { availableAt: 'asc' },
          select: { availableAt: true },
        });
        const overdue = await tx.communicationOutbox.count({
          where: {
            state: { in: ['pending', 'deferred'] },
            availableAt: { lte: new Date(now.getTime() - OVERDUE_AFTER_SECONDS * 1000) },
          },
        });

        return {
          outboxByState,
          deliveryByStatus,
          deliveryByProvider,
          suppression,
          digests,
          oldestDue,
          overdue,
        };
      },
    );

    const byState = zeroed(OUTBOX_STATES);
    for (const row of db.outboxByState) byState[row.state] = row._count;

    const byStatus = zeroed(DELIVERY_STATUSES);
    for (const row of db.deliveryByStatus) byStatus[row.status] = row._count;

    const byProvider: Record<string, number> = {};
    for (const row of db.deliveryByProvider) {
      if (row.provider) byProvider[row.provider] = row._count;
    }

    const byReason = zeroed(SUPPRESSION_REASONS);
    let suppressionTotal = 0;
    for (const row of db.suppression) {
      byReason[row.reason] = row._count;
      suppressionTotal += row._count;
    }

    const digestState: Record<string, number> = {};
    for (const row of db.digests) digestState[row.state] = row._count;

    let failed = 0;
    let terminal = 0;
    for (const [status, count] of Object.entries(byStatus)) {
      if (FAILED_STATUSES.has(status)) failed += count;
      if (TERMINAL_STATUSES.has(status)) terminal += count;
    }

    return {
      windowDays,
      outbox: {
        byState,
        oldestPendingSeconds: db.oldestDue
          ? Math.max(
              0,
              Math.round((now.getTime() - db.oldestDue.availableAt.getTime()) / 1000),
            )
          : null,
        overdue: db.overdue,
        failed: byState.failed ?? 0,
      },
      deliveries: {
        byStatus,
        byProvider,
        // Zero when nothing has reached a terminal state yet: reporting
        // 0/0 as a 100% failure rate would page someone over silence.
        failureRatio: terminal === 0 ? 0 : failed / terminal,
      },
      suppressions: { total: suppressionTotal, byReason },
      digests: digestState,
      providers: await this.providerQuotas(now),
      generatedAt: now.toISOString(),
    };
  }

  /** The live chain in fallback order, each with its real usage against its real limit. */
  private async providerQuotas(now: Date): Promise<CommunicationsProviderQuota[]> {
    const names = this.registry.providerNames();
    const quotas: CommunicationsProviderQuota[] = [];
    for (const [position, name] of names.entries()) {
      const adapter = this.registry.find(name);
      if (!adapter) continue;
      const capabilities = adapter.capabilities();
      const usage = await this.quota.usage(name, capabilities, now);
      quotas.push({
        provider: name,
        position,
        dailyUsed: usage.daily.used,
        dailyLimit: usage.daily.limit ?? null,
        monthlyUsed: usage.monthly.used,
        monthlyLimit: usage.monthly.limit ?? null,
      });
    }
    return quotas;
  }
}

/** Kept exported so the spec asserts the same threshold the service uses. */
export const COMMUNICATIONS_OVERDUE_AFTER_SECONDS = OVERDUE_AFTER_SECONDS;
