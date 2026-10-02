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
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AcademyMember, AcademyMemberRole } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AccountSetupService } from '../../identity/services/account-setup.service';
import { OrganizationsRepository } from '../../tenancy/repositories/organizations.repository';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import {
  ORGANIZATION_INSTRUCTOR_PERMISSIONS,
  ORGANIZATION_MANAGER_PERMISSIONS,
} from '../../tenancy/constants/organization-permissions.constants';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { TenantUsageRecomputeProducer } from '../../plans/queue/tenant-usage-recompute.producer';
import { AcademiesRepository } from '../repositories/academies.repository';
import { AcademyMembersRepository } from '../repositories/academy-members.repository';
import { ContactSubmissionsRepository } from '../repositories/contact-submissions.repository';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { DomainConnectionsRepository } from '../../domain/repositories/domain-connections.repository';
import { DomainProviderReleasesRepository } from '../../domain/repositories/domain-provider-releases.repository';
import { DomainProviderReleaseService } from '../../domain/services/domain-provider-release.service';
import { PlatformDomainService } from '../../domain/services/platform-domain.service';
import {
  buildFullHost,
  resolveEffectiveBaseDomain,
} from '../../domain/utils/effective-base-domain.util';
import { RESERVED_SUBDOMAINS } from '../../provisioning/dto/provisioning.constants';
import { ConfigService } from '@nestjs/config';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { PlatformDomainConfigurationRepository } from '../../domain/repositories/platform-domain-configuration.repository';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { toAcademyResponse } from '../dto/academy.contract';
import type { AcademyResponse, AcademyAddressResponse } from '../dto/academy.contract';
import { toAcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyMemberResponse } from '../dto/academy-member.contract';
import { toAcademyStudentResponse } from '../dto/academy-student.contract';
import type { AcademyStatsResponse } from '../dto/academy-stats.contract';
import type { AcademyActivityResponse } from '../dto/academy-activity.contract';
import {
  toContactSubmissionResponse,
  type ContactSubmissionResponse,
  type ContactSubmissionSummaryResponse,
} from '../dto/contact-submission.contract';
import type { UpdateContactSubmissionStatusDto } from '../dto/update-contact-submission-status.dto';
import type { ContactSubmissionQueryDto } from '../dto/contact-submission-query.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../dto/list-query.dto';
import type { CollectionQueryDto, ListAcademiesQueryDto } from '../dto/list-query.dto';
import type { CreateAcademyDto } from '../dto/create-academy.dto';
import type { UpdateAcademyDto } from '../dto/update-academy.dto';
import type { AcademyArchiveReason } from '../dto/delete-academy.dto';
import type { UpdateAcademyBrandingDto } from '../dto/update-academy-branding.dto';
import type { AddAcademyManagerDto } from '../dto/add-academy-manager.dto';
import type { AddAcademyInstructorDto } from '../dto/add-academy-instructor.dto';
import type { CreateAcademyStudentDto } from '../dto/create-academy-student.dto';
import type { User } from '@prisma/client';
import {
  recordMemberAdd,
  recordMemberAddRace,
  recordMemberLookup,
  type MemberAddAccount,
  type MemberAddRole,
} from '../../observability/metrics/member-metrics';
import type {
  AcademyMemberAddResponse,
  MemberAddOutcome,
} from '../dto/academy-member.contract';
import type { AcademyStudentAddResponse } from '../dto/academy-student.contract';
import type {
  AcademyMemberLookupResponse,
  MemberLookupRole,
} from '../dto/academy-member-lookup.dto';
import { AuthRateLimiterService } from '../../identity/services/auth-rate-limiter.service';
import { normalizeEmail } from '../../identity/utils/email.util';

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
/** P63g — a slug that is a reserved platform label can never become a public subdomain. */
export function assertSlugNotReserved(slug: string): void {
  if (RESERVED_SUBDOMAINS.includes(slug.trim().toLowerCase())) {
    throw new ConflictException({ messageKey: 'errors.academy.slugReserved' });
  }
}

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

