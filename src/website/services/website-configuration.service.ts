/**
 * WebsiteConfigurationService — matches the real frontend
 * `WebsiteConfigurationService`'s configuration-half exactly:
 * `getConfiguration`/`updateConfiguration`/`publishConfiguration`.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other service
 * in this codebase's "never trust the guard's own read" discipline.
 *
 * Write authorization mirrors `CoursesService`/`MediaService`'s
 * `assertCanManage` exactly: organization membership alone is
 * READ-sufficient (`AcademyScopeGuard`), WRITE (update/publish) requires
 * an `academy_members` row with role `owner`/`administrator`.
 *
 * `brand`/`seo` are partial merges onto the existing stored JSON (matching
 * `UpdateWebsiteConfigurationPayload.brand`/`.seo` being `Partial<...>`),
 * the same shallow-merge-then-validate-the-result discipline
 * `AcademiesService.update` already established for `Academy.address`.
 * `navigation`/`header`/`footer` are full replaces (their payload fields
 * are NOT `Partial<...>`), validated directly.
 *
 * Publish (master plan §21 P9: "must NOT implement yet: public
 * rendering") is deliberately minimal and deterministic — there is
 * nothing to render yet (P11's job), so this sets `status = 'published'`,
 * `publishedAt = now()` synchronously in the same request, with no queue,
 * no worker, no `'publishing'` intermediate state. `'publishing'`/`'failed'`
 * remain real, valid enum values (matching the frontend's
 * `WebsitePublishStatus` type exactly) for a future P11 async
 * render-worker to use — this phase just never produces them itself.
 */
import { resolveBrandUpdate } from '../brand/brand-palette-update';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import {
  collectSampleContent,
  type SampleContentEntry,
} from '../utils/sample-content.util';
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { STALE_RESOURCE_VERSION_CODE } from '../../concurrency/errors/stale-resource-version.exception';
import { Prisma } from '@prisma/client';
import type { WebsiteConfiguration } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademiesService } from '../../academy/services/academies.service';
import {
  toAcademyResponse,
  type AcademyResponse,
} from '../../academy/dto/academy.contract';
import type { SaveVisualIdentityDto } from '../dto/save-visual-identity.dto';
import {
  WebsiteConfigurationRepository,
  buildPublishedSnapshot,
  hasUnpublishedConfigurationChanges,
} from '../repositories/website-configuration.repository';
import { WebsiteBootstrapService } from './website-bootstrap.service';
import { SectionReferenceValidatorService } from './section-reference-validator.service';
import {
  toWebsiteConfigurationResponse,
  type WebsiteConfigurationResponse,
} from '../dto/website-configuration.contract';
import type { UpdateWebsiteConfigurationDto } from '../dto/update-website-configuration.dto';
import {
  websiteBrandPatchSchema,
  websiteBrandSchema,
  websiteFooterSchema,
  websiteHeaderSchema,
  websiteNavigationSchema,
  globalSeoSchema,
} from '../validation/website-config.schemas';
import { parseOrThrow } from '../../common/validation/zod-violations.util';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/** The publish response: the configuration plus the sample-content warning (§D.4). Additive — older clients ignore it. */
export type PublishWebsiteResponse = WebsiteConfigurationResponse & {
  readonly sampleContent: readonly SampleContentEntry[];
};

