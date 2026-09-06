/**
 * CommunityModule — Phase P7 (master plan §21), the "Community" half:
 * Announcements, Blog, Forum. Bundled into one module — the same "one
 * cohesive module, several controllers/services" shape `LearningModule`
 * (P6) already established for five services, rather than three
 * near-identical single-purpose modules. `AuthCoreModule` (`JwtAuthGuard`)
 * and `TenancyModule` (`TenancyContextService`) cover every course/academy-
 * scoped route — real scoping/authorization happens entirely inside each
 * service under `TenancyContextService.runInUserContext`, per each
 * service's own doc comment. Phase 6 adds `IdentityModule`, for the one
 * real route-level guard this module now has: `PlatformOwnerGuard`, on
 * `AnnouncementsController`'s new `platform/announcements/*` routes.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { AnnouncementsController } from './controllers/announcements.controller';
import { BlogPostsController } from './controllers/blog-posts.controller';
import { ForumsController } from './controllers/forums.controller';
import { AnnouncementsService } from './services/announcements.service';
import { BlogPostsService } from './services/blog-posts.service';
import { ForumsService } from './services/forums.service';
import { AnnouncementsRepository } from './repositories/announcements.repository';
import { BlogPostsRepository } from './repositories/blog-posts.repository';
import { ForumsRepository } from './repositories/forums.repository';

@Module({
  // Phase 6 — `IdentityModule` added for `PlatformOwnerGuard` (used by
  // `AnnouncementsController`'s new `platform/announcements/*` routes).
  // No cycle: `IdentityModule` only imports `AuthCoreModule`/`TenancyModule`
  // itself, never anything that depends back on `CommunityModule`.
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [AnnouncementsController, BlogPostsController, ForumsController],
  providers: [
    AnnouncementsService,
    BlogPostsService,
    ForumsService,
    AnnouncementsRepository,
    BlogPostsRepository,
    ForumsRepository,
  ],
  exports: [
    // Phase 6 — `SubscriptionSweepService` (`PlansModule`) needs these to
    // publish due scheduled announcements/blog posts on the same Phase 2
    // sweep tick, rather than a second scheduler; reusing these
    // repositories directly matches this codebase's "one shared
    // definition, not a second copy" rule.
    AnnouncementsRepository,
    BlogPostsRepository,
  ],
})
export class CommunityModule {}
