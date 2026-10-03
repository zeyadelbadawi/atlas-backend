/**
 * CommunicationDispatchService — P64 Communications C1/C3: drains the
 * outbox. Runs under the PLATFORM-OWNER user context (the established
 * sweep precedent — `Phase2MaintenanceService` documents why "no context"
 * silently reads nothing under FORCE RLS), never under the recipient's.
 *
 * DOUBLE-SEND GUARD. Every `dispatch` begins with ONE conditional UPDATE:
 *
 *   UPDATE communication_outbox
 *      SET attempts = attempts + 1, available_at = <now + lease>
 *    WHERE id = $1 AND state IN ('pending','deferred')
 *      AND digest_id IS NULL AND available_at <= <now>
 *
 * Postgres serialises concurrent UPDATEs of one row, so exactly one of
 * two workers holding the same outbox id sees `1 row` and proceeds; the
 * other sees `0` and returns. The lease pushes `available_at` ten minutes
 * out, so the sweep cannot hand the row to a third worker while the first
 * is mid-send. The claim is the whole guard — no advisory lock, no Redis
 * lock, nothing that can drift from the row.
 *
 * DISPATCH PIPELINE (one claimed row):
 *   claim → recipient (anonymised/deleted → suppressed) → channel policy
 *   → preferences → suppression list → cooldown → daily cap (→ digest)
 *   → branding & links → render → send (idempotencyKey = outbox id)
 *   → delivery row → outbox `dispatched`.
 *
 * The send itself runs OUTSIDE any transaction (a provider round-trip must
 * never hold a Postgres transaction open): the decision is taken in one
 * short platform-owner transaction, the send happens, the outcome is
 * written in a second. A crash between the send and the write leaves the
 * row claimed until its lease expires, after which the sweep retries it;
 * the provider's `idempotencyKey` (the outbox id) is what turns that
 * retry into a no-op rather than a second email.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma, CommunicationOutbox } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { RedisService } from '../../redis/redis.service';
import {
  COMMUNICATION_CATALOG,
  isCommunicationEventKey,
  settleScrubKeys,
  type CommunicationAudience,
  type CommunicationCatalogEntry,
  type CommunicationEventKey,
  type CommunicationLocale,
} from '../catalog/communication-catalog';
import { withSavepoint } from '../../common/database/savepoint.util';
import { DIGEST_TEMPLATE, TemplateRegistry } from '../templates/template-registry';
import type { RenderedEmail } from '../templates/template-registry';
import { EmailTransport } from './email-transport';
import { LinkBuilderService } from './link-builder.service';
import { CommunicationBrandingService } from './communication-branding.service';
import type { ResolvedBranding } from './communication-branding.service';
import {
  COMMUNICATION_SUPPRESSION,
  type CommunicationSuppressionLookup,
} from './communication-suppression.interface';
import { resolveCommunicationPreferences } from './communication-preferences.util';
import type { CommunicationPreferences } from './communication-preferences.util';
import { cooldownKey, type OutboxChannels } from './communication.service';
import { CommunicationsProducer } from '../queue/communications.producer';
import { CommunicationMetricsService } from '../metrics/communication-metrics.service';
import {
  COMMUNICATION_CLAIM_LEASE_MS,
  COMMUNICATION_RETENTION_DAYS,
  DAILY_EMAIL_CAP_LEARNER,
  DAILY_EMAIL_CAP_STAFF,
  DIGEST_LOCAL_HOUR,
} from '../queue/communications.types';

export type DispatchOutcome =
  'skipped' | 'sent' | 'in_app_only' | 'suppressed' | 'deferred' | 'digested' | 'failed';

export interface DispatchAttempt {
  /** Attempts already made by BullMQ before this one (`job.attemptsMade`). */
  readonly made: number;
  /** Total attempts the job allows (`job.opts.attempts`). */
  readonly max: number;
}

export interface PruneResult {
  readonly outbox: number;
  readonly deliveries: number;
  readonly digests: number;
  readonly notifications: number;
}

/** Sentinel domain `AccountDeletionService` rewrites an anonymised account's address to. */
const ANONYMISED_EMAIL_DOMAIN = '@account.invalid';

/** Categories a person can never be capped or digested out of. */
const CAP_EXEMPT_CATEGORIES: ReadonlySet<string> = new Set(['security', 'transactional']);

/**
 * A settled row's `values` with the entry's `credentialValues` and
 * `personalValues` removed — or `undefined` (leave the column untouched)
 * when the entry declares none or the row holds none of them. Exported for
 * its unit test.
 *
 * Every entry that declares credentials is `security`, which is never
 * capped or digested, so the per-row settle paths here are the only ones
 * such a row can take. An entry with `personalValues` may be digested, so
 * the digest settle paths scrub through `scrubSettledRows` as well.
 */
