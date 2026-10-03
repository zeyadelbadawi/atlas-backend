/**
 * PlatformContactIntakeService — `POST public/contact`, the Atlas
 * marketing homepage's contact form.
 *
 * ONE ANSWER FOR EVERYTHING ACCEPTED. A stored enquiry, a duplicate, a
 * honeypot hit and a too-fast submission all return the same
 * `{ received: true }`. The response never names a row and never echoes
 * the address, so the endpoint cannot be used to learn which checks exist
 * or whether an address has written before. Only malformed input (400)
 * and the per-IP throttle (429) are visible from outside.
 *
 * LAYERS, cheapest first:
 *   1. the route throttle (5 / 10 min / IP) and the global one — in the
 *      controller, before this service runs;
 *   2. the honeypot (`company`) — discard;
 *   3. the minimum fill time (`startedAt`) — discard;
 *   4. dedupe: the same address + message within 10 minutes is stored
 *      once (`SET NX EX` in Redis);
 *   5. the INSERT itself, in a context-less transaction — the only context
 *      the table's RLS INSERT policy admits.
 *
 * NOTIFYING ATLAS. After the row has COMMITTED, every active Platform
 * Owner gets an in-app notification and an email through the
 * communications outbox. That runs in its own transactions, after the
 * response is sent, and is best-effort by design: the enquiry is the
 * asset, and no failure in the notification path (no owner account yet,
 * an outbox write error, a provider outage later in the worker) may lose
 * or roll it back, or delay the visitor's answer. Fan-outs run one at a
 * time on a single in-process lane (bounded database pressure under a
 * burst) and the lane is drained on application shutdown. The enquiry is
 * always visible in the Platform Owner's inbox regardless.
 */
