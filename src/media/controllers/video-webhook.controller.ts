/**
 * `POST /webhooks/video/stream` — inbound video-provider events (master
 * plan Phase 2 §D.4, §I, §L).
 *
 * PUBLIC BY NECESSITY, AUTHORIZED BY SIGNATURE. The provider is not an
 * authenticated Atlas user, so there is no JWT to check; the HMAC IS the
 * authorization boundary — exactly the model
 * `LiveProviderWebhookController` and `PaymentWebhookController` already
 * establish, and for exactly the same reason.
 *
 * VERIFIED AGAINST THE RAW BYTES. The provider signs the exact body it
 * sent, so verification runs against `request.rawBody` (captured for this
 * path only, see `main.ts`) rather than a re-serialized object.
 * `JSON.stringify` of the parsed body is not byte-identical — key order,
 * whitespace and unicode escaping all differ — so verifying against it
 * would fail unpredictably, which is the worst kind of security bug
 * because it looks like it works.
 *
 * NOTHING IS WRITTEN BEFORE VERIFICATION SUCCEEDS, and a forged body
 * naming a real asset is refused because the attacker does not hold the
 * signing secret.
 *
 * ALWAYS 200 ONCE VERIFIED. Providers retry non-2xx deliveries, so a
 * processing failure must not cause a redelivery storm. Failures surface
 * in the application log and are recovered by the status poll.
 *
 * NOTHING SENSITIVE IS LOGGED: no signature, no secret, no raw payload.
 */
import {
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { VideoProviderRegistry } from '../video/video-provider.registry';
import { VideoReconciliationService } from '../services/video-reconciliation.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';

/** Cloudflare Stream's own header name. Fixed by the provider, not by Atlas. */
const SIGNATURE_HEADER = 'webhook-signature';

@Controller('webhooks/video')
export class VideoWebhookController {
  private readonly logger = new Logger(VideoWebhookController.name);

  constructor(
    private readonly videoProviders: VideoProviderRegistry,
    private readonly reconciliation: VideoReconciliationService,
    private readonly metrics: LearningMetricsService,
  ) {}

  @Post('stream')
  @HttpCode(HttpStatus.OK)
  async handle(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers(SIGNATURE_HEADER) signatureHeader: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      // The raw body is captured per-path in `main.ts`. Its absence means
      // this route was reached without that capture — a configuration
      // error, and one that must fail closed rather than fall back to
      // verifying a re-serialized body.
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    // SEC-5 — every webhook-capable adapter is tried, not the
    // process-wide default. See `VideoProviderRegistry.webhookCapable`
    // for why that is both necessary and safe.
    const verifier = this.videoProviders
      .webhookCapable()
      .find((provider) => provider.verifyWebhookSignature({ rawBody, signatureHeader }));

    if (!verifier) {
      // Counted by the alert in Phase 2 §U ("webhook signature failures
      // (any → alert)"). The reason is deliberately not disclosed.
      // §U alerts on ANY signature failure, so it is counted as well as
      // logged — a log line nobody greps is not an alert.
      this.metrics.recordWebhookSignatureFailure();
      this.logger.warn('Video webhook signature verification failed.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    // Parsed by the SAME adapter that verified it — a body is only ever
    // in one provider's shape.
    const event = verifier.parseWebhookEvent(rawBody);
    if (!event) return { received: true };

    try {
      await this.reconciliation.applyEvent(event);
    } catch (error) {
      this.logger.error(
        {
          providerId: event.providerId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Verified video webhook could not be applied; the status poll will recover it.',
      );
    }
    return { received: true };
  }
}
