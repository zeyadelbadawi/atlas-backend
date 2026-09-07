/**
 * PublicWebsiteService — matches the real frontend `PublicWebsiteService`
 * exactly: `resolveHostname`/`getPublishedWebsite`/`getPublishedPages`/
 * `getPublishedPage`. No session, no `AcademyScopeGuard` — Academy
 * identity comes FROM the hostname (or, for the latter three methods, an
 * `academyId` the caller already obtained from a real `resolveHostname`
 * response), never trusted as a client-supplied parameter on its own
 * (master plan §21 P11 "Tenant Isolation": "trusted hostname → exact
 * domain/subdomain allocation → academy → published website data").
 *
 * THE CRITICAL SECURITY INVARIANT (master plan §21 P11 §5): every method
 * below makes the publication condition part of the database query
 * itself (`WebsiteConfigurationRepository.findPublishedByAcademyId`/
 * `WebsitePagesRepository.findAllPublished`/`findPublishedBySlug`, P9,
 * reused unmodified) — never "fetch, then check status." A draft/
 * unpublished/hidden row is indistinguishable, from this service's return
 * shape alone, from a row that does not exist at all.
 *
 * Reuses P9's own `toWebsiteConfigurationResponse`/`toWebsitePageResponse`
 * response mappers — the public response is byte-for-byte the same
 * `WebsiteConfiguration`/`WebsitePage` shape the authenticated dashboard
 * already returns (confirmed directly: `PublicWebsiteService`, frontend,
 * imports the exact same `WebsiteConfiguration`/`WebsitePage` types from
 * `@types`), never a second, parallel public projection.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { WebsiteConfigurationRepository } from '../../website/repositories/website-configuration.repository';
import { WebsitePagesRepository } from '../../website/repositories/website-pages.repository';
import {
  toWebsiteConfigurationResponse,
  type WebsiteConfigurationResponse,
} from '../../website/dto/website-configuration.contract';
import {
  toWebsitePageResponse,
  type WebsitePageResponse,
} from '../../website/dto/website-page.contract';
import { PublicHostnameResolutionRepository } from '../repositories/public-hostname-resolution.repository';
import { PublicWebsiteCacheService } from './public-website-cache.service';
import {
  extractSubdomainLabel,
  normalizeHostname,
} from '../utils/hostname-normalization.util';
import type { HostnameResolutionResponse } from '../dto/hostname-resolution.contract';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
// Phase 6 additions — see this file's own header comment.
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { ContactSubmissionsRepository } from '../../academy/repositories/contact-submissions.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { CourseSectionsRepository } from '../../course/repositories/course-sections.repository';
import { toCourseResponse } from '../../course/dto/course.contract';
import type { CourseResponse } from '../../course/dto/course.contract';
import type { CourseListQueryDto } from '../../course/dto/course-list-query.dto';
import { toPublicCourseCurriculumResponse } from '../dto/public-course-curriculum.contract';
import type { PublicCourseCurriculumSectionResponse } from '../dto/public-course-curriculum.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { PublicWebsiteStatisticsResponse } from '../dto/public-statistics.contract';
import type { SubmitContactMessageDto } from '../dto/submit-contact-message.dto';
import type { AcademyIdentityResponse } from '../dto/public-identity.contract';
import type { AcademyAddressResponse } from '../../academy/dto/academy.contract';
import {
  toContactSubmissionResponse,
  type ContactSubmissionResponse,
} from '../../academy/dto/contact-submission.contract';

@Injectable()
export class PublicWebsiteService {
  private readonly baseDomain?: string;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly publicHostnameResolutionRepository: PublicHostnameResolutionRepository,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly cacheService: PublicWebsiteCacheService,
    // Phase 6 additions — see this file's own header comment.
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly contactSubmissionsRepository: ContactSubmissionsRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly courseSectionsRepository: CourseSectionsRepository,
    private readonly academiesRepository: AcademiesRepository,
    configService: ConfigService,
  ) {
    this.baseDomain =
      configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;
  }

  /** Resolves the candidate subdomain label to try: the trusted-base-domain-derived one first, falling back to treating a bare, dot-free input as a direct subdomain label (this is what makes a real Academy subdomain like `harvard` — sent with no base-domain suffix at all, e.g. a local/dev lookup — resolvable without the backend needing any dev-mode-specific branch of its own). */
  private resolveSubdomainCandidate(normalizedHostname: string): string | null {
    const extracted = extractSubdomainLabel(normalizedHostname, this.baseDomain);
    if (extracted) return extracted;
    return normalizedHostname.includes('.') ? null : normalizedHostname;
  }

  async resolveHostname(rawHostname: string): Promise<HostnameResolutionResponse | null> {
    const normalized = normalizeHostname(rawHostname);
    if (!normalized) return null;

    const cached =
      await this.cacheService.getHostnameResolution<HostnameResolutionResponse>(
        normalized,
      );
    if (cached) return cached;

    const subdomainLabel = this.resolveSubdomainCandidate(normalized);
    const resolved = await this.publicHostnameResolutionRepository.resolve(
      normalized,
      subdomainLabel,
    );
    if (!resolved) return null;

    const response: HostnameResolutionResponse = {
      academyId: resolved.academyId,
      academyName: resolved.academyName,
      academySlug: resolved.academySlug,
      academyLogo: resolved.academyLogoUrl ?? undefined,
    };
    await this.cacheService.setHostnameResolution(normalized, response);
    return response;
  }

  private async resolveOrganizationId(academyId: string): Promise<string | null> {
    return this.publicHostnameResolutionRepository.resolveAcademyOrganization(academyId);
  }

  async getPublishedWebsite(
    academyId: string,
  ): Promise<WebsiteConfigurationResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
    );
    if (!configuration) return null;

    const response = toWebsiteConfigurationResponse(configuration);
    const cached = await this.cacheService.getConfiguration<WebsiteConfigurationResponse>(
      academyId,
      configuration.configVersion,
    );
    if (cached) return cached;
    await this.cacheService.setConfiguration(
      academyId,
      configuration.configVersion,
      response,
    );
    return response;
  }

  async getPublishedPages(
    academyId: string,
  ): Promise<readonly WebsitePageResponse[] | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
    );
    if (!configuration) return null;

    const cached = await this.cacheService.getPages<WebsitePageResponse[]>(
      academyId,
      configuration.configVersion,
    );
    if (cached) return cached;

    const pages = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websitePagesRepository.findAllPublished(tx, academyId),
    );
    const response = pages.map(toWebsitePageResponse);
    await this.cacheService.setPages(academyId, configuration.configVersion, response);
    return response;
  }

  async getPublishedPage(
    academyId: string,
    slug: string,
  ): Promise<WebsitePageResponse | null> {
    // Reuses the already-cached full pages array — one cache read serves
    // every slug lookup for this Academy's current published version,
    // never a fourth, separately-keyed cache entry.
    const pages = await this.getPublishedPages(academyId);
    if (!pages) return null;
    return pages.find((page) => page.slug === slug) ?? null;
  }

  /**
   * Phase 6 — `StatisticsSection`'s real, live, Academy-scoped counts.
   * `academyId` is resolved to an organization exactly like every other
   * method on this service (never trusted on its own); `null` here means
   * the SAME thing it means everywhere else in this file — "no such
   * Academy, from this caller's point of view" — so the controller turns
   * it into the identical plain 404. One `runInTenantContext`, three
   * counts, no revenue or any other private figure ever touched.
   */
  async getPublicStatistics(
    academyId: string,
  ): Promise<PublicWebsiteStatisticsResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const [courses, students, instructors] = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        Promise.all([
          this.coursesRepository.countPublished(tx, academyId),
          this.academyStudentsRepository.countForAcademy(tx, academyId),
          this.academyMembersRepository.countByRoleAndStatus(tx, academyId, 'instructor'),
        ]),
    );

    return { courses, students, instructors };
  }

  /**
   * `FeaturedCoursesSection`/`InstructorsSection`'s real, live, published-
   * course list — added after both sections were found calling the
   * TENANT-scoped `GET /academies/:id/courses` (`CoursesService.list`,
   * `AcademyScopeGuard`-gated) from the public website, which 403s for
   * literally any real visitor (anonymous or authenticated) with no
   * `OrganizationMembership` in this Academy's org — i.e. every genuine
   * public visitor a marketing site exists for. Same `resolveOrganizationId`
   * + `runInTenantContext` shape as every other method here (no user
   * identity, no membership check), reusing the cross-academy discovery
   * catalog's own `findManyPublished` (`CourseDiscoveryService`'s doc
   * comment) with its `academyId` filter now scoping it to one Academy.
   * `query.status`/`.visibility` are deliberately never read, exactly like
   * `CourseDiscoveryService.discoverCourses` — see `findManyPublished`'s
   * own doc comment for why a discovery-style caller must never be able to
   * widen this to a draft/private course via a crafted query param.
   */
  async getPublicCourses(
    academyId: string,
    query: CourseListQueryDto,
  ): Promise<PaginatedResult<CourseResponse> | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.coursesRepository.findManyPublished(tx, {
          academyId,
          search: query.search,
          categoryId: query.categoryId,
          pricingType: query.pricingType,
          sortBy: query.sortBy as
            'title' | 'createdAt' | 'updatedAt' | 'publishedAt' | undefined,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    const { sectionCounts, lessonCounts } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.coursesRepository.countSectionsAndLessonsBatch(tx, items.map((course) => course.id)),
    );
    const withStats = items.map((course) =>
      toCourseResponse(course, {
        totalSections: sectionCounts.get(course.id) ?? 0,
        totalLessons: lessonCounts.get(course.id) ?? 0,
      }),
    );

    return { items: withStats, pagination: buildPaginationMeta(page, pageSize, totalItems) };
  }

  /**
   * The public Course Details marketing page's real data source — added
   * alongside the Course Details UX overhaul after finding
   * `CourseDetailsTemplate` (frontend) was calling `useCourse`, the
   * TENANT-scoped `GET academies/:id/courses/:courseId`
   * (`JwtAuthGuard`+`AcademyScopeGuard`), the exact same "403s for every
   * real visitor" bug `getPublicCourses` above already documents having
   * fixed for the listing section — just never applied to the single-
   * course template. Same shape, same rule: `findPublishedById` is the
   * P6 discovery catalog's own single-course lookup (published+public
   * only, RLS-backed), re-scoped here to confirm the course actually
   * belongs to THIS academy (defense in depth — `findPublishedById`
   * itself is cross-academy by design, matching `discoverCourse`'s use of
   * it) rather than trusting the caller's `academyId` alone.
   */
  async getPublicCourse(academyId: string, courseId: string): Promise<CourseResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const result = await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const course = await this.coursesRepository.findPublishedById(tx, courseId);
      if (!course || course.academyId !== academyId) return null;
      const [totalSections, totalLessons] = await Promise.all([
        this.coursesRepository.countSections(tx, courseId),
        this.coursesRepository.countLessons(tx, courseId),
      ]);
      return { course, totalSections, totalLessons };
    });
    if (!result) return null;

    return toCourseResponse(result.course, {
      totalSections: result.totalSections,
      totalLessons: result.totalLessons,
    });
  }

  /**
   * The public Course Details page's curriculum PREVIEW — real section/
   * lesson titles and structure for a visitor who has not enrolled yet,
   * with no `contentUrl`/`description` ever leaving this method (see
   * `toPublicCourseCurriculumResponse`'s own doc comment for why). Same
   * academy-ownership + published-course confirmation as `getPublicCourse`
   * before any section is even queried.
   */
  async getPublicCourseCurriculum(
    academyId: string,
    courseId: string,
  ): Promise<PublicCourseCurriculumSectionResponse[] | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const course = await this.coursesRepository.findPublishedById(tx, courseId);
      if (!course || course.academyId !== academyId) return null;
      const sections = await this.courseSectionsRepository.findManyForCourse(tx, courseId);
      return toPublicCourseCurriculumResponse(sections);
    });
  }

  /**
   * Phase 6 — the ONE combined Academy Identity/Branding read, reused by
   * the public website, the Student LMS, and (indirectly, matching this
   * exact shape) the authenticated dashboard. See
   * `AcademyIdentityResponse`'s own doc comment for why this reads two
   * already-existing sources rather than a new one. Colors are present
   * only when a real, PUBLISHED `WebsiteConfiguration` exists — an Academy
   * that has never published a website still resolves a real name/logo/
   * contact identity, just with no custom color overrides.
   */
  async getPublicIdentity(academyId: string): Promise<AcademyIdentityResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const [academy, configuration] = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        Promise.all([
          this.academiesRepository.findById(tx, academyId),
          this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
        ]),
    );
    if (!academy) return null;

    const brand = (configuration?.brand ?? undefined) as
      | { primaryColor?: unknown; secondaryColor?: unknown; accentColor?: unknown }
      | undefined;
    const asColor = (value: unknown): string | undefined =>
      typeof value === 'string' ? value : undefined;

    return {
      academyId: academy.id,
      name: academy.name,
      logoUrl: academy.logoUrl ?? undefined,
      faviconUrl: academy.faviconUrl ?? undefined,
      primaryColor: asColor(brand?.primaryColor),
      secondaryColor: asColor(brand?.secondaryColor),
      accentColor: asColor(brand?.accentColor),
      contactEmail: academy.contactEmail ?? undefined,
      contactPhone: academy.contactPhone ?? undefined,
      address: (academy.address as AcademyAddressResponse | null) ?? undefined,
    };
  }

  /**
   * Phase 6 — the real backend destination for the public Contact
   * section's form (previously an intentional no-op). `academyId` is
   * resolved to an organization exactly like every other method on this
   * service; the resulting SERVER-resolved `organizationId` (never a
   * client-supplied one) is what `contact_submissions_public_insert`'s
   * `WITH CHECK` actually verifies against (see that policy's own doc
   * comment, P27 migration) — a request naming an academyId that does not
   * resolve to a real organization never reaches the insert at all.
   */
  async submitContactMessage(
    academyId: string,
    payload: SubmitContactMessageDto,
  ): Promise<ContactSubmissionResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const created = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.contactSubmissionsRepository.create(tx, {
          academyId,
          name: payload.name,
          email: payload.email,
          message: payload.message,
        }),
    );
    return toContactSubmissionResponse(created);
  }
}
