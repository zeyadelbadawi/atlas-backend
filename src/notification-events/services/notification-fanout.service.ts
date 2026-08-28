/**
 * NotificationFanoutService — the ONE thing every other phase's service
 * injects to fire a notification (master plan §21 Phase P17, §12
 * "Notification fan-out": producer = "any notification-worthy domain
 * event", consumer = the fan-out logic here — this codebase's synchronous
 * BullMQ-free equivalent, see this class's own "why not a queue" note
 * below).
 *
 * Deliberate TWO-STEP call contract, mirroring master plan §21 P17's own
 * "business transaction succeeds → notification/event is created → email
 * delivery is attempted separately" instruction exactly:
 *
 * 1. `notify(tx, input)` — called INSIDE the caller's own already-open
 *    transaction (the exact same "reuse the caller's tx" discipline
 *    `AuditLogWriterService.write` established in P15). Writes ONLY the
 *    in-app `Notification` row (a plain Postgres insert, safe to
 *    co-locate with the business mutation) and returns whether it was
 *    newly created (`false` = a deduped retry, see `dedupeKey`).
 * 2. `sendEmailAfterCommit(userId, wasNewlyCreated, email)` — called
 *    AFTER the caller's transaction has actually committed (i.e. after
 *    the `await this.prisma.$transaction(...)`/`runInTenantContext(...)`
 *    call that wrapped step 1 has returned successfully). Never inside
 *    the same transaction — this is the concrete mechanism by which "a
 *    successful purchase must not become a failed purchase simply
 *    because email delivery failed" (master plan §21 P17) is
 *    structurally guaranteed, not just hoped for: by the time this runs,
 *    there is no open transaction left for an email failure to roll back.
 *
 * Why not a BullMQ queue for step 2 (master plan §12 nominally assigns
 * this to a `notification-worker`/`email-worker`): every existing BullMQ
 * queue in this codebase (`payment-webhook`, `tenant-usage-recompute`,
 * `password-reset-email`) is registered per-module, and this service is
 * injected from many DIFFERENT modules (billing, course-commerce,
 * provisioning, support, identity) — queuing here would mean either a
 * new queue registered in `NotificationEventsModule` (itself fine) or
 * duplicating queue registration per caller module. Given `EmailService.
 * sendTemplated` ALREADY never throws and is a single fast HTTP call
 * (§7's own "don't queue what's clearly synchronous... only genuinely
 * async work" carve-out doesn't obviously apply either way here), this
 * phase keeps step 2 a plain async method call rather than adding a new
 * queue — a reasoned, documented scope decision (`Reports/
 * ARCHITECTURE.md`'s P17 section), not an oversight. Revisit if email
 * volume/latency ever makes this a real bottleneck.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { NotificationsRepository } from '../repositories/notifications.repository';
import type { CreateNotificationInput } from '../repositories/notifications.repository';
import { EmailService } from './email.service';
import type { EmailTemplateKey } from '../templates/email-templates';
import { resolveNotificationPreferences } from '../notification-preferences.util';

export type FanOutInput = CreateNotificationInput;

export interface EmailDispatch {
  readonly template: EmailTemplateKey;
  readonly values?: Record<string, unknown>;
}

@Injectable()
export class NotificationFanoutService {
  constructor(
    private readonly notificationsRepository: NotificationsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly emailService: EmailService,
  ) {}

  /** Step 1 — call inside the caller's own open transaction. */
  notify(tx: Prisma.TransactionClient, input: FanOutInput): Promise<boolean> {
    return this.notificationsRepository.create(tx, input);
  }

  /**
   * Step 2 — call only after the caller's transaction has committed.
   * No-ops on a deduped retry (`wasNewlyCreated === false`) or when the
   * recipient has email notifications turned off — the same
   * `resolveNotificationPreferences` default `NotificationsService`'s own
   * `GET .../preferences` uses, so the two can never silently disagree
   * about what "email enabled" means for a user who has never touched
   * this setting.
   */
  async sendEmailAfterCommit(
    userId: string,
    wasNewlyCreated: boolean,
    email: EmailDispatch,
  ): Promise<void> {
    if (!wasNewlyCreated) return;

    const user = await this.usersRepository.findById(userId);
    if (!user) return;

    const preferences = resolveNotificationPreferences(user.preferences);
    if (!preferences.email) return;

    await this.emailService.sendTemplated(user.email, email.template, email.values);
  }
}
