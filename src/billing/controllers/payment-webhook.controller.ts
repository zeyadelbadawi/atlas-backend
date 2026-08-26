/**
 * PaymentWebhookController — `POST /payments/webhook`. Public (no
 * `JwtAuthGuard` — a payment provider is not an authenticated Atlas user);
 * signature verification is the actual authorization boundary (master plan
 * §16: "HMAC signature verification on every inbound payment/provider
 * webhook"). No real gateway calls this in this phase (§21 P12: "not yet
 * connected") — real, callable, idempotent infrastructure, never a faked
 * integration (rule 10).
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PaymentWebhookService } from '../services/payment-webhook.service';
import { PaymentWebhookProducer } from '../queue/payment-webhook.producer';
import { PaymentWebhookEventDto } from '../dto/payment-webhook-event.dto';
import { buildWebhookCanonicalPayload } from '../utils/webhook-signature.util';
import type { BillingConfig } from '../../config/configuration';

/** The header a future gateway adapter's normalized webhook call would carry the HMAC signature in — see `webhook-signature.util.ts`'s own doc comment for why this is Atlas's own defined scheme, not a specific real provider's. */
export const PAYMENT_WEBHOOK_SIGNATURE_HEADER = 'x-atlas-webhook-signature';

@Controller('payments')
export class PaymentWebhookController {
  private readonly billingConfig: BillingConfig;

  constructor(
    private readonly paymentWebhookService: PaymentWebhookService,
    private readonly paymentWebhookProducer: PaymentWebhookProducer,
    configService: ConfigService,
  ) {
    this.billingConfig = configService.getOrThrow<BillingConfig>('billing');
  }

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Body() event: PaymentWebhookEventDto,
    @Headers(PAYMENT_WEBHOOK_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<{ received: true }> {
    const canonicalPayload = buildWebhookCanonicalPayload(event);
    const valid = this.paymentWebhookService.verifySignature(
      canonicalPayload,
      signature,
      this.billingConfig,
    );
    if (!valid) {
      throw new BadRequestException({
        messageKey: 'errors.payment.invalidWebhookSignature',
      });
    }

    const organizationId =
      await this.paymentWebhookService.resolveOrganizationForEvent(event);
    if (!organizationId) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    await this.paymentWebhookProducer.enqueue({
      provider: PaymentWebhookService.PROVIDER,
      eventId: event.id,
      eventType: event.type,
      paymentId: event.paymentId,
      occurredAt: event.occurredAt,
    });

    return { received: true };
  }
}
