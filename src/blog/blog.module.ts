/**
 * BlogModule — B3: the marketing blog (Platform Owner management, image
 * upload, public reads). A leaf module: nothing imports it.
 * `AuditLogWriterService` and `EdgeCachePurgeService` come from their
 * `@Global()` modules; `MediaModule` provides the public media bucket.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { MediaModule } from '../media/media.module';
import {
  PlatformBlogImagesController,
  PlatformBlogPostsController,
} from './controllers/platform-blog-posts.controller';
import { PublicBlogController } from './controllers/public-blog.controller';
import { PlatformBlogPostsService } from './services/platform-blog-posts.service';
import { BlogImagesService } from './services/blog-images.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, MediaModule],
  controllers: [
    PlatformBlogPostsController,
    PlatformBlogImagesController,
    PublicBlogController,
  ],
  providers: [PlatformBlogPostsService, BlogImagesService],
})
export class BlogModule {}
