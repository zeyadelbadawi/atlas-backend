/**
 * `POST /video-gate/authorize` — the Normal tier's delivery Worker asking
 * whether a playback token it already verified is still honoured
 * (Workstream D; `VideoGateAuthorizationService` has the whole argument).
 *
 * PUBLIC BY NECESSITY, AUTHORIZED BY HMAC. No JWT — the caller is the
 * Cloudflare Worker, not an Atlas user. The HMAC over the EXACT request
 * bytes (`request.rawBody`, captured for this path only — see
 * `common/http/body-limits.ts`) is the authorization boundary, checked
 * before the body is even parsed; the playback token inside is then
 * verified with Atlas's own signing secret. Missing raw body fails closed.
 *
 * DOES NOT EXIST WHILE OFF. Without `BASIC_VIDEO_GATE_AUTHZ_SECRET` (today's
 * production state) every call is a 404, so nothing about production
 * changes until the tier is activated by the runbook.
 *
 * RATE LIMIT. The Worker calls from Cloudflare's egress addresses, so many
 * viewers share one client IP. The global 120/min/IP ceiling would turn a
 * busy edge location into a fail-closed playback outage, so this route has
 * its own, higher per-IP ceiling. An unauthenticated caller costs one HMAC
 * and is refused before any database read.
 *
 * ANSWERS. 200 `{ allow, reason?, ttlSeconds }` for every decision about a
 * properly authenticated call, so the Worker can cache refusals too; 401
 * for a bad signature; 5xx (thrown) when Atlas cannot decide — the Worker
 * treats anything but a 200 as "cannot authorize" and refuses (fail closed).
 */
import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Post,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  GATE_AUTHZ_SIGNATURE_HEADER,
  GATE_AUTHZ_TIMESTAMP_HEADER,
  VideoGateAuthorizationService,
  type GateAuthzDecision,
} from '../video/video-gate-authorization.service';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';

/** Real tokens are ~400 bytes; object keys are ≤ 1024. Anything larger is not a Worker call. */
const MAX_FIELD_LENGTH = 4096;

/**
 * Per client IP, per minute. Sized for one Cloudflare egress address
 * fronting a busy edge location: each viewer costs about two calls a
 * minute per isolate (one per cache window).
 */
export const GATE_AUTHZ_PER_IP_CEILING = { limit: 6000, ttl: 60_000 } as const;

@Controller('video-gate')
export class VideoGateAuthorizationController {
  private readonly logger = new Logger(VideoGateAuthorizationController.name);

  constructor(
    private readonly authorization: VideoGateAuthorizationService,
    private readonly metrics: LearningMetricsService,
  ) {}

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: GATE_AUTHZ_PER_IP_CEILING })
  async authorize(
    @Req() request: Request & { rawBody?: Buffer },
    @Headers(GATE_AUTHZ_TIMESTAMP_HEADER) timestamp: string | undefined,
    @Headers(GATE_AUTHZ_SIGNATURE_HEADER) signature: string | undefined,
  ): Promise<GateAuthzDecision> {
    if (!this.authorization.isEnabled) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const rawBody = request.rawBody?.toString('utf8');
    if (!rawBody || !this.authorization.verifyCaller(timestamp, signature, rawBody)) {
      this.metrics.recordGateAuthorization('caller_rejected');
      this.logger.warn('Video gate authorization call failed verification.');
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }
    const { token, objectKey } = (body ?? {}) as { token?: unknown; objectKey?: unknown };
    if (
      typeof token !== 'string' ||
      typeof objectKey !== 'string' ||
      token.length === 0 ||
      objectKey.length === 0 ||
      token.length > MAX_FIELD_LENGTH ||
      objectKey.length > MAX_FIELD_LENGTH
    ) {
      throw new BadRequestException({ messageKey: 'errors.validation.failed' });
    }
    return this.authorization.authorize(token, objectKey);
  }
}
