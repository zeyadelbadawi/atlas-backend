/**
 * B0-SUP-01 — tells every active Platform Owner that there is work waiting:
 * a subscription payment proof, a new support case or a customer reply on
 * one, a new organization signup, an Atlas-collected course payment proof,
 * or a refund recorded on an Atlas-collected course payment. Before this,
 * every review queue depended on someone polling it.
 *
 * Same shape as the marketing contact form's fan-out
 * (`PlatformContactIntakeService.notifyPlatformOwners`):
 *
 *   - Call `notify` only AFTER the triggering transaction has committed.
 *     The fan-out runs on its own transactions, off the request path, on
 *     one in-process lane (bounded database pressure under a burst), and
 *     the lane is drained on shutdown.
 *   - Best-effort by design: no failure here (no owner account yet, an
 *     outbox write error) may fail or roll back the customer's action. The
 *     queue pages stay the source of truth either way.
 *   - Callers pass ids; the organization and academy names are resolved
 *     here under a Platform Owner's context (`organizations_platform_select`
 *     / `academies_platform_select`), so no caller widens its own RLS
 *     reads to build an alert. No learner or requester personal data is
 *     put in these alerts — the Platform Owner opens the record for that.
 *   - Dedupe is the catalogue's, per entity (and per proof / message where
 *     a second submission is genuinely new work).
 *   - `FLAG_PLATFORM_OWNER_ALERTS_MODE` (`on` unless set) switches it off.
 *     Shutdown waits a bounded time for queued alerts, then drops the rest.
 */
import {
  Injectable,
  Logger,
  type BeforeApplicationShutdown,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CommunicationsConfig } from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from './communication.service';
import type { CommunicationEventKey } from '../catalog/communication-catalog';

export const PLATFORM_OWNER_ALERT_KEYS = [
  'platform.subscription_payment.submitted',
  'platform.support_case.created',
  'platform.support_case.customer_replied',
  'platform.organization.signed_up',
  'platform.course_payment.submitted',
  'platform.refund.recorded',
] as const satisfies readonly CommunicationEventKey[];

export type PlatformOwnerAlertKey = (typeof PLATFORM_OWNER_ALERT_KEYS)[number];

export interface PlatformOwnerAlert {
  readonly key: PlatformOwnerAlertKey;
  readonly entity: { readonly type: string; readonly id: string };
  /** Resolved to `organizationName` in the alert's values. */
  readonly organizationId?: string | null;
  /** Resolved to `academyName` in the alert's values. */
  readonly academyId?: string | null;
  readonly values?: Readonly<Record<string, string | number | boolean>>;
}

/**
 * One owner per transaction. Each `emit` also takes a second, short-lived
 * connection (the recipient's locale is read in its own transaction), so a
 * batch held open across many owners would pin two pool connections for
 * the whole fan-out while customer requests wait for one. Short
 * transactions hand the connections back between owners; dedupe makes
 * every emit idempotent, so nothing is gained by grouping them.
 */
const NOTIFY_BATCH_SIZE = 1;

/**
 * How long shutdown waits for queued alerts. Bounded so a deploy restart is
 * never held up by a long fan-out; anything still queued is dropped with a
 * warning — the queue pages remain the source of truth.
 */
const SHUTDOWN_DRAIN_MS = 10_000;

/**
 * A fan-out stops after this many owners in a row fail: the cause is then
 * the database or the outbox, not one recipient, and retrying it for every
 * remaining owner only adds load (and, at shutdown, delay).
 */
const MAX_CONSECUTIVE_FAILURES = 3;

