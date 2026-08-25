/**
 * CommunityModule — Phase P7 (master plan §21), the "Community" half:
 * Announcements, Blog, Forum. Bundled into one module — the same "one
 * cohesive module, several controllers/services" shape `LearningModule`
 * (P6) already established for five services, rather than three
 * near-identical single-purpose modules. `AuthCoreModule` (`JwtAuthGuard`)
 * and `TenancyModule` (`TenancyContextService`) only — no new guard, every
 * route runs entirely under `TenancyContextService.runInUserContext`, per
 * each service's own doc comment.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
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
  imports: [AuthCoreModule, TenancyModule],
  controllers: [AnnouncementsController, BlogPostsController, ForumsController],
  providers: [
    AnnouncementsService,
    BlogPostsService,
    ForumsService,
    AnnouncementsRepository,
    BlogPostsRepository,
    ForumsRepository,
  ],
})
export class CommunityModule {}
