/**
 * BlogPostsController — flat `blog-posts` resource, matching
 * `BlogService`'s (frontend) `protected readonly resource = 'blog-posts'`
 * exactly. `JwtAuthGuard` alone — see `InstructorController`'s doc comment
 * for why (real scoping happens inside `BlogPostsService`/RLS).
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { BlogPostsService } from '../services/blog-posts.service';
import { CreateBlogPostDto } from '../dto/create-blog-post.dto';
import { UpdateBlogPostDto } from '../dto/update-blog-post.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { BlogPostResponse } from '../dto/blog-post.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('blog-posts')
@UseGuards(JwtAuthGuard)
export class BlogPostsController {
  constructor(private readonly blogPostsService: BlogPostsService) {}

  @Get()
  async getPosts(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<BlogPostResponse>> {
    return this.blogPostsService.getPosts(request.authContext!.userId, query);
  }

  @Get(':id')
  async getPost(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<BlogPostResponse> {
    return this.blogPostsService.getPost(request.authContext!.userId, id);
  }

  @Post()
  async createPost(
    @Req() request: Request,
    @Body() body: CreateBlogPostDto,
  ): Promise<BlogPostResponse> {
    return this.blogPostsService.createPost(request.authContext!.userId, body);
  }

  @Patch(':id')
  async updatePost(
    @Req() request: Request,
    @Param('id') id: string,
    @Body() body: UpdateBlogPostDto,
  ): Promise<BlogPostResponse> {
    return this.blogPostsService.updatePost(request.authContext!.userId, id, body);
  }

  @Post(':id/publish')
  async publishPost(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<BlogPostResponse> {
    return this.blogPostsService.publishPost(request.authContext!.userId, id);
  }

  @Post(':id/archive')
  async archivePost(
    @Req() request: Request,
    @Param('id') id: string,
  ): Promise<BlogPostResponse> {
    return this.blogPostsService.archivePost(request.authContext!.userId, id);
  }

  @Delete(':id')
  @HttpCode(204)
  async deletePost(@Req() request: Request, @Param('id') id: string): Promise<void> {
    return this.blogPostsService.deletePost(request.authContext!.userId, id);
  }
}
