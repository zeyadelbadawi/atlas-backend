/**
 * PublicSiteAnnouncementsController — B3: `public/site-announcements`,
 * what the marketing site's client script shows (banners, one pop-up) and
 * its view/click/dismiss beacon.
 *
 * No guard, on purpose (listed in `route-surface-inventory.spec`'s
 * `PUBLIC_ROUTES`). Reads run with NO database context: RLS shows only
 * live marketing announcements. Responses carry no name, counters,
 * schedule or authorship.
 *
 * THE BEACON always answers 204 for a well-formed body: an unknown id, a
 * malformed id, an announcement that is not live, or a counting failure
 * are all ignored silently, so the route says nothing about what exists.
 * Throttled per client address (IPv6 per /64) at 60 a minute.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CachePolicy } from '../../common/http/cache-policy';
import { clientIpPrefixTracker } from '../../common/security/client-ip-throttler.guard';
import { SiteAnnouncementsService } from '../services/site-announcements.service';
import {
  PublicSiteAnnouncementsQueryDto,
  SiteAnnouncementEventDto,
  isAnnouncementId,
} from '../dto/site-announcements.dto';
import type { PublicMarketingAnnouncements } from '../dto/site-announcements.contract';

export const PUBLIC_ANNOUNCEMENTS_CACHE = 'public, max-age=30, s-maxage=60';
export const ANNOUNCEMENT_EVENTS_THROTTLE = {
  limit: 60,
  ttl: 60_000,
  getTracker: clientIpPrefixTracker,
} as const;

@Controller('public/site-announcements')
export class PublicSiteAnnouncementsController {
  constructor(private readonly service: SiteAnnouncementsService) {}

  @Get()
  @CachePolicy(PUBLIC_ANNOUNCEMENTS_CACHE)
  @Throttle({ default: { limit: 300, ttl: 60_000 } })
  marketing(
    @Query() query: PublicSiteAnnouncementsQueryDto,
  ): Promise<PublicMarketingAnnouncements> {
    return this.service.marketing(query.locale ?? 'en', query.path);
  }

  @Post(':id/events')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: ANNOUNCEMENT_EVENTS_THROTTLE })
  async event(
    @Param('id') id: string,
    @Body() body: SiteAnnouncementEventDto,
  ): Promise<void> {
    if (!isAnnouncementId(id)) return;
    await this.service.recordEvent(id.toLowerCase(), body.type);
  }
}
