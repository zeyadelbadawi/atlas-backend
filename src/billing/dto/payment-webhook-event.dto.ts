/**
 * `POST /payments/webhook` request body — the normalized
 * `PaymentWebhookEvent` shape the frontend already documents as a future
 * contract (`payment.types.ts`: "documentation for the future backend, not
 * consumed by any frontend runtime code path... Provider-specific payload
 * names... must be normalized to this shape before reaching the core
 * payment domain"). No real gateway sends this in this phase (master plan
 * §21 P12: "not yet connected") — signature verification
 * (`PaymentWebhookService.verifySignature`) is what actually gates
 * whether an event is trusted, not this DTO's shape alone.
 */
import { IsIn, IsISO8601, IsNotEmpty, IsString } from 'class-validator';

const PAYMENT_WEBHOOK_EVENT_TYPES = [
  'payment.created',
  'payment.processing',
  'payment.requires_action',
  'payment.succeeded',
  'payment.failed',
  'payment.cancelled',
  'payment.expired',
  'refund.created',
  'refund.succeeded',
  'refund.failed',
] as const;

export class PaymentWebhookEventDto {
  @IsNotEmpty()
  @IsString()
  readonly id!: string;

  @IsIn(PAYMENT_WEBHOOK_EVENT_TYPES)
  readonly type!: (typeof PAYMENT_WEBHOOK_EVENT_TYPES)[number];

  @IsNotEmpty()
  @IsString()
  readonly paymentId!: string;

  @IsISO8601()
  readonly occurredAt!: string;
}
