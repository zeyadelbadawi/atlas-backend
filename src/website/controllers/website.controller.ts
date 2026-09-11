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
import type { EditingParticipant } from '../../concurrency/services/editing-presence.service';
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

  /**
   * Takes the public website offline.
   *
   * Deliberately the same shape and the same guard as `publish` above —
   * unpublishing removes a customer's site from the internet, so it must
   * not be reachable by anyone who could not have published it.
   */
  @Post(':id/website/unpublish')
  async unpublish(@Req() request: Request): Promise<WebsiteConfigurationResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteConfigurationService.unpublishConfiguration(
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

  /*
    Editing presence. A POST because it WRITES a session record and
    refreshes a TTL — it is not a cacheable read, and modelling it as a GET
    would invite proxies and browsers to serve it from cache, which for a
    liveness signal means showing colleagues who left ten minutes ago.
  */
  @Post(':id/website/pages/:pageId/editing-session')
  @HttpCode(200)
  async heartbeatEditingSession(
    @Req() request: Request,
    @Param('pageId') pageId: string,
  ): Promise<{ readonly participants: readonly EditingParticipant[] }> {
    const { academyId, organizationId } = request.academyContext!;
    const participants = await this.websitePagesService.heartbeatEditingSession(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
    );
    return { participants };
  }

  @Delete(':id/website/pages/:pageId/editing-session')
  @HttpCode(204)
  async releaseEditingSession(
    @Req() request: Request,
    @Param('pageId') pageId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    await this.websitePagesService.releaseEditingSession(
      academyId,
      organizationId,
      request.authContext!.userId,
      pageId,
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