export function withoutCredentials(
  entry: Pick<CommunicationCatalogEntry, 'credentialValues' | 'personalValues'>,
  values: Prisma.JsonValue | null,
): Prisma.InputJsonValue | undefined {
  const keys = settleScrubKeys(entry);
  if (!keys.length || !values || typeof values !== 'object' || Array.isArray(values)) {
    return undefined;
  }
  const record = values as Prisma.JsonObject;
  if (!keys.some((key) => key in record)) return undefined;
  return Object.fromEntries(
    Object.entries(record).filter(([key]) => !keys.includes(key)),
  ) as Prisma.InputJsonValue;
}

interface RecipientState {
  readonly email: string;
  readonly preferences: unknown;
  readonly isStaff: boolean;
}

/** Everything the send needs, decided inside the claim transaction. */
interface SendPlan {
  readonly kind: 'send';
  readonly row: CommunicationOutbox;
  readonly entry: CommunicationCatalogEntry;
  readonly to: string;
  readonly rendered: RenderedEmail;
}

interface SettledPlan {
  readonly kind: 'settled';
  readonly outcome: DispatchOutcome;
}

@Injectable()
export class CommunicationDispatchService {
  private readonly logger = new Logger(CommunicationDispatchService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly redisService: RedisService,
    private readonly transport: EmailTransport,
    private readonly links: LinkBuilderService,
    private readonly brandingService: CommunicationBrandingService,
    private readonly producer: CommunicationsProducer,
    private readonly metrics: CommunicationMetricsService,
    @Inject(COMMUNICATION_SUPPRESSION)
    private readonly suppression: CommunicationSuppressionLookup,
  ) {}

  // ---------------------------------------------------------------------
  // dispatch
  // ---------------------------------------------------------------------