@Injectable()
export class PlatformOwnerAlertService
  implements OnModuleDestroy, BeforeApplicationShutdown
{
  private readonly logger = new Logger(PlatformOwnerAlertService.name);
  private lane: Promise<void> = Promise.resolve();
  private closing = false;
  /** The live config object, so a flag change applies to the next alert. */
  private readonly config: CommunicationsConfig;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly communicationService: CommunicationService,
    configService: ConfigService,
  ) {
    this.config = configService.getOrThrow<CommunicationsConfig>('communications');
  }

  /** Queues the alert and returns at once. Never throws. */
  notify(alert: PlatformOwnerAlert): void {
    if (this.config.platformOwnerAlertsMode !== 'on') return;
    // `deliver` never rejects; the catch only keeps one unexpected failure
    // from breaking the lane for every later alert.
    this.lane = this.lane.then(() => this.deliver(alert)).catch(() => undefined);
  }

  /** Resolves once every alert queued so far has been written and enqueued. */
  async drain(): Promise<void> {
    await this.lane;
  }

  /**
   * Nest runs `onModuleDestroy` (where the database client disconnects)
   * before `beforeApplicationShutdown`, so new work stops here: an alert
   * still on the lane would otherwise run against a closed client.
   */
  onModuleDestroy(): void {
    this.closing = true;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.closing = true;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      this.drain(),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
        timer.unref();
      }),
    ]);
    if (timer) clearTimeout(timer);
  }

  private async deliver(alert: PlatformOwnerAlert): Promise<void> {
    const log = {
      key: alert.key,
      entityType: alert.entity.type,
      entityId: alert.entity.id,
    };
    if (this.closing) {
      this.logger.warn(log, 'Shutting down; queued Platform Owner alert dropped.');
      return;
    }
    try {
      const anchor = await this.usersRepository.findFirstPlatformOwnerId();
      if (!anchor) {
        this.logger.warn(log, 'No platform owner account exists; alert not sent.');
        return;
      }
      const { ownerIds, values } = await this.tenancyContextService.runInUserContext(
        anchor.id,
        async (tx) => {
          const [owners, organization, academy] = await Promise.all([
            tx.user.findMany({
              where: { isPlatformOwner: true, status: 'active', deletedAt: null },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            }),
            alert.organizationId
              ? tx.organization.findUnique({
                  where: { id: alert.organizationId },
                  select: { name: true },
                })
              : null,
            alert.academyId
              ? tx.academy.findUnique({
                  where: { id: alert.academyId },
                  select: { name: true },
                })
              : null,
          ]);
          return {
            ownerIds: owners.map((owner) => owner.id),
            values: {
              ...(alert.values ?? {}),
              ...(alert.organizationId
                ? { organizationName: organization?.name ?? '' }
                : {}),
              ...(alert.academyId ? { academyName: academy?.name ?? '' } : {}),
            },
          };
        },
      );
      // A failed batch does not stop the others, unless failures repeat.
      let consecutiveFailures = 0;
      for (let start = 0; start < ownerIds.length; start += NOTIFY_BATCH_SIZE) {
        if (this.closing) {
          this.logger.warn(
            log,
            'Shutting down; remaining Platform Owner alerts dropped.',
          );
          return;
        }
        const batch = ownerIds.slice(start, start + NOTIFY_BATCH_SIZE);
        try {
          const outboxIds = await this.tenancyContextService.runInUserContext(
            anchor.id,
            async (tx) => {
              const ids: (string | null)[] = [];
              for (const recipientUserId of batch) {
                const emitted = await this.communicationService.emit(tx, {
                  key: alert.key,
                  recipientUserId,
                  entity: alert.entity,
                  values,
                });
                ids.push(emitted.outboxId);
              }
              return ids;
            },
          );
          consecutiveFailures = 0;
          for (const outboxId of outboxIds) {
            await this.communicationService.enqueueAfterCommit(outboxId);
          }
        } catch (error) {
          consecutiveFailures += 1;
          this.logger.error(
            { ...log, error: error instanceof Error ? error.message : String(error) },
            'Notifying a batch of platform owners failed.',
          );
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            this.logger.error(
              log,
              'Repeated failures; remaining Platform Owner alerts dropped.',
            );
            return;
          }
        }
      }
    } catch (error) {
      this.logger.error(
        { ...log, error: error instanceof Error ? error.message : String(error) },
        'Notifying platform owners failed.',
      );
    }
  }
}