import { Injectable, Logger, type BeforeApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import type { IdentityConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { CommunicationService } from '../../communications/services/communication.service';
import { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import type { SubmitPlatformContactDto } from '../dto/submit-platform-contact.dto';
import type { PlatformContactReceiptResponse } from '../dto/platform-contact-submission.contract';
import {
  PLATFORM_CONTACT_DEDUPE_TTL_SECONDS,
  PLATFORM_CONTACT_LIMITS,
  PLATFORM_CONTACT_MIN_FILL_MS,
  PLATFORM_CONTACT_NOTIFICATION,
} from '../platform-contact.constants';

export interface PlatformContactRequestMeta {
  readonly ip?: string;
  readonly userAgent?: string;
}

/** Why a submission was accepted without being stored. Logged, never returned. */
export type PlatformContactDiscardReason = 'honeypot' | 'too_fast' | 'duplicate';

const RECEIPT: PlatformContactReceiptResponse = { received: true };

/** A `startedAt` further in the past than this is a stale tab, not a signal. */
const MAX_PLAUSIBLE_SKEW_MS = 24 * 60 * 60 * 1000;

const DEDUPE_KEY_PREFIX = 'platform-contact:dedupe:';
const IP_HASH_KEY_LABEL = 'atlas:platform-contact:ip-hash:v1';
const EMAIL_MESSAGE_EXCERPT = 1000;
const NOTIFY_BATCH_SIZE = 20;

@Injectable()
export class PlatformContactIntakeService implements BeforeApplicationShutdown {
  private readonly logger = new Logger(PlatformContactIntakeService.name);
  private readonly ipHashKey: Buffer;
  private notificationLane: Promise<void> = Promise.resolve();

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly repository: PlatformContactSubmissionsRepository,
    private readonly redisService: RedisService,
    private readonly usersRepository: UsersRepository,
    private readonly communicationService: CommunicationService,
    configService: ConfigService,
  ) {
    // A key DERIVED from the server's signing secret with a fixed label,
    // so the IP hash is salted with a server-only value without adding
    // another secret to provision — and is useless to anyone holding only
    // the database. Rotating the signing secret simply starts new hashes.
    const secret = configService.getOrThrow<IdentityConfig>('identity').jwtAccessSecret;
    this.ipHashKey = createHmac('sha256', secret).update(IP_HASH_KEY_LABEL).digest();
  }

  async submit(
    payload: SubmitPlatformContactDto,
    meta: PlatformContactRequestMeta,
    now: Date = new Date(),
  ): Promise<PlatformContactReceiptResponse> {
    const discard = this.screen(payload, now);
    if (discard) return this.discarded(discard);

    const dedupeKey = this.dedupeKey(payload.email, payload.message);
    if (!(await this.claimDedupe(dedupeKey))) return this.discarded('duplicate');

    let id: string;
    try {
      id = await this.tenancyContextService.runWithoutContext((tx) =>
        this.repository.insertAnonymous(tx, {
          name: payload.name,
          email: payload.email,
          organizationName: payload.organizationName ?? null,
          topic: payload.topic,
          message: payload.message,
          locale: payload.locale ?? 'en',
          sourcePath: payload.sourcePath ?? null,
          ipHash: this.hashIp(meta.ip),
          userAgent: meta.userAgent
            ? meta.userAgent.slice(0, PLATFORM_CONTACT_LIMITS.userAgentMax)
            : null,
        }),
      );
    } catch (error) {
      // Release the claim, so the person's retry is not swallowed as a
      // "duplicate" of a message that was never stored.
      await this.releaseDedupe(dedupeKey);
      throw error;
    }

    // Not awaited: the visitor's answer must not wait on (or depend on)
    // fanning out to every owner. Queued on ONE lane, so a burst of
    // enquiries can never run many fan-outs at once and starve the shared
    // database pool; shutdown drains the lane.
    this.enqueueNotification(() => this.notifyPlatformOwners(id, payload));
    return RECEIPT;
  }

  /** Waits until the notification lane is empty. Used on shutdown and by tests. */
  async drainNotifications(): Promise<void> {
    let tail: Promise<void>;
    do {
      tail = this.notificationLane;
      await tail;
    } while (tail !== this.notificationLane);
  }

  // Before shutdown, not on it: the communications queue closes in
  // `onApplicationShutdown`, and the lane still needs it to enqueue.
  async beforeApplicationShutdown(): Promise<void> {
    await this.drainNotifications();
  }

  private enqueueNotification(work: () => Promise<void>): void {
    // `notifyPlatformOwners` never rejects; the catch only keeps one
    // unexpected failure from breaking the lane for every later enquiry.
    this.notificationLane = this.notificationLane.then(work).catch(() => undefined);
  }

  /** The cheap, local checks. Returns why to discard, or `null` to continue. */
  screen(
    payload: SubmitPlatformContactDto,
    now: Date,
  ): PlatformContactDiscardReason | null {
    if ((payload.company ?? '').trim().length > 0) return 'honeypot';
    const elapsed = now.getTime() - payload.startedAt;
    // A NEGATIVE elapsed time means the visitor's clock runs ahead of
    // ours; that says nothing about whether a person typed the message,
    // so it is accepted rather than silently dropping a real enquiry.
    if (elapsed >= 0 && elapsed < PLATFORM_CONTACT_MIN_FILL_MS) return 'too_fast';
    if (elapsed < -MAX_PLAUSIBLE_SKEW_MS) return 'too_fast';
    return null;
  }

  private discarded(
    reason: PlatformContactDiscardReason,
  ): PlatformContactReceiptResponse {
    // The reason only — never the address, the name or the message.
    this.logger.log({ reason }, 'Platform contact submission accepted without storing.');
    return RECEIPT;
  }

  private dedupeKey(email: string, message: string): string {
    const digest = createHash('sha256')
      .update(email.trim().toLowerCase())
      .update('\n')
      .update(message.trim())
      .digest('hex');
    return `${DEDUPE_KEY_PREFIX}${digest}`;
  }

  /**
   * `true` when this is the first identical submission in the window.
   * FAILS OPEN: if Redis is unreachable the enquiry is stored — a possible
   * duplicate in the inbox is a far smaller cost than a lost lead.
   */
  private async claimDedupe(key: string): Promise<boolean> {
    try {
      const result = await this.redisService
        .getClient()
        .set(key, '1', 'EX', PLATFORM_CONTACT_DEDUPE_TTL_SECONDS, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Platform contact dedupe unavailable; storing without it.',
      );
      return true;
    }
  }

  private async releaseDedupe(key: string): Promise<void> {
    try {
      await this.redisService.getClient().del(key);
    } catch {
      // The key expires on its own; nothing more to do.
    }
  }

  /** Keyed SHA-256 of the client address — the raw address is never stored. */
  hashIp(ip: string | undefined): string {
    return createHmac('sha256', this.ipHashKey)
      .update(ip ?? 'unknown')
      .digest('hex');
  }

  /**
   * In-app + email to every active Platform Owner, after the enquiry has
   * committed. Never throws — see the file header.
   */
  private async notifyPlatformOwners(
    submissionId: string,
    payload: SubmitPlatformContactDto,
  ): Promise<void> {
    try {
      const anchor = await this.usersRepository.findFirstPlatformOwnerId();
      if (!anchor) {
        this.logger.warn(
          { submissionId },
          'No platform owner account exists; contact enquiry stored without a notification.',
        );
        return;
      }
      const ownerIds = await this.tenancyContextService.runInUserContext(
        anchor.id,
        async (tx) =>
          (
            await tx.user.findMany({
              where: { isPlatformOwner: true, status: 'active', deletedAt: null },
              select: { id: true },
              orderBy: { createdAt: 'asc' },
            })
          ).map((owner) => owner.id),
      );
      const values = {
        name: payload.name,
        email: payload.email,
        organizationName: payload.organizationName ?? '',
        topic: payload.topic,
        message: payload.message.slice(0, EMAIL_MESSAGE_EXCERPT),
      };
      // Bounded transactions: each emit is a handful of statements, and one
      // transaction per batch keeps every batch far inside the interactive
      // transaction timeout however many owner accounts exist. A failed
      // batch does not stop the others.
      for (let start = 0; start < ownerIds.length; start += NOTIFY_BATCH_SIZE) {
        const batch = ownerIds.slice(start, start + NOTIFY_BATCH_SIZE);
        try {
          const outboxIds = await this.tenancyContextService.runInUserContext(
            anchor.id,
            async (tx) => {
              const ids: (string | null)[] = [];
              // Deleted while queued: emit nothing, so no email about a
              // deleted enquiry is ever sent (see `lockIfExists`).
              if (!(await this.repository.lockIfExists(tx, submissionId))) return ids;
              for (const recipientUserId of batch) {
                const emitted = await this.communicationService.emit(tx, {
                  key: PLATFORM_CONTACT_NOTIFICATION.key,
                  recipientUserId,
                  entity: {
                    type: PLATFORM_CONTACT_NOTIFICATION.entityType,
                    id: submissionId,
                  },
                  values,
                });
                ids.push(emitted.outboxId);
              }
              return ids;
            },
          );
          for (const outboxId of outboxIds) {
            await this.communicationService.enqueueAfterCommit(outboxId);
          }
        } catch (error) {
          this.logger.error(
            {
              submissionId,
              error: error instanceof Error ? error.message : String(error),
            },
            'Contact enquiry stored, but notifying a batch of platform owners failed.',
          );
        }
      }
    } catch (error) {
      this.logger.error(
        {
          submissionId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Contact enquiry stored, but notifying platform owners failed.',
      );
    }
  }
}
