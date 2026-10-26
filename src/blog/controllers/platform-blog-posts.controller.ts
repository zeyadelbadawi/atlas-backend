/**
 * PlatformBlogPostsController — B3: `platform-blog-posts` and
 * `platform-blog-images`, the Platform Owner's marketing blog management.
 *
 * AUTHORIZATION exactly like `PlatformFoundingAcademiesController`:
 * `PlatformOwnerGuard` re-reads the caller's real `is_platform_owner` on
 * every request; `ManagementSurfaceGuard` refuses academy-website
 * sessions. RLS on `platform_blog_posts` is the second line (writes need a
 * Platform Owner user context).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { PlatformBlogPostsService } from '../services/platform-blog-posts.service';
import {
  BlogImagesService,
  type UploadedImageFile,
} from '../services/blog-images.service';
import {
  BlogImageFileInterceptor,
  BlogImageUploadErrorsInterceptor,
} from './blog-image-upload.interceptor';
import {
  BlogLocaleQueryDto,
  BlogVersionDto,
  CreateBlogPostDto,
  ListBlogPostsQueryDto,
  PublishBlogPostDto,
  UpdateBlogPostDto,
} from '../dto/blog.dto';
import type {
  BlogImageUploadResult,
  BlogPostDetail,
  BlogPostListItem,
  PublicBlogPost,
} from '../dto/blog.contract';

function actor(request: Request): string {
  return request.authContext!.userId;
}

@Controller('platform-blog-posts')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformBlogPostsController {
  constructor(private readonly service: PlatformBlogPostsService) {}

  @Get()
  list(
    @Req() request: Request,
    @Query() query: ListBlogPostsQueryDto,
  ): Promise<PaginatedResult<BlogPostListItem>> {
    return this.service.list(actor(request), query);
  }

  @Get(':id')
  get(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<BlogPostDetail> {
    return this.service.get(actor(request), id);
  }

  @Get(':id/preview')
  preview(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: BlogLocaleQueryDto,
  ): Promise<PublicBlogPost> {
    return this.service.preview(actor(request), id, query.locale ?? 'en');
  }

  @Post()
  create(
    @Req() request: Request,
    @Body() body: CreateBlogPostDto,
  ): Promise<BlogPostDetail> {
    return this.service.create(actor(request), body);
  }

  @Patch(':id')
  update(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateBlogPostDto,
  ): Promise<BlogPostDetail> {
    return this.service.update(actor(request), id, body);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  publish(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: PublishBlogPostDto,
  ): Promise<BlogPostDetail> {
    return this.service.publish(actor(request), id, body);
  }

  @Post(':id/unpublish')
  @HttpCode(HttpStatus.OK)
  unpublish(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BlogVersionDto,
  ): Promise<BlogPostDetail> {
    return this.service.unpublish(actor(request), id, body.version);
  }

  @Post(':id/archive')
  @HttpCode(HttpStatus.OK)
  archive(
    @Req() request: Request,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: BlogVersionDto,
  ): Promise<BlogPostDetail> {
    return this.service.archive(actor(request), id, body.version);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@Req() request: Request, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(actor(request), id);
  }
}

@Controller('platform-blog-images')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformBlogImagesController {
  constructor(private readonly service: BlogImagesService) {}

  /** Multipart `file`: PNG, JPEG or WebP, at most 5 MB and 6000 px a side → WebP. */
  @Post()
  @UseInterceptors(BlogImageUploadErrorsInterceptor, BlogImageFileInterceptor)
  upload(
    @Req() request: Request,
    @UploadedFile() file: UploadedImageFile | undefined,
  ): Promise<BlogImageUploadResult> {
    return this.service.upload(actor(request), file);
  }
}