/** The account an add resolved to, inside the add's own transaction. */
interface ResolvedMemberAccount {
  readonly user: User;
  readonly account: MemberAddAccount;
}

/** A Prisma unique-constraint violation (`P2002`) — the only error the add path retries. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/**
 * Staff member lookups, per acting user. Generous for a person typing into
 * a dialog (the frontend debounces), tight enough that a self-serve owner
 * account cannot be used to harvest the names behind a list of emails.
 */
const MEMBER_LOOKUP_LIMITS = [
  { window: 'short', max: 30, windowSeconds: 600 },
  { window: 'day', max: 300, windowSeconds: 86_400 },
] as const;

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

/**
 * What the caller may record when deleting an Academy. Both fields are
 * optional: deletion must never depend on answering an exit survey.
 */
export interface ArchiveAcademyInput {
  readonly reason?: AcademyArchiveReason;
  readonly feedback?: string;
}

/**
 * What one new academy member COSTS, by role (P62).
 *
 * TOTAL over `AcademyMemberRole` on purpose: adding a role to the enum
 * without deciding what it consumes fails to compile, which is the only
 * way this mapping stays correct. `null` means "consumes no plan seat" and
 * is a decision, not an omission:
 *
 *   - `owner` is the academy's creator, already gated by the `academies`
 *     limit that let the academy exist at all. Charging a second seat for
 *     the same act would double-count one creation.
 *   - `administrator`/`manager` are counted by neither `instructors` nor
 *     `staff` in `TenantUsageRecomputeService.computeLiveCounts`, which
 *     counts only the literally-matching role. Enforcing a limit here that
 *     usage does not measure would refuse writes against a number no
 *     dashboard could explain.
 *
 * `staff` maps to the `staff` limit even though no endpoint currently
 * creates a staff member — see `createAcademyMember`.
 */
export const MEMBER_ROLE_LIMIT: Record<
  AcademyMemberRole,
  'instructors' | 'staff' | null
> = {
  owner: null,
  administrator: null,
  manager: null,
  instructor: 'instructors',
  staff: 'staff',
};

@Injectable()
export class AcademiesService {
  private readonly logger = new Logger(AcademiesService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academiesRepository: AcademiesRepository,
    private readonly accountSetupService: AccountSetupService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly organizationsRepository: OrganizationsRepository,
    private readonly organizationMembershipsRepository: OrganizationMembershipsRepository,
    private readonly usersRepository: UsersRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly tenantUsageRecomputeProducer: TenantUsageRecomputeProducer,
    private readonly contactSubmissionsRepository: ContactSubmissionsRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly domainProviderReleasesRepository: DomainProviderReleasesRepository,
    private readonly domainProviderReleaseService: DomainProviderReleaseService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    private readonly authRateLimiter: AuthRateLimiterService,
    configService: ConfigService,
  ) {
    this.environmentBaseDomain = configService
      .get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain?.trim()
      .toLowerCase();
  }

  private readonly environmentBaseDomain?: string;

  /** P63g — best-effort provider release after the archive committed; the sweep retries anything that fails. Never throws into the request. */
  private async domainReleaseAfterCommit(releaseId: string): Promise<void> {
    try {
      const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
      if (!platformOwner) return;
      const providerAvailable = await this.platformDomainService.isProviderAvailable();
      await this.tenancyContextService.runInUserContext(platformOwner.id, async (tx) => {
        const row = await this.domainProviderReleasesRepository.findById(tx, releaseId);
        if (row)
          await this.domainProviderReleaseService.attempt(tx, row, providerAvailable);
      });
    } catch {
      // Recorded in the ledger; the sweep retries.
    }
  }

