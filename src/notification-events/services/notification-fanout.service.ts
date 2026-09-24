/**
 * NotificationFanoutService — the P17 fan-out, kept as a THIN FAÇADE over
 * the in-app writer now that delivery lives in the P64 outbox
 * (`CommunicationService.emit` in `src/communications/`).
 *
 * `notify(tx, input)` still writes ONLY the in-app `Notification` row
 * inside the caller's open transaction and reports whether it was newly
 * created — the seam the notifications e2e suite and any caller that only
 * ever wanted the feed keep using. Everything that used to follow it
 * (`sendEmailAfterCommit`, `EmailService`, the English-only templates) is
 * gone: every domain event now names a catalogue key and lets the
 * dispatcher decide channels, locale, branding and preferences. There is
 * no second way to send an email from a domain service.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { NotificationsRepository } from '../repositories/notifications.repository';
import type { CreateNotificationInput } from '../repositories/notifications.repository';

export type FanOutInput = CreateNotificationInput;

@Injectable()
export class NotificationFanoutService {
  constructor(private readonly notificationsRepository: NotificationsRepository) {}

  /** Writes the in-app row inside the caller's own transaction; `false` = deduped retry. */
  notify(tx: Prisma.TransactionClient, input: FanOutInput): Promise<boolean> {
    return this.notificationsRepository.create(tx, input);
  }
}
