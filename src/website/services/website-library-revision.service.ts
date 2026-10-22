/**
 * The content-library revision of an Academy — a counter bumped by every
 * FAQ/testimonial library write.
 *
 * The public pages payload expands the library entries a section
 * references (`PublicWebsiteService`), and is cached per
 * `configVersion`. A library edit doesn't change `configVersion`, so the
 * cache key also carries this revision: an entry edited, unpublished,
 * hidden or archived is reflected on the next read instead of after the
 * cache's TTL. Kept in Redis next to that cache; if Redis is unreachable
 * the revision reads as 0 and the cache's own TTL still bounds staleness.
 */
import { Injectable, Optional } from '@nestjs/common';
import { RedisService } from '../../redis/redis.service';
import { EdgeCachePurgeService } from '../../edge-cache/edge-cache-purge.service';

function revisionKey(academyId: string): string {
  return `public:library-rev:v1:${academyId}`;
}

@Injectable()
export class WebsiteLibraryRevisionService {
  constructor(
    private readonly redisService: RedisService,
    // A library edit changes the published pages: their edge copies go too.
    @Optional() private readonly edgeCachePurgeService?: EdgeCachePurgeService,
  ) {}

  async get(academyId: string): Promise<number> {
    try {
      const raw = await this.redisService.getClient().get(revisionKey(academyId));
      const value = raw ? Number(raw) : 0;
      return Number.isFinite(value) ? value : 0;
    } catch {
      return 0;
    }
  }

  async bump(academyId: string): Promise<void> {
    this.edgeCachePurgeService?.purgeAcademy(academyId);
    try {
      await this.redisService.getClient().incr(revisionKey(academyId));
    } catch {
      // Best effort: the pages cache's TTL is the backstop.
    }
  }
}
