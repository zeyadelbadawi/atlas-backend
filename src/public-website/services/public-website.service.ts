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
import { randomUUID } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import type { CourseWithRelations } from '../../course/repositories/courses.repository';
import { Injectable } from '@nestjs/common';
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
import { faviconVersion, parseFavicon, type FaviconSource } from '../utils/favicon.util';
import { PublicWebsiteCacheService } from './public-website-cache.service';
import {
  extractSubdomainLabel,
  normalizeHostname,
} from '../utils/hostname-normalization.util';
import type {
  HostnamePresentation,
  HostnameResolutionResponse,
} from '../dto/hostname-resolution.contract';
import { PlatformDomainService } from '../../domain/services/platform-domain.service';
import { resolveCanonicalHost } from '../../domain/utils/canonical-host.util';
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
import { CourseReviewsRepository } from '../../learning/repositories/course-reviews.repository';
import {
  buildRatingSummary,
  toCourseReviewResponse,
} from '../../learning/dto/course-review.contract';
import type {
  CourseRatingSummary,
  CourseReviewResponse,
} from '../../learning/dto/course-review.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { PublicWebsiteStatisticsResponse } from '../dto/public-statistics.contract';
import type { SubmitContactMessageDto } from '../dto/submit-contact-message.dto';
import type { AcademyIdentityResponse } from '../dto/public-identity.contract';
import type { AcademyAddressResponse } from '../../academy/dto/academy.contract';
import { SubscriptionAccessService } from '../../plans/services/subscription-access.service';
import {
  toContactSubmissionResponse,
  type ContactSubmissionResponse,
} from '../../academy/dto/contact-submission.contract';
import { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';
import { CourseCategoriesRepository } from '../../course/repositories/course-categories.repository';
import type { PublicCourseCategoryResponse } from '../dto/public-categories.contract';
import { stripSampleContent } from '../../website/utils/sample-content.util';
import { toPublicBrand } from '../../website/brand/brand-palette-update';
import { WebsiteFaqEntriesRepository } from '../../website/repositories/website-faq-entries.repository';
import { WebsiteTestimonialEntriesRepository } from '../../website/repositories/website-testimonial-entries.repository';
import { WebsiteLibraryRevisionService } from '../../website/services/website-library-revision.service';
import {
  toPublicFaqLibraryEntry,
  toPublicTestimonialLibraryEntry,
} from '../dto/public-library-entry.contract';
import {
  collectLibraryEntryIds,
  expandLibraryEntries,
} from '../utils/library-entries.util';

@Injectable()
export class PublicWebsiteService {
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
    private readonly courseReviewsRepository: CourseReviewsRepository,
    private readonly courseSectionsRepository: CourseSectionsRepository,
    private readonly academiesRepository: AcademiesRepository,
    // Decides whether this tenant may be served publicly at all.
    private readonly subscriptionAccessService: SubscriptionAccessService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly metrics: LearningMetricsService,
    // Theme 1 plan Phase 2 — the public category listing.
    private readonly courseCategoriesRepository: CourseCategoriesRepository,
    // FAQ & testimonial content library, expanded into the public pages.
    private readonly websiteFaqEntriesRepository: WebsiteFaqEntriesRepository,
    private readonly websiteTestimonialEntriesRepository: WebsiteTestimonialEntriesRepository,
    private readonly libraryRevisionService: WebsiteLibraryRevisionService,
  ) {}

  /** P63g — the effective base domain (environment first, then the configured row), never only the env var. */
  private async baseDomainNow(): Promise<string | undefined> {
    return (await this.platformDomainService.getEffectiveBaseDomain()).baseDomain;
  }

  /** Resolves the candidate subdomain label to try: the trusted-base-domain-derived one first, falling back to treating a bare, dot-free input as a direct subdomain label (this is what makes a real Academy subdomain like `harvard` — sent with no base-domain suffix at all, e.g. a local/dev lookup — resolvable without the backend needing any dev-mode-specific branch of its own). */
  private resolveSubdomainCandidate(
    normalizedHostname: string,
    baseDomain: string | undefined,
  ): string | null {
    const extracted = extractSubdomainLabel(normalizedHostname, baseDomain);
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

    const baseDomain = await this.baseDomainNow();
    const subdomainLabel = this.resolveSubdomainCandidate(normalized, baseDomain);
    const resolved = await this.publicHostnameResolutionRepository.resolve(
      normalized,
      subdomainLabel,
    );
    if (!resolved) return null;

    // Same rule and same inputs as the dashboard (`DomainService.toResponse`):
    // the allocation's stored full host, else label + effective base domain.
    const canonical = resolveCanonicalHost({
      connectedCustomHostname: resolved.customHostname,
      subdomainFullHost: resolved.subdomainFullHost,
      subdomainLabel: resolved.subdomain,
      baseDomain,
    });
    const [presentation, favicon] = await Promise.all([
      this.findPresentation(resolved.academyId),
      this.findFaviconVersion(resolved.academyId),
    ]);
    const response: HostnameResolutionResponse = {
      academyId: resolved.academyId,
      academyName: resolved.academyName,
      academySlug: resolved.academySlug,
      academyLogo: resolved.academyLogoUrl ?? undefined,
      canonicalHost: canonical?.host,
      ...(favicon ? { faviconVersion: favicon } : {}),
      ...(presentation ? { presentation } : {}),
    };
    await this.cacheService.setHostnameResolution(normalized, response);
    return response;
  }

  /**
   * The version of this Academy's favicon (`favicon.util.ts`), when it has
   * one the public site can serve — the public runtime links
   * `public/websites/:academyId/favicon?v=<version>`, so a new upload is a
   * new URL. Same gate as the favicon read itself, so the link is never
   * advertised for a favicon that read would refuse.
   */
  private async findFaviconVersion(academyId: string): Promise<string | undefined> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return undefined;
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academiesRepository.findById(tx, academyId),
    );
    const stored = academy?.faviconUrl;
    return stored && parseFavicon(stored) ? faviconVersion(stored) : undefined;
  }

  /**
   * `GET public/websites/:academyId/favicon` — the Academy's own favicon,
   * gated exactly like the identity read (an Academy whose site must not be
   * served has none here either). `null` when there is nothing to serve.
   */
  async getFavicon(
    academyId: string,
  ): Promise<{ readonly source: FaviconSource; readonly version: string } | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academiesRepository.findById(tx, academyId),
    );
    const stored = academy?.faviconUrl;
    const source = parseFavicon(stored);
    return stored && source ? { source, version: faviconVersion(stored) } : null;
  }

  /**
   * W3 — the stored logo value behind `GET public/websites/:academyId/logo`,
   * gated exactly like the favicon and the identity read: an unknown,
   * archived, suspended or not-serving-eligible Academy has none (`null`).
   * The value itself never leaves the server — the controller renders it
   * into a bounded PNG through `EmailLogoService`.
   */
  async getLogoReference(academyId: string): Promise<string | null> {
    return (await this.findLogoReference(academyId)) ?? null;
  }

  /**
   * As `getLogoReference`, but tells "no such serving academy" (`undefined`
   * — unknown, archived, suspended, ineligible) apart from "an academy with
   * no logo" (`null`), so the public route can cache only the former
   * negatively (security review finding 4).
   */
  async findLogoReference(academyId: string): Promise<string | null | undefined> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return undefined;
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academiesRepository.findById(tx, academyId),
    );
    if (!academy) return undefined;
    return academy.logoUrl ?? null;
  }

  /**
   * Theme 1 plan Phase 6 — the Academy's theme key and public brand colours,
   * whatever the website's publication state, so Coming Soon can wear them.
   * Read through `resolve_public_presentation` (an unpublished configuration
   * is invisible to anonymous tenant reads by design) and reduced to exactly
   * the colour fields a published website already exposes: no content, no
   * draft data, no palette provenance.
   */
  private async findPresentation(
    academyId: string,
  ): Promise<HostnamePresentation | undefined> {
    const presentation =
      await this.publicHostnameResolutionRepository.resolvePresentation(academyId);
    if (!presentation) return undefined;
    const brand = toPublicBrand(presentation.brand);
    const colour = (key: string) =>
      typeof brand[key] === 'string' ? (brand[key] as string) : undefined;
    const palette =
      brand.palette && typeof brand.palette === 'object'
        ? (brand.palette as Record<string, unknown>)
        : undefined;
    return {
      themeKey: presentation.themeKey,
      brand: {
        primaryColor: colour('primaryColor'),
        secondaryColor: colour('secondaryColor'),
        accentColor: colour('accentColor'),
        ...(palette ? { palette } : {}),
      },
    };
  }

  /**
   * The Organization that owns this Academy — or `null` when its website
   * must not be served.
   *
   * WHY THE SUBSCRIPTION CHECK LIVES HERE. This is the single choke point
   * every public read already passes through (`getPublishedWebsite`,
   * `getPublishedPages`, the page-by-slug read), so one check covers all of
   * them and there is no fourth read that could be added later and quietly
   * miss it.
   *
   * WHY `null` RATHER THAN AN ERROR. Returning nothing produces exactly the
   * same 404 an unpublished site already produces, which the public runtime
   * already renders as the Coming Soon page. A visitor therefore sees a
   * professional holding page, never a server error — and, importantly,
   * never learns anything about the Academy's billing. That a business has
   * not paid is between Atlas and that business; publishing it on their own
   * domain, in front of their own customers, would be a real harm done to
   * them by their supplier.
   *
   * The hostname itself keeps resolving. The domain stays technically
   * healthy, exactly as the unknown/unavailable/expired distinction
   * requires — this changes what is SERVED, not whether the address works.
   */
  private async resolveOrganizationId(academyId: string): Promise<string | null> {
    const organizationId =
      await this.publicHostnameResolutionRepository.resolveAcademyOrganization(academyId);
    if (!organizationId) return null;

    return (await this.isServingEligible(organizationId)) ? organizationId : null;
  }

  /**
   * Cached because this is the highest-traffic surface in the product and
   * the answer changes a handful of times per tenant per year. A payment
   * invalidates it explicitly rather than waiting out the TTL.
   */
  private async isServingEligible(organizationId: string): Promise<boolean> {
    const cached = await this.cacheService.getServingEligibility(organizationId);
    if (cached !== undefined) return cached;

    const eligible =
      await this.subscriptionAccessService.isServingEligible(organizationId);
    await this.cacheService.setServingEligibility(organizationId, eligible);
    return eligible;
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

    const configurationResponse = toWebsiteConfigurationResponse(configuration);
    // Theme 1 plan §D.2 — the palette's colours are public; who confirmed it,
    // when, and the logo analysis are not.
    const response: WebsiteConfigurationResponse = {
      ...configurationResponse,
      brand: toPublicBrand(configurationResponse.brand),
    };
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

    const libraryRevision = await this.libraryRevisionService.get(academyId);
    const cached = await this.cacheService.getPages<WebsitePageResponse[]>(
      academyId,
      configuration.configVersion,
      libraryRevision,
    );
    if (cached) return cached;

    const { pages, faqEntries, testimonialEntries } =
      await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        const pages = (
          await this.websitePagesRepository.findAllPublished(tx, academyId)
        ).map(toWebsitePageResponse);
        // Content library: only the referenced entries that are published,
        // visible and this Academy's — the repository's query is the gate.
        const ids = collectLibraryEntryIds(pages);
        const [faqEntries, testimonialEntries] = await Promise.all([
          this.websiteFaqEntriesRepository.findPublishedVisibleByIds(
            tx,
            academyId,
            ids.faq,
          ),
          this.websiteTestimonialEntriesRepository.findPublishedVisibleByIds(
            tx,
            academyId,
            ids.testimonials,
          ),
        ]);
        return { pages, faqEntries, testimonialEntries };
      });
    const faqById = new Map(
      faqEntries.map((entry) => [entry.id, toPublicFaqLibraryEntry(entry)]),
    );
    const testimonialById = new Map(
      testimonialEntries.map((entry) => [
        entry.id,
        toPublicTestimonialLibraryEntry(entry),
      ]),
    );
    // Theme 1 plan §D.4 — sample testimonials are preview-only: removed
    // here, before caching, so they never reach a visitor's browser.
    const response = pages.map((mapped) => {
      return {
        ...mapped,
        sections: expandLibraryEntries(
          stripSampleContent(mapped.sections),
          faqById,
          testimonialById,
        ),
      };
    });
    await this.cacheService.setPages(
      academyId,
      configuration.configVersion,
      libraryRevision,
      response,
    );
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

    const [courses, students, instructors] =
      await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
        Promise.all([
          this.coursesRepository.countPublished(tx, academyId),
          this.academyStudentsRepository.countActiveForAcademy(tx, academyId),
          this.academyMembersRepository.countByRoleAndStatus(tx, academyId, 'instructor'),
        ]),
      );

    return { courses, students, instructors };
  }

  /**
   * Theme 1 plan §D.2 — the "Explore by category" section's live data: this
   * Academy's categories that hold at least one published, public course,
   * with that count, alphabetically. Same `resolveOrganizationId` +
   * `runInTenantContext` shape as `getPublicCourses` (RLS-scoped to the
   * Academy's organisation; no user identity). A category with only draft
   * or private courses is omitted, so the listing can't reveal them.
   */
  async getPublicCategories(
    academyId: string,
  ): Promise<PublicCourseCategoryResponse[] | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const [categories, counts] = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        Promise.all([
          this.courseCategoriesRepository.findManyForAcademy(tx, academyId),
          this.courseCategoriesRepository.countPublishedPublicCoursesByCategory(
            tx,
            academyId,
          ),
        ]),
    );
    const countByCategory = new Map(
      counts.map((row) => [row.categoryId, row._count.categoryId] as const),
    );
    return categories
      .map((category) => ({
        id: category.id,
        name: category.name,
        slug: category.slug,
        ...(category.description ? { description: category.description } : {}),
        courseCount: countByCategory.get(category.id) ?? 0,
      }))
      .filter((category) => category.courseCount > 0);
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

    // P64 Phase 4 (§D.5) — the catalog query is timed around the repository
    // call itself (transaction included), the same way the quiz engine
    // times an autosave; the cache and count-batch below are not part of it.
    const catalogStarted = process.hrtime.bigint();
    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.coursesRepository.findManyPublished(tx, {
          academyId,
          search: query.search,
          categoryId: query.categoryId,
          pricingType: query.pricingType,
          level: query.level,
          language: query.language,
          priceMinMinorUnits: query.priceMin,
          priceMaxMinorUnits: query.priceMax,
          ids: query.ids,
          sortBy: query.sortBy as
            'title' | 'createdAt' | 'updatedAt' | 'publishedAt' | 'price' | undefined,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );
    this.metrics.recordPublicCatalogQuery(
      Number(process.hrtime.bigint() - catalogStarted) / 1e6,
    );

    const ids = items.map((course) => course.id);
    const [
      { sectionCounts, lessonCounts },
      aggregates,
      { quizCounts, assignmentCounts },
    ] = await this.tenancyContextService.runInTenantContext(organizationId, (tx) =>
      Promise.all([
        this.coursesRepository.countSectionsAndLessonsBatch(tx, ids),
        this.coursesRepository.catalogAggregatesBatch(tx, ids),
        this.coursesRepository.countPublishedAssessmentsBatch(tx, ids),
      ]),
    );
    const withStats = items.map((course) =>
      toCourseResponse(course, {
        totalSections: sectionCounts.get(course.id) ?? 0,
        totalLessons: lessonCounts.get(course.id) ?? 0,
        durationSeconds: aggregates.durationSeconds.get(course.id) ?? null,
        hasPreview: aggregates.hasPreview.has(course.id),
        averageRating: aggregates.ratings.get(course.id)?.average ?? 0,
        totalReviews: aggregates.ratings.get(course.id)?.total ?? 0,
        totalQuizzes: quizCounts.get(course.id) ?? 0,
        totalAssignments: assignmentCounts.get(course.id) ?? 0,
      }),
    );

    return {
      items: withStats,
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
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
  async getPublicCourse(
    academyId: string,
    courseId: string,
  ): Promise<CourseResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const result = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const course = await this.findPublishedPublicCourseByIdOrSlug(
          tx,
          academyId,
          courseId,
        );
        if (!course) return null;
        const [totalSections, totalLessons, aggregates, assessments] = await Promise.all([
          this.coursesRepository.countSections(tx, course.id),
          this.coursesRepository.countLessons(tx, course.id),
          this.coursesRepository.catalogAggregatesBatch(tx, [course.id]),
          this.coursesRepository.countPublishedAssessmentsBatch(tx, [course.id]),
        ]);
        return { course, totalSections, totalLessons, aggregates, assessments };
      },
    );
    if (!result) return null;

    const { course, aggregates } = result;
    return toCourseResponse(course, {
      totalSections: result.totalSections,
      totalLessons: result.totalLessons,
      durationSeconds: aggregates.durationSeconds.get(course.id) ?? null,
      hasPreview: aggregates.hasPreview.has(course.id),
      averageRating: aggregates.ratings.get(course.id)?.average ?? 0,
      totalReviews: aggregates.ratings.get(course.id)?.total ?? 0,
      totalQuizzes: result.assessments.quizCounts.get(course.id) ?? 0,
      totalAssignments: result.assessments.assignmentCounts.get(course.id) ?? 0,
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
      const course = await this.findPublishedPublicCourseByIdOrSlug(
        tx,
        academyId,
        courseId,
      );
      if (!course) return null;
      const sections = await this.courseSectionsRepository.findManyForCourse(
        tx,
        course.id,
      );
      return toPublicCourseCurriculumResponse(sections);
    });
  }

  /**
   * P64 Phase 4 — the public, approved reviews of a published+public
   * course. Gated the same way as every other public read: serving
   * eligibility resolves the org, then the course must resolve as
   * published+public in THIS academy (defense in depth beyond the
   * `course_reviews_public_select` RLS policy, and it also canonicalises a
   * slug to the real course id before the review lookup). `null` when the
   * academy is not served or the course is not publicly visible.
   */
  async getPublicCourseReviews(
    academyId: string,
    courseId: string,
    query: { page?: number; pageSize?: number },
  ): Promise<PaginatedResult<CourseReviewResponse> | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const course = await this.findPublishedPublicCourseByIdOrSlug(
        tx,
        academyId,
        courseId,
      );
      if (!course) return null;
      const page = query.page ?? DEFAULT_PAGE;
      const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
      const { items, totalItems } =
        await this.courseReviewsRepository.listApprovedByCourse(tx, course.id, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      return {
        items: items.map(toCourseReviewResponse),
        pagination: buildPaginationMeta(page, pageSize, totalItems),
      };
    });
  }

  /**
   * P64 Phase 4 — the aggregate rating signal a catalog/course-details page
   * renders. Computed only over approved reviews of a published+public
   * course; `null` under the same gating as the list above. A course with
   * no approved reviews returns a real zeroed summary (average 0, total 0),
   * not `null` — `null` means "not publicly visible", zero means "visible,
   * no reviews yet".
   */
  async getPublicCourseRatingSummary(
    academyId: string,
    courseId: string,
  ): Promise<CourseRatingSummary | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const course = await this.findPublishedPublicCourseByIdOrSlug(
        tx,
        academyId,
        courseId,
      );
      if (!course) return null;
      const ratings = await this.courseReviewsRepository.approvedRatings(tx, course.id);
      return buildRatingSummary(course.id, ratings);
    });
  }

  /**
   * P64 Phase 4 — "related courses" for a course-details page: other
   * published+public courses of the SAME academy (never cross-academy,
   * §H), same category first. `null` under the usual public gating; an
   * empty array when the academy has no other public courses.
   */
  async getPublicCourseRecommendations(
    academyId: string,
    courseId: string,
    limit = 8,
  ): Promise<CourseResponse[] | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const course = await this.findPublishedPublicCourseByIdOrSlug(
        tx,
        academyId,
        courseId,
      );
      if (!course) return null;
      const recommendations = await this.coursesRepository.findRecommendations(
        tx,
        academyId,
        course.id,
        course.categoryId ?? null,
        limit,
      );
      const ids = recommendations.map((c) => c.id);
      const [{ sectionCounts, lessonCounts }, { quizCounts, assignmentCounts }] =
        await Promise.all([
          this.coursesRepository.countSectionsAndLessonsBatch(tx, ids),
          this.coursesRepository.countPublishedAssessmentsBatch(tx, ids),
        ]);
      return recommendations.map((c) =>
        toCourseResponse(c, {
          totalSections: sectionCounts.get(c.id) ?? 0,
          totalLessons: lessonCounts.get(c.id) ?? 0,
          // A quiz-only course's card says what it holds, as the catalog does.
          totalQuizzes: quizCounts.get(c.id) ?? 0,
          totalAssignments: assignmentCounts.get(c.id) ?? 0,
        }),
      );
    });
  }

  /**
   * P64 Phase 1 — the public course page is addressed by id OR by the
   * academy-scoped slug (the production website linked `/courses/{slug}`
   * while this API resolved ids only, and every such page 404'd). The
   * slug lookup is scoped to this academy's compound key, so a same-slug
   * course in another academy is never even queried; both paths still
   * require published + public and this academy's ownership.
   */
  private async findPublishedPublicCourseByIdOrSlug(
    tx: Prisma.TransactionClient,
    academyId: string,
    courseIdOrSlug: string,
  ): Promise<CourseWithRelations | null> {
    const byId = await this.coursesRepository.findPublishedById(tx, courseIdOrSlug);
    if (byId && byId.academyId === academyId) return byId;
    if (byId) return null;
    const bySlug = await this.coursesRepository.findByAcademyAndSlug(
      tx,
      academyId,
      courseIdOrSlug.toLowerCase(),
    );
    if (!bySlug) return null;
    const published = await this.coursesRepository.findPublishedById(tx, bySlug.id);
    return published && published.academyId === academyId ? published : null;
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
      description: academy.description?.trim() || undefined,
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
   *
   * Only a PUBLISHED website accepts messages (the same
   * `findPublishedByAcademyId` condition every public read uses); an
   * unpublished one gets the same `null` → 404 as an unknown Academy. A
   * filled honeypot (`company`) is checked only after those, so a bot
   * learns nothing a person would not, and is then discarded silently.
   */
  async submitContactMessage(
    academyId: string,
    payload: SubmitContactMessageDto,
  ): Promise<ContactSubmissionResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
    );
    if (!configuration) return null;

    if ((payload.company ?? '').trim().length > 0) {
      return this.toDiscardedSubmissionResponse(academyId, payload);
    }

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

  /**
   * The success response for a honeypot-discarded submission: the same
   * shape and status a stored one gets, so a bot cannot tell them apart.
   * Every field echoes only what the caller sent or a fresh value — the
   * `id` is a random UUID (the same format a real row's id has) that
   * refers to nothing, and no stored data is read or exposed.
   */
  private toDiscardedSubmissionResponse(
    academyId: string,
    payload: SubmitContactMessageDto,
  ): ContactSubmissionResponse {
    return {
      id: randomUUID(),
      academyId,
      name: payload.name,
      email: payload.email,
      message: payload.message,
      status: 'new', // the column default a stored row starts with
      createdAt: new Date().toISOString(),
    };
  }
}
