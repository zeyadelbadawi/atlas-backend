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
 *
 * CMS phase 4 — page history (`WebsitePageVersionsRepository`): a version
 * is recorded on every publish that changes what is live, before a draft
 * save at most once per `DRAFT_SNAPSHOT_INTERVAL_MS`, and before a restore.
 * A restore writes the DRAFT only, revalidated against today's schemas.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { WebsitePage } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { WebsiteConfigurationRepository } from '../repositories/website-configuration.repository';
import { WebsitePagesRepository } from '../repositories/website-pages.repository';
import { WebsitePageVersionsRepository } from '../repositories/website-page-versions.repository';
import { WebsiteBootstrapService } from './website-bootstrap.service';
import { SectionReferenceValidatorService } from './section-reference-validator.service';
import { StaleResourceVersionException } from '../../concurrency/errors/stale-resource-version.exception';
import { EditingPresenceService } from '../../concurrency/services/editing-presence.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { diffListCounts } from '../../audit-log/utils/audit-diff.util';
import { pruneDeletedPageReferences } from '../utils/deleted-page-references.util';
import type { EditingParticipant } from '../../concurrency/services/editing-presence.service';
import {
  toManagedWebsitePageResponse,
  toWebsitePageVersionResponse,
  toWebsitePageVersionSummaryResponse,
  type WebsitePageResponse,
  type WebsitePageVersionResponse,
  type WebsitePageVersionSummaryResponse,
} from '../dto/website-page.contract';
import type { CreateWebsitePageDto } from '../dto/create-website-page.dto';
import type { UpdateWebsitePageDto } from '../dto/update-website-page.dto';
import type { ReorderItemsDto } from '../../course/dto/reorder-items.dto';
import {
  createWebsitePageSchema,
  pageSeoSchema,
} from '../validation/website-config.schemas';
import {
  sectionInstanceArraySchema,
  withRequiredLocale,
} from '../validation/section-config.schemas';
import {
  parseOrThrow,
  zodIssuesToViolations,
} from '../../common/validation/zod-violations.util';
import type { FieldViolation } from '../../common/dto/api-error.dto';
import { RESERVED_PAGE_SLUGS } from '../constants/website.constants';
import { resolveDefaultLocale } from '../constants/locale.constants';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type { CollectionQueryDto } from '../../common/dto/collection-query.dto';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/**
 * A draft save records the copy it is about to replace at most this often
 * per page: the editor autosaves every few seconds, and history should
 * hold one entry per editing session, not one per keystroke.
 */
const DRAFT_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

