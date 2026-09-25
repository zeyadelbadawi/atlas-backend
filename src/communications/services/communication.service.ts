/**
 * CommunicationService — P64 Communications C1, the ONE thing a domain
 * service calls to tell a person something.
 *
 * `emit(tx, input)` runs INSIDE the caller's own open transaction (the
 * same "reuse the caller's tx" discipline `AuditLogWriterService.write`
 * and P17's fan-out established) and writes exactly two things:
 *
 *   1. the in-app `notifications` row, when the catalogue says
 *      `inApp: 'always'` — the feed the frontend already renders;
 *   2. the `communication_outbox` row — the durable intent to deliver.
 *
 * It NEVER sends. Delivery is the dispatcher's job, after the caller's
 * transaction has committed: a rolled-back purchase leaves no row and
 * therefore no email, and an email-provider outage can never turn a
 * successful purchase into a failed one. Callers invoke
 * `enqueueAfterCommit(outboxId)` once their transaction has returned;
 * forgetting to is harmless — the one-minute sweep finds the row.
 *
 * Both inserts are raw, no `RETURNING`, no `ON CONFLICT` — the two RLS
 * facts `NotificationsRepository`'s header documents apply verbatim to
 * the outbox (`communication_outbox_system_insert WITH CHECK (true)`;
 * the recipient is not the acting session). A genuine duplicate hits the
 * real `(recipient_user_id, dedupe_key)` unique constraint and is reported
 * as `{ created: false }`, never thrown — and, because a failed statement
 * aborts a Postgres transaction, each of the two inserts runs inside its
 * own SAVEPOINT so that report leaves the CALLER's transaction usable.
 * The notification insert carries its own (inside
 * `NotificationsRepository.create`, where the swallow lives, so that
 * every caller of that repository is safe and not just this one); the
 * outbox insert below wraps itself in `withSavepoint` here.
 */
import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { NotificationsRepository } from '../../notification-events/repositories/notifications.repository';
import { RedisService } from '../../redis/redis.service';
import { withSavepoint } from '../../common/database/savepoint.util';
import {
  COMMUNICATION_CATALOG,
  catalogCopy,
  type CommunicationCatalogEntry,
  type CommunicationEntityRef,
  type CommunicationEventKey,
  type CommunicationLocale,
} from '../catalog/communication-catalog';
import { CommunicationsProducer } from '../queue/communications.producer';
import { CommunicationMetricsService } from '../metrics/communication-metrics.service';

export interface EmitInput {
  readonly key: CommunicationEventKey;
  readonly recipientUserId: string;
  readonly organizationId?: string | null;
  readonly academyId?: string | null;
  readonly entity: CommunicationEntityRef;
  readonly values?: Record<string, unknown>;
}

export interface EmitResult {
  /** `false` on a deduped retry — nothing new was written. */
  readonly created: boolean;
  readonly outboxId: string | null;
}

/** The channel policy snapshot stored on the outbox row. */
export interface OutboxChannels {
  readonly inApp: boolean;
  readonly email: CommunicationCatalogEntry['channels']['email'];
}

export function cooldownKey(userId: string, key: string): string {
  return `comm:cooldown:${userId}:${key}`;
}

function isUniqueConstraintViolation(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (error.code === 'P2002') return true;
  const meta = error.meta as { code?: string } | undefined;
  return meta?.code === '23505';
}

@Injectable()
export class CommunicationService {
  private readonly logger = new Logger(CommunicationService.name);

  constructor(
    private readonly notificationsRepository: NotificationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly redisService: RedisService,
    private readonly producer: CommunicationsProducer,
    private readonly metrics: CommunicationMetricsService,
  ) {}

