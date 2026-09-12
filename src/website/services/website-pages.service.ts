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
  BadRequestException,
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
import { StaleResourceVersionException } from '../../concurrency/errors/stale-resource-version.exception';
import { EditingPresenceService } from '../../concurrency/services/editing-presence.service';
import type { EditingParticipant } from '../../concurrency/services/editing-presence.service';
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
    private readonly editingPresenceService: EditingPresenceService,
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

  /** Phase 1 (Extended Scope, dependency A), narrowed to the managing tier in Phase 9 — see `WebsiteConfigurationService.assertIsMember`'s doc comment for both changes and why an Instructor must be refused here. */
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

  private assertSlugAllowed(slug: string): void {
    if (RESERVED_PAGE_SLUGS.includes(slug)) {
      throw new ConflictException({ messageKey: 'errors.website.slugReserved' });
    }
  }

  async list(
    academyId: string,
    organizationId: string,
    userId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<WebsitePageResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertIsMember(tx, academyId, userId);
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
    userId: string,
    pageId: string,
  ): Promise<WebsitePageResponse> {
    const page = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertIsMember(tx, academyId, userId);
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
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
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
      },
    );
  }

  async update(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    payload: UpdateWebsitePageDto,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);

        const existing = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

        /*
         * OPTIMISTIC CONCURRENCY.
         *
         * `sections` is the entire composition of a page in one column, so
         * a save is always a full replace. Two admins editing the same page
         * — an ordinary situation for an Academy with an owner and a
         * manager — meant the second save silently destroyed the first,
         * with no error and nothing anywhere to show it had happened.
         *
         * The check happens INSIDE the same transaction as the write, and
         * the write itself is conditional on the version as well (see
         * `WebsitePagesRepository.update`). Checking here alone would leave
         * a window between the read and the update; the conditional write
         * is what actually closes it, and this check is what turns a lost
         * race into a useful message instead of a silent no-op.
         *
         * `expectedVersion` IS NOW REQUIRED, and the audit that changed
         * that is worth recording, because the previous reasoning was
         * sound but rested on a false premise.
         *
         * It used to be optional so a caller predating the field would get
         * the old last-write-wins behaviour rather than a hard failure it
         * could not satisfy, and the comment here asserted that "every
         * Atlas editor sends it". That was not true. Tracing every caller
         * found the section editor sending it and TWO others not: the SEO
         * dialog, which replaces the whole `seo` object — so a second
         * admin saving a stale dialog silently discarded the first one's
         * title and description — and the visibility toggle on the pages
         * list. The kindness of accepting a version-less write was being
         * paid for by whoever's work got destroyed by one.
         *
         * Requiring it is safe here specifically because this endpoint has
         * no external contract to break: Swagger is disabled in
         * production (`main.ts`), nothing but the HTTP route calls the
         * service, and every Atlas caller now sends the token.
         *
         * The refusal is deliberately NOT a DTO-level validation error. A
         * missing concurrency token is not a field the user typed, so a
         * `violations: [{field: 'expectedVersion'}]` response would attach
         * an error to a form control that does not exist. It is refused
         * here instead, with a message that tells the one caller this can
         * still happen to — a tab loaded before this deployed — to reload.
         */
        if (payload.expectedVersion === undefined) {
          throw new BadRequestException({
            messageKey: 'errors.website.versionRequired',
          });
        }

        if (
          payload.expectedVersion !== undefined &&
          payload.expectedVersion !== existing.version
        ) {
          const editor = existing.updatedById
            ? await tx.user.findUnique({
                where: { id: existing.updatedById },
                select: { name: true },
              })
            : null;

          throw new StaleResourceVersionException({
            submittedVersion: payload.expectedVersion,
            currentVersion: existing.version,
            lastEditedByName: editor?.name,
            lastEditedAt: existing.updatedAt.toISOString(),
          });
        }

        const data: Prisma.WebsitePageUncheckedUpdateInput = {
          // Every save moves the token forward and records who moved it, so
          // the next conflict can name a person rather than a mystery.
          version: { increment: 1 },
          updatedById: userId,
        };

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
          // The version goes into the WHERE clause so the DATABASE decides
          // the race, not the gap between our read above and this write.
          // There is no unconditional path any more — a version-less
          // request was refused before we got here.
          const updated = await this.websitePagesRepository.updateIfVersionMatches(
            tx,
            pageId,
            payload.expectedVersion,
            data,
          );

          if (!updated) {
            // The pre-check passed and this still matched nothing, so
            // somebody committed in between. Same conflict, same shape —
            // the client cannot tell which of the two paths produced it,
            // and should not need to.
            const current = await this.websitePagesRepository.findById(
              tx,
              academyId,
              pageId,
            );
            const editor = current?.updatedById
              ? await tx.user.findUnique({
                  where: { id: current.updatedById },
                  select: { name: true },
                })
              : null;

            throw new StaleResourceVersionException({
              submittedVersion: payload.expectedVersion,
              currentVersion: current?.version ?? payload.expectedVersion,
              lastEditedByName: editor?.name,
              lastEditedAt: current?.updatedAt.toISOString(),
            });
          }

          return toWebsitePageResponse(updated);
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            throw new ConflictException({ messageKey: 'errors.website.slugTaken' });
          }
          throw error;
        }
      },
    );
  }

  /**
   * Announces (or refreshes) this user's editing session on a page and
   * returns everyone ELSE currently editing it.
   *
   * AUTHORISED EXACTLY LIKE A SAVE, on purpose. Presence records a real
   * person's name and role against a real resource, and returns the names
   * and roles of other staff — so it has to be behind the same door as
   * editing itself, not a weaker one. Anyone who could not save this page
   * cannot announce themselves on it, cannot learn who is working on it,
   * and cannot use it to confirm that an academy or page id exists: the
   * page is resolved inside the academy's own tenant context first, so a
   * cross-academy id is a 404 before presence is ever touched.
   *
   * The role reported to colleagues is the caller's real
   * `academy_members.role`, read here rather than accepted from the
   * request — a client cannot announce itself as an owner.
   */
  async heartbeatEditingSession(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
  ): Promise<readonly EditingParticipant[]> {
    const { role, name } = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        const page = await this.websitePagesRepository.findById(tx, academyId, pageId);
        if (!page) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const membership = await this.academyMembersRepository.findForUserInAcademy(
          tx,
          academyId,
          userId,
        );
        const user = await tx.user.findUnique({
          where: { id: userId },
          select: { name: true },
        });
        return { role: membership?.role ?? 'member', name: user?.name ?? '' };
      },
    );

    return this.editingPresenceService.heartbeat('website-page', pageId, {
      userId,
      name,
      role,
    });
  }

  /** Ends this user's editing session immediately. Same authorisation as the heartbeat. */
  async releaseEditingSession(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const page = await this.websitePagesRepository.findById(tx, academyId, pageId);
        if (!page) throw new NotFoundException({ messageKey: 'errors.notFound' });
      },
    );

    await this.editingPresenceService.release('website-page', pageId, userId);
  }

  async delete(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const existing = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (existing.pageType === 'core') {
          throw new ForbiddenException({
            messageKey: 'errors.website.corePageNotDeletable',
          });
        }
        await this.websitePagesRepository.delete(tx, pageId);
      },
    );
  }

  async reorderSections(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    payload: ReorderItemsDto,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const existing = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const currentSections = existing.sections as { id: string }[];
        const currentIds = new Set(currentSections.map((section) => section.id));
        const orderedIds = payload.orderedIds;

        const isSamePermutation =
          orderedIds.length === currentSections.length &&
          orderedIds.every((id) => currentIds.has(id)) &&
          new Set(orderedIds).size === orderedIds.length;

        if (!isSamePermutation) {
          throw new ConflictException({
            messageKey: 'errors.website.invalidSectionOrder',
          });
        }

        const byId = new Map(currentSections.map((section) => [section.id, section]));
        const reordered = orderedIds.map((id) => byId.get(id));

        const updated = await this.websitePagesRepository.update(tx, pageId, {
          sections: reordered as unknown as Prisma.InputJsonValue,
        });
        return toWebsitePageResponse(updated);
      },
    );
  }
}