  async dispatch(outboxId: string, attempt: DispatchAttempt): Promise<DispatchOutcome> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId) return 'skipped';

    const plan = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      (tx) => this.decide(tx, outboxId),
    );
    if (plan.kind === 'settled') return plan.outcome;

    const startedAt = Date.now();
    try {
      const result = await this.transport.send({
        to: plan.to,
        subject: plan.rendered.subject,
        text: plan.rendered.text,
        html: plan.rendered.html,
        idempotencyKey: plan.row.id,
        tags: { key: plan.row.key, category: plan.row.category },
        // The quota line the registry reserves against — a per-category
        // budget is the whole point of having categories, so losing it
        // here would bill every outbox email to the default line.
        category: plan.row.category,
      });
      await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
        await tx.communicationDelivery.create({
          data: {
            outboxId: plan.row.id,
            channel: 'email',
            provider: result.provider,
            providerMessageId: result.providerMessageId,
            status: 'sent',
            attempts: attempt.made + 1,
            templateVersion: plan.rendered.version,
            sentAt: new Date(),
          },
        });
        await tx.communicationOutbox.update({
          where: { id: plan.row.id },
          data: {
            state: 'dispatched',
            dispatchedAt: new Date(),
            lastError: null,
            // The email is out; the link token it carried has no business
            // staying in the outbox for the rest of the retention window.
            values: withoutCredentials(plan.entry, plan.row.values),
          },
        });
      });
      await this.countTowardsDailyCap(plan.row.recipientUserId!);
      this.metrics.recordOutbox(plan.row.category, 'dispatched');
      this.metrics.recordDispatchLatency(
        plan.row.category,
        (Date.now() - plan.row.createdAt.getTime()) / 1000,
      );
      this.logger.log(
        { outboxId: plan.row.id, key: plan.row.key, ms: Date.now() - startedAt },
        'Communication email sent',
      );
      return 'sent';
    } catch (error) {
      return this.handleSendFailure(platformOwnerId, plan, attempt, error);
    }
  }

  /** The claim + every pre-send decision, in one platform-owner transaction. */
  private async decide(
    tx: Prisma.TransactionClient,
    outboxId: string,
  ): Promise<SendPlan | SettledPlan> {
    const now = new Date();
    const claimed = await tx.$executeRaw`
      UPDATE "communication_outbox"
         SET "attempts" = "attempts" + 1,
             "available_at" = ${new Date(now.getTime() + COMMUNICATION_CLAIM_LEASE_MS)}
       WHERE "id" = ${outboxId}
         AND "state" IN ('pending', 'deferred')
         AND "digest_id" IS NULL
         AND "available_at" <= ${now}
    `;
    if (claimed === 0) return { kind: 'settled', outcome: 'skipped' };

    const row = await tx.communicationOutbox.findUnique({ where: { id: outboxId } });
    if (!row || !row.recipientUserId) {
      return this.settle(tx, outboxId, 'suppressed', 'no_recipient');
    }
    if (!isCommunicationEventKey(row.key)) {
      return this.settle(tx, outboxId, 'failed', `unknown_key:${row.key}`);
    }
    const entry = COMMUNICATION_CATALOG[row.key];
    const channels = row.channels as unknown as OutboxChannels;

    const recipient = await this.loadRecipient(tx, row.recipientUserId);
    if (!recipient) {
      return this.settle(tx, outboxId, 'suppressed', 'recipient_unavailable', {
        inApp: channels.inApp,
      });
    }

    if (channels.email === 'never') {
      return this.settle(tx, outboxId, 'dispatched', null, {
        inApp: channels.inApp,
        outcome: 'in_app_only',
      });
    }

    // Preferences — only `preference`/`digest` policies consult them;
    // `always` (security, transactional, lifecycle facts) bypasses them.
    const preferences = resolveCommunicationPreferences(recipient.preferences, {
      isStaff: recipient.isStaff,
    });
    let wantsDigest = channels.email === 'digest';
    if (channels.email === 'preference') {
      if (entry.category === 'engagement') {
        if (!preferences.categories.engagement.email) {
          return this.settle(tx, outboxId, 'dispatched', 'preference_off', {
            inApp: channels.inApp,
            outcome: 'in_app_only',
            emailStatus: 'suppressed',
          });
        }
        wantsDigest = preferences.categories.engagement.digest === 'daily';
      } else if (entry.category === 'lifecycle') {
        /*
          P64 C5 (§26/§27) — the `reminders` toggle, and ONLY it.
          `lifecycle.email` is locked on in `resolveCommunicationPreferences`
          because a person may not opt out of being told their site went
          offline; the steps that carry that kind of news (T3, S3, S5, S7,
          S9) declare `email: 'always'` and never reach this branch at all.
          What does reach it is the nudge half of the sequences — T4, T5,
          T6, S10 — which are marketing-adjacent and must respect the
          toggle. Nothing here is digestible: a follow-up folded into a
          daily digest days later would arrive after the moment it was
          timed for.
        */
        if (!preferences.categories.lifecycle.reminders) {
          return this.settle(tx, outboxId, 'dispatched', 'preference_off', {
            inApp: channels.inApp,
            outcome: 'in_app_only',
            emailStatus: 'suppressed',
          });
        }
      } else if (entry.category === 'operational' && preferences.categories.operational) {
        if (!preferences.categories.operational.email) {
          return this.settle(tx, outboxId, 'dispatched', 'preference_off', {
            inApp: channels.inApp,
            outcome: 'in_app_only',
            emailStatus: 'suppressed',
          });
        }
        wantsDigest = preferences.categories.operational.digest === 'daily';
      }
    }

    if (await this.suppression.isSuppressed(recipient.email)) {
      return this.settle(tx, outboxId, 'suppressed', 'address_suppressed', {
        inApp: channels.inApp,
      });
    }

    // Cooldown — at most one email of this key per window; the row waits
    // for the window to elapse and the sweep brings it back.
    const cooldownRemainingMs = await this.cooldownRemaining(
      row.recipientUserId,
      row.key,
      entry,
    );
    if (cooldownRemainingMs > 0) {
      await tx.communicationOutbox.update({
        where: { id: outboxId },
        data: {
          state: 'deferred',
          availableAt: new Date(now.getTime() + cooldownRemainingMs),
        },
      });
      this.metrics.recordOutbox(row.category, 'deferred');
      return { kind: 'settled', outcome: 'deferred' };
    }

    const branding = await this.brandingService.resolve(
      tx,
      entry.branding,
      row.academyId,
    );

    // Daily cap — security/transactional are exempt; everything else past
    // the cap goes into the open digest window instead of being dropped.
    if (!CAP_EXEMPT_CATEGORIES.has(entry.category) && !wantsDigest) {
      const cap = recipient.isStaff ? DAILY_EMAIL_CAP_STAFF : DAILY_EMAIL_CAP_LEARNER;
      const sentToday = await this.sentTodayCount(row.recipientUserId);
      if (sentToday >= cap) {
        // A learner who turned the digest OFF asked for no batching at all.
        if (
          entry.category === 'engagement' &&
          preferences.categories.engagement.digest === 'off'
        ) {
          return this.settle(tx, outboxId, 'dispatched', 'daily_cap', {
            inApp: channels.inApp,
            outcome: 'in_app_only',
            emailStatus: 'suppressed',
          });
        }
        wantsDigest = true;
      }
    }

    if (wantsDigest) {
      await this.attachToDigest(tx, row, entry.audience, branding.academyTimezone, now);
      return { kind: 'settled', outcome: 'digested' };
    }

    const locale = this.resolveLocale(recipient.preferences, entry, branding, row.locale);
    const rendered = this.render(row, entry, locale, branding);
    return { kind: 'send', row, entry, to: recipient.email, rendered };
  }

  private render(
    row: CommunicationOutbox,
    entry: CommunicationCatalogEntry,
    locale: CommunicationLocale,
    branding: ResolvedBranding,
  ): RenderedEmail {
    const values = (row.values as Record<string, unknown> | null) ?? {};
    const path = entry.actionUrl?.({
      entity: { type: row.entityType ?? '', id: row.entityId ?? '' },
      values,
    });
    // An academy-branded key emitted with NO academy (e.g. a management-
    // surface signup's verification email) is a platform email: it is
    // built like one, without the academy-host `/ar` prefix the platform
    // host does not mount. An academy that exists but has no host yet
    // keeps `onHost`'s documented fallback.
    const actionUrl = path
      ? entry.branding === 'academy' && row.academyId
        ? this.links.onHost(branding.host, path, locale)
        : this.links.platform(path)
      : null;
    return TemplateRegistry.render(
      entry.template,
      locale,
      {
        branding: branding.branding,
        actionUrl,
        // The audience decides the surface: a learner manages preferences
        // on their academy host, staff and platform recipients on the
        // management host. Without it the footer link 404s for everyone.
        settingsUrl: this.links.settings(
          locale,
          entry.branding === 'academy' ? branding.host : null,
          entry.audience,
        ),
      },
      values,
    );
  }

  /** The dispatcher has full visibility, so it re-resolves the locale rather than trusting the emit-time snapshot blindly. */
  private resolveLocale(
    preferences: unknown,
    entry: CommunicationCatalogEntry,
    branding: ResolvedBranding,
    stored: string,
  ): CommunicationLocale {
    const preferred = (preferences as { language?: unknown } | null)?.language;
    if (preferred === 'ar' || preferred === 'en') return preferred;
    if (entry.locale === 'academy' && branding.academyLanguage === 'ar') return 'ar';
    return stored === 'ar' ? 'ar' : 'en';
  }

  private async handleSendFailure(
    platformOwnerId: string,
    plan: SendPlan,
    attempt: DispatchAttempt,
    error: unknown,
  ): Promise<DispatchOutcome> {
    const message = error instanceof Error ? error.message : String(error);
    const exhausted = attempt.made + 1 >= attempt.max;
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      await tx.communicationDelivery.create({
        data: {
          outboxId: plan.row.id,
          channel: 'email',
          provider: this.transport.providerName,
          status: 'failed',
          errorCode: message.slice(0, 200),
          attempts: attempt.made + 1,
          templateVersion: plan.rendered.version,
        },
      });
      await tx.communicationOutbox.update({
        where: { id: plan.row.id },
        data: exhausted
          ? {
              state: 'failed',
              lastError: message.slice(0, 1000),
              // Terminal: nothing will render this row again.
              values: withoutCredentials(plan.entry, plan.row.values),
            }
          : // Hand the row back so the BullMQ retry (or the sweep) can claim it
            // again — credentials intact, because the retry re-renders the link.
            {
              state: 'pending',
              availableAt: new Date(),
              lastError: message.slice(0, 1000),
            },
      });
    });
    if (exhausted) {
      this.metrics.recordDeadLetter(plan.row.category);
      this.metrics.recordOutbox(plan.row.category, 'failed');
      this.logger.error(
        {
          outboxId: plan.row.id,
          key: plan.row.key,
          attempts: attempt.made + 1,
          error: message,
        },
        'Communication delivery exhausted its retries and was marked failed',
      );
    } else {
      this.metrics.recordRetry(plan.row.category);
      this.logger.warn(
        {
          outboxId: plan.row.id,
          key: plan.row.key,
          attempt: attempt.made + 1,
          error: message,
        },
        'Communication delivery failed transiently; retrying',
      );
    }
    // Rethrow so BullMQ applies its backoff/retry (and keeps the exhausted job in the failed set).
    throw error;
  }

  /** Writes the terminal state for a row that will not be emailed now, plus its in-app delivery row when the feed was written. */
  private async settle(
    tx: Prisma.TransactionClient,
    outboxId: string,
    state: 'dispatched' | 'suppressed' | 'failed',
    reason: string | null,
    options: {
      readonly inApp?: boolean;
      readonly outcome?: DispatchOutcome;
      readonly emailStatus?: 'suppressed' | 'failed';
    } = {},
  ): Promise<SettledPlan> {
    const row = await tx.communicationOutbox.update({
      where: { id: outboxId },
      data: {
        state,
        dispatchedAt: state === 'dispatched' ? new Date() : undefined,
        lastError: reason,
      },
    });
    // Every state written here is terminal, so a credential the row was
    // holding for a render that will now never happen goes too.
    const scrubbed = isCommunicationEventKey(row.key)
      ? withoutCredentials(COMMUNICATION_CATALOG[row.key], row.values)
      : undefined;
    if (scrubbed !== undefined) {
      await tx.communicationOutbox.update({
        where: { id: outboxId },
        data: { values: scrubbed },
      });
    }
    if (options.inApp) {
      await tx.communicationDelivery.create({
        data: { outboxId, channel: 'in_app', status: 'sent', sentAt: row.createdAt },
      });
    }
    const emailStatus =
      options.emailStatus ??
      (state === 'suppressed' ? 'suppressed' : state === 'failed' ? 'failed' : null);
    if (emailStatus) {
      await tx.communicationDelivery.create({
        data: { outboxId, channel: 'email', status: emailStatus, errorCode: reason },
      });
    }
    this.metrics.recordOutbox(row.category, state);
    return {
      kind: 'settled',
      outcome:
        options.outcome ??
        (state === 'suppressed'
          ? 'suppressed'
          : state === 'failed'
            ? 'failed'
            : 'in_app_only'),
    };
  }

  // ---------------------------------------------------------------------
  // recipient, preferences, cooldown, cap
  // ---------------------------------------------------------------------

  private async loadRecipient(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<RecipientState | null> {
    const user = await this.usersRepository.findById(userId);
    if (!user) return null;
    if (user.deletedAt || user.status === 'deleted') return null;
    if (user.email.toLowerCase().endsWith(ANONYMISED_EMAIL_DOMAIN)) return null;
    return {
      email: user.email,
      preferences: user.preferences,
      isStaff: await this.isStaff(tx, userId),
    };
  }

  /** Any organisation or academy membership makes a person staff for cap and preference purposes. */
  private async isStaff(tx: Prisma.TransactionClient, userId: string): Promise<boolean> {
    const [organizations, academies] = await Promise.all([
      tx.organizationMembership.count({ where: { userId } }),
      tx.academyMember.count({ where: { userId } }),
    ]);
    return organizations + academies > 0;
  }

  private async cooldownRemaining(
    userId: string,
    key: string,
    entry: CommunicationCatalogEntry,
  ): Promise<number> {
    if (entry.cooldownSeconds <= 0) return 0;
    try {
      const client = this.redisService.getClient();
      const acquired = await client.set(
        cooldownKey(userId, key),
        '1',
        'EX',
        entry.cooldownSeconds,
        'NX',
      );
      if (acquired === 'OK') return 0;
      const remaining = await client.pttl(cooldownKey(userId, key));
      return remaining > 0 ? remaining : 0;
    } catch (error) {
      this.logger.warn(
        { key, error: error instanceof Error ? error.message : String(error) },
        'Cooldown check failed; sending without it.',
      );
      return 0;
    }
  }

  private capKey(userId: string): string {
    return `comm:cap:${userId}:${new Date().toISOString().slice(0, 10)}`;
  }

  private async sentTodayCount(userId: string): Promise<number> {
    try {
      const raw = await this.redisService.getClient().get(this.capKey(userId));
      return raw ? Number(raw) || 0 : 0;
    } catch {
      return 0;
    }
  }

  private async countTowardsDailyCap(userId: string): Promise<void> {
    try {
      const client = this.redisService.getClient();
      const key = this.capKey(userId);
      await client.incr(key);
      await client.expire(key, 2 * 24 * 60 * 60);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Daily-cap counter update failed (ignored).',
      );
    }
  }

  // ---------------------------------------------------------------------
  // digests
  // ---------------------------------------------------------------------

  private async attachToDigest(
    tx: Prisma.TransactionClient,
    row: CommunicationOutbox,
    audience: CommunicationAudience,
    timezone: string | null,
    now: Date,
  ): Promise<void> {
    const kind = digestKind(audience);
    const windowEnd = nextLocalHour(now, timezone ?? 'UTC', DIGEST_LOCAL_HOUR);
    const windowStart = new Date(windowEnd.getTime() - 24 * 60 * 60 * 1000);
    const recipientUserId = row.recipientUserId!;

    // Oldest open window first, deterministically: without an order the
    // recipient's items could land in different windows on two runs and
    // arrive as two emails for the same day.
    let digest = await tx.communicationDigest.findFirst({
      where: { recipientUserId, kind, state: 'open', windowEnd: { gte: now } },
      orderBy: { windowEnd: 'asc' },
    });
    if (!digest) {
      // The create can lose the `(recipient, kind, window_start)` race with
      // a concurrent worker — and a failed statement ABORTS this
      // transaction, which is the DISPATCH transaction. Without the
      // savepoint the recovery read below runs on an aborted transaction
      // and fails with 25P02, turning "another worker got there first"
      // into a dead dispatch that the claim lease then has to time out.
      // Same reasoning, same helper, as `CommunicationService.emit`.
      digest = await withSavepoint(
        tx,
        async () =>
          tx.communicationDigest.create({
            data: { recipientUserId, kind, windowStart, windowEnd },
          }),
        {
          onCleanupError: (error) =>
            this.logger.warn(
              { error: error instanceof Error ? error.message : String(error) },
              'Could not roll back to the digest savepoint.',
            ),
        },
      ).catch(async (error) => {
        const raced = await tx.communicationDigest.findUnique({
          where: {
            recipientUserId_kind_windowStart: { recipientUserId, kind, windowStart },
          },
        });
        if (!raced) throw error;
        return raced;
      });
    }
    await tx.communicationOutbox.update({
      where: { id: row.id },
      data: { state: 'deferred', digestId: digest.id, availableAt: digest.windowEnd },
    });
    await tx.communicationDigest.update({
      where: { id: digest.id },
      data: { itemCount: { increment: 1 } },
    });
    this.metrics.recordOutbox(row.category, 'deferred');
    this.metrics.recordDigestItem(kind);
  }

  /** Hourly: every open window past its end becomes one email (or `empty`). */
  async sendDueDigests(): Promise<number> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId) return 0;
    const due = await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      tx.communicationDigest.findMany({
        where: { state: 'open', windowEnd: { lte: new Date() } },
        orderBy: { windowEnd: 'asc' },
        take: 100,
        select: { id: true },
      }),
    );
    let sent = 0;
    for (const { id } of due) {
      try {
        if (await this.sendDigest(platformOwnerId, id)) sent += 1;
      } catch (error) {
        this.logger.error(
          { digestId: id, error: error instanceof Error ? error.message : String(error) },
          'Digest send failed; it stays open for the next run.',
        );
      }
    }
    return sent;
  }

  /**
   * Turns ONE due window into ONE email.
   *
   * CLAIM. `communication_digests` has no `sending` state (open | sent |
   * empty), so the claim is `sent_at` itself: exactly one worker can move
   * it from NULL while the row is still `open`, and Postgres serialises
   * the UPDATE, so the loser sees `0 rows` and returns. A worker that
   * crashes after claiming leaves `sent_at` set on an `open` row; the
   * lease (`COMMUNICATION_CLAIM_LEASE_MS`) lets the next run reclaim it
   * rather than stranding the window forever, and the provider's
   * `idempotencyKey` (`digest-<id>`) is what stops that retry from being
   * a second email. `sent_at` on an `open` row therefore means "being
   * sent"; on a `sent` row it means what it says.
   *
   * PREFERENCES ARE RE-READ HERE, not trusted from attach time. An item
   * joins a window and is emailed up to 24 hours later; a recipient who
   * turns engagement email off in between has asked not to receive
   * exactly this email. Items they have since silenced are dropped from
   * the batch and settled as in-app-only, and a window with nothing left
   * becomes `empty` and sends nothing.
   */
  private async sendDigest(platformOwnerId: string, digestId: string): Promise<boolean> {
    const plan = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const now = new Date();
        if (!(await this.claimDigest(tx, digestId, now))) return null;

        const digest = await tx.communicationDigest.findUnique({
          where: { id: digestId },
        });
        if (!digest) return null;
        const items = await tx.communicationOutbox.findMany({
          where: { digestId, state: 'deferred' },
          orderBy: { createdAt: 'asc' },
        });
        if (items.length === 0) return this.closeEmptyDigest(tx, digestId);

        const recipient = await this.loadRecipient(tx, digest.recipientUserId);
        if (!recipient || (await this.suppression.isSuppressed(recipient.email))) {
          await tx.communicationOutbox.updateMany({
            where: { digestId, state: 'deferred' },
            data: { state: 'suppressed', lastError: 'recipient_unavailable' },
          });
          await this.scrubSettledRows(tx, items);
          return this.closeEmptyDigest(tx, digestId);
        }

        // A key the catalogue no longer knows cannot be rendered, so it
        // must not be reported as delivered either — it is settled as a
        // real failure, the way `decide` settles the same case.
        const unknown = items.filter((item) => !isCommunicationEventKey(item.key));
        if (unknown.length > 0) {
          await tx.communicationOutbox.updateMany({
            where: { id: { in: unknown.map((item) => item.id) } },
            data: { state: 'failed', lastError: 'unknown_key' },
          });
        }
        const known = items.filter((item) => isCommunicationEventKey(item.key));

        const preferences = resolveCommunicationPreferences(recipient.preferences, {
          isStaff: recipient.isStaff,
        });
        const silenced = known.filter(
          (item) => !this.allowedByPreference(item.category, preferences),
        );
        if (silenced.length > 0) {
          await this.settleAsInAppOnly(
            tx,
            silenced.map((item) => item.id),
            'preference_off',
          );
          await this.scrubSettledRows(tx, silenced);
        }
        const included = known.filter((item) =>
          this.allowedByPreference(item.category, preferences),
        );
        if (included.length === 0) return this.closeEmptyDigest(tx, digestId);

        const first = included[0];
        const firstEntry = COMMUNICATION_CATALOG[first.key as CommunicationEventKey];
        const branding = await this.brandingService.resolve(
          tx,
          firstEntry.branding,
          first.academyId,
        );
        const locale = this.resolveLocale(
          recipient.preferences,
          firstEntry,
          branding,
          first.locale,
        );
        const digestItems = [];
        for (const item of included) {
          const entry = COMMUNICATION_CATALOG[item.key as CommunicationEventKey];
          const itemBranding =
            item.academyId === first.academyId
              ? branding
              : await this.brandingService.resolve(tx, entry.branding, item.academyId);
          const rendered = this.render(item, entry, locale, itemBranding);
          const values = (item.values as Record<string, unknown> | null) ?? {};
          const path = entry.actionUrl?.({
            entity: { type: item.entityType ?? '', id: item.entityId ?? '' },
            values,
          });
          digestItems.push({
            subject: rendered.subject,
            url: path
              ? entry.branding === 'academy'
                ? this.links.onHost(itemBranding.host, path, locale)
                : this.links.platform(path)
              : null,
          });
        }
        const rendered = TemplateRegistry.render(
          DIGEST_TEMPLATE,
          locale,
          {
            branding: branding.branding,
            actionUrl: null,
            // Same rule as a single email's footer: a platform-branded
            // digest must not point at an academy host.
            settingsUrl: this.links.settings(
              locale,
              firstEntry.branding === 'academy' ? branding.host : null,
              firstEntry.audience,
            ),
          },
          { items: digestItems },
        );
        return {
          to: recipient.email,
          recipientUserId: digest.recipientUserId,
          rendered,
          itemIds: included.map((i) => i.id),
          // Rendered above; what `scrubSettledRows` needs once the send lands.
          items: included.map(({ id, key, values }) => ({ id, key, values })),
        };
      },
    );
    if (!plan) return false;

    let result;
    try {
      result = await this.transport.send({
        to: plan.to,
        subject: plan.rendered.subject,
        text: plan.rendered.text,
        html: plan.rendered.html,
        idempotencyKey: `digest-${digestId}`,
        tags: { key: DIGEST_TEMPLATE },
        // A digest exists to BATCH engagement mail; it is never security or
        // transactional, whatever the individual events inside it were.
        category: 'engagement',
      });
    } catch (error) {
      // Release the claim so the next hourly run retries this window
      // instead of it sitting `open` with a claimed `sent_at` until the
      // lease expires.
      await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
        this.releaseDigestClaim(tx, digestId),
      );
      throw error;
    }
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const sentAt = new Date();
      await tx.communicationDelivery.createMany({
        data: plan.itemIds.map((outboxId) => ({
          outboxId,
          channel: 'email' as const,
          provider: result.provider,
          providerMessageId: result.providerMessageId,
          status: 'sent' as const,
          attempts: 1,
          templateVersion: plan.rendered.version,
          sentAt,
        })),
      });
      await tx.communicationOutbox.updateMany({
        where: { id: { in: plan.itemIds } },
        data: { state: 'dispatched', dispatchedAt: sentAt },
      });
      await this.scrubSettledRows(tx, plan.items);
      await tx.communicationDigest.update({
        where: { id: digestId },
        // `itemCount` was incremented optimistically at attach time; what
        // is recorded now is what the recipient actually received.
        data: { state: 'sent', sentAt, itemCount: plan.itemIds.length },
      });
    });
    // A digest IS an email, so it counts against the recipient's daily
    // cap exactly like the messages it replaced would have.
    await this.countTowardsDailyCap(plan.recipientUserId);
    this.metrics.recordOutbox('engagement', 'dispatched');
    return true;
  }

  /**
   * `sent_at` as the claim marker — see `sendDigest`'s header. Returns
   * whether THIS worker owns the window.
   */
  private async claimDigest(
    tx: Prisma.TransactionClient,
    digestId: string,
    now: Date,
  ): Promise<boolean> {
    const leaseCutoff = new Date(now.getTime() - COMMUNICATION_CLAIM_LEASE_MS);
    const claimed = await tx.$executeRaw`
      UPDATE "communication_digests"
         SET "sent_at" = ${now}
       WHERE "id" = ${digestId}
         AND "state" = 'open'
         AND ("sent_at" IS NULL OR "sent_at" <= ${leaseCutoff})
    `;
    return claimed === 1;
  }

  private async releaseDigestClaim(
    tx: Prisma.TransactionClient,
    digestId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "communication_digests"
         SET "sent_at" = NULL
       WHERE "id" = ${digestId} AND "state" = 'open'
    `;
  }

  /** Closes a window that has nothing left to send, and drops its claim. */
  private async closeEmptyDigest(
    tx: Prisma.TransactionClient,
    digestId: string,
  ): Promise<null> {
    await tx.communicationDigest.update({
      where: { id: digestId },
      data: { state: 'empty', sentAt: null, itemCount: 0 },
    });
    return null;
  }

  /**
   * The preference question asked at SEND time, for one batched item.
   * Security, transactional and lifecycle are locked on in the preference
   * model and can never reach a digest anyway; engagement and operational
   * are the two a person can silence.
   */
  private allowedByPreference(
    category: string,
    preferences: CommunicationPreferences,
  ): boolean {
    if (category === 'engagement') return preferences.categories.engagement.email;
    if (category === 'operational')
      return preferences.categories.operational?.email ?? true;
    return true;
  }

  /**
   * The digest settle paths' `withoutCredentials`: rows settled in bulk
   * (`updateMany`) drop their scrub keys here, one UPDATE per row that
   * actually holds one. A key the catalogue no longer knows is left alone.
   */
  private async scrubSettledRows(
    tx: Prisma.TransactionClient,
    rows: readonly Pick<CommunicationOutbox, 'id' | 'key' | 'values'>[],
  ): Promise<void> {
    for (const row of rows) {
      if (!isCommunicationEventKey(row.key)) continue;
      const scrubbed = withoutCredentials(COMMUNICATION_CATALOG[row.key], row.values);
      if (scrubbed === undefined) continue;
      await tx.communicationOutbox.update({
        where: { id: row.id },
        data: { values: scrubbed },
      });
    }
  }

  /** The in-app row was already delivered; only the email half is dropped. */
  private async settleAsInAppOnly(
    tx: Prisma.TransactionClient,
    outboxIds: readonly string[],
    reason: string,
  ): Promise<void> {
    await tx.communicationOutbox.updateMany({
      where: { id: { in: [...outboxIds] } },
      data: { state: 'dispatched', dispatchedAt: new Date(), lastError: reason },
    });
    await tx.communicationDelivery.createMany({
      data: outboxIds.map((outboxId) => ({
        outboxId,
        channel: 'email' as const,
        status: 'suppressed' as const,
        errorCode: reason,
      })),
    });
  }

  // ---------------------------------------------------------------------
  // sweep & prune
  // ---------------------------------------------------------------------

  /** Re-enqueues every row that is due and not attached to a digest. Returns how many hints were queued. */
  async sweep(): Promise<number> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId) return 0;
    const due = await this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      tx.communicationOutbox.findMany({
        where: {
          state: { in: ['pending', 'deferred'] },
          digestId: null,
          availableAt: { lte: new Date() },
        },
        orderBy: { availableAt: 'asc' },
        take: 500,
        select: { id: true, attempts: true, availableAt: true },
      }),
    );
    // Ordered by `availableAt` ascending, so the first row of the page is
    // the globally oldest due row even when the backlog exceeds the page
    // size — the gauge does not need a second query.
    const oldestDue = due[0];
    // Publish the liveness gauge BEFORE enqueuing, so it reports the age
    // the queue actually had when the sweep found it. `due` is ordered by
    // `availableAt`, so the first row is the oldest; an empty queue is 0,
    // which is the healthy reading and the value an alert compares against.
    const now = Date.now();
    this.metrics.recordOldestPendingSeconds(
      oldestDue ? Math.round((now - oldestDue.availableAt.getTime()) / 1000) : 0,
    );

    let enqueued = 0;
    for (const row of due) {
      if (await this.producer.enqueueDispatch(row.id, row.attempts)) enqueued += 1;
    }
    return enqueued;
  }

  /**
   * Daily retention. Each DELETE is bounded twice: by the cutoff here and,
   * independently, by the table's `*_retention_delete` RLS policy.
   * `notifications` has no platform SELECT policy, so a WHERE clause would
   * make the DELETE see (and delete) nothing — the statement is therefore
   * unqualified and the `notifications_retention_delete` policy alone
   * decides which rows are old enough (180 d standard / 365 d extended).
   */
  async prune(): Promise<PruneResult> {
    const platformOwnerId = await this.platformOwnerId();
    if (!platformOwnerId)
      return { outbox: 0, deliveries: 0, digests: 0, notifications: 0 };
    const cutoff = new Date(
      Date.now() - COMMUNICATION_RETENTION_DAYS * 24 * 60 * 60 * 1000,
    );
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const deliveries =
        await tx.$executeRaw`DELETE FROM "communication_deliveries" WHERE "created_at" < ${cutoff}`;
      const outbox =
        await tx.$executeRaw`DELETE FROM "communication_outbox" WHERE "created_at" < ${cutoff}`;
      const digests =
        await tx.$executeRaw`DELETE FROM "communication_digests" WHERE "created_at" < ${cutoff}`;
      const notifications = await tx.$executeRaw`DELETE FROM "notifications"`;
      return { outbox, deliveries, digests, notifications };
    });
  }

  private async platformOwnerId(): Promise<string | null> {
    const owner = await this.usersRepository.findFirstPlatformOwnerId();
    if (owner) return owner.id;
    this.logger.warn(
      'No platform owner account exists yet — communications cannot be dispatched.',
    );
    return null;
  }
}

export function digestKind(audience: CommunicationAudience): string {
  switch (audience) {
    case 'learner':
      return 'learner_engagement_daily';
    case 'staff':
      return 'staff_daily';
    case 'platform':
      return 'platform_ops_daily';
  }
}

/**
 * The next `hour:00:00.000` in `timeZone`, strictly after `now`. Falls
 * back to UTC for an unknown zone. DST transitions inside the next 24 h
 * can shift the result by an hour, which is acceptable for a digest
 * boundary.
 *
 * THE MILLISECONDS MATTER. `window_start` is two thirds of
 * `communication_digests`'s `(recipient_user_id, kind, window_start)`
 * unique index — the index that is supposed to make "one digest per
 * recipient per window" a database fact rather than a hope. The zone
 * offset is therefore computed against a millisecond-free `now`, so the
 * boundary lands exactly on the hour: deriving it from `now.getTime()`
 * carries that instant's milliseconds into the result, and two workers
 * opening the same window a millisecond apart then compute two DIFFERENT
 * `window_start` values, collide on nothing, and mail the recipient two
 * digests for the same day.
 */
export function nextLocalHour(now: Date, timeZone: string, hour: number): Date {
  const zone = isValidTimeZone(timeZone) ? timeZone : 'UTC';
  const parts = localParts(now, zone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  // `localParts` has no millisecond field, so the reference instant must
  // not have one either — otherwise the offset absorbs it.
  const offsetMs = asUtc - (now.getTime() - now.getMilliseconds());
  let candidate = Date.UTC(parts.year, parts.month - 1, parts.day, hour, 0, 0) - offsetMs;
  if (candidate <= now.getTime()) candidate += 24 * 60 * 60 * 1000;
  return new Date(candidate);
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function localParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const read = (type: string): number =>
    Number(
      formatter.formatToParts(date).find((part) => part.type === type)?.value ?? '0',
    );
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour') % 24,
    minute: read('minute'),
    second: read('second'),
  };
}
