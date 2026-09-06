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
 * Deliberately does NOT import `AuthCoreModule` — this module's one
 * controller has no guard, and nothing here needs `JwtAuthGuard` at all.
 *
 * Phase 6 — now also imports `AcademyModule`, for its exported
 * `ContactSubmissionsRepository` (the real destination for the public
 * Contact section's form) and, via `AcademiesRepository`, the course-count
 * filter the new public statistics endpoint reuses. No NEW cycle: this
 * module already transitively depends on `AcademyModule` through
 * `WebsiteModule` (`WebsiteModule` imports `AcademyModule` directly) —
 * this import only makes that existing edge explicit so DI can actually
 * resolve the provider, which transitive reachability alone does not grant
 * in Nest's module encapsulation.
 */
import { Module } from '@nestjs/common';
import { TenancyModule } from '../tenancy/tenancy.module';
import { WebsiteModule } from '../website/website.module';
import { AcademyModule } from '../academy/academy.module';
import { CourseModule } from '../course/course.module';
import { PublicWebsiteController } from './controllers/public-website.controller';
import { PublicWebsiteService } from './services/public-website.service';
import { PublicWebsiteCacheService } from './services/public-website-cache.service';
import { PublicHostnameResolutionRepository } from './repositories/public-hostname-resolution.repository';

@Module({
  imports: [TenancyModule, WebsiteModule, AcademyModule, CourseModule],
  controllers: [PublicWebsiteController],
  providers: [
    PublicWebsiteService,
    PublicWebsiteCacheService,
    PublicHostnameResolutionRepository,
  ],
})
export class PublicWebsiteModule {}