@Injectable()
export class WebsiteConfigurationService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websiteBootstrapService: WebsiteBootstrapService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly sectionReferenceValidatorService: SectionReferenceValidatorService,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academiesService: AcademiesService,
  ) {}

  /**
   * Refuses a save based on a copy someone has saved over since. Locks the
   * row first, so two saves based on the same copy cannot both pass.
   */
  private async assertNotStale(
    tx: Prisma.TransactionClient,
    academyId: string,
    expectedUpdatedAt: string | undefined,
  ): Promise<void> {
    if (expectedUpdatedAt === undefined) return;
    await this.websiteBootstrapService.ensureConfiguration(tx, academyId);
    await this.websiteConfigurationRepository.lockForPublish(tx, academyId);
    const current = await this.websiteBootstrapService.ensureConfiguration(tx, academyId);
    if (Date.parse(expectedUpdatedAt) !== current.updatedAt.getTime()) {
      throw new ConflictException({
        code: STALE_RESOURCE_VERSION_CODE,
        messageKey: 'errors.concurrency.staleVersion',
        details: { currentUpdatedAt: current.updatedAt.toISOString() },
      });
    }
  }

  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.website.insufficientRole' });
    }
  }

  /**
   * Phase 1 (Extended Scope, Decision 11, dependency A) — reads were the
   * one gap `assertCanManage` (write-only) never closed: `AcademyScopeGuard`
   * only proves organization membership, so before this check a Manager
   * assigned to Academy A could read Academy B's website configuration
   * merely because both share an Organization.
   *
   * Phase 9 (roadmap finding I1) narrowed it further. Requiring "any real
   * academy role" still admitted an Instructor, and the roadmap's
   * acceptance criterion is that an Instructor receives a 403 on the
   * Website surface through a direct API call, not merely a hidden link.
   * Website reads now require the same managing tier every website WRITE
   * already required, so an Instructor is refused consistently on both.
   * The method keeps its name because its job — "is this caller entitled
   * to this academy's website at all" — is unchanged; only the tier moved.
   */
  private async assertIsMember(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.website.insufficientRole' });
    }
  }

  /** The dashboard's view: the working copy plus what is not yet published. */
  private async toManagedResponse(
    tx: Prisma.TransactionClient,
    academyId: string,
    configuration: WebsiteConfiguration,
  ): Promise<WebsiteConfigurationResponse> {
    return {
      ...toWebsiteConfigurationResponse(configuration),
      unpublishedChanges: {
        configuration: hasUnpublishedConfigurationChanges(configuration),
        pages: await this.websitePagesRepository.countWithUnpublishedChanges(
          tx,
          academyId,
        ),
      },
    };
  }

  async getConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<WebsiteConfigurationResponse> {
    const configuration = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertIsMember(tx, academyId, userId);
        const row = await this.websiteBootstrapService.ensureConfiguration(tx, academyId);
        return this.toManagedResponse(tx, academyId, row);
      },
    );
    return configuration;
  }

  async updateConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateWebsiteConfigurationDto,
  ): Promise<WebsiteConfigurationResponse> {
    const response = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        await this.assertNotStale(tx, academyId, payload.expectedUpdatedAt);
        const current = await this.websiteBootstrapService.ensureConfiguration(
          tx,
          academyId,
        );

        const data: Prisma.WebsiteConfigurationUpdateInput = {};

        if (payload.themeKey !== undefined) {
          data.themeKey = payload.themeKey;
        }

        if (payload.brand !== undefined) {
          const patch = parseOrThrow(websiteBrandPatchSchema, payload.brand);
          // Theme 1 plan §F.4.3 — palettes are re-derived and validated
          // here; legacy colours and the palette are kept in step.
          const merged = resolveBrandUpdate(
            current.brand as Record<string, unknown>,
            patch as Record<string, unknown>,
            { userId, now: new Date() },
          );
          data.brand = parseOrThrow(websiteBrandSchema, merged) as Prisma.InputJsonValue;
        }

        if (payload.seo !== undefined) {
          const patch = parseOrThrow(globalSeoSchema, payload.seo);
          data.seo = { ...(current.seo as Record<string, unknown>), ...patch };
        }

        if (payload.navigation !== undefined) {
          data.navigation = parseOrThrow(websiteNavigationSchema, payload.navigation);
        }

        if (payload.header !== undefined) {
          data.header = parseOrThrow(websiteHeaderSchema, payload.header);
        }

        if (payload.footer !== undefined) {
          data.footer = parseOrThrow(websiteFooterSchema, payload.footer);
        }

        await this.sectionReferenceValidatorService.validateConfigurationReferences(
          tx,
          academyId,
          {
            navigation:
              (data.navigation as { pageId: string }[] | undefined) ?? undefined,
            header:
              (data.header as { cta?: { pageId?: string } } | undefined) ?? undefined,
            footer:
              (data.footer as
                | {
                    groups?: { links?: { pageId?: string }[] }[];
                    socialLinks?: { pageId?: string }[];
                  }
                | undefined) ?? undefined,
          },
        );

        const updated = await this.websiteConfigurationRepository.update(
          tx,
          academyId,
          data,
        );
        return this.toManagedResponse(tx, academyId, updated);
      },
    );
    // Before the site is first published, the hostname resolution carries
    // the DRAFT theme and colours (`resolve_public_presentation`): drop it,
    // so the Coming Soon page shows them on the next load, not a minute on.
    if (payload.brand !== undefined || payload.themeKey !== undefined) {
      await this.academiesService.invalidatePublicHostnamesForAcademy(
        academyId,
        organizationId,
        userId,
      );
    }
    return response;
  }

  /**
   * The one save for an Academy's visual identity (Task G): name, logo,
   * favicon and website colours, in ONE transaction — never a logo saved
   * with the old colours, or colours without the logo they came from.
   *
   * A VISUAL IDENTITY IS LIVE ON SAVE. The logo always was (visitors see
   * `academies.logo_url` directly), while colours went to the draft and
   * waited for a site publish — so a new logo appeared on the old colours.
   * Now, on a published site, the saved brand also replaces the published
   * brand and `configVersion` moves on, which changes every versioned
   * public cache key (configuration, pages, SSR); the hostname resolution,
   * which carries the colours for the first paint, is dropped after commit.
   * Pages, navigation and SEO keep their own draft/publish cycle.
   */
  async saveVisualIdentity(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: SaveVisualIdentityDto,
  ): Promise<{
    readonly academy: AcademyResponse;
    readonly configuration: WebsiteConfigurationResponse;
  }> {
    const result = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        await this.assertNotStale(tx, academyId, payload.expectedUpdatedAt);
        const current = await this.websiteBootstrapService.ensureConfiguration(
          tx,
          academyId,
        );

        const academyData: Prisma.AcademyUpdateInput = {};
        if (payload.name !== undefined) academyData.name = payload.name.trim();
        if (payload.logo !== undefined) academyData.logoUrl = payload.logo || null;
        if (payload.favicon !== undefined) {
          academyData.faviconUrl = payload.favicon || null;
        }
        const academy =
          Object.keys(academyData).length > 0
            ? await this.academiesRepository.update(tx, academyId, academyData)
            : await this.academiesRepository.findById(tx, academyId);
        if (!academy) {
          throw new ForbiddenException({ messageKey: 'errors.website.insufficientRole' });
        }

        const configData: Prisma.WebsiteConfigurationUpdateInput = {};
        if (payload.brand !== undefined) {
          const patch = parseOrThrow(websiteBrandPatchSchema, payload.brand);
          const brand = parseOrThrow(
            websiteBrandSchema,
            resolveBrandUpdate(
              current.brand as Record<string, unknown>,
              patch as Record<string, unknown>,
              { userId, now: new Date() },
            ),
          ) as Prisma.InputJsonValue;
          configData.brand = brand;
          if (current.status === 'published' && current.publishedSnapshot) {
            configData.publishedSnapshot = {
              ...(current.publishedSnapshot as Record<string, unknown>),
              brand,
            } as Prisma.InputJsonValue;
          }
        }
        // Anything visitors see changed: move every versioned public cache
        // key on, so the SSR page cache cannot serve the old logo or colours.
        if (Object.keys(academyData).length > 0 || payload.brand !== undefined) {
          configData.configVersion = { increment: 1 };
        }
        const configuration =
          Object.keys(configData).length > 0
            ? await this.websiteConfigurationRepository.update(tx, academyId, configData)
            : current;

        return {
          academy: toAcademyResponse(academy),
          configuration: await this.toManagedResponse(tx, academyId, configuration),
        };
      },
    );
    await this.academiesService.invalidatePublicHostnamesForAcademy(
      academyId,
      organizationId,
      userId,
    );
    return result;
  }

  async publishConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<PublishWebsiteResponse> {
    const response = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        await this.websiteBootstrapService.ensureConfiguration(tx, academyId);
        await this.websiteConfigurationRepository.lockForPublish(tx, academyId);
        const current = await this.websiteBootstrapService.ensureConfiguration(
          tx,
          academyId,
        );

        // Publishing the website publishes everything: every page's working
        // copy and the site-wide settings become what visitors see. The
        // `configVersion` bump changes every public cache key (Redis and the
        // SSR render cache), so the new content is served on the next request.
        await this.websitePagesRepository.publish(tx, academyId);
        const updated = await this.websiteConfigurationRepository.update(tx, academyId, {
          status: 'published',
          publishedAt: new Date(),
          lastPublishError: Prisma.JsonNull,
          configVersion: { increment: 1 },
          publishedSnapshot: buildPublishedSnapshot(current),
        });
        // Theme 1 plan §D.4 — a warning, never a block: which visible
        // sections still hold sample testimonials (stripped from the public
        // site, listed here so the Owner can review them).
        const visiblePages = await this.websitePagesRepository.findAllPublished(
          tx,
          academyId,
        );
        return {
          ...(await this.toManagedResponse(tx, academyId, updated)),
          sampleContent: collectSampleContent(
            visiblePages.map((page) => ({
              id: page.id,
              title: page.title,
              sections: page.sections as unknown[],
            })),
          ),
        };
      },
    );
    // The hostname resolution carries the published theme and colours
    // (`resolve_public_presentation`); drop it so the change shows at once.
    await this.academiesService.invalidatePublicHostnamesForAcademy(
      academyId,
      organizationId,
      userId,
    );
    return response;
  }

  /**
   * Takes the public website offline again.
   *
   * WHY `draft` AND NOT A NEW STATUS. `WebsiteConfigurationRepository`'s
   * public read filters on `status: 'published'` in the WHERE clause, so
   * returning the configuration to `draft` is precisely what makes the
   * public site stop serving — there is no second flag to keep in sync,
   * and no state the resolver would not already understand.
   *
   * WHY `publishedAt` IS KEPT. It records when the site was last
   * published, which stays true after unpublishing and is useful to show.
   * It is NOT what the public runtime reads — `status` is — so leaving it
   * cannot accidentally keep a site online.
   *
   * Authorization is identical to publishing: unpublishing takes a
   * customer's website off the internet, so it cannot be the easier of
   * the two operations.
   */
  async unpublishConfiguration(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<WebsiteConfigurationResponse> {
    const response = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        await this.websiteBootstrapService.ensureConfiguration(tx, academyId);

        const updated = await this.websiteConfigurationRepository.update(tx, academyId, {
          status: 'draft',
          lastPublishError: Prisma.JsonNull,
          configVersion: { increment: 1 },
        });
        return this.toManagedResponse(tx, academyId, updated);
      },
    );
    // The hostname resolution carries the published theme and colours
    // (`resolve_public_presentation`); drop it so the change shows at once.
    await this.academiesService.invalidatePublicHostnamesForAcademy(
      academyId,
      organizationId,
      userId,
    );
    return response;
  }
}
