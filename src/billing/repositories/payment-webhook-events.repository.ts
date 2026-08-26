/**
 * PaymentWebhookEventsRepository — `payment_webhook_events` is the
 * idempotency ledger master plan §12/§18 scenario 8 require. `tryInsert`
 * is the one method that matters: it relies on the `(provider, event_id)`
 * unique constraint to make "has this exact event already been applied"
 * atomic with the insert itself — never a separate `findFirst` then
 * `create` (a real TOCTOU race under concurrent redelivery).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { PaymentWebhookEvent } from '@prisma/client';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class PaymentWebhookEventsRepository {
  /** Returns the created row, or `null` if `(provider, eventId)` was already recorded — the caller's signal to skip re-applying the event. */
  async tryInsert(
    tx: Prisma.TransactionClient,
    data: Prisma.PaymentWebhookEventCreateInput,
  ): Promise<PaymentWebhookEvent | null> {
    try {
      return await tx.paymentWebhookEvent.create({ data });
    } catch (error) {
      if (isUniqueConstraintViolation(error)) return null;
      throw error;
    }
  }
}
