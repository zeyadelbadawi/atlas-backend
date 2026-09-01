/**
 * WebsiteController — `academies/:id/website/*` (master plan §10: "section
 * writes strictly schema-validated server-side"). Same guard reuse as
 * `CoursesController`/`MediaController` — `AcademyScopeGuard` resolves
 * `request.academyContext` before any handler runs.
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
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { WebsiteConfigurationService } from '../services/website-configuration.service';
import { WebsitePagesService } from '../services/website-pages.service';
import { UpdateWebsiteConfigurationDto } from '../dto/update-website-configuration.dto';
import { CreateWebsitePageDto } from '../dto/create-website-page.dto';
import { UpdateWebsitePageDto } from '../dto/update-website-page.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import { ReorderItemsDto } from '../../course/dto/reorder-items.dto';
import type { WebsiteConfigurationResponse } from '../dto/website-configuration.contract';
import type { WebsitePageResponse } from '../dto/website-page.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class WebsiteController {
  constructor(
    private readonly websiteConfigurationService: WebsiteConfigurationService,
    private readonly websitePagesService: WebsitePagesService,
  ) {}

  @Get(':id/website/configuration')
  async getConfiguration(@Req() request: Request): Promise<WebsiteConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteConfigurationService.getConfiguration(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Patch(':id/website/configuration')
  async updateConfiguration(
    @Req() request: Request,
    @Body() body: UpdateWebsiteConfigurationDto,
  ): Promise<WebsiteConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteConfigurationService.updateConfiguration(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Post(':id/website/publish')
  async publish(@Req() request: Request): Promise<WebsiteConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteConfigurationService.publishConfiguration(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Get(':id/website/pages')
  async getPages(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<WebsitePageResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.list(
      academyId,
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id/website/pages/:pageId')
  async getPage(
    @Req() request: Request,
    @Param('pageId') pageId: string,
  ): Promise<WebsitePageResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.getById(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
    );
  }

  @Post(':id/website/pages')
  async createPage(
    @Req() request: Request,
    @Body() body: CreateWebsitePageDto,
  ): Promise<WebsitePageResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.create(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/website/pages/:pageId')
  async updatePage(
    @Req() request: Request,
    @Param('pageId') pageId: string,
    @Body() body: UpdateWebsitePageDto,
  ): Promise<WebsitePageResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.update(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
      body,
    );
  }

  @Delete(':id/website/pages/:pageId')
  @HttpCode(204)
  async deletePage(
    @Req() request: Request,
    @Param('pageId') pageId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.delete(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
    );
  }

  @Post(':id/website/pages/:pageId/sections/reorder')
  async reorderSections(
    @Req() request: Request,
    @Param('pageId') pageId: string,
    @Body() body: ReorderItemsDto,
  ): Promise<WebsitePageResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websitePagesService.reorderSections(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
      body,
    );
  }
}
