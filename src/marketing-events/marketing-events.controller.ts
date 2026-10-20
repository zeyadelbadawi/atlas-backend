/**
 * `POST /api/v1/mkt/events` — the Atlas marketing website's COOKIELESS
 * beacon (B1 F.5), a sibling of `POST /rum/vitals` and built the same way.
 *
 * PRIVACY MODEL (as RUM). The browser sends closed-vocabulary events with
 * `credentials: 'omit'`; nothing is stored in the browser; a browser
 * sending Global Privacy Control or Do Not Track sends nothing, and this
 * endpoint drops a request carrying `Sec-GPC: 1` / `DNT: 1` anyway. Only
 * DAILY AGGREGATE counts are stored (`marketing_event_daily`): no visitor,
 * session or device identifier, no IP address, never a URL, query or
 * fragment. The client address is used only by the throttler (per IPv4
 * address / IPv6 /64), as on every route; nothing is logged per request.
 *
 * CONSENT. Owner decision DL-51: the beacon runs WITHOUT a consent prompt,
 * exactly like RUM (superseding SPEC F.5's "ships behind consent" line,
 * XB-15), and is disclosed in the privacy policy in English and Arabic.
 * GA4 or any third-party analytics is out of scope until legal review.
 *
 * ALWAYS 204 for a JSON body, whatever it contains: an unknown event,
 * a bot User-Agent, an opted-out request or ingestion switched off are all
 * dropped silently, and a storage failure is swallowed (logged without the
 * payload) — a beacon never gets a 500. `MARKETING_EVENTS_ENABLED` other
 * than exactly "true" turns ingestion off; the deploy workflow turns it on
 * with the M1a marketing site (owner decision DL-51, 20 Oct 2026).
 * Bodies are capped at 16 KB (`body-limits.ts`, `beacon` tier).
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { clientIpPrefixTracker } from '../common/security/client-ip-throttler.guard';
import { MarketingEventsService } from './marketing-events.service';
import {
  isBotUserAgent,
  parseMarketingBeacon,
  requestOptedOut,
} from './marketing-events.util';
import {
  MKT_EVENTS_THROTTLE_LIMIT,
  MKT_EVENTS_THROTTLE_TTL_MS,
} from './marketing-events.vocabulary';

@Controller('mkt')
export class MarketingEventsController {
  private readonly logger = new Logger(MarketingEventsController.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly service: MarketingEventsService,
  ) {}

  private isEnabled(): boolean {
    const value = this.configService.get<unknown>('MARKETING_EVENTS_ENABLED');
    return value === true || value === 'true';
  }

  @Post('events')
  @Throttle({
    default: {
      limit: MKT_EVENTS_THROTTLE_LIMIT,
      ttl: MKT_EVENTS_THROTTLE_TTL_MS,
      getTracker: clientIpPrefixTracker,
    },
  })
  @HttpCode(HttpStatus.NO_CONTENT)
  async receive(@Req() request: Request, @Body() body: unknown): Promise<void> {
    if (!this.isEnabled()) return;
    if (requestOptedOut((name) => request.headers[name])) return;
    if (isBotUserAgent(request.headers['user-agent'])) return;
    const events = parseMarketingBeacon(body);
    if (events.length === 0) return;
    try {
      await this.service.record(events);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Marketing beacon batch was not stored.',
      );
    }
  }
}
