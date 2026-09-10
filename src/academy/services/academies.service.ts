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
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../../tenancy/constants/organization-permissions.constants';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { PasswordHasherService } from '../../identity/services/password-hasher.service';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { AcademiesRepository } from '../repositories/academies.repository';
import { AcademyMembersRepository } from '../repositories/academy-members.repository';
import { ContactSubmissionsRepository } from '../repositories/contact-submissions.repository';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { PlatformDomainConfigurationRepository } from '../../domain/repositories/platform-domain-configuration.repository';
import { toAcademyResponse } from '../dto/academy.contract';
import type { AcademyResponse, AcademyAddressResponse } from '../dto/academy.contract';
import { toAcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyMemberResponse } from '../dto/academy-member.contract';
import { toAcademyStudentResponse } from '../dto/academy-student.contract';
import type { AcademyStudentResponse } from '../dto/academy-student.contract';
import type { AcademyStatsResponse } from '../dto/academy-stats.contract';
import type { AcademyActivityResponse } from '../dto/academy-activity.contract';
import {
  toContactSubmissionResponse,
  type ContactSubmissionResponse,
} from '../dto/contact-submission.contract';
import type { UpdateContactSubmissionStatusDto } from '../dto/update-contact-submission-status.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../dto/list-query.dto';
import type { CollectionQueryDto, ListAcademiesQueryDto } from '../dto/list-query.dto';
import type { CreateAcademyDto } from '../dto/create-academy.dto';
import type { UpdateAcademyDto } from '../dto/update-academy.dto';
import type { UpdateAcademyBrandingDto } from '../dto/update-academy-branding.dto';
import type { AddAcademyManagerDto } from '../dto/add-academy-manager.dto';
import type { AddAcademyInstructorDto } from '../dto/add-academy-instructor.dto';
import type { CreateAcademyStudentDto } from '../dto/create-academy-student.dto';
import type { User } from '@prisma/client';

/**
 * Roles permitted to write to an Academy (create/update/branding/archive)
 * — never assumed from organization role. See `AcademyScopeGuard`'s doc
 * comment. `'manager'` joined this set in the Organization Manager phase:
 * a real `AcademyMemberRole` enum value (`schema.prisma`) that previously
 * had no code path that ever created one — see `addManager` below, the
 * one method that now does. `'instructor'` deliberately does NOT join
 * this set — an Instructor teaches/grades (via the separate
 * `course_instructors` mechanism) but never authors academy/course
 * content; see `ORGANIZATION_INSTRUCTOR_PERMISSIONS`'s doc comment for
 * the same exclusion at the organization-permission layer.
 */
const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

/**
 * Only the Academy's `owner`-role member may grant Manager or Instructor
 * access to someone else, or create a Student account — a more sensitive
 * action than ordinary content management, so deliberately narrower than
 * `MANAGING_ROLES`. Also matches the one real database constraint this
 * relies on: the `organization_memberships_owner_grants_insert` RLS
 * policy (P20 migration) only admits an INSERT for another user when
 * `organizations.owner_user_id` equals the caller — a Manager attempting
 * the same grant would fail at the database layer regardless of what the
 * service layer permitted, so the service-layer gate is kept identically
 * narrow rather than presenting a capability the database would then deny.
 */
const GRANTS_MANAGER_ROLES = new Set(['owner']);

/**
 * Phase 5 (Onboarding & Provisioning Completion) — who may create a brand
 * NEW Academy at all, independent of and checked before the entitlement
 * check below. `academy.provisioning.create` is Organization-Owner-only
 * (`ORGANIZATION_OWNER_PERMISSIONS`, deliberately absent from
 * `ORGANIZATION_MANAGER_PERMISSIONS` — see that file's own doc comment:
 * "a Manager operates the academy but never touches... provisioning of
 * new academies"), and the frontend's `AcademyCreatePage` route is
 * already gated on exactly that permission
 * (`requiredPermissions={['academy.provisioning.create']}`). Before this
 * check existed, `AcademyOrganizationScopeGuard` (which only verifies
 * SOME organization-membership row exists, not its role) was the only
 * gate on `POST /academies`, so a Manager's own valid JWT could reach and
 * succeed at `AcademiesService.create` directly — the frontend route
 * guard was, in practice, the only thing enforcing the Owner-only rule.
 * Same narrow `Set`-of-roles shape as `GRANTS_MANAGER_ROLES` immediately
 * above, kept as its own constant rather than reused: the two gate
 * different actions (granting Manager access vs. creating an Academy)
 * that only currently happen to share the same one-role membership.
 */