  async emit(tx: Prisma.TransactionClient, input: EmitInput): Promise<EmitResult> {
    const entry = COMMUNICATION_CATALOG[input.key];
    const values = input.values ?? {};
    const ruleContext = { entity: input.entity, values };
    const dedupeKey = entry.dedupe(ruleContext);
    const actionUrl = entry.actionUrl?.(ruleContext);
    const locale = await this.resolveLocale(tx, entry, input);

    if (entry.channels.inApp === 'always') {
      // Which copy this one event writes into the feed. Almost always the
      // entry's own pair; a handful of keys whose single fact reads two
      // ways (see `CommunicationCopyVariant`) choose between pairs from
      // the values the producer already decided.
      const copy = catalogCopy(entry, ruleContext);
      // No savepoint here: `create` runs its own around the INSERT it is
      // allowed to lose, so a deduped call already returns with the
      // caller's transaction intact.
      const created = await this.notificationsRepository.create(tx, {
        userId: input.recipientUserId,
        type: entry.notificationType,
        priority: entry.priority,
        titleKey: copy.titleKey,
        messageKey: copy.messageKey,
        values,
        actionUrl,
        actionLabelKey: entry.actionLabelKey,
        dedupeKey,
        retentionClass: entry.retentionClass,
      });
      // A deduped in-app row means this event was already emitted once;
      // never open a second delivery intent for it.
      if (!created) return { created: false, outboxId: null };
    }

    const outboxId = randomUUID();
    const now = new Date();
    const availableAt = await this.cooldownAdjustedAvailability(
      input.recipientUserId,
      input.key,
      entry,
      now,
    );
    const channels: OutboxChannels = {
      inApp: entry.channels.inApp === 'always',
      email: entry.channels.email,
    };

    try {
      await this.withOutboxSavepoint(
        tx,
        dedupeKey !== null,
        () => tx.$executeRaw`
        INSERT INTO "communication_outbox"
          ("id", "key", "category", "recipient_user_id", "organization_id", "academy_id",
           "entity_type", "entity_id", "dedupe_key", "locale", "branding", "values", "channels",
           "priority", "state", "available_at", "attempts", "created_at")
        VALUES (
          ${outboxId}, ${input.key}, ${entry.category}::"communication_category",
          ${input.recipientUserId}, ${input.organizationId ?? null}, ${input.academyId ?? null},
          ${input.entity.type}, ${input.entity.id}, ${dedupeKey}, ${locale}, ${entry.branding},
          ${JSON.stringify(values)}::jsonb, ${JSON.stringify(channels)}::jsonb,
          ${entry.priority}::"notification_priority", 'pending'::"communication_outbox_state",
          ${availableAt}, 0, ${now}
        )
      `,
      );
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return { created: false, outboxId: null };
      throw error;
    }
    this.metrics.recordOutbox(entry.category, 'pending');
    return { created: true, outboxId };
  }

  /**
   * Runs the outbox INSERT inside a SAVEPOINT when it can collide.
   *
   * The reasoning is `withSavepoint`'s own (see
   * `src/common/database/savepoint.util.ts`): catching the unique
   * violation below is only half of an idempotent insert, because in
   * PostgreSQL the failed statement has already aborted the CALLER's
   * transaction — a retried live-session announcement would otherwise
   * take every other student's row, and the emitting service's own
   * writes, down with the one duplicate. Skipped when the key never
   * dedupes: with a NULL `dedupe_key` no unique violation is possible,
   * so the two extra round-trips would buy nothing.
   */
  private withOutboxSavepoint<T>(
    tx: Prisma.TransactionClient,
    guard: boolean,
    work: () => Promise<T>,
  ): Promise<T> {
    if (!guard) return work();
    return withSavepoint(tx, work, {
      onCleanupError: (error) =>
        // Never mask the original failure with the cleanup's own.
        this.logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          'Could not roll back to the emit savepoint; the caller transaction stays aborted.',
        ),
    });
  }

  /**
   * Call AFTER the transaction that wrapped `emit` has committed. A hint
   * to the worker, not a requirement — never throws.
   */
  async enqueueAfterCommit(outboxId: string | null): Promise<void> {
    if (!outboxId) return;
    await this.producer.enqueueDispatch(outboxId, 0);
  }

  /**
   * user `preferences.language` (when `en`/`ar`) → academy `language`
   * (when the catalogue says `locale: 'academy'` and an academy is
   * attached) → `en`. The academy read is best-effort: it may be invisible
   * under the caller's RLS context, in which case the dispatcher — which
   * has full visibility — resolves it again before rendering.
   */
  private async resolveLocale(
    tx: Prisma.TransactionClient,
    entry: CommunicationCatalogEntry,
    input: EmitInput,
  ): Promise<CommunicationLocale> {
    const user = await this.usersRepository.findById(input.recipientUserId);
    const preferred = (user?.preferences as { language?: unknown } | null)?.language;
    if (preferred === 'ar' || preferred === 'en') return preferred;
    if (entry.locale === 'academy' && input.academyId) {
      try {
        const academy = await tx.academy.findUnique({
          where: { id: input.academyId },
          select: { language: true },
        });
        if (academy?.language === 'ar') return 'ar';
      } catch (error) {
        this.logger.debug(
          {
            academyId: input.academyId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Academy language not readable at emit time; dispatcher will resolve it.',
        );
      }
    }
    return 'en';
  }

  /** `now`, or the moment the recipient's cooldown for this key elapses — read-only against Redis, never throws. */
  private async cooldownAdjustedAvailability(
    userId: string,
    key: string,
    entry: CommunicationCatalogEntry,
    now: Date,
  ): Promise<Date> {
    if (entry.cooldownSeconds <= 0) return now;
    try {
      const remainingMs = await this.redisService
        .getClient()
        .pttl(cooldownKey(userId, key));
      if (remainingMs > 0) return new Date(now.getTime() + remainingMs);
    } catch (error) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'Cooldown lookup failed at emit; dispatching at the normal time.',
      );
    }
    return now;
  }
}
