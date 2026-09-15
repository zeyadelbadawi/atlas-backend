/**
 * Zoom's deauthorization notification endpoint.
 *
 * A SEPARATE ROUTE FROM THE MEETING WEBHOOK, DELIBERATELY. Zoom asks for
 * a Deauthorization Notification Endpoint URL of its own, and the two
 * payloads have nothing structurally in common: meeting events are
 * meeting-shaped and are queued for attribution by meeting id, while this
 * one is account-shaped and carries no meeting at all. Pointing Zoom's
 * deauthorization at `/live-sessions/webhook` would be worse than a
 * visible failure — that handler would answer 200 while the queue
 * discarded the event as `unmatched`, so Atlas would keep a revoked
 * authorization forever and Zoom would consider every delivery a success.
 *
 * SAME VERIFICATION AS THE MEETING WEBHOOK, AND THAT IS VERIFIED, NOT
 * ASSUMED. Zoom's webhook guidance now covers this endpoint too: the
 * legacy per-app Verification Token was deprecated and sunset, and
 * deauthorization requests are to be verified with the app-level Secret
 * Token via the `x-zm-signature` header. So this reuses
 * `ZoomProvider.verifyWebhookSignature` rather than growing a second
 * crypto path — one HMAC implementation, already timing-safe, already
 * covered by its own tests.
 *
 * FAIL CLOSED, AND SAY NOTHING. Every refusal is the same 401 with no
 * detail: a caller must not be able to tell a bad signature from a stale
 * timestamp from a malformed body, and a valid-looking request for an
 * account Atlas has never seen must look exactly like one it has. The
 * success body is a constant `{ received: true }` for the same reason —
 * the outcome is in the logs, never in the response.
 *
 * NOTHING SENSITIVE IS LOGGED: no raw payload, no authorization header,
 * no secret, no token.
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
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ZoomProvider } from '../providers/zoom.provider';
import { LiveProviderDeauthorizationService } from '../services/live-provider-deauthorization.service';
import { extractZoomDeauthorization } from '../utils/zoom-deauthorization.util';
import type { ZoomConfig } from '../../config/configuration';

const ZOOM_SIGNATURE_HEADER = 'x-zm-signature';
const ZOOM_TIMESTAMP_HEADER = 'x-zm-request-timestamp';

/**
 * Same bound as the meeting webhook. Without it a captured signature
 * stays valid forever and can be replayed indefinitely.
 */
const MAX_TIMESTAMP_SKEW_MS = 5 * 60 * 1000;

/** Length-safe constant-time compare for the client id. */
function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

@Controller('live-sessions')
export class LiveProviderDeauthorizationController {
  private readonly logger = new Logger(LiveProviderDeauthorizationController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly zoomProvider: ZoomProvider,
    private readonly deauthorizationService: LiveProviderDeauthorizationService,
  ) {}

  private zoom(): ZoomConfig {
    return this.configService.get<ZoomConfig>('zoom') ?? {};
  }

  @Post('deauthorization')
  @HttpCode(200)
  async handle(
    @Req() request: Request & { rawBody?: Buffer },
    @Body() body: unknown,
    @Headers(ZOOM_SIGNATURE_HEADER) signature: string | undefined,
    @Headers(ZOOM_TIMESTAMP_HEADER) timestamp: string | undefined,
  ): Promise<{ received: true }> {
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody) {
      /*
        The raw-body hook did not run, which means this route is no longer
        in `main.ts`'s capture list and nothing here can be verified. Fail
        closed and loudly rather than accept unverifiable traffic — the
        same stance the meeting webhook takes.
      */
      this.logger.error('Deauthorization raw body unavailable — refusing to process.');
      throw new BadRequestException({ messageKey: 'errors.badRequest' });
    }

    if (!signature || !timestamp) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    // REPLAY WINDOW FIRST — a stale capture costs nothing beyond a
    // rejected request, and this check needs no secret and no lookup.
    const sentAtMs = Number(timestamp) * 1000;
    if (
      !Number.isFinite(sentAtMs) ||
      Math.abs(Date.now() - sentAtMs) > MAX_TIMESTAMP_SKEW_MS
    ) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    /*
      SIGNATURE BEFORE ANYTHING ELSE IS READ FROM THE BODY.

      Atlas owns one Zoom application and Zoom signs every customer's
      events with its single Secret Token, so this needs no tenant lookup
      to verify — which is what keeps an unsigned request from reaching
      any code that could reveal whether an account exists.
    */
    const verified = this.zoomProvider.verifyWebhookSignature(
      this.zoom().webhookSecretToken,
      { rawBody, signature, timestamp },
    );
    if (!verified) {
      this.logger.warn('Deauthorization signature verification failed — rejected.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const extracted = extractZoomDeauthorization(body);
    if (!extracted) {
      // Signed by Zoom but not a shape Atlas understands. Refused
      // identically to a bad signature so the two are indistinguishable.
      this.logger.warn('Deauthorization payload could not be interpreted — refused.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    /*
      WHICH APPLICATION WAS REMOVED.

      One Atlas deployment authorizes exactly one Zoom app. A correctly
      signed notification naming a different `client_id` is not ours to
      act on — and acting on it would let anyone holding the Secret Token
      for some other integration clear an Atlas connection.
    */
    const expectedClientId = this.zoom().clientId;
    if (!expectedClientId || !constantTimeEquals(extracted.clientId, expectedClientId)) {
      this.logger.warn('Deauthorization named a different Zoom application — ignored.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const outcome = await this.deauthorizationService.handle(extracted);

    // The outcome is logged, never returned. See the class comment.
    this.logger.log({ outcome }, 'Zoom deauthorization processed.');

    return { received: true };
  }
}
