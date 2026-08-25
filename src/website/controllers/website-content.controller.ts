/**
 * WebsiteContentController — `academies/:id/website/{faq,testimonial}-entries/*`
 * (master plan §21 Phase P10). Same guard reuse as `WebsiteController` —
 * `AcademyScopeGuard` resolves `request.academyContext` before any
 * handler runs.
 */
import {
  Body,
  Controller,
  Get,
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
import { WebsiteContentService } from '../services/website-content.service';
import { CreateWebsiteFaqEntryDto } from '../dto/create-website-faq-entry.dto';
import { UpdateWebsiteFaqEntryDto } from '../dto/update-website-faq-entry.dto';
import { CreateWebsiteTestimonialEntryDto } from '../dto/create-website-testimonial-entry.dto';
import { UpdateWebsiteTestimonialEntryDto } from '../dto/update-website-testimonial-entry.dto';
import { WebsiteContentListQueryDto } from '../dto/website-content-list-query.dto';
import type { WebsiteFaqEntryResponse } from '../dto/website-faq-entry.contract';
import type { WebsiteTestimonialEntryResponse } from '../dto/website-testimonial-entry.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class WebsiteContentController {
  constructor(private readonly websiteContentService: WebsiteContentService) {}

  /* ------------------------------ FAQ ------------------------------ */

  @Get(':id/website/faq-entries')
  async getFaqEntries(
    @Req() request: Request,
    @Query() query: WebsiteContentListQueryDto,
  ): Promise<PaginatedResult<WebsiteFaqEntryResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.getFaqEntries(academyId, organizationId, query);
  }

  @Get(':id/website/faq-entries/:entryId')
  async getFaqEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.getFaqEntry(academyId, organizationId, entryId);
  }

  @Post(':id/website/faq-entries')
  async createFaqEntry(
    @Req() request: Request,
    @Body() body: CreateWebsiteFaqEntryDto,
  ): Promise<WebsiteFaqEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.createFaqEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/website/faq-entries/:entryId')
  async updateFaqEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Body() body: UpdateWebsiteFaqEntryDto,
  ): Promise<WebsiteFaqEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.updateFaqEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
      body,
    );
  }

  @Post(':id/website/faq-entries/:entryId/publish')
  async publishFaqEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.publishFaqEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
    );
  }

  @Post(':id/website/faq-entries/:entryId/archive')
  async archiveFaqEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.archiveFaqEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
    );
  }

  /* --------------------------- Testimonial -------------------------- */

  @Get(':id/website/testimonial-entries')
  async getTestimonialEntries(
    @Req() request: Request,
    @Query() query: WebsiteContentListQueryDto,
  ): Promise<PaginatedResult<WebsiteTestimonialEntryResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.getTestimonialEntries(
      academyId,
      organizationId,
      query,
    );
  }

  @Get(':id/website/testimonial-entries/:entryId')
  async getTestimonialEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.getTestimonialEntry(
      academyId,
      organizationId,
      entryId,
    );
  }

  @Post(':id/website/testimonial-entries')
  async createTestimonialEntry(
    @Req() request: Request,
    @Body() body: CreateWebsiteTestimonialEntryDto,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.createTestimonialEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/website/testimonial-entries/:entryId')
  async updateTestimonialEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
    @Body() body: UpdateWebsiteTestimonialEntryDto,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.updateTestimonialEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
      body,
    );
  }

  @Post(':id/website/testimonial-entries/:entryId/publish')
  async publishTestimonialEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.publishTestimonialEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
    );
  }

  @Post(':id/website/testimonial-entries/:entryId/archive')
  async archiveTestimonialEntry(
    @Req() request: Request,
    @Param('entryId') entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.websiteContentService.archiveTestimonialEntry(
      academyId,
      organizationId,
      request.authContext!.userId,
      entryId,
    );
  }
}
