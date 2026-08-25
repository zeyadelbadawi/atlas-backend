/**
 * PublicWebsiteModule — Phase P11 (master plan §21). Wires the public,
 * unauthenticated website runtime: hostname resolution, published
 * configuration/pages.
 *
 * Imports `TenancyModule` (for `TenancyContextService`, used only AFTER
 * a real hostname/academyId resolution establishes an organization id —
 * never before) and `WebsiteModule` (for its now-exported
 * `WebsiteConfigurationRepository`/`WebsitePagesRepository`, reused
 * verbatim — never a duplicated query against the same tables).
 * Deliberately does NOT import `AcademyModule`/`AuthCoreModule` — this
 * module's one controller has no guard, and nothing here needs
 * `AcademyScopeGuard`/`JwtAuthGuard` at all.
 */
import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WebsiteModule } from '../website/website.module';
import { PublicWebsiteController } from './controllers/public-website.controller';
import { PublicWebsiteService } from './services/public-website.service';
import { PublicWebsiteCacheService } from './services/public-website-cache.service';
import { PublicHostnameResolutionRepository } from './repositories/public-hostname-resolution.repository';

@Module({
  imports: [TenancyModule, WebsiteModule],
  controllers: [PublicWebsiteController],
  providers: [
    PublicWebsiteService,
    PublicWebsiteCacheService,
    PublicHostnameResolutionRepository,
  ],
})
export class PublicWebsiteModule {}
