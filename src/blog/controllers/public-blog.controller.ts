/**
 * PublicBlogController — B3: `public/blog/*`, the marketing blog for the
 * apex site's renderer (SSR) and browsers.
 *
 * No guard, on purpose (listed in `route-surface-inventory.spec`'s
 * `PUBLIC_ROUTES`): published marketing content. Reads run with NO
 * database context, where RLS shows only public posts (scheduled or
 * published, publish time reached); responses carry no ids, authorship,
 * notes or counters. A draft, archived or future post is a plain 404,
 * indistinguishable from a slug that never existed.
 *
 * CACHING. Successful GETs: `public, max-age=60, s-maxage=300` — the same
 * for every visitor. The renderer's edge copies carry the `atlas-blog` tag,
 * purged after every write that changes what the public sees.
 *
 * THROTTLE. Higher than the global default: the renderer fetches from one
 * address for every visitor whose page is not cached yet.
 */
import { Controller, Get, Param, Query } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CachePolicy } from '../../common/http/cache-policy';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { PlatformBlogPostsService } from '../services/platform-blog-posts.service';
import { BlogLocaleQueryDto, PublicBlogListQueryDto } from '../dto/blog.dto';
import type {
  PublicBlogPost,
  PublicBlogPostSummary,
  PublicBlogSitemap,
} from '../dto/blog.contract';

export const PUBLIC_BLOG_CACHE = 'public, max-age=60, s-maxage=300';
export const PUBLIC_BLOG_THROTTLE = { limit: 300, ttl: 60_000 } as const;

@CachePolicy(PUBLIC_BLOG_CACHE)
@Throttle({ default: PUBLIC_BLOG_THROTTLE })
@Controller('public/blog')
export class PublicBlogController {
  constructor(private readonly service: PlatformBlogPostsService) {}

  @Get('posts')
  list(
    @Query() query: PublicBlogListQueryDto,
  ): Promise<PaginatedResult<PublicBlogPostSummary>> {
    return this.service.publicList(query);
  }

  @Get('sitemap')
  sitemap(): Promise<PublicBlogSitemap> {
    return this.service.publicSitemap();
  }

  @Get('posts/:slug')
  detail(
    @Param('slug') slug: string,
    @Query() query: BlogLocaleQueryDto,
  ): Promise<PublicBlogPost> {
    return this.service.publicDetail(slug, query.locale ?? 'en');
  }
}