  /**
   * Smart member invitation — resolves the account an add is about, INSIDE
   * the caller's transaction, so the user row and the membership commit or
   * roll back together (no orphaned `invited` account when a later check
   * refuses the add):
   *  - an existing, active account → reused as-is (password, name and every
   *    other membership untouched);
   *  - an existing account that never finished setup (`invited`) → reused,
   *    and the caller sends a FRESH setup link rather than an "added"
   *    notice it could not act on;
   *  - a suspended or deleted account → refused;
   *  - no account and a `name` → a new `invited` account (A2);
   *  - no account and no `name` → `null` (the caller's "not found").
   *
   * The frontend lookup is never trusted: this is the only resolution that
   * decides anything.
   */
  private async resolveMemberAccount(
    tx: Prisma.TransactionClient,
    email: string,
    name: string | undefined,
  ): Promise<ResolvedMemberAccount | null> {
    const existing = await this.usersRepository.findByEmail(email, tx);
    if (existing) {
      if (existing.status === 'suspended' || existing.status === 'deleted') {
        throw new ConflictException({ messageKey: 'errors.academy.accountUnavailable' });
      }
      return {
        user: existing,
        account: existing.status === 'invited' ? 'pending_setup' : 'existing',
      };
    }
    if (!name) return null;
    return { user: await this.createInvitedUser(email, name, tx), account: 'new' };
  }