const CREATES_ACADEMY_ROLES = new Set(['owner']);

@Injectable()
export class AcademiesService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly passwordHasherService: PasswordHasherService,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly contactSubmissionsRepository: ContactSubmissionsRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
  ) {}

  /**
   * Resolves the target user for a Manager/Instructor grant: an existing
   * account found by email, or — when `name`+`password` are BOTH supplied
   * — a brand-new one created on the spot (there is no invitation/email
   * system in this codebase; this is the closest equivalent an owner has
   * to "invite someone who doesn't have an account yet"). Returns `null`
   * only when no account exists AND no creation fields were supplied,
   * letting the caller report the pre-existing "that email has no Atlas
   * account yet" 404 unchanged.
   */
  private async findOrCreateUserByEmail(
    email: string,
    name?: string,
    password?: string,
  ): Promise<User | null> {
    const existing = await this.usersRepository.findByEmail(email);
    if (existing) return existing;
    if (!name || !password) return null;

    const passwordHash = await this.passwordHasherService.hash(password);
    return this.usersRepository.create({ email, passwordHash, name });
  }

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

  /**
   * Academy Overview. Phase 9 (roadmap finding I1) added the
   * `assertCanManage` check: `AcademyScopeGuard` proves only ORGANIZATION
   * membership, which an Instructor legitimately has, so before this an
   * Instructor could read the Academy Overview through a direct API call
   * even once the frontend stopped rendering the link. Phase 9's
   * acceptance criterion requires a real 403 there, not a hidden link.
   *
   * The managing tier (`owner`/`administrator`/`manager`) is the same set
   * every Academy WRITE already required — this raises the read to match,
   * rather than inventing a new tier. Verified before making the change
   * that no Instructor surface consumes this endpoint: the Teaching
   * Dashboard and My Courses resolve their own course-scoped data and
   * never call `GET /academies/:id`.
   */
  async getById(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyResponse> {
    const academy = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        return this.academiesRepository.findById(tx, academyId);
      },
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
      // Phase 10.4 — tenant AND user context, not tenant alone.
      //
      // The `subdomain_allocations_insert` RLS policy requires
      // `is_academy_member(academy_id, app.current_user_id)` (added in
      // P21). Under a tenant-only context `app.current_user_id` is unset,
      // so the allocation below is refused with a bare
      // "new row violates row-level security policy" and the whole
      // Academy creation fails. `ProvisioningOrchestratorService` already
      // ran its own allocation under a tenant+user context for exactly
      // this reason; this makes the two paths agree.
      //
      // Setting the acting user is strictly more precise, not more
      // permissive: it is the same user the method already authorises
      // above, and every other policy in this transaction is either
      // organization-scoped (unaffected) or membership-scoped (satisfied
      // by the `academy_members` row created below, before the
      // allocation).
      this.tenancyContextService.runInTenantAndUserContext(
        payload.organizationId,
        userId,
        async (tx) => {
          // Phase 5 — WHO may create an Academy at all, checked first and
          // independent of the entitlement check below (see
          // `CREATES_ACADEMY_ROLES`'s own doc comment for the exact gap
          // this closes: without it, any organization member with a
          // valid JWT — not only the Owner the frontend route restricts
          // this to — could reach and succeed at this method directly).
          const actingMembership =
            await this.organizationMembershipsRepository.findForUserInOrganization(
              tx,
              payload.organizationId,
              userId,
            );
          if (!actingMembership || !CREATES_ACADEMY_ROLES.has(actingMembership.role)) {
            throw new ForbiddenException({
              messageKey: 'errors.academy.insufficientRole',
            });
          }

          // Phase 2 (Decision 4) — the live, write-time entitlement
          // check, INSIDE the same transaction as the insert below, so
          // the count and the write can never observe a different state
          // of the world. Reached from every real entry point this
          // codebase has for creating an Academy — the direct `POST
          // /academies` route AND `ProvisioningModule`'s orchestration
          // step (`ProvisioningOrchestratorService`, which calls this
          // exact method, never a second, parallel academy-creation
          // path) — so both are covered by this one check, never just
          // the primary UI-driven one.
          await this.entitlementEnforcementService.assertWithinLimit(
            tx,
            payload.organizationId,
            'academies',
          );

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

          // THE PUBLIC WEBSITE'S HOSTNAME ALLOCATION.
          //
          // Without this row, `resolve_public_hostname` finds nothing and
          // the Academy's public site answers "not found" at
          // `{slug}.{baseDomain}` — even though DNS, TLS and origin
          // routing are all working perfectly. That was a real, live
          // production defect: of five Academies, only the two created
          // through `ProvisioningOrchestratorService` (which allocates
          // its own subdomain as a separate step) had an allocation. The
          // three created through THIS method — the ordinary "New
          // Academy" flow — had none, and their public sites were dead.
          //
          // Allocating here rather than in a second place is what makes
          // the two creation paths agree: provisioning's own step checks
          // `findByAcademyId` first and returns `completed` when a row
          // already exists, so it simply becomes a no-op rather than a
          // conflicting duplicate.
          //
          // The subdomain IS the slug. `assertSlugAvailable` above and
          // the `subdomain_allocations` unique index enforce the same
          // uniqueness from two directions, and `subdomain_is_taken`
          // already treats the two namespaces as one.
          const platformDomain =
            await this.platformDomainConfigurationRepository.findSingleton();

          await this.subdomainAllocationsRepository.create(tx, {
            academyId: created.id,
            subdomain: created.slug,
            status: 'assigned',
            // Null when no platform base domain is configured (local and
            // early environments). The allocation is still recorded, so
            // resolution by bare label keeps working and configuring the
            // domain later needs no backfill.
            fullHost: platformDomain.baseDomain
              ? `${created.slug}.${platformDomain.baseDomain}`
              : null,
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

    // Phase 2 — real reactive usage-recompute trigger (an academy change).
    await this.tenantUsageRecomputeProducer.enqueueOne(payload.organizationId);

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

    // Phase 2 — an archived academy frees its entire quota footprint
    // (academies/instructors/staff/courses/students/storage all drop) —
    // real reactive usage-recompute trigger.
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
  }

  /**
   * Academy Members. Phase 9 (roadmap: "`AcademiesService.getMembers`
   * currently lacks the correct role restriction even though the frontend
   * hides the link from Instructor") added the `assertCanManage` check —
   * this method previously took no `userId` at all and performed no role
   * check whatsoever, so any organization member reaching
   * `AcademyScopeGuard` could list an academy's full staff roster (names
   * and email addresses) through a direct API call.
   *
   * Students are unaffected by this change and were never able to reach
   * it: a Student is an `academy_students` row and holds no
   * `organization_memberships` row at all, so `AcademyScopeGuard` already
   * refuses them one layer earlier. Both facts are asserted by this
   * phase's own tests rather than assumed.
   */
  async getMembers(
    academyId: string,
    organizationId: string,
    userId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyMemberResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        return this.academyMembersRepository.findManyForAcademy(tx, academyId, {
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
      },
    );

    return {
      items: items.map(toAcademyMemberResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  /**
   * `POST /academies/:id/members` — grants an already-registered Atlas
   * user Manager access to this Academy. There is no invitation system
   * in this codebase (see `AddAcademyManagerDto`'s doc comment), so the
   * target user must already have an account; a 404 here means "that
   * email has no Atlas account yet", not "not found" in the generic
   * sense.
   *
   * Two rows are ensured, matching the two parallel authorization axes
   * this codebase has (see `organization-permissions.constants.ts`'s
   * updated doc comment):
   *   1. `organization_memberships` (role `'manager'`,
   *      `ORGANIZATION_MANAGER_PERMISSIONS`) — reused if the user already
   *      has one for this organization (never downgraded/overwritten;
   *      an existing Owner adding themselves to a second academy, for
   *      instance, keeps their Owner permissions), created otherwise.
   *      This is what the frontend's `RouteGuard` actually reads.
   *   2. `academy_members` (role `'manager'`) — this specific academy's
   *      grant; this is what every backend `MANAGING_ROLES` check reads.
   *
   * Only the Academy's `owner`-role member may call this
   * (`GRANTS_MANAGER_ROLES`, deliberately narrower than the
   * `MANAGING_ROLES` content-management set) — granting operational
   * access to another person is a more sensitive action than editing
   * academy content. The database backs this up independently: the new
   * `organization_memberships_owner_grants_insert` RLS policy (P20
   * migration) only admits the INSERT when `organizations.owner_user_id`
   * equals the caller, which this method also checks explicitly first so
   * a mismatch surfaces as a clean `ForbiddenException` rather than a raw
   * RLS-denial database error.
   */
  async addManager(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    payload: AddAcademyManagerDto,
  ): Promise<AcademyMemberResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const actingMembership = await this.academyMembersRepository.findForUserInAcademy(
          tx,
          academyId,
          actingUserId,
        );
        if (!actingMembership || !GRANTS_MANAGER_ROLES.has(actingMembership.role)) {
          throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
        }

        const organization = await this.organizationsRepository.findById(
          tx,
          organizationId,
        );
        if (!organization || organization.ownerUserId !== actingUserId) {
          // Backstops the RLS policy's own check (see this method's doc
          // comment) with a clean application-level error instead of
          // letting the later INSERT fail on the database constraint.
          throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
        }

        const targetUser = await this.findOrCreateUserByEmail(
          payload.email,
          payload.name,
          payload.password,
        );
        if (!targetUser) {
          throw new NotFoundException({
            messageKey: 'errors.academy.managerUserNotFound',
          });
        }

        const existingAcademyMembership =
          await this.academyMembersRepository.findForUserInAcademy(
            tx,
            academyId,
            targetUser.id,
          );
        if (existingAcademyMembership) {
          throw new ConflictException({
            messageKey: 'errors.academy.managerAlreadyMember',
          });
        }

        const existingOrgMembership =
          await this.organizationMembershipsRepository.findForUserInOrganization(
            tx,
            organizationId,
            targetUser.id,
          );
        if (!existingOrgMembership) {
          await this.organizationMembershipsRepository.create(tx, {
            organizationId,
            userId: targetUser.id,
            role: 'manager',
            permissions: ORGANIZATION_MANAGER_PERMISSIONS,
            isPrimary: false,
          });
        }

        const created = await this.academyMembersRepository.create(tx, {
          academy: { connect: { id: academyId } },
          user: { connect: { id: targetUser.id } },
          role: 'manager',
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          action: 'academy.manager.added',
          targetType: 'academy_member',
          targetId: created.id,
          targetLabel: targetUser.email,
        });

        return toAcademyMemberResponse({
          ...created,
          user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
        });
      },
    );
  }

  /**
   * `POST /academies/:id/instructors` — the Instructor counterpart of
   * `addManager` above; same shape, same owner-only gate, same
   * find-or-create-by-email resolution, same two-row (org membership +
   * academy member) grant — only the role and the granted permission set
   * differ (`ORGANIZATION_INSTRUCTOR_PERMISSIONS`, deliberately narrower
   * than a Manager's, see that constant's doc comment).
   *
   * This grant does NOT, by itself, connect the instructor to any course
   * — `course_instructors` (a separate table `InstructorService` actually
   * reads for `/dashboard/instructor`) is populated per-course, via the
   * explicit Phase 3 assignment path (`CoursesService.assignInstructor`/
   * `removeInstructor`, master plan §22/§23), never automatically by this
   * method. An `academy_members` `'instructor'` row is this codebase's
   * staffing/roster record and its `ORGANIZATION_INSTRUCTOR_PERMISSIONS`
   * grant (route access) — it makes someone ELIGIBLE to be assigned to a
   * course, never actually assigned to one. This method must never be
   * changed to auto-assign every existing or future course in the
   * academy; course access always requires the separate, explicit grant.
   */
  async addInstructor(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    payload: AddAcademyInstructorDto,
  ): Promise<AcademyMemberResponse> {
    return this.tenancyContextService
      .runInTenantAndUserContext(organizationId, actingUserId, async (tx) => {
        const actingMembership = await this.academyMembersRepository.findForUserInAcademy(
          tx,
          academyId,
          actingUserId,
        );
        if (!actingMembership || !GRANTS_MANAGER_ROLES.has(actingMembership.role)) {
          throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
        }

        const organization = await this.organizationsRepository.findById(
          tx,
          organizationId,
        );
        if (!organization || organization.ownerUserId !== actingUserId) {
          throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
        }

        const targetUser = await this.findOrCreateUserByEmail(
          payload.email,
          payload.name,
          payload.password,
        );
        if (!targetUser) {
          throw new NotFoundException({
            messageKey: 'errors.academy.managerUserNotFound',
          });
        }

        const existingAcademyMembership =
          await this.academyMembersRepository.findForUserInAcademy(
            tx,
            academyId,
            targetUser.id,
          );
        if (existingAcademyMembership) {
          throw new ConflictException({
            messageKey: 'errors.academy.managerAlreadyMember',
          });
        }

        const existingOrgMembership =
          await this.organizationMembershipsRepository.findForUserInOrganization(
            tx,
            organizationId,
            targetUser.id,
          );
        if (!existingOrgMembership) {
          await this.organizationMembershipsRepository.create(tx, {
            organizationId,
            userId: targetUser.id,
            role: 'instructor',
            permissions: ORGANIZATION_INSTRUCTOR_PERMISSIONS,
            isPrimary: false,
          });
        }

        // Phase 2 (Decision 4) — live `instructors` limit check, after
        // every authorization/conflict check above (a caller who was
        // never allowed to grant this, or a target who is already a
        // member, gets that specific error first — a limit rejection
        // only fires for an otherwise-legitimate grant).
        await this.entitlementEnforcementService.assertWithinLimit(
          tx,
          organizationId,
          'instructors',
        );

        const created = await this.academyMembersRepository.create(tx, {
          academy: { connect: { id: academyId } },
          user: { connect: { id: targetUser.id } },
          role: 'instructor',
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          action: 'academy.instructor.added',
          targetType: 'academy_member',
          targetId: created.id,
          targetLabel: targetUser.email,
        });

        return toAcademyMemberResponse({
          ...created,
          user: { id: targetUser.id, name: targetUser.name, email: targetUser.email },
        });
      })
      .then(async (response) => {
        // Phase 2 — real reactive usage-recompute trigger (an `instructors`
        // count change), run after the granting transaction has committed.
        await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
        return response;
      });
  }

  /**
   * `POST /academies/:id/students` — creates a brand-new Atlas account for
   * a real test/actual student. Deliberately NOT a Manager/Instructor-style
   * grant: "student" is never an `academy_members` row in this codebase
   * (`AcademyMemberRole` has no `student` value) and never an
   * `organization_memberships` row either — `Enrollment`'s own RLS
   * policies key only on `student_id = app.current_user_id`, with no
   * academy/organization predicate at all (confirmed against
   * `schema.prisma` and the P6 migration). So this method creates ONLY a
   * `users` row (name + email + password, all required — there is no
   * existing account to "find" the way Manager/Instructor can, since the
   * whole point is a fresh test student) and does nothing else; the
   * returned account then self-discovers and self-enrolls in courses
   * through the ordinary student flow, exactly like any other Atlas user.
   */
  async createStudent(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    payload: CreateAcademyStudentDto,
  ): Promise<AcademyStudentResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const actingMembership = await this.academyMembersRepository.findForUserInAcademy(
          tx,
          academyId,
          actingUserId,
        );
        if (!actingMembership || !GRANTS_MANAGER_ROLES.has(actingMembership.role)) {
          throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
        }

        const existing = await this.usersRepository.findByEmail(payload.email);
        if (existing) {
          throw new ConflictException({
            messageKey: 'errors.auth.emailAlreadyRegistered',
          });
        }

        const passwordHash = await this.passwordHasherService.hash(payload.password);
        const created = await this.usersRepository.create({
          email: payload.email,
          passwordHash,
          name: payload.name,
        });

        // Phase 1 (Extended Scope, Decision 11, dependency D) — a
        // Manager/Owner-created student now gets the exact same real
        // Academy membership self-registration does, closing the gap this
        // response type's own pre-existing doc comment named explicitly
        // ("a student is never an `academy_members` row" — true, and now
        // also no longer true that they have NO academy row at all).
        // Staff-insert policy (`academy_students_staff_insert`), tenant-
        // scoped exactly like `academy_members_insert` — the role check
        // above already gates who may reach this point.
        await this.academyStudentsRepository.create(tx, {
          academyId,
          userId: created.id,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          action: 'academy.student.created',
          targetType: 'user',
          targetId: created.id,
          targetLabel: created.email,
        });

        return toAcademyStudentResponse(created, academyId);
      },
    );
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

  /**
   * Phase 6 — staff-side read of the public Contact section's real
   * submissions. `assertCanManage` (never mere organization membership,
   * per `AcademyScopeGuard`'s own doc comment) gates this the same way
   * every other write-adjacent Academy action already is; the
   * `contact_submissions_manage_select` RLS policy independently agrees.
   */
  async getContactSubmissions(
    academyId: string,
    organizationId: string,
    userId: string,
    query: CollectionQueryDto,
  ): Promise<PaginatedResult<ContactSubmissionResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    // `runInTenantAndUserContext` — `contact_submissions_manage_select`
    // (RLS) requires a real `app.current_user_id` (`is_academy_moderator`),
    // unlike `academy_members`' own tenant-only backstop; a plain
    // `runInTenantContext` would leave that setting unset.
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const { items, totalItems } =
          await this.contactSubmissionsRepository.findManyForAcademy(tx, academyId, {
            skip: (page - 1) * pageSize,
            take: pageSize,
          });
        return {
          items: items.map(toContactSubmissionResponse),
          pagination: buildPaginationMeta(page, pageSize, totalItems),
        };
      },
    );
  }

  /** Phase 6 — staff triage (mark read/archived); never re-opens the public write path. */
  async updateContactSubmissionStatus(
    academyId: string,
    organizationId: string,
    userId: string,
    submissionId: string,
    body: UpdateContactSubmissionStatusDto,
  ): Promise<ContactSubmissionResponse> {
    // `runInTenantAndUserContext` — `contact_submissions_manage_update`
    // (RLS) requires a real `app.current_user_id` (`is_academy_moderator`)
    // in BOTH its `USING` and `WITH CHECK`; see `getContactSubmissions`'s
    // identical doc comment.
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const existing = await this.contactSubmissionsRepository.findById(
          tx,
          submissionId,
        );
        if (!existing || existing.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const updated = await this.contactSubmissionsRepository.updateStatus(
          tx,
          submissionId,
          body.status,
        );
        return toContactSubmissionResponse(updated);
      },
    );
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
  /**
   * `academies` has exactly one relevant unique constraint reachable from
   * the two callers of this method (`create`/`update`'s wrapped writes):
   * `slug`. `error.meta.target` is NOT reliably populated by Postgres/
   * Prisma for every `P2002` — confirmed empirically in this environment
   * (surfaces as `"(not available)"`, no target array at all), which is
   * exactly the same, already-documented limitation
   * `OrganizationsService.isUniqueSlugViolation` and the provisioning
   * orchestrator's `tryAdoptExistingAcademy` (`isRawSlugConflict`) both
   * work around by matching on `error.code === 'P2002'` alone rather than
   * trusting `target`'s shape. This previously relied on `target` being
   * an array containing `'slug'`, which this driver never actually
   * provides, so the conversion below silently never fired and a raw
   * `PrismaClientKnownRequestError` escaped as an unhandled 500 on every
   * real slug/subdomain collision through `create`/`update` (the
   * orchestrator's own call path already worked around this independently
   * — see its doc comment — but the direct `create`/`update` routes did
   * not). Fixed here at the actual source, matching the same reasoning
   * `OrganizationsService` already documents for the identical problem.
   */
  private async withSlugConflictHandling<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
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