/** A stored version that today's section schemas or references refuse (422). */
export const WEBSITE_PAGE_VERSION_INVALID_CODE = 'website_page_version_invalid';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Task 3 — what a section save did, in counts a person can read ("2 sections
 * added, 1 edited"). Sections carry stable ids, so identity is the id and a
 * section counts as edited when its stored JSON changed.
 */
function sectionChangeContext(
  before: unknown,
  after: unknown,
): {
  sectionsAdded: number;
  sectionsRemoved: number;
  sectionsUpdated: number;
  sectionCount: number;
} {
  type SectionLike = { readonly id?: string };
  const previous = Array.isArray(before) ? (before as SectionLike[]) : [];
  const next = Array.isArray(after) ? (after as SectionLike[]) : [];
  const counts = diffListCounts(
    previous,
    next,
    (section, index) => section.id ?? `#${index}`,
    (section) => JSON.stringify(section),
  );
  return {
    sectionsAdded: counts.added,
    sectionsRemoved: counts.removed,
    sectionsUpdated: counts.changed,
    sectionCount: next.length,
  };
}

/** The page fields `website_page.updated` diffs (catalogue `diffFields`). */
function pageAuditSnapshot(page: {
  readonly title: string;
  readonly slug: string;
  readonly visible: boolean;
  readonly seo: Prisma.JsonValue;
}): Record<string, unknown> {
  return { title: page.title, slug: page.slug, visible: page.visible, seo: page.seo };
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
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly websitePageVersionsRepository: WebsitePageVersionsRepository,
  ) {}

  /**
   * Before a draft save: keeps the copy about to be replaced, unless one was
   * kept less than `DRAFT_SNAPSHOT_INTERVAL_MS` ago or the newest version
   * already holds exactly this copy (e.g. it was just published).
   */
  private async snapshotDraftIfDue(
    tx: Prisma.TransactionClient,
    existing: WebsitePage,
    userId: string,
  ): Promise<void> {
    const latest = await this.websitePageVersionsRepository.findLatest(
      tx,
      existing.academyId,
      existing.id,
    );
    if (latest?.sourceVersion === existing.version) return;
    const latestSnapshot = await this.websitePageVersionsRepository.findLatest(
      tx,
      existing.academyId,
      existing.id,
      'draft_snapshot',
    );
    if (
      latestSnapshot &&
      Date.now() - latestSnapshot.createdAt.getTime() < DRAFT_SNAPSHOT_INTERVAL_MS
    ) {
      return;
    }
    await this.websitePageVersionsRepository.record(
      tx,
      existing,
      'draft_snapshot',
      userId,
    );
  }

  /** The 409 every version-pinned write answers when the page moved on. */
  private async staleVersion(
    tx: Prisma.TransactionClient,
    page: WebsitePage | null,
    submittedVersion: number,
  ): Promise<StaleResourceVersionException> {
    const editor = page?.updatedById
      ? await tx.user.findUnique({
          where: { id: page.updatedById },
          select: { name: true },
        })
      : null;
    return new StaleResourceVersionException({
      submittedVersion,
      currentVersion: page?.version ?? submittedVersion,
      lastEditedByName: editor?.name,
      lastEditedAt: page?.updatedAt.toISOString(),
    });
  }

  /**
   * Sections through the CURRENT schemas (site language included) and the
   * academy-scoped reference validator — the one path every section write
   * takes: page saves, create-with-sections and restores.
   */
  private async validateSections(
    tx: Prisma.TransactionClient,
    academyId: string,
    sections: unknown,
  ): Promise<Prisma.InputJsonValue> {
    // B0-WEB-02 — an Arabic-default site requires the Arabic side of
    // every required bilingual field; every other site the English.
    const configuration = await this.websiteConfigurationRepository.findByAcademyId(
      tx,
      academyId,
    );
    const validated = withRequiredLocale(
      resolveDefaultLocale(configuration?.defaultLocale),
      () => parseOrThrow(sectionInstanceArraySchema, sections),
    );
    await this.sectionReferenceValidatorService.validateSectionReferences(
      tx,
      academyId,
      validated,
    );
    return validated as unknown as Prisma.InputJsonValue;
  }

  /** Returns the caller's academy role, which the audit row records (no second lookup). */
  private async assertCanManage(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const role = await this.academyMembersRepository.findManagingRole(
      tx,
      academyId,
      userId,
      MANAGING_ROLES,
    );
    if (!role) {
      throw new ForbiddenException({ messageKey: 'errors.website.insufficientRole' });
    }
    return role;
  }

  /** Phase 1 (Extended Scope, dependency A), narrowed to the managing tier in Phase 9 — see `WebsiteConfigurationService.assertIsMember`'s doc comment for both changes and why an Instructor must be refused here. */
  private async assertIsMember(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<void> {
    const role = await this.academyMembersRepository.findManagingRole(
      tx,
      academyId,
      userId,
      MANAGING_ROLES,
    );
    if (!role) {
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
      items: items.map(toManagedWebsitePageResponse),
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
    return toManagedWebsitePageResponse(page);
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
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.websiteBootstrapService.ensureBootstrapped(tx, academyId);

        const validated = parseOrThrow(createWebsitePageSchema, payload);
        this.assertSlugAllowed(validated.slug);
        // CMS phase 4 — optional starting sections, validated exactly like a
        // page save's; the page and its sections commit together or not at all.
        const sections =
          payload.sections !== undefined
            ? await this.validateSections(tx, academyId, payload.sections)
            : [];

        try {
          const created = await this.websitePagesRepository.create(tx, {
            academy: { connect: { id: academyId } },
            pageType: 'custom',
            title: validated.title,
            slug: validated.slug,
            visible: true,
            seo: {},
            sections,
          });
          await this.auditLogWriterService.record(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            role,
            action: 'website_page.created',
            targetId: created.id,
            targetLabel: created.title,
            context: {
              pageType: created.pageType,
              slug: created.slug,
              ...(payload.sections !== undefined
                ? sectionChangeContext([], created.sections)
                : {}),
            },
          });
          return toManagedWebsitePageResponse(created);
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
        const role = await this.assertCanManage(tx, academyId, userId);
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
          data.sections = await this.validateSections(tx, academyId, payload.sections);
        }

        // CMS phase 4 — history keeps the copy this save replaces (throttled).
        if (
          payload.title !== undefined ||
          payload.slug !== undefined ||
          payload.visible !== undefined ||
          payload.seo !== undefined ||
          payload.sections !== undefined
        ) {
          await this.snapshotDraftIfDue(tx, existing, userId);
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

          // Task 3 — one row per save: field before/after for title, slug,
          // visibility and SEO, and readable counts for the sections.
          await this.auditLogWriterService.record(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            role,
            action: 'website_page.updated',
            targetId: pageId,
            targetLabel: updated.title,
            context: {
              pageType: updated.pageType,
              slug: updated.slug,
              ...(payload.sections !== undefined
                ? sectionChangeContext(existing.sections, updated.sections)
                : {}),
            },
            before: pageAuditSnapshot(existing),
            after: pageAuditSnapshot(updated),
          });

          return toManagedWebsitePageResponse(updated);
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
        const role = await this.assertCanManage(tx, academyId, userId);
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
        await this.forgetDeletedPage(tx, academyId, pageId);
        await this.auditLogWriterService.record(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'website_page.deleted',
          targetId: pageId,
          targetLabel: existing.title,
          context: { pageType: existing.pageType, slug: existing.slug },
        });
      },
    );
  }

  /**
   * B0-WEB-11 — a deleted page is gone from the live site at once (the row
   * is hard-deleted), so:
   *   - menu entries, footer links and the header call to action that
   *     pointed at it are removed from the working copy AND the published
   *     snapshot — otherwise the Owner's next save of those areas is
   *     refused (`errors.website.pageNotFound`) by the reference validator;
   *   - `configVersion` moves, which changes every public cache key (Redis
   *     and the SSR render cache), so visitors stop getting the deleted
   *     page on the next request instead of after the content TTL.
   * Section call-to-action links on OTHER pages are not rewritten; the
   * public renderer drops a link whose page is missing.
   */
  private async forgetDeletedPage(
    tx: Prisma.TransactionClient,
    academyId: string,
    pageId: string,
  ): Promise<void> {
    const configuration = await this.websiteConfigurationRepository.findByAcademyId(
      tx,
      academyId,
    );
    if (!configuration) return;
    const draft = pruneDeletedPageReferences(configuration, pageId);
    const snapshot = configuration.publishedSnapshot as Record<string, unknown> | null;
    const live = snapshot
      ? pruneDeletedPageReferences(
          {
            navigation: snapshot.navigation,
            header: snapshot.header,
            footer: snapshot.footer,
          },
          pageId,
        )
      : null;
    await this.websiteConfigurationRepository.update(tx, academyId, {
      configVersion: { increment: 1 },
      ...(draft.changed
        ? {
            navigation: draft.navigation as Prisma.InputJsonValue,
            header: draft.header as Prisma.InputJsonValue,
            footer: draft.footer as Prisma.InputJsonValue,
          }
        : {}),
      ...(snapshot && live?.changed
        ? {
            publishedSnapshot: {
              ...snapshot,
              navigation: live.navigation,
              header: live.header,
              footer: live.footer,
            } as Prisma.InputJsonValue,
          }
        : {}),
    });
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
        const role = await this.assertCanManage(tx, academyId, userId);
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
        await this.snapshotDraftIfDue(tx, existing, userId);

        const updated = await this.websitePagesRepository.update(tx, pageId, {
          sections: reordered as unknown as Prisma.InputJsonValue,
          // A reorder is an edit like any other: it must count as an
          // unpublished change and invalidate a stale editor's version.
          version: { increment: 1 },
        });
        await this.auditLogWriterService.record(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'website_page.sections_reordered',
          targetId: pageId,
          targetLabel: existing.title,
          context: {
            pageType: existing.pageType,
            slug: existing.slug,
            sectionCount: orderedIds.length,
          },
          changes: {
            sectionOrder: {
              from: currentSections.map((section) => section.id),
              to: [...orderedIds],
            },
          },
        });
        return toManagedWebsitePageResponse(updated);
      },
    );
  }

  /**
   * Publish ONE page: its working copy becomes what visitors see, without
   * republishing the rest of the website. Same authorization as publishing
   * the whole website. The `configVersion` bump changes every public cache
   * key (Redis, SSR render cache), so the published page is served on the
   * next request — not after a cache TTL.
   *
   * On a website that is not published yet this only records the page's
   * published copy; nothing becomes public until the website is published.
   */
  async publish(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    expectedVersion?: number,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        await this.websiteBootstrapService.ensureConfiguration(tx, academyId);
        await this.websiteConfigurationRepository.lockForPublish(tx, academyId);
        const existing = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
        // Pinned publish (Task H): the publisher saw `expectedVersion`; a
        // later save by someone else must not go live unseen.
        if (expectedVersion !== undefined && expectedVersion !== existing.version) {
          const editor = existing.updatedById
            ? await tx.user.findUnique({
                where: { id: existing.updatedById },
                select: { name: true },
              })
            : null;
          throw new StaleResourceVersionException({
            submittedVersion: expectedVersion,
            currentVersion: existing.version,
            lastEditedByName: editor?.name,
            lastEditedAt: existing.updatedAt.toISOString(),
          });
        }
        const clash = await this.websitePagesRepository.findPublishedSlugClash(
          tx,
          academyId,
          pageId,
          existing.slug,
        );
        if (clash) {
          throw new ConflictException({
            messageKey: 'errors.website.publishedSlugTaken',
            details: { pageId: clash.id, title: clash.title },
          });
        }

        const copied = await this.websitePagesRepository.publish(tx, academyId, {
          id: pageId,
          slug: existing.slug,
          version: existing.version,
        });
        if (copied === 0) {
          // Saved by someone else between the read above and the copy.
          throw new ConflictException({
            messageKey: 'errors.website.pageChangedDuringPublish',
          });
        }
        // CMS phase 4 — history: what just went live, when it changed anything.
        if (existing.publishedVersion !== existing.version) {
          await this.websitePageVersionsRepository.record(
            tx,
            existing,
            'published',
            userId,
          );
        }
        await this.websiteConfigurationRepository.update(tx, academyId, {
          configVersion: { increment: 1 },
        });
        const published = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        await this.auditLogWriterService.record(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'website_page.published',
          targetId: pageId,
          targetLabel: existing.title,
          context: { pageType: existing.pageType, slug: existing.slug },
        });
        return toManagedWebsitePageResponse(published!);
      },
    );
  }

  /** CMS phase 4 — a page's history, newest first, without content. Same door as reading the page. */
  async listVersions(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
  ): Promise<{ readonly items: readonly WebsitePageVersionSummaryResponse[] }> {
    const rows = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertIsMember(tx, academyId, userId);
        const page = await this.websitePagesRepository.findById(tx, academyId, pageId);
        if (!page) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return this.websitePageVersionsRepository.listForPage(tx, academyId, pageId);
      },
    );
    return { items: rows.map(toWebsitePageVersionSummaryResponse) };
  }

  /** CMS phase 4 — one version with its full content, for a preview. */
  async getVersion(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    versionId: string,
  ): Promise<WebsitePageVersionResponse> {
    const version = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertIsMember(tx, academyId, userId);
        return this.websitePageVersionsRepository.findById(
          tx,
          academyId,
          pageId,
          versionId,
        );
      },
    );
    if (!version) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toWebsitePageVersionResponse(version);
  }

  /**
   * CMS phase 4 — copies a version into the page's DRAFT (never publishes).
   *
   * Pinned to `expectedVersion` exactly like a save. The version's content
   * is revalidated against TODAY's schemas and references first: a copy
   * that no longer validates (a section type or limit that changed, a
   * course or page since deleted) is refused with a 422
   * `website_page_version_invalid` carrying the violations, never written.
   * The working copy it replaces is kept as a `restore_backup` version, so
   * the restore itself can be undone. `courseDetails` keeps its current
   * visibility (it is not toggleable).
   */
  async restoreVersion(
    academyId: string,
    organizationId: string,
    userId: string,
    pageId: string,
    versionId: string,
    expectedVersion: number | undefined,
  ): Promise<WebsitePageResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManage(tx, academyId, userId);
        const existing = await this.websitePagesRepository.findById(
          tx,
          academyId,
          pageId,
        );
        if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });
        const version = await this.websitePageVersionsRepository.findById(
          tx,
          academyId,
          pageId,
          versionId,
        );
        if (!version) throw new NotFoundException({ messageKey: 'errors.notFound' });

        if (expectedVersion === undefined) {
          throw new BadRequestException({ messageKey: 'errors.website.versionRequired' });
        }
        if (expectedVersion !== existing.version) {
          throw await this.staleVersion(tx, existing, expectedVersion);
        }

        const content = await this.validateRestorableVersion(tx, academyId, version);
        if (content.slug !== existing.slug) this.assertSlugAllowed(content.slug);

        await this.websitePageVersionsRepository.record(
          tx,
          existing,
          'restore_backup',
          userId,
        );

        try {
          const updated = await this.websitePagesRepository.updateIfVersionMatches(
            tx,
            pageId,
            expectedVersion,
            {
              title: content.title,
              slug: content.slug,
              visible:
                existing.coreType === 'courseDetails'
                  ? existing.visible
                  : version.visible,
              seo: content.seo,
              sections: content.sections,
              version: { increment: 1 },
              updatedById: userId,
            },
          );
          if (!updated) {
            throw await this.staleVersion(
              tx,
              await this.websitePagesRepository.findById(tx, academyId, pageId),
              expectedVersion,
            );
          }

          await this.auditLogWriterService.record(tx, {
            actorUserId: userId,
            organizationId,
            academyId,
            role,
            action: 'website_page.restored',
            targetId: pageId,
            targetLabel: updated.title,
            context: {
              pageType: updated.pageType,
              slug: updated.slug,
              restoredVersionId: version.id,
              restoredVersionKind: version.kind,
              ...sectionChangeContext(existing.sections, updated.sections),
            },
            before: pageAuditSnapshot(existing),
            after: pageAuditSnapshot(updated),
          });
          return toManagedWebsitePageResponse(updated);
        } catch (error) {
          if (isUniqueConstraintViolation(error)) {
            throw new ConflictException({ messageKey: 'errors.website.slugTaken' });
          }
          throw error;
        }
      },
    );
  }

  /** A version's content through today's page schemas; every refusal becomes one 422 with the violations. */
  private async validateRestorableVersion(
    tx: Prisma.TransactionClient,
    academyId: string,
    version: { title: string; slug: string; seo: Prisma.JsonValue; sections: unknown },
  ): Promise<{
    title: string;
    slug: string;
    seo: Prisma.InputJsonValue;
    sections: Prisma.InputJsonValue;
  }> {
    const violations: FieldViolation[] = [];
    const identity = createWebsitePageSchema.safeParse({
      title: version.title,
      slug: version.slug,
    });
    if (!identity.success)
      violations.push(...zodIssuesToViolations(identity.error.issues));
    const seo = pageSeoSchema.safeParse(version.seo);
    if (!seo.success) {
      violations.push(
        ...zodIssuesToViolations(seo.error.issues).map((violation) => ({
          ...violation,
          field: `seo.${violation.field}`,
        })),
      );
    }
    let sections: Prisma.InputJsonValue | undefined;
    try {
      sections = await this.validateSections(tx, academyId, version.sections);
    } catch (error) {
      if (!(error instanceof HttpException) || error.getStatus() !== 400) throw error;
      const body = error.getResponse() as { violations?: FieldViolation[] };
      violations.push(
        ...(body.violations ?? []).map((violation) => ({
          ...violation,
          field: `sections.${violation.field}`,
        })),
      );
    }
    if (violations.length > 0 || !identity.success || !seo.success || !sections) {
      throw new UnprocessableEntityException({
        code: WEBSITE_PAGE_VERSION_INVALID_CODE,
        messageKey: 'errors.website.versionNoLongerValid',
        violations,
      });
    }
    return {
      title: identity.data.title,
      slug: identity.data.slug,
      seo: seo.data as Prisma.InputJsonValue,
      sections,
    };
  }
}
