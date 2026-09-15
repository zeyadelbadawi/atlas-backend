/**
 * `POST /live-sessions/webhook` — inbound Zoom events.
 *
 * PUBLIC BY NECESSITY, AUTHORIZED BY SIGNATURE. Zoom is not an
 * authenticated Atlas user, so there is no JWT to check; the HMAC
 * signature IS the authorization boundary, exactly as
 * `PaymentWebhookController` already establishes for payment providers.
 *
 * VERIFIED AGAINST THE RAW BYTES. Zoom signs the exact body it sent, so
 * the signature is checked against `request.rawBody` (captured for this
 * path only, see `main.ts`) rather than a re-serialized object.
 * `JSON.stringify` of the parsed body is not byte-identical — key order,
 * whitespace and unicode escaping all differ — so verifying against it
 * would fail unpredictably, which is the worst kind of security bug
 * because it looks like it works.
 *
 * WHICH ACADEMY'S SECRET. The signature can only be checked with the
 * secret of the academy that owns the meeting, and the body cannot be
 * trusted to say which academy that is. So the meeting id is read from
 * the (still unverified) payload and used ONLY to look up a candidate
 * connection; the signature is then verified with THAT academy's stored
 * secret. A forged body naming another tenant's meeting fails
 * verification, because the attacker does not hold that tenant's secret.
 * Nothing is written before verification succeeds.
 *
 * ALWAYS 200 ONCE VERIFIED. Zoom retries non-2xx deliveries, so a
 * processing failure must not cause an infinite redelivery storm — the
 * event is persisted and queued, and failures are visible in
 * `live_provider_events` rather than as repeated inbound traffic.
 *
 * NOTHING SENSITIVE IS LOGGED: no signature, no secret, no raw payload.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { ConfigService } from '@nestjs/config';
import { ZoomProvider } from '../providers/zoom.provider';
import type { ZoomConfig } from '../../config/configuration';
import { LiveProviderEventsRepository } from '../repositories/live-provider-events.repository';
import { LiveProviderEventProducer } from '../queue/live-provider-event.producer';
import { extractZoomEvent } from '../utils/zoom-event.util';

/** Zoom's own headers. Names are fixed by the provider, not by Atlas. */
const ZOOM_SIGNATURE_HEADER = 'x-zm-signature';
const ZOOM_TIMESTAMP_HEADER = 'x-zm-request-timestamp';

/**
 * How much clock skew is tolerated on a delivery.
 *
 * Bounded on purpose: without it, a signature captured once stays valid
 * forever and can be replayed indefinitely. Five minutes is Zoom's own
 * documented guidance and is generous for real network delay.
 */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

@Controller('live-sessions')
export class LiveProviderWebhookController {
  private readonly logger = new Logger(LiveProviderWebhookController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly zoomProvider: ZoomProvider,
    private readonly eventsRepository: LiveProviderEventsRepository,
    private readonly producer: LiveProviderEventProducer,
  ) {}

  /**
   * Atlas's ONE app-level webhook secret.
   *
   * Zoom issues a single Secret Token per application and signs events
   * from every authorized customer account with it — so there is exactly
   * one secret here, never a per-academy lookup.
   */
  private webhookSecretToken(): string | undefined {
    return this.configService.get<ZoomConfig>('zoom')?.webhookSecretToken;
  }

  @Post('webhook')
  @HttpCode(200)
  async handle(
    @Req() request: Request & { rawBody?: Buffer },
    @Body() body: unknown,
    @Headers(ZOOM_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(ZOOM_TIMESTAMP_HEADER) timestamp: string | undefined,
  ): Promise<{ received: true } | { plainToken: string; encryptedToken: string }> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      // The raw-body hook did not run, which means the path changed and
      // this endpoint can no longer verify anything. Fail closed and loudly
      // rather than silently accepting unverifiable traffic.
      this.logger.error('Webhook raw body unavailable — refusing to process.');
      throw new BadRequestException({ messageKey: 'errors.badRequest' });
    }

    if (!signature || !timestamp) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    // REPLAY WINDOW. Checked before any lookup, so a stale capture costs
    // nothing beyond a rejected request.
    const sentAtMs = Number(timestamp) * 1000;
    if (
      !Number.isFinite(sentAtMs) ||
      Math.abs(Date.now() - sentAtMs) > MAX_TIMESTAMP_SKEW_MS
    ) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const extracted = extractZoomEvent(body);
    if (!extracted) {
      // Unverifiable: without a meeting id there is no secret to check
      // against, so this is refused exactly like a bad signature. See the
      // uniform-refusal note below for why they must not differ.
      this.logger.warn('Webhook payload could not be interpreted — refused.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    /*
      SIGNATURE FIRST, TENANT SECOND — and that ordering is the whole
      point of the app-level model.

      Atlas owns ONE Zoom application, so Zoom issues ONE Secret Token and
      signs every customer's events with it. That means the signature can
      be checked before anything is looked up, which removes an entire
      class of problem the per-academy design had: it needed to pick a
      tenant's secret using a meeting id read from a body nobody had
      authenticated yet. That pre-verification lookup is what created the
      enumeration oracle an adversarial test caught (401 for meeting ids
      Atlas tracks, 200 for ids it does not — enumerating other tenants'
      meetings while holding no secret at all).

      Now there is nothing to enumerate: an unsigned or forged request is
      refused identically whether or not the meeting, account or tenant
      exists, because no lookup has happened yet.
    */
    const verified = this.zoomProvider.verifyWebhookSignature(this.webhookSecretToken(), {
      rawBody,
      signature,
      timestamp,
    });

    if (!verified) {
      this.logger.warn('Webhook signature verification failed — rejected.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    /*
      ZOOM'S ENDPOINT VALIDATION HANDSHAKE. When a webhook URL is first
      saved, Zoom posts `endpoint.url_validation` and expects the plain
      token echoed back alongside an HMAC of it. Without this the endpoint
      cannot be registered at all — it is part of the protocol, not an
      optional extra. Answered only AFTER the signature check, so an
      unauthenticated caller cannot use it as an oracle.

      Under the app-level model this no longer needs a connection to
      exist: the handshake happens when ATLAS registers its own endpoint,
      long before any customer has authorized anything.
    */
    if (extracted.eventType === 'endpoint.url_validation' && extracted.plainToken) {
      const encryptedToken = createHmac('sha256', this.webhookSecretToken() ?? '')
        .update(extracted.plainToken)
        .digest('hex');
      return { plainToken: extracted.plainToken, encryptedToken };
    }

    // IDEMPOTENCY AT THE DATABASE. A redelivery loses the insert and is
    // skipped without any read-then-write race.
    const isNew = await this.eventsRepository.tryInsert({
      providerEventId: extracted.providerEventId,
      eventType: extracted.eventType,
      // A non-sensitive extract only — never the raw payload.
      summary: {
        providerMeetingId: extracted.providerMeetingId ?? null,
        occurredAt: extracted.occurredAt,
      },
    });

    if (!isNew) {
      // Duplicate delivery is a normal, harmless outcome.
      return { received: true };
    }

    await this.producer.enqueue({
      providerEventId: extracted.providerEventId,
      eventType: extracted.eventType,
      providerMeetingId: extracted.providerMeetingId,
      participantKey: extracted.participantKey,
      providerParticipantId: extracted.providerParticipantId,
      joinedAt: extracted.joinedAt,
      leftAt: extracted.leftAt,
      occurredAt: extracted.occurredAt,
    });

    return { received: true };
  }
}
