/**
 * AcademiesService — implements `AcademyService`'s complete method set
 * (atlas frontend `src/features/academy/services/AcademyService.ts`):
 * list, get, create, update, updateBranding, archive (soft-delete),
 * members, stats, activity.
 *
 * Every method independently re-establishes the RLS tenant context via
 * `TenancyContextService.runInTenantContext` rather than trusting
 * `AcademyScopeGuard`'s own reads — see that guard's doc comment for why.
 */
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AcademiesRepository } from '../repositories/academies.repository';
import { AcademyMembersRepository } from '../repositories/academy-members.repository';
import { toAcademyResponse } from '../dto/academy.contract';
import type { AcademyResponse, AcademyAddressResponse } from '../dto/academy.contract';
import { toAcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyStatsResponse } from '../dto/academy-stats.contract';
import type { AcademyActivityResponse } from '../dto/academy-activity.contract';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../dto/list-query.dto';
import type { CollectionQueryDto, ListAcademiesQueryDto } from '../dto/list-query.dto';
import type { CreateAcademyDto } from '../dto/create-academy.dto';
import type { UpdateAcademyDto } from '../dto/update-academy.dto';
import type { UpdateAcademyBrandingDto } from '../dto/update-academy-branding.dto';

/** Roles permitted to write to an Academy (create/update/branding/archive) — never assumed from organization role. See `AcademyScopeGuard`'s doc comment. */
const MANAGING_ROLES = new Set(['owner', 'administrator']);

