/**
 * `POST /webhooks/email/:provider` — inbound delivery events from the
 * email providers (P64 Communications).
 *
 * PUBLIC BY NECESSITY, AUTHORIZED BY THE ADAPTER. No JWT — a provider is
 * not an Atlas user; `verifyWebhook` on the named adapter IS the
 * authorization boundary (Svix HMAC for Resend, shared URL secret for
 * Brevo), the same model `VideoWebhookController` and
 * `PaymentWebhookController` already use.
 *
 * VERIFIED AGAINST THE RAW BYTES (`request.rawBody`, captured for this
 * path only in `main.ts` / the e2e app factory) — a re-serialised body is
 * not byte-identical. Missing raw body fails closed.
 *
 * NOTHING IS WRITTEN BEFORE VERIFICATION SUCCEEDS. Once verified the
 * events are enqueued and 202 is returned; processing failures never
 * cause a redelivery storm. Nothing sensitive is logged: no secret, no
 * signature, no address, no raw payload.
 */
import {
  Controller,
  HttpCode,
  Inject,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  WEBHOOK_URL_SECRET_HEADER,
  type EmailProviderAdapter,
  type WebhookHeaders,
} from '../../identity/services/email-provider.interface';
import { CommunicationsWebhookProducer } from '../queue/communications-webhook.producer';
import { CommunicationMetricsService } from '../services/communication-metrics.service';

/** The webhook-capable adapters, by name — provided by `CommunicationsProvidersModule`. */
export const EMAIL_WEBHOOK_ADAPTERS = Symbol('EMAIL_WEBHOOK_ADAPTERS');

@Controller('webhooks/email')
export class EmailWebhookController {
  private readonly logger = new Logger(EmailWebhookController.name);

  constructor(
    @Inject(EMAIL_WEBHOOK_ADAPTERS)
    private readonly adapters: readonly EmailProviderAdapter[],
    private readonly producer: CommunicationsWebhookProducer,
    private readonly metrics: CommunicationMetricsService,
  ) {}

  @Post(':provider')
  @HttpCode(HttpStatus.ACCEPTED)
  async handle(
    @Param('provider') providerName: string,
    @Query('secret') urlSecret: string | undefined,
    @Req() request: Request & { rawBody?: Buffer },
  ): Promise<{ received: true; events: number }> {
    const wanted = providerName.toLowerCase();
    const provider = this.adapters.find((adapter) => adapter.name === wanted);
    if (!provider || !provider.capabilities().supportsWebhooks) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const headers: WebhookHeaders = {
      ...(request.headers as WebhookHeaders),
      ...(typeof urlSecret === 'string'
        ? { [WEBHOOK_URL_SECRET_HEADER]: urlSecret }
        : {}),
    };
    if (!provider.verifyWebhook(headers, rawBody)) {
      this.metrics.recordWebhookSignatureFailure(provider.name);
      this.logger.warn({ provider: provider.name }, 'Email webhook verification failed.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return { received: true, events: 0 };
    }
    const events = provider.parseWebhookEvents(body);
    for (const event of events) {
      await this.producer.enqueue({
        provider: provider.name,
        providerMessageId: event.providerMessageId,
        recipientEmail: event.recipientEmail,
        event: event.event,
        occurredAt: event.occurredAt.toISOString(),
        reason: event.reason,
      });
    }
    return { received: true, events: events.length };
  }
}
