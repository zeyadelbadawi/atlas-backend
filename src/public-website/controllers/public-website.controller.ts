/**
 * PublicWebsiteController — `public/websites/*` (master plan §21 Phase
 * P11). Deliberately carries NO guard at all — a real, intentional
 * absence, not an oversight: the real frontend's own `PublicWebsiteService`
 * issues these calls with no session/access token, mirroring
 * `apiClient`'s tolerance for unauthenticated requests (the same client
 * sign-in itself uses). Tenant isolation here is established entirely
 * through the hostname/academyId resolution chain inside
 * `PublicWebsiteService` — never through a guard, never through
 * `request.authContext`, which is simply absent for every request this
 * controller handles.
 *
 * Every "not found" case (unrecognized hostname, unpublished
 * configuration, hidden/nonexistent page) returns a plain `404` via
 * `NotFoundException` — indistinguishable, in shape and status, from a
 * genuinely nonexistent resource. No draft title, SEO, section, or id
 * ever appears in any response body this controller can produce.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { PublicWebsiteService } from '../services/public-website.service';
import { SubmitContactMessageDto } from '../dto/submit-contact-message.dto';
import type { HostnameResolutionResponse } from '../dto/hostname-resolution.contract';
import type { WebsiteConfigurationResponse } from '../../website/dto/website-configuration.contract';
import type { WebsitePageResponse } from '../../website/dto/website-page.contract';
import type { PublicWebsiteStatisticsResponse } from '../dto/public-statistics.contract';
import type { ContactSubmissionResponse } from '../../academy/dto/contact-submission.contract';
import type { AcademyIdentityResponse } from '../dto/public-identity.contract';

@Controller('public/websites')
export class PublicWebsiteController {
  constructor(private readonly publicWebsiteService: PublicWebsiteService) {}

  @Get('resolve')
  async resolveHostname(
    @Query('hostname') hostname: string,
  ): Promise<HostnameResolutionResponse> {
    const resolved = await this.publicWebsiteService.resolveHostname(hostname ?? '');
    if (!resolved) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return resolved;
  }

  @Get(':academyId')
  async getPublishedWebsite(
    @Param('academyId') academyId: string,
  ): Promise<WebsiteConfigurationResponse> {
    const configuration = await this.publicWebsiteService.getPublishedWebsite(academyId);
    if (!configuration) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return configuration;
  }

  @Get(':academyId/pages')
  async getPublishedPages(
    @Param('academyId') academyId: string,
  ): Promise<readonly WebsitePageResponse[]> {
    const pages = await this.publicWebsiteService.getPublishedPages(academyId);
    if (!pages) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return pages;
  }

  @Get(':academyId/pages/:slug')
  async getPublishedPage(
    @Param('academyId') academyId: string,
    @Param('slug') slug: string,
  ): Promise<WebsitePageResponse> {
    const page = await this.publicWebsiteService.getPublishedPage(academyId, slug);
    if (!page) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return page;
  }

  /** Phase 6 — the combined Academy Identity/Branding read, reused by the public site, the LMS, and the dashboard. See `PublicWebsiteService.getPublicIdentity`'s own doc comment. */
  @Get(':academyId/identity')
  async getIdentity(
    @Param('academyId') academyId: string,
  ): Promise<AcademyIdentityResponse> {
    const identity = await this.publicWebsiteService.getPublicIdentity(academyId);
    if (!identity) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return identity;
  }

  /** Phase 6 — `StatisticsSection`'s real, live counts. See `PublicWebsiteService.getPublicStatistics`'s own doc comment. */
  @Get(':academyId/statistics')
  async getStatistics(
    @Param('academyId') academyId: string,
  ): Promise<PublicWebsiteStatisticsResponse> {
    const statistics = await this.publicWebsiteService.getPublicStatistics(academyId);
    if (!statistics) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return statistics;
  }

  /** Phase 6 — the real backend destination for the public Contact section's form. See `PublicWebsiteService.submitContactMessage`'s own doc comment. */
  @Post(':academyId/contact')
  @HttpCode(201)
  async submitContactMessage(
    @Param('academyId') academyId: string,
    @Body() body: SubmitContactMessageDto,
  ): Promise<ContactSubmissionResponse> {
    const submission = await this.publicWebsiteService.submitContactMessage(academyId, body);
    if (!submission) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return submission;
  }
}
