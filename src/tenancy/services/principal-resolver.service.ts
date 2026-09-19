/**
 * PrincipalResolverService — P64 Phase 1 (master plan AD-4).
 *
 * Atlas has no stored "user kind": a person is a Platform Owner (real
 * `is_platform_owner` column), STAFF (any `organization_memberships` row or
 * any active `academy_members` row), or a LEARNER (only `academy_students`
 * rows). A person may be staff in one organization and a learner in
 * another academy — the surface they are on decides which capabilities
 * apply, never a flag. `unaffiliated` is the fourth, honest answer for a
 * brand-new account that holds no fact at all yet (the self-service
 * Organization-Owner onboarding journey, Decision 5 of P19): it is treated
 * as management-capable so that journey keeps working, and it is exactly
 * what `SaasLevelCallerGuard` has always distinguished.
 *
 * Three indexed reads under the user's own context (all three tables carry
 * a `*_self_select` policy). Cached per request on `request.principal` so
 * a guard and a controller never pay twice.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { TenancyContextService } from './tenancy-context.service';
import { OrganizationMembershipsRepository } from '../repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from '../repositories/academy-students.repository';
import { AcademyStaffRepository } from '../repositories/academy-staff.repository';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { resolveCanonicalHost } from '../../domain/utils/canonical-host.util';

export type PrincipalKind = 'platform_owner' | 'staff' | 'learner' | 'unaffiliated';

export interface LearnerAcademy {
  readonly academyId: string;
  readonly name: string;
  readonly slug: string;
  /** Public host of the academy website (custom domain when live, else the Atlas subdomain); absent when neither exists yet. */
  readonly host?: string;
  readonly membershipStatus: string;
  readonly blocked: boolean;
}

export interface Principal {
  readonly userId: string;
  readonly kind: PrincipalKind;
  readonly isPlatformOwner: boolean;
  readonly organizationMembershipCount: number;
  readonly academyStaff: readonly { academyId: string; role: string; status: string }[];
  readonly academies: readonly LearnerAcademy[];
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set lazily by `PrincipalResolverService.forRequest`. */
    principal?: Principal;
  }
}

interface LearnerAcademyRow {
  academy_id: string;
  academy_name: string;
  academy_slug: string;
  academy_status: string;
  membership_status: string;
  blocked_at: Date | null;
  joined_at: Date;
  custom_hostname: string | null;
  custom_domain_live: boolean | null;
  subdomain: string | null;
  subdomain_full_host: string | null;
}

@Injectable()
export class PrincipalResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly membershipsRepository: OrganizationMembershipsRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly academyStaffRepository: AcademyStaffRepository,
    private readonly configService: ConfigService,
  ) {}

  /** Per-request memo: the first caller resolves, later callers reuse. */
  async forRequest(request: Request, userId: string): Promise<Principal> {
    if (request.principal && request.principal.userId === userId) {
      return request.principal;
    }
    const principal = await this.resolve(userId);
    request.principal = principal;
    return principal;
  }

  /**
   * ONE transaction, not three round trips.
   *
   * This runs inside `ManagementSurfaceGuard`, so it is on the hot path of
   * every management request in the product. Written as three sequential
   * awaits — a `users` read, an interactive transaction for the two
   * RLS-scoped reads, and the definer-function call — it took three
   * connection acquisitions per request, and a 25-way concurrent burst
   * against the dev server then failed every single request with Prisma's
   * "Transaction already closed: expired transaction" (measured: 25/25
   * failures on a guarded endpoint against 3/25 on an unguarded one).
   *
   * Everything therefore happens inside the single transaction the
   * RLS-scoped reads need anyway: `users` carries no RLS, and
   * `resolve_learner_academies` is SECURITY DEFINER, so neither depends on
   * running outside it. The four reads are pipelined on that one
   * connection, which is what the measurement below the fix showed
   * mattered.
   */
  async resolve(userId: string): Promise<Principal> {
    const { isPlatformOwner, memberships, staff, academies } =
      await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        const [user, memberships, staff, academies] = await Promise.all([
          tx.user.findUnique({
            where: { id: userId },
            select: { isPlatformOwner: true },
          }),
          this.membershipsRepository.findAllForUser(tx, userId),
          this.academyStaffRepository.findAllForUser(tx, userId),
          this.readLearnerAcademies(tx, userId),
        ]);
        return {
          isPlatformOwner: user?.isPlatformOwner === true,
          memberships,
          staff,
          academies,
        };
      });

    const activeStaff = staff.filter((row) => row.status === 'active');
    const kind: PrincipalKind = isPlatformOwner
      ? 'platform_owner'
      : memberships.length > 0 || activeStaff.length > 0
        ? 'staff'
        : academies.length > 0
          ? 'learner'
          : 'unaffiliated';

    return {
      userId,
      kind,
      isPlatformOwner,
      organizationMembershipCount: memberships.length,
      academyStaff: activeStaff.map((row) => ({
        academyId: row.academyId,
        role: row.role,
        status: row.status,
      })),
      academies,
    };
  }

  /** Every academy the user is a student of, with the public host a refusal message can link to. */
  async resolveLearnerAcademies(userId: string): Promise<readonly LearnerAcademy[]> {
    return this.readLearnerAcademies(this.prisma, userId);
  }

  /** The same read, against whichever client the caller already holds — see `resolve`. */
  private async readLearnerAcademies(
    client: Pick<PrismaService, '$queryRaw'> | Prisma.TransactionClient,
    userId: string,
  ): Promise<readonly LearnerAcademy[]> {
    const rows = await client.$queryRaw<LearnerAcademyRow[]>(
      Prisma.sql`SELECT * FROM resolve_learner_academies(${userId})`,
    );
    const baseDomain =
      this.configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;

    return rows.map((row) => {
      const canonical = resolveCanonicalHost({
        connectedCustomHostname: row.custom_domain_live ? row.custom_hostname : null,
        subdomainFullHost: row.subdomain_full_host,
        subdomainLabel: row.subdomain,
        baseDomain,
      });
      return {
        academyId: row.academy_id,
        name: row.academy_name,
        slug: row.academy_slug,
        host: canonical?.host,
        membershipStatus: row.membership_status,
        blocked: row.blocked_at !== null,
      };
    });
  }

  /** `true` when the user holds an academy_students row for this academy (any status). */
  async isStudentOf(userId: string, academyId: string): Promise<boolean> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const row = await this.academyStudentsRepository.findForUserInAcademy(
        tx,
        academyId,
        userId,
      );
      return row !== null;
    });
  }
}