  /**
   * Two owners adding the same email at the same moment race on
   * `users.email` (or on the membership's own unique constraint). The loser's
   * transaction rolls back completely — its user row included — and is run
   * ONCE more, when it simply finds what the winner committed (an existing
   * account, or an existing membership → the usual 409). A second collision
   * is reported as that 409 rather than a 500.
   */
  private async withAddRaceRetry<T>(
    role: MemberAddRole,
    conflictMessageKey: string,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      recordMemberAddRace(role);
      try {
        return await run();
      } catch (retryError) {
        if (isUniqueViolation(retryError)) {
          throw new ConflictException({ messageKey: conflictMessageKey });
        }
        throw retryError;
      }
    }
  }

  /**
   * Who may add a member at all: the academy's `owner`-role member — and,
   * for a Manager or Instructor grant, the organization owner as well (the
   * `organization_memberships_owner_grants_insert` RLS policy admits the
   * org-membership INSERT only for them; see `GRANTS_MANAGER_ROLES`).
   */
  private async assertCanAddMember(
    tx: Prisma.TransactionClient,
    academyId: string,
    organizationId: string,
    actingUserId: string,
    role: MemberAddRole,
  ): Promise<{ readonly academyName: string }> {
    const actingMembership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      actingUserId,
    );
    if (!actingMembership || !GRANTS_MANAGER_ROLES.has(actingMembership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
    }
    if (role !== 'student') {
      const organization = await this.organizationsRepository.findById(
        tx,
        organizationId,
      );
      if (!organization || organization.ownerUserId !== actingUserId) {
        throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
      }
    }
    // The academy's name, read HERE — inside the caller's tenant context,
    // where `academies` RLS lets it be seen. It is the authoritative value
    // every "invited"/"added" email names; reading it later without a
    // context returns nothing (FORCE RLS), which is how those emails once
    // said "You've been added to  on Atlas".
    const academy = await tx.academy.findUnique({
      where: { id: academyId },
      select: { name: true },
    });
    if (!academy?.name) {
      throw new NotFoundException({ messageKey: 'errors.academy.notFound' });
    }
    return { academyName: academy.name };
  }

  /**
   * After the add committed: a new or never-activated account gets a setup
   * link (`AccountSetupService.sendInvite`, a fresh token each time); an
   * existing, active account gets the "you've been added" notice. Both are
   * best-effort and never throw — the membership stands either way.
   */
  private async notifyMemberAdded(input: {
    readonly userId: string;
    readonly email: string;
    readonly account: MemberAddAccount;
    readonly academyId: string;
    /** From `assertCanAddMember`, read inside the add's own transaction. */
    readonly academyName: string;
    readonly role: MemberAddRole;
    readonly membershipId: string;
  }): Promise<MemberAddOutcome> {
    recordMemberAdd(input.role, input.account);
    if (input.account === 'existing') {
      await this.accountSetupService.sendAddedNotice({
        userId: input.userId,
        academyId: input.academyId,
        academyName: input.academyName,
        role: input.role,
        membershipId: input.membershipId,
      });
      return 'added';
    }
    await this.accountSetupService.sendInvite({
      userId: input.userId,
      academyId: input.academyId,
      academyName: input.academyName,
      role: input.role,
      email: input.email,
    });
    return input.account === 'new' ? 'invited' : 'reinvited';
  }

  /**
   * Launch Stabilization A2 (D2) — an account somebody else creates is
   * `invited`, with NO password credential at all. Identity is global: a password chosen by the staff
   * member who created the account would let them sign in as that person
   * anywhere, for as long as the person had not set their own. The person
   * sets it through the emailed setup link (`AccountSetupService`), which
   * is what activates the account.
   */
  private async createInvitedUser(
    email: string,
    name: string,
    tx: Prisma.TransactionClient,
  ): Promise<User> {
    // No credential at all: an invited account has no password until its
    // owner sets one through the setup link.
    return this.usersRepository.create({ email, name, status: 'invited' }, tx);
  }

  /** The deprecated staff-chosen `password` field is accepted for compatibility and never used. */
  private warnIgnoredPassword(password: string | undefined): void {
    if (password) {
      this.logger.warn(
        'A staff-supplied password was ignored: invited accounts set their own password through the emailed setup link.',
      );
    }
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
    // P63g — the slug IS the public subdomain label; labels Atlas itself
    // needs (`www`, `api`, `admin`, …) are refused here exactly as the
    // provisioning path refuses them.
    assertSlugNotReserved(payload.slug);
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
          await this.createAcademyMember(tx, payload.organizationId, {
            academyId: created.id,
            userId,
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
          const { baseDomain } = resolveEffectiveBaseDomain(
            this.environmentBaseDomain,
            platformDomain,
          );

          await this.subdomainAllocationsRepository.create(tx, {
            academyId: created.id,
            subdomain: created.slug,
            status: 'assigned',
            // Null when no platform base domain is configured (local and
            // early environments). The allocation is still recorded, so
            // resolution by bare label keeps working and configuring the
            // domain later needs no backfill. P63g: the EFFECTIVE base
            // domain (environment first), the same rule every reader uses.
            fullHost: buildFullHost(created.slug, baseDomain),
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
      assertSlugNotReserved(payload.slug);
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
    const { academy, allocation, customHostname } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          await this.assertCanManage(tx, academyId, userId);

          const updated = await this.academiesRepository.update(tx, academyId, {
            name: payload.name,
            logoUrl: payload.logo,
            faviconUrl: payload.favicon,
          });
          const [allocation, connection] = await Promise.all([
            this.subdomainAllocationsRepository.findByAcademyId(tx, academyId),
            this.domainConnectionsRepository.findByAcademyId(tx, academyId),
          ]);
          return {
            academy: updated,
            allocation,
            customHostname: connection?.hostname ?? null,
          };
        },
      );

    // The public site reads the name, logo and favicon version from the
    // cached hostname resolution (60 s): drop it, so a new favicon or logo
    // shows on the next page load rather than up to a minute later.
    await this.invalidatePublicHostnames(academy.slug, allocation, customHostname);

    return toAcademyResponse(academy);
  }

  /**
   * Drops every cached hostname resolution that could answer for this
   * Academy (P63g): the allocation's label, its stored full host, the
   * effective full host, the slug forms and the connected custom hostname.
   */
  private async invalidatePublicHostnames(
    slug: string,
    allocation: { readonly subdomain: string; readonly fullHost: string | null } | null,
    customHostname: string | null,
  ): Promise<void> {
    const platformDomain =
      await this.platformDomainConfigurationRepository.findSingleton();
    const { baseDomain } = resolveEffectiveBaseDomain(
      this.environmentBaseDomain,
      platformDomain,
    );
    const hosts = new Set<string>([slug]);
    if (allocation) {
      hosts.add(allocation.subdomain);
      if (allocation.fullHost) hosts.add(allocation.fullHost);
      const full = buildFullHost(allocation.subdomain, baseDomain);
      if (full) hosts.add(full);
    }
    const slugFull = buildFullHost(slug, baseDomain);
    if (slugFull) hosts.add(slugFull);
    if (platformDomain.baseDomain) hosts.add(`${slug}.${platformDomain.baseDomain}`);
    if (customHostname) hosts.add(customHostname);
    await this.publicWebsiteCacheService.invalidateHostnameResolution([...hosts]);
  }

  /** `DELETE /academies/:id` — soft-archive via status transition, never a SQL DELETE (no DELETE RLS policy exists on `academies` at all). */
  /**
   * Deletes an Academy.
   *
   * Deletion is ARCHIVAL, and deliberately so: `academies` has no DELETE
   * RLS policy, because courses, enrolments, orders and revenue-ledger
   * entries reference the row and destroying it would take a customer's
   * financial history with it. What the customer actually asked for still
   * happens — the public website goes offline immediately and the plan's
   * academy allowance is released.
   *
   * `input` is optional so the plain `DELETE /academies/:id` transport,
   * which carries no body, keeps working unchanged.
   */
  async archive(
    academyId: string,
    organizationId: string,
    userId: string,
    input: ArchiveAcademyInput = {},
  ): Promise<void> {
    const archived = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        return this.academiesRepository.update(tx, academyId, {
          status: 'archived',
          archivedAt: new Date(),
          archiveReason: input.reason ?? null,
          archiveFeedback: input.feedback?.trim() || null,
        });
      },
    );

    // Phase 10.6 — take the public website offline IMMEDIATELY.
    //
    // `resolve_public_hostname` now refuses archived Academies, but the
    // resolution is also cached in Redis for 60 seconds. Without this the
    // deleted Academy's site kept serving for up to a minute — the
    // customer deletes it, watches the site stay up, and reasonably
    // concludes deletion did not work.
    //
    // Both hostname forms the resolver accepts are dropped: the bare slug
    // and the fully-qualified host, since either could be the cached key.
    // P63g — every host that could be cached is dropped: the allocation's
    // label (which may differ from the slug), its stored full host, the
    // effective full host, the slug forms, AND the connected custom
    // hostname. The custom domain itself is released: an archived Academy
    // must not keep a hostname burned (no path could free it before) nor
    // keep a provider resource answering at the edge.
    const { allocation, releaseId, previousHostname } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          const allocation = await this.subdomainAllocationsRepository.findByAcademyId(
            tx,
            academyId,
          );
          const connection = await this.domainConnectionsRepository.lockByAcademyId(
            tx,
            academyId,
          );
          let releaseId: string | null = null;
          if (connection?.hostname) {
            const release = await this.domainProviderReleasesRepository.enqueue(tx, {
              academyId,
              hostname: connection.hostname,
              providerHostnameId: connection.providerHostnameId,
              reason: 'archived',
            });
            releaseId = release.id;
            await this.domainConnectionsRepository.updateByAcademyId(tx, academyId, {
              hostname: null,
              status: 'not_configured',
              verificationRecords: Prisma.JsonNull,
              sslStatus: 'not_configured',
              cdnStatus: 'not_configured',
              cdnProvider: null,
              providerHostnameId: null,
              connectedAt: null,
              lastCheckedAt: null,
              lastCheckError: null,
              lastProviderErrorCode: null,
              httpsReachable: null,
              httpsCheckedAt: null,
              httpsStatusCode: null,
              httpsFailureReason: null,
              consecutiveFailures: 0,
            });
          }
          return {
            allocation,
            releaseId,
            previousHostname: connection?.hostname ?? null,
          };
        },
      );
    await this.invalidatePublicHostnames(archived.slug, allocation, previousHostname);
    if (releaseId) {
      await this.domainReleaseAfterCommit(releaseId);
    }

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
  ): Promise<AcademyMemberAddResponse> {
    this.warnIgnoredPassword(payload.password);
    return this.addStaffMember(
      academyId,
      organizationId,
      actingUserId,
      payload,
      'manager',
    );
  }

  /**
   * `POST /academies/:id/instructors` — the Instructor counterpart of
   * `addManager` above; same owner-only gate, same smart email resolution,
   * same two-row (org membership + academy member) grant — only the role
   * and the granted permission set differ (`ORGANIZATION_INSTRUCTOR_PERMISSIONS`,
   * deliberately narrower than a Manager's, see that constant's doc comment).
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
  ): Promise<AcademyMemberAddResponse> {
    this.warnIgnoredPassword(payload.password);
    const response = await this.addStaffMember(
      academyId,
      organizationId,
      actingUserId,
      payload,
      'instructor',
    );
    // Phase 2 — real reactive usage-recompute trigger (an `instructors`
    // count change), run after the granting transaction has committed.
    await this.tenantUsageRecomputeProducer.enqueueOne(organizationId);
    return response;
  }

  /**
   * The shared Manager/Instructor add. ONE transaction resolves the email
   * (`resolveMemberAccount`), creates the organization membership if the
   * person has none there yet (an existing one — whatever its role — is left
   * exactly as it is), creates the `academy_members` row (with the Phase 2
   * entitlement check, after every authorization/conflict check so a caller
   * who was never allowed, or a target already a member, gets that specific
   * error first) and writes the audit row. Notification happens after
   * commit (`notifyMemberAdded`).
   */
  private async addStaffMember(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    payload: { readonly email: string; readonly name?: string },
    role: 'manager' | 'instructor',
  ): Promise<AcademyMemberAddResponse> {
    const result = await this.withAddRaceRetry(
      role,
      'errors.academy.managerAlreadyMember',
      () =>
        this.tenancyContextService.runInTenantAndUserContext(
          organizationId,
          actingUserId,
          async (tx) => {
            const { academyName } = await this.assertCanAddMember(
              tx,
              academyId,
              organizationId,
              actingUserId,
              role,
            );

            const target = await this.resolveMemberAccount(
              tx,
              payload.email,
              payload.name,
            );
            if (!target) {
              throw new NotFoundException({
                messageKey: 'errors.academy.managerUserNotFound',
              });
            }

            const existingAcademyMembership =
              await this.academyMembersRepository.findForUserInAcademy(
                tx,
                academyId,
                target.user.id,
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
                target.user.id,
              );
            if (!existingOrgMembership) {
              await this.organizationMembershipsRepository.create(tx, {
                organizationId,
                userId: target.user.id,
                role,
                permissions:
                  role === 'manager'
                    ? ORGANIZATION_MANAGER_PERMISSIONS
                    : ORGANIZATION_INSTRUCTOR_PERMISSIONS,
                isPrimary: false,
              });
            }

            const created = await this.createAcademyMember(tx, organizationId, {
              academyId,
              userId: target.user.id,
              role,
            });

            await this.auditLogWriterService.write(tx, {
              actorUserId: actingUserId,
              organizationId,
              action:
                role === 'manager' ? 'academy.manager.added' : 'academy.instructor.added',
              targetType: 'academy_member',
              targetId: created.id,
              targetLabel: target.user.email,
              context: { account: target.account },
            });

            return {
              member: toAcademyMemberResponse({
                ...created,
                user: {
                  id: target.user.id,
                  name: target.user.name,
                  email: target.user.email,
                },
              }),
              userId: target.user.id,
              email: target.user.email,
              account: target.account,
              membershipId: created.id,
              academyName,
            };
          },
        ),
    );

    const outcome = await this.notifyMemberAdded({
      userId: result.userId,
      email: result.email,
      account: result.account,
      academyId,
      academyName: result.academyName,
      role,
      membershipId: result.membershipId,
    });
    return { ...result.member, outcome };
  }

  /**
   * `POST /academies/:id/students` — adds a learner to this academy.
   *
   * A student is never an `academy_members` row and never an
   * `organization_memberships` row — `Enrollment`'s own RLS policies key
   * only on `student_id = app.current_user_id`. The learner relationship is
   * the `academy_students` row (Phase 1, Decision 11), created here with
   * `source: 'staff_created'` exactly as self-registration creates its own.
   *
   * Smart member invitation: the email may belong to an existing Atlas
   * account (a learner elsewhere, or staff anywhere) — it is then added to
   * THIS academy as a learner and told so; nothing else about the account
   * changes. A new email becomes an `invited` account (A2) with a setup
   * link. `name` is required only for a new account.
   */
  async createStudent(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    payload: CreateAcademyStudentDto,
  ): Promise<AcademyStudentAddResponse> {
    this.warnIgnoredPassword(payload.password);
    const result = await this.withAddRaceRetry(
      'student',
      'errors.academy.studentAlreadyMember',
      () =>
        this.tenancyContextService.runInTenantAndUserContext(
          organizationId,
          actingUserId,
          async (tx) => {
            const { academyName } = await this.assertCanAddMember(
              tx,
              academyId,
              organizationId,
              actingUserId,
              'student',
            );

            const target = await this.resolveMemberAccount(
              tx,
              payload.email,
              payload.name,
            );
            if (!target) {
              throw new BadRequestException({
                messageKey: 'errors.academy.nameRequiredForNewAccount',
              });
            }

            const existingLearner =
              await this.academyStudentsRepository.findForUserInAcademy(
                tx,
                academyId,
                target.user.id,
              );
            if (existingLearner) {
              throw existingLearner.blockedAt
                ? new ForbiddenException({ messageKey: 'errors.academy.studentBlocked' })
                : new ConflictException({
                    messageKey: 'errors.academy.studentAlreadyMember',
                  });
            }

            // Staff-insert policy (`academy_students_staff_insert`), tenant-
            // scoped exactly like `academy_members_insert` — the role check
            // above already gates who may reach this point.
            const learner = await this.academyStudentsRepository.create(tx, {
              academyId,
              userId: target.user.id,
              source: 'staff_created',
            });

            await this.auditLogWriterService.write(tx, {
              actorUserId: actingUserId,
              organizationId,
              action:
                target.account === 'new'
                  ? 'academy.student.created'
                  : 'academy.student.added',
              targetType: 'user',
              targetId: target.user.id,
              targetLabel: target.user.email,
              context: { account: target.account },
            });

            return {
              response: toAcademyStudentResponse(target.user, academyId),
              userId: target.user.id,
              email: target.user.email,
              account: target.account,
              membershipId: learner.id,
              academyName,
            };
          },
        ),
    );

    // AFTER the transaction: the learner row exists, so a mail failure is
    // recoverable (password recovery reaches the same page).
    const outcome = await this.notifyMemberAdded({
      userId: result.userId,
      email: result.email,
      account: result.account,
      academyId,
      academyName: result.academyName,
      role: 'student',
      membershipId: result.membershipId,
    });
    return { ...result.response, outcome };
  }

  /**
   * `GET /academies/:id/member-lookup` — the invitation dialog's debounced
   * email check. UX only: the add call above re-resolves everything in its
   * own transaction and never reads this answer.
   *
   * Only someone who could perform the matching add may ask (the same
   * `assertCanAddMember` gate), the answer is scoped to THIS academy, and it
   * carries nothing but a status and — when an account exists — its display
   * name. Rate-limited per acting user so an owner account cannot be used to
   * map a list of emails to names.
   */
  async lookupMember(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    email: string,
    role: MemberLookupRole,
  ): Promise<AcademyMemberLookupResponse> {
    for (const limit of MEMBER_LOOKUP_LIMITS) {
      const check = await this.authRateLimiter.consume(
        `member-lookup:${limit.window}:${actingUserId}`,
        limit.max,
        limit.windowSeconds,
      );
      if (!check.allowed) {
        recordMemberLookup('rate_limited');
        throw new HttpException(
          { messageKey: 'errors.academy.memberLookupRateLimited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
    }

    try {
      const answer = await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        actingUserId,
        async (tx): Promise<AcademyMemberLookupResponse> => {
          await this.assertCanAddMember(
            tx,
            academyId,
            organizationId,
            actingUserId,
            role,
          );

          const user = await tx.user.findUnique({
            where: { email: normalizeEmail(email) },
            select: { id: true, name: true, status: true },
          });
          if (!user) return { status: 'new' };
          if (user.status === 'suspended' || user.status === 'deleted') {
            return { status: 'unavailable' };
          }
          const alreadyHere =
            role === 'student'
              ? await this.academyStudentsRepository.findForUserInAcademy(
                  tx,
                  academyId,
                  user.id,
                )
              : await this.academyMembersRepository.findForUserInAcademy(
                  tx,
                  academyId,
                  user.id,
                );
          if (alreadyHere) return { status: 'already_member' };
          return user.status === 'invited'
            ? { status: 'existing_pending_setup', name: user.name }
            : { status: 'existing', name: user.name };
        },
      );
      recordMemberLookup(
        answer.status === 'existing_pending_setup' ? 'pending_setup' : answer.status,
      );
      return answer;
    } catch (error) {
      if (error instanceof ForbiddenException) recordMemberLookup('denied');
      throw error;
    }
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
    query: ContactSubmissionQueryDto,
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
            search: query.search,
            status: query.status,
            from: query.from ? new Date(`${query.from}T00:00:00.000Z`) : undefined,
            // Inclusive `to`: everything before the start of the next day.
            toExclusive: query.to
              ? new Date(Date.parse(`${query.to}T00:00:00.000Z`) + 86_400_000)
              : undefined,
            sortBy: query.sortBy,
            sortDirection: query.sortDirection,
          });
        return {
          items: items.map(toContactSubmissionResponse),
          pagination: buildPaginationMeta(page, pageSize, totalItems),
        };
      },
    );
  }

  /** Message counts per status for the Owner's Messages page (same access as the list). */
  async getContactSubmissionSummary(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<ContactSubmissionSummaryResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, userId);
        const counts = await this.contactSubmissionsRepository.countByStatus(
          tx,
          academyId,
        );
        return { ...counts, total: counts.new + counts.read + counts.archived };
      },
    );
  }

  /** Phase 6 — staff triage (mark new/read/archived); never re-opens the public write path. */
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

  /**
   * THE ONLY WAY THIS SERVICE CREATES AN ACADEMY MEMBER (P62).
   *
   * Entitlement enforcement used to live at each call site, which meant it
   * could be — and was — forgotten: `staff` had a plan limit, a usage
   * counter and a dashboard row, and no check anywhere. Routing every
   * creation through one method makes the check structural: a new member
   * path cannot skip it without deliberately not using this.
   *
   * WHAT THIS DOES NOT DO. It does not invent a staff-creation endpoint.
   * Nothing in Atlas creates a member with role `staff` today — the three
   * real paths produce `owner`, `manager` and `instructor` — so the `staff`
   * branch is unreachable until such a path exists, and correct the moment
   * one does. That is the honest state: the limit was unenforceable rather
   * than merely unenforced.
   *
   * Runs inside the caller's transaction, after their own authorization and
   * conflict checks, so a caller who was never allowed to do this — or a
   * target who is already a member — still gets that specific error first.
   */
  private async createAcademyMember(
    tx: Prisma.TransactionClient,
    organizationId: string,
    member: {
      readonly academyId: string;
      readonly userId: string;
      readonly role: AcademyMemberRole;
    },
  ): Promise<AcademyMember> {
    const limitKey = MEMBER_ROLE_LIMIT[member.role];
    if (limitKey) {
      await this.entitlementEnforcementService.assertWithinLimit(
        tx,
        organizationId,
        limitKey,
      );
    }

    return this.academyMembersRepository.create(tx, {
      academy: { connect: { id: member.academyId } },
      user: { connect: { id: member.userId } },
      role: member.role,
    });
  }
}
