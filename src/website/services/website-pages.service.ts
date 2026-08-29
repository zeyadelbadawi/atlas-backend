/**
 * WebsitePagesService — matches the real frontend
 * `WebsiteConfigurationService`'s page-half exactly: `getPages`/`getPage`/
 * `createPage`/`updatePage`/`deletePage`/`reorderPageSections`.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`. Write authorization mirrors
 * `WebsiteConfigurationService`'s own `assertCanManage`.
 *
 * `createPage` always produces a `custom` page — there is no way to
 * create a `core` page through this service; the six core pages are
 * provisioned once by `WebsiteBootstrapService`. `deletePage` rejects a
 * `core` page outright (`WebsitePagesPage.tsx`'s own "no delete button for
 * a core page" rule, enforced server-side, not just hidden client-side —
 * master plan §21 P9's own instruction). Changing `visible` on the
 * `courseDetails` core page is rejected — `website.types.ts` itself
 * documents `courseDetails` as excluded from `TOGGLEABLE_CORE_PAGE_TYPES`
 * ("not part of the visibility/navigation toggle set"), matched here as a
 * real, type-documented rule rather than an invented one.
 *
 * `sections` is the real stored-content-injection boundary (master plan
 * §5.10) — every write is parsed against `sectionInstanceArraySchema`
 * (a field-for-field reproduction of the frontend's own discriminated
 * union) and every embedded `courseId`/`pageId` reference is verified to
 * exist, academy-scoped, via `SectionReferenceValidatorService`, before
 * anything is persisted.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import { WebsiteBootstrapService } from './website-bootstrap.service';
import { SectionReferenceValidatorService } from './section-reference-validator.service';
import {
  toWebsitePageResponse,
  type WebsitePageResponse,
} from '../dto/website-page.contract';
import type { CreateWebsitePageDto } from '../dto/create-website-page.dto';
import type { UpdateWebsitePageDto } from '../dto/update-website-page.dto';
import type { ReorderItemsDto } from '../../course/dto/reorder-items.dto';
import {
  createWebsitePageSchema,
  pageSeoSchema,
} from '../validation/website-config.schemas';
import { sectionInstanceArraySchema } from '../validation/section-config.schemas';
import { parseOrThrow } from '../../common/validation/zod-violations.util';
import { RESERVED_PAGE_SLUGS } from '../constants/website.constants';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class WebsitePagesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly websiteBootstrapService: WebsiteBootstrapService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly sectionReferenceValidatorService: SectionReferenceValidatorService,
  ) {}

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

  private assertSlugAllowed(slug: string): void {
    if (RESERVED_PAGE_SLUGS.includes(slug)) {
      throw new ConflictException({ messageKey: 'errors.website.slugReserved' });
    }
  }

  async list(
    academyId: string,
    organizationId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<WebsitePageResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);
        return this.websitePagesRepository.findManyForAcademy(tx, academyId, {
          search: query.search,
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      },
    );

    return {
      items: items.map(toWebsitePageResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getById(
    academyId: string,
    organizationId: string,
    pageId: string,
  ): Promise<WebsitePageResponse> {
    const page = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);
        return this.websitePagesRepository.findById(tx, academyId, pageId);
      },
    );
    if (!page) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toWebsitePageResponse(page);
  }

  async create(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateWebsitePageDto,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);

      const validated = parseOrThrow(createWebsitePageSchema, payload);
      this.assertSlugAllowed(validated.slug);

      try {
        const created = await this.websitePagesRepository.create(tx, {
          academy: { connect: { id: academyId } },
          pageType: 'custom',
          title: validated.title,
          slug: validated.slug,
          visible: true,
          seo: {},
          sections: [],
        });
        return toWebsitePageResponse(created);
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictException({ messageKey: 'errors.website.slugTaken' });
        }
        throw error;
      }
    });
  }

  async update(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    payload: UpdateWebsitePageDto,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);

      const existing = await this.websitePagesRepository.findById(tx, academyId, pageId);
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const data: Prisma.WebsitePageUpdateInput = {};

      if (payload.title !== undefined) {
        data.title = payload.title;
      }

      if (payload.slug !== undefined && payload.slug !== existing.slug) {
        this.assertSlugAllowed(payload.slug);
        data.slug = payload.slug;
      }

      if (payload.visible !== undefined) {
        if (existing.coreType === 'courseDetails') {
          throw new ForbiddenException({
            messageKey: 'errors.website.courseDetailsNotToggleable',
          });
        }
        data.visible = payload.visible;
      }

      if (payload.seo !== undefined) {
        data.seo = parseOrThrow(pageSeoSchema, payload.seo);
      }

      if (payload.sections !== undefined) {
        const sections = parseOrThrow(sectionInstanceArraySchema, payload.sections);
        await this.sectionReferenceValidatorService.validateSectionReferences(
          tx,
          academyId,
          sections,
        );
        data.sections = sections as unknown as Prisma.InputJsonValue;
      }

      try {
        const updated = await this.websitePagesRepository.update(tx, pageId, data);
        return toWebsitePageResponse(updated);
      } catch (error) {
        if (isUniqueConstraintViolation(error)) {
          throw new ConflictException({ messageKey: 'errors.website.slugTaken' });
        }
        throw error;
      }
    });
  }

  async delete(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websitePagesRepository.findById(tx, academyId, pageId);
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (existing.pageType === 'core') {
        throw new ForbiddenException({
          messageKey: 'errors.website.corePageNotDeletable',
        });
      }
      await this.websitePagesRepository.delete(tx, pageId);
    });
  }

  async reorderSections(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    payload: ReorderItemsDto,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websitePagesRepository.findById(tx, academyId, pageId);
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const currentSections = existing.sections as { id: string }[];
      const currentIds = new Set(currentSections.map((section) => section.id));
      const orderedIds = payload.orderedIds;

      const isSamePermutation =
        orderedIds.length === currentSections.length &&
        orderedIds.every((id) => currentIds.has(id)) &&
        new Set(orderedIds).size === orderedIds.length;

      if (!isSamePermutation) {
        throw new ConflictException({ messageKey: 'errors.website.invalidSectionOrder' });
      }

      const byId = new Map(currentSections.map((section) => [section.id, section]));
      const reordered = orderedIds.map((id) => byId.get(id));

      const updated = await this.websitePagesRepository.update(tx, pageId, {
        sections: reordered as unknown as Prisma.InputJsonValue,
      });
      return toWebsitePageResponse(updated);
    });
  }
}
