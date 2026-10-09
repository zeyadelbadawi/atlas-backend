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
import { CachePolicy, PUBLIC_WEBSITE_CACHE } from '../../common/http/cache-policy';
import type { PublicCourseCategoryResponse } from '../dto/public-categories.contract';
import {
  Body,
  Controller,
  Get,
  HttpCode,
  NotFoundException,
  type OnModuleInit,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { Throttle } from '@nestjs/throttler';
import { EmailLogoService } from '../../communications/services/email-logo.service';
import { PublicWebsiteService } from '../services/public-website.service';
import { SubmitContactMessageDto } from '../dto/submit-contact-message.dto';
import { CourseListQueryDto } from '../../course/dto/course-list-query.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  CourseRatingSummary,
  CourseReviewResponse,
} from '../../learning/dto/course-review.contract';
import type { HostnameResolutionResponse } from '../dto/hostname-resolution.contract';
import type { WebsiteConfigurationResponse } from '../../website/dto/website-configuration.contract';
import type { WebsitePageResponse } from '../../website/dto/website-page.contract';
import type { PublicWebsiteStatisticsResponse } from '../dto/public-statistics.contract';
import type { ContactSubmissionResponse } from '../../academy/dto/contact-submission.contract';
import type { AcademyIdentityResponse } from '../dto/public-identity.contract';
import type { CourseResponse } from '../../course/dto/course.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import type { PublicCourseCurriculumSectionResponse } from '../dto/public-course-curriculum.contract';

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Successful GETs here are published, tenant-public content: the visitor's
 * own browser may keep them briefly (`PUBLIC_WEBSITE_CACHE`, see
 * `common/http/cache-policy.ts`); errors and the contact POST stay
 * `no-store`, and the favicon/logo routes set their own.
 */
@CachePolicy(PUBLIC_WEBSITE_CACHE)
@Controller('public/websites')
export class PublicWebsiteController implements OnModuleInit {
  constructor(
    private readonly publicWebsiteService: PublicWebsiteService,
    private readonly emailLogoService: EmailLogoService,
  ) {}

  /**
   * Production QA Issue 4 — hands the email side the SAME "may this
   * academy's logo be served" read the route below answers with, so an
   * email never links a logo this route would 404 (an unpaid, suspended
   * or archived academy). Registered rather than injected: communications
   * is the lower layer and must not import the public website module.
   */
  onModuleInit(): void {
    this.emailLogoService.registerServingReference((academyId) =>
      this.publicWebsiteService.findLogoReference(academyId),
    );
  }

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

  /**
   * The Academy's own favicon (`favicon.util.ts`): the stored PNG/ICO
   * bytes, or a same-origin redirect to its own uploaded image — never to
   * an external URL (W2). The public site links it with
   * `?v=<faviconVersion>`; that exact version is immutable for a year, any
   * other (an old page still open after a change) only briefly cached.
   */
  @Get(':academyId/favicon')
  async getFavicon(
    @Param('academyId') academyId: string,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const favicon = await this.publicWebsiteService.getFavicon(academyId);
    if (!favicon) throw new NotFoundException({ messageKey: 'errors.notFound' });
    if (favicon.source.kind === 'media') {
      // W2 — only ever a same-origin, path-only redirect to this Academy's
      // own uploaded image, and never cached as immutable: a redirect is a
      // pointer that must be able to change, not content.
      response.setHeader('Cache-Control', 'public, max-age=300');
      response.redirect(302, favicon.source.path);
      return;
    }
    response.setHeader(
      'Cache-Control',
      version === favicon.version
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=60',
    );
    response.setHeader('Content-Type', favicon.source.contentType);
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.status(200).end(favicon.source.bytes);
  }

