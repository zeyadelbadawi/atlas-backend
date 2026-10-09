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
 *
 * A10 — REPLAY PROTECTION. A captured delivery used to be acceptable again
 * and again: Resend's Svix signature is only time-bounded (five minutes
 * either side, exactly the official `standardwebhooks`/`svix` verifier's
 * `WEBHOOK_TOLERANCE_IN_SECONDS`, which itself keeps no record of ids), and
 * Brevo's URL secret is not bound to the request at all. Each verified
 * delivery is now claimed once in Redis (`SET NX`, 24 h for a Svix id —
 * longer than the tolerance window and than Svix's retry schedule needs
 * after a 2xx — and 7 days per Brevo event): a Svix delivery by its
 * signed `svix-id`; a provider without delivery ids per event (message id,
 * event, timestamp, recipient). A replay is answered 202 with nothing
 * enqueued. If enqueueing fails the claims are released so the provider's
 * own retry is processed; if Redis itself is unavailable the request is
 * processed rather than dropped (event processing is idempotent — the
 * claim stops replays, it is not what makes a duplicate harmless).
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
import { createHash } from 'node:crypto';
import { CommunicationsWebhookProducer } from '../queue/communications-webhook.producer';
import { CommunicationMetricsService } from '../services/communication-metrics.service';
import { RedisService } from '../../redis/redis.service';
import type { EmailWebhookEvent } from '../../identity/services/email-provider.interface';

/** A Svix delivery id is honoured once for a day — far beyond the 5-minute signature window. */
export const WEBHOOK_DELIVERY_CLAIM_TTL_SECONDS = 24 * 60 * 60;
/** Per-event claims (providers with no delivery id) are kept for a week. */
export const WEBHOOK_EVENT_CLAIM_TTL_SECONDS = 7 * 24 * 60 * 60;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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
    private readonly redis: RedisService,
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
    const parsed = provider.parseWebhookEvents(body);
    const deliveryId = provider.webhookDeliveryId?.(headers);

    // A10 — claim before enqueueing; a replay claims nothing.
    const claimed: string[] = [];
    let events: EmailWebhookEvent[];
    if (deliveryId) {
      const key = `webhook:email:${provider.name}:delivery:${digest(deliveryId)}`;
      if (!(await this.claim(key, WEBHOOK_DELIVERY_CLAIM_TTL_SECONDS))) {
        return { received: true, events: 0 };
      }
      claimed.push(key);
      events = parsed;
    } else {
      events = [];
      for (const event of parsed) {
        const key = `webhook:email:${provider.name}:event:${digest(
          [
            event.providerMessageId,
            event.event,
            event.occurredAt.toISOString(),
            event.recipientEmail.toLowerCase(),
          ].join('\n'),
        )}`;
        if (await this.claim(key, WEBHOOK_EVENT_CLAIM_TTL_SECONDS)) {
          claimed.push(key);
          events.push(event);
        }
      }
    }

    try {
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
    } catch (error) {
      // Let the provider's own retry through: an unprocessed delivery must
      // not stay claimed.
      await this.release(claimed);
      throw error;
    }
    return { received: true, events: events.length };
  }

  /** `true` when this key was not seen before (or Redis cannot say — fail open, see above). */
  private async claim(key: string, ttlSeconds: number): Promise<boolean> {
    try {
      const result = await this.redis.getClient().set(key, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Email webhook replay check unavailable; processing the delivery.',
      );
      return true;
    }
  }

  private async release(keys: readonly string[]): Promise<void> {
    if (keys.length === 0) return;
    await this.redis
      .getClient()
      .del(...keys)
      .catch(() => undefined);
  }
}
