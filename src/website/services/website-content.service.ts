/**
 * WebsiteContentService — matches the real frontend `WebsiteContentService`
 * exactly: `getFaqEntries`/`getFaqEntry`/`createFaqEntry`/`updateFaqEntry`/
 * `publishFaqEntry`/`archiveFaqEntry`, and the identical shape for
 * Testimonial entries. One service class, mirroring the frontend's own
 * single-file design (master plan §21 P10: "the backend response must
 * match the frontend type field-for-field").
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext`, matching every other
 * service in this codebase's "never trust the guard's own read"
 * discipline.
 *
 * Write authorization: a single tier, `owner`/`administrator` academy
 * membership, applied identically to every write action — create,
 * update, publish, AND archive. This deliberately does not distinguish
 * `academy.website.manage` from `academy.website.publish` (both appear
 * in the frontend's permission checks, `WebsiteFaqContentTab.tsx`) —
 * `WebsiteConfigurationService.publishConfiguration` (P9) already
 * established that a "publish" action is governed by the exact same
 * `assertCanManage` tier as every other website write, with no separate,
 * narrower role ever introduced; there is no evidence anywhere in this
 * codebase of a role that can publish without also being able to manage,
 * or vice versa. Inventing that distinction now, with no backend
 * specification for it, would be exactly the "new CMS permission system"
 * master plan §21 P10 forbids.
 *
 * Status is never accepted through `updateFaqEntry`/`updateTestimonialEntry`
 * — only `publishFaqEntry`/`archiveFaqEntry` (and their Testimonial
 * equivalents) transition it, matching `UpdateWebsiteFaqEntryPayload`/
 * `UpdateWebsiteTestimonialEntryPayload` having no `status` field at all.
 * `archived` is terminal: neither publish nor archive is accepted once an
 * entry is archived (matching `WebsiteFaqContentTab.tsx`'s own UI rule —
 * no publish/archive action is ever offered for an archived entry).
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { WebsiteFaqEntriesRepository } from '../repositories/website-faq-entries.repository';
import { WebsiteTestimonialEntriesRepository } from '../repositories/website-testimonial-entries.repository';
import {
  toWebsiteFaqEntryResponse,
  type WebsiteFaqEntryResponse,
} from '../dto/website-faq-entry.contract';
import {
  toWebsiteTestimonialEntryResponse,
  type WebsiteTestimonialEntryResponse,
} from '../dto/website-testimonial-entry.contract';
import type { CreateWebsiteFaqEntryDto } from '../dto/create-website-faq-entry.dto';
import type { UpdateWebsiteFaqEntryDto } from '../dto/update-website-faq-entry.dto';
import type { CreateWebsiteTestimonialEntryDto } from '../dto/create-website-testimonial-entry.dto';
import type { UpdateWebsiteTestimonialEntryDto } from '../dto/update-website-testimonial-entry.dto';
import type { WebsiteContentListQueryDto } from '../dto/website-content-list-query.dto';
import {
  createFaqEntrySchema,
  createTestimonialEntrySchema,
  updateFaqEntrySchema,
  updateTestimonialEntrySchema,
} from '../validation/website-content.schemas';
import { parseOrThrow } from '../../common/validation/zod-violations.util';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';

const MANAGING_ROLES = new Set(['owner', 'administrator']);

@Injectable()
export class WebsiteContentService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly websiteFaqEntriesRepository: WebsiteFaqEntriesRepository,
    private readonly websiteTestimonialEntriesRepository: WebsiteTestimonialEntriesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
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

  /* ------------------------------ FAQ ------------------------------ */

  async getFaqEntries(
    academyId: string,
    organizationId: string,
    query: WebsiteContentListQueryDto,
  ): Promise<PaginatedResult<WebsiteFaqEntryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.websiteFaqEntriesRepository.findManyForAcademy(tx, academyId, {
          status: query.status,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toWebsiteFaqEntryResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getFaqEntry(
    academyId: string,
    organizationId: string,
    entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    const entry = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteFaqEntriesRepository.findById(tx, academyId, entryId),
    );
    if (!entry) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toWebsiteFaqEntryResponse(entry);
  }

  async createFaqEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateWebsiteFaqEntryDto,
  ): Promise<WebsiteFaqEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const validated = parseOrThrow(createFaqEntrySchema, payload);
      const order = await this.websiteFaqEntriesRepository.nextOrder(tx, academyId);

      const created = await this.websiteFaqEntriesRepository.create(tx, {
        academy: { connect: { id: academyId } },
        question: validated.question,
        answer: validated.answer,
        order,
      });
      return toWebsiteFaqEntryResponse(created);
    });
  }

  async updateFaqEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
    payload: UpdateWebsiteFaqEntryDto,
  ): Promise<WebsiteFaqEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteFaqEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const validated = parseOrThrow(updateFaqEntrySchema, payload);
      const data: Prisma.WebsiteFaqEntryUpdateInput = {};
      if (validated.question !== undefined) data.question = validated.question;
      if (validated.answer !== undefined) data.answer = validated.answer;
      if (validated.order !== undefined) data.order = validated.order;
      if (validated.visible !== undefined) data.visible = validated.visible;

      const updated = await this.websiteFaqEntriesRepository.update(tx, entryId, data);
      return toWebsiteFaqEntryResponse(updated);
    });
  }

  async publishFaqEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteFaqEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (existing.status === 'archived') {
        throw new ConflictException({ messageKey: 'errors.website.contentArchived' });
      }

      const updated = await this.websiteFaqEntriesRepository.update(tx, entryId, {
        status: 'published',
      });
      return toWebsiteFaqEntryResponse(updated);
    });
  }

  async archiveFaqEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<WebsiteFaqEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteFaqEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (existing.status === 'archived') {
        throw new ConflictException({ messageKey: 'errors.website.contentArchived' });
      }

      const updated = await this.websiteFaqEntriesRepository.update(tx, entryId, {
        status: 'archived',
      });
      return toWebsiteFaqEntryResponse(updated);
    });
  }

  /* --------------------------- Testimonial -------------------------- */

  async getTestimonialEntries(
    academyId: string,
    organizationId: string,
    query: WebsiteContentListQueryDto,
  ): Promise<PaginatedResult<WebsiteTestimonialEntryResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.websiteTestimonialEntriesRepository.findManyForAcademy(tx, academyId, {
          status: query.status,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toWebsiteTestimonialEntryResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getTestimonialEntry(
    academyId: string,
    organizationId: string,
    entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    const entry = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteTestimonialEntriesRepository.findById(tx, academyId, entryId),
    );
    if (!entry) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toWebsiteTestimonialEntryResponse(entry);
  }

  async createTestimonialEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateWebsiteTestimonialEntryDto,
  ): Promise<WebsiteTestimonialEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const validated = parseOrThrow(createTestimonialEntrySchema, payload);
      const order = await this.websiteTestimonialEntriesRepository.nextOrder(
        tx,
        academyId,
      );

      const created = await this.websiteTestimonialEntriesRepository.create(tx, {
        academy: { connect: { id: academyId } },
        quote: validated.quote,
        authorName: validated.authorName,
        authorRole: validated.authorRole,
        avatar: validated.avatar,
        order,
      });
      return toWebsiteTestimonialEntryResponse(created);
    });
  }

  async updateTestimonialEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
    payload: UpdateWebsiteTestimonialEntryDto,
  ): Promise<WebsiteTestimonialEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteTestimonialEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const validated = parseOrThrow(updateTestimonialEntrySchema, payload);
      const data: Prisma.WebsiteTestimonialEntryUpdateInput = {};
      if (validated.quote !== undefined) data.quote = validated.quote;
      if (validated.authorName !== undefined) data.authorName = validated.authorName;
      if (validated.authorRole !== undefined) data.authorRole = validated.authorRole;
      if (validated.avatar !== undefined) data.avatar = validated.avatar;
      if (validated.order !== undefined) data.order = validated.order;
      if (validated.visible !== undefined) data.visible = validated.visible;

      const updated = await this.websiteTestimonialEntriesRepository.update(
        tx,
        entryId,
        data,
      );
      return toWebsiteTestimonialEntryResponse(updated);
    });
  }

  async publishTestimonialEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteTestimonialEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (existing.status === 'archived') {
        throw new ConflictException({ messageKey: 'errors.website.contentArchived' });
      }

      const updated = await this.websiteTestimonialEntriesRepository.update(tx, entryId, {
        status: 'published',
      });
      return toWebsiteTestimonialEntryResponse(updated);
    });
  }

  async archiveTestimonialEntry(
    academyId: string,
    organizationId: string,
    userId: string,
    entryId: string,
  ): Promise<WebsiteTestimonialEntryResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      const existing = await this.websiteTestimonialEntriesRepository.findById(
        tx,
        academyId,
        entryId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
      if (existing.status === 'archived') {
        throw new ConflictException({ messageKey: 'errors.website.contentArchived' });
      }

      const updated = await this.websiteTestimonialEntriesRepository.update(tx, entryId, {
        status: 'archived',
      });
      return toWebsiteTestimonialEntryResponse(updated);
    });
  }
}