  /**
   * W3 — the Academy's EMAIL logo: a bounded PNG rendered from its stored
   * logo (`EmailLogoService`), linked from every academy-identity email as
   * `https://<platform host>/api/v1/public/websites/:academyId/logo?v=<hash>`.
   *
   *  - PNG only, re-encoded (WebP/GIF rasterised, metadata stripped); a
   *    remote URL, SVG or anything undecodable is a 404 and the email shows
   *    the academy name as text instead.
   *  - Read from the PUBLIC media store or the row's own data URI — never
   *    the protected bucket, never a third-party fetch.
   *  - `?v=` matching the stored value's hash → immutable for a year;
   *    anything else (an old email after a logo change) → 5 minutes.
   *  - `Cross-Origin-Resource-Policy: cross-origin` on THIS route only:
   *    webmail and preview panes embed it from another origin, which the
   *    global helmet default (`same-origin`) forbids.
   *  - A generous per-IP ceiling (600/min) instead of the 120/min default:
   *    image proxies (Gmail, Outlook, Apple MPP) fetch from a handful of
   *    shared IPs, but fetch once and cache, so legitimate bursts fit; a
   *    flood does not get unlimited work (security review finding 4).
   *    Unknown academy ids are cached negatively (bounded, short TTL), and
   *    concurrent lookups and decodes are de-duplicated in flight
   *    (`EmailLogoService.renderPublic`); a rendered logo is cached per
   *    (academy, version).
   *  - 404 for an unknown, archived, suspended or ineligible Academy, with
   *    the same body as every other not-found here — no tenant data at all.
   */
  @Get(':academyId/logo')
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  async getEmailLogo(
    @Param('academyId') academyId: string,
    @Query('v') version: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    if (!UUID_PATTERN.test(academyId)) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const logo = await this.emailLogoService.renderPublic(academyId, () =>
      this.publicWebsiteService.findLogoReference(academyId),
    );
    if (!logo) throw new NotFoundException({ messageKey: 'errors.notFound' });
    response.setHeader(
      'Cache-Control',
      version === logo.version
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300',
    );
    response.setHeader('Content-Type', 'image/png');
    response.setHeader('Content-Length', String(logo.png.length));
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.status(200).end(logo.png);
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

  /** Theme 1 plan §D.2 — categories with published, public courses. See `PublicWebsiteService.getPublicCategories`. */
  @Get(':academyId/categories')
  async getCategories(
    @Param('academyId') academyId: string,
  ): Promise<PublicCourseCategoryResponse[]> {
    const categories = await this.publicWebsiteService.getPublicCategories(academyId);
    if (!categories) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return categories;
  }

  /** `FeaturedCoursesSection`/`InstructorsSection`'s real, live, published course list. See `PublicWebsiteService.getPublicCourses`'s own doc comment. */
  @Get(':academyId/courses')
  async getCourses(
    @Param('academyId') academyId: string,
    @Query() query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse>> {
    const result = await this.publicWebsiteService.getPublicCourses(academyId, query);
    if (!result) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return result;
  }

  /** The public Course Details page's real data source. See `PublicWebsiteService.getPublicCourse`'s own doc comment. */
  @Get(':academyId/courses/:courseId')
  async getCourse(
    @Param('academyId') academyId: string,
    @Param('courseId') courseId: string,
  ): Promise<CourseResponse> {
    const course = await this.publicWebsiteService.getPublicCourse(academyId, courseId);
    if (!course) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return course;
  }

  /** The public Course Details page's curriculum preview. See `PublicWebsiteService.getPublicCourseCurriculum`'s own doc comment. */
  @Get(':academyId/courses/:courseId/curriculum')
  async getCourseCurriculum(
    @Param('academyId') academyId: string,
    @Param('courseId') courseId: string,
  ): Promise<readonly PublicCourseCurriculumSectionResponse[]> {
    const curriculum = await this.publicWebsiteService.getPublicCourseCurriculum(
      academyId,
      courseId,
    );
    if (!curriculum) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return curriculum;
  }

  /** P64 Phase 4 — the public, approved reviews of a published+public course. */
  @Get(':academyId/courses/:courseId/reviews')
  async getCourseReviews(
    @Param('academyId') academyId: string,
    @Param('courseId') courseId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<CourseReviewResponse>> {
    const result = await this.publicWebsiteService.getPublicCourseReviews(
      academyId,
      courseId,
      { page: query.page, pageSize: query.pageSize },
    );
    if (!result) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return result;
  }

  /** P64 Phase 4 — the aggregate rating (mean + histogram) over approved reviews. */
  @Get(':academyId/courses/:courseId/rating')
  async getCourseRating(
    @Param('academyId') academyId: string,
    @Param('courseId') courseId: string,
  ): Promise<CourseRatingSummary> {
    const summary = await this.publicWebsiteService.getPublicCourseRatingSummary(
      academyId,
      courseId,
    );
    if (!summary) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return summary;
  }

  /** P64 Phase 4 — related courses (same academy, same category first) for the course-details page. */
  @Get(':academyId/courses/:courseId/recommendations')
  async getCourseRecommendations(
    @Param('academyId') academyId: string,
    @Param('courseId') courseId: string,
  ): Promise<CourseResponse[]> {
    const result = await this.publicWebsiteService.getPublicCourseRecommendations(
      academyId,
      courseId,
    );
    if (!result) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return result;
  }

  /**
   * Phase 6 — the real backend destination for the public Contact
   * section's form. See `PublicWebsiteService.submitContactMessage`'s own
   * doc comment. 5 submissions per 10 minutes per client IP — overrides
   * the global `default` throttler (120/min, keyed by
   * `ClientIpThrottlerGuard`) for this route only; excess requests get the
   * guard's normal 429.
   */
  @Post(':academyId/contact')
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @HttpCode(201)
  async submitContactMessage(
    @Param('academyId') academyId: string,
    @Body() body: SubmitContactMessageDto,
  ): Promise<ContactSubmissionResponse> {
    const submission = await this.publicWebsiteService.submitContactMessage(
      academyId,
      body,
    );
    if (!submission) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return submission;
  }
}