@Injectable()
export class AcademiesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async list(query: ListAcademiesQueryDto): Promise<PaginatedResult<AcademyResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      query.organizationId,
      (tx) =>
        this.academiesRepository.findManyForOrganization(tx, query.organizationId, {
          search: query.search,
          sortBy: query.sortBy as 'name' | 'slug' | 'createdAt' | 'updatedAt' | undefined,
          sortDirection: query.sortDirection,
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAcademyResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getById(academyId: string, organizationId: string): Promise<AcademyResponse> {
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academiesRepository.findById(tx, academyId),
    );

    if (!academy) {
      // Structurally unreachable if `AcademyScopeGuard` ran first.
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }

    return toAcademyResponse(academy);
  }

  async create(userId: string, payload: CreateAcademyDto): Promise<AcademyResponse> {
    await this.assertSlugAvailable(payload.organizationId, payload.slug);

    const academy = await this.withSlugConflictHandling(() =>
      this.tenancyContextService.runInTenantContext(
        payload.organizationId,
        async (tx) => {
          const created = await this.academiesRepository.create(tx, {
            organization: { connect: { id: payload.organizationId } },
            name: payload.name,
            slug: payload.slug,
            description: payload.description,
            contactEmail: payload.contactEmail,
            contactPhone: payload.contactPhone,
            websiteUrl: payload.website,
            language: payload.language,
            timezone: payload.timezone,
            currency: payload.currency,
            address: payload.country ? { country: payload.country } : undefined,
          });

          // Creator becomes the Academy's first `owner`-role member —
          // there is no standalone "add member" endpoint in P3 (see the
          // migration's doc comment on `academy_members_insert`).
          await this.academyMembersRepository.create(tx, {
            academy: { connect: { id: created.id } },
            user: { connect: { id: userId } },
            role: 'owner',
          });

          // Phase P15 retroactive audit coverage (master plan §21 P15's
          // own Definition of Done) — same transaction, atomic with the
          // Academy/membership rows above.
          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            organizationId: payload.organizationId,
            action: 'academy.created',
            targetType: 'academy',
            targetId: created.id,
            targetLabel: created.name,
          });

          return created;
        },
      ),
    );

    return toAcademyResponse(academy);
  }

  async update(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateAcademyDto,
  ): Promise<AcademyResponse> {
    if (payload.slug) {
      await this.assertSlugAvailable(organizationId, payload.slug, academyId);
    }

    const academy = await this.withSlugConflictHandling(() =>
      this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        const current = await this.academiesRepository.findById(tx, academyId);
        if (!current) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }

        const mergedAddress: AcademyAddressResponse | undefined = payload.address
          ? { ...(current.address as AcademyAddressResponse | null), ...payload.address }
          : undefined;

        const data: Prisma.AcademyUpdateInput = {
          name: payload.name,
          slug: payload.slug,
          description: payload.description,
          contactEmail: payload.contactEmail,
          contactPhone: payload.contactPhone,
          websiteUrl: payload.website,
          language: payload.language,
          timezone: payload.timezone,
          currency: payload.currency,
          status: payload.status,
          // `organization_id` is never in `data` — `UpdateAcademyDto` has
          // no such field, and `academies_tenant_update`'s RLS `WITH
          // CHECK` would reject the row even if it were.
          ...(mergedAddress ? { address: mergedAddress as Prisma.InputJsonValue } : {}),
        };

        return this.academiesRepository.update(tx, academyId, data);
      }),
    );

    return toAcademyResponse(academy);
  }

  async updateBranding(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateAcademyBrandingDto,
  ): Promise<AcademyResponse> {
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);

        return this.academiesRepository.update(tx, academyId, {
          name: payload.name,
          logoUrl: payload.logo,
          faviconUrl: payload.favicon,
        });
      },
    );

    return toAcademyResponse(academy);
  }

  /** `DELETE /academies/:id` — soft-archive via status transition, never a SQL DELETE (no DELETE RLS policy exists on `academies` at all). */
  async archive(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, userId);
      await this.academiesRepository.update(tx, academyId, { status: 'archived' });
    });
  }

  async getMembers(
    academyId: string,
    organizationId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyMemberResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.academyMembersRepository.findManyForAcademy(tx, academyId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        }),
    );

    return {
      items: items.map(toAcademyMemberResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getStats(
    academyId: string,
    organizationId: string,
  ): Promise<AcademyStatsResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const [totalMembers, activeStaff, activeInstructors] = await Promise.all([
        this.academyMembersRepository.countAll(tx, academyId),
        this.academyMembersRepository.countByRoleAndStatus(tx, academyId, 'staff'),
        this.academyMembersRepository.countByRoleAndStatus(tx, academyId, 'instructor'),
      ]);

      // See `academy-stats.contract.ts`'s doc comment — honestly `0`, no
      // `courses` table exists yet.
      return { totalMembers, activeStaff, activeInstructors, publishedCourses: 0 };
    });
  }

  /** See `academy-activity.contract.ts`'s doc comment — no activity source exists yet; a real, honestly-empty page, not a hidden error. */
  getActivity(
    _academyId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyActivityResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    return Promise.resolve({
      items: [],
      pagination: buildPaginationMeta(page, pageSize, 0),
    });
  }

  /** Enforces the write-authorization rule documented on `AcademyScopeGuard`: organization membership alone is never sufficient to write. */
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
      throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
    }
  }

  /**
   * `assertSlugAvailable`'s pre-check runs inside the caller's own tenant
   * context, so it cannot see a slug taken by an academy in a DIFFERENT
   * organization (RLS makes that row invisible, by design — see
   * `assertSlugAvailable`'s own doc comment). This is the real backstop:
   * the database's own `@unique` constraint on `academies.slug` is the
   * actual source of truth, and a violation here is converted to the same
   * clean 409 rather than surfacing as a raw, unhandled 500.
   */
  private async withSlugConflictHandling<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        (error.meta?.target as string[] | undefined)?.includes('slug')
      ) {
        throw new ConflictException({ messageKey: 'errors.academy.slugTaken' });
      }
      throw error;
    }
  }

  private async assertSlugAvailable(
    organizationId: string,
    slug: string,
    excludeAcademyId?: string,
  ): Promise<void> {
    const existing = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.academiesRepository.findBySlug(tx, slug),
    );

    // `slug` is globally unique (one `@unique` index across all
    // organizations, matching `organizations.slug`'s own precedent), so a
    // collision is reported the same way regardless of which organization
    // currently holds it — this call already runs inside the caller's own
    // tenant context, so it can only ever see a same-organization
    // collision if the slug is actually taken there; a collision in a
    // *different* organization surfaces as `findBySlug` returning `null`
    // here (RLS-invisible), and the eventual `create`/`update` call fails
    // on the real DB unique constraint instead — reported identically.
    if (existing && existing.id !== excludeAcademyId) {
      throw new ConflictException({ messageKey: 'errors.academy.slugTaken' });
    }
  }
}
