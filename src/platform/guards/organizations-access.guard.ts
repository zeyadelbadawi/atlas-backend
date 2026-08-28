/**
 * OrganizationsAccessGuard — Phase P15's resolution to a real, confirmed
 * frontend contract collision on `organizations`: TWO different frontend
 * services call the exact same routes with different audiences and
 * different expected shapes —
 *
 *   - `OrganizationService.getById` (Prompt 1, `useOrganization`,
 *     `OrganizationOverviewPage`) — a TENANT MEMBER reading their OWN
 *     organization, expects the narrow `Organization`/`OrganizationResponse`
 *     shape. This is `OrganizationMembershipGuard`'s existing, unmodified
 *     P2 behavior.
 *   - `PlatformOrganizationService.getOrganization`/`.getOrganizations`
 *     (Prompt 13, `usePlatformOrganization(s)`,
 *     `PlatformOrganization{List,Detail}Page`) — a PLATFORM OWNER reading
 *     ANY organization cross-tenant, expects the richer
 *     `PlatformOrganizationDetail`/`PlatformOrganizationSummary` shape.
 *     `PlatformOrganizationService`'s own `resource = 'organizations'` is
 *     the confirmed, deliberate reuse of this exact resource for its
 *     detail call (`fetchOne` → `GET /organizations/:id`) — there is no
 *     separate `platform-organizations` path the way
 *     `PlatformAcademyService`/`PlatformUserService` each got their own
 *     distinct `platform-academies`/`platform-users` resource. Confirmed
 *     by reading both services' source directly, not assumed.
 *
 * Rather than inventing a second, parallel route the frontend never calls,
 * `PlatformModule`'s own `OrganizationsController` makes `GET
 * /organizations` (new, list) and `GET /organizations/:id` (P2's real
 * route, now hosted here — see `TenancyModule`'s own doc comment for why
 * it moved) serve BOTH real audiences correctly on their ACTUAL shared
 * route: a verified Platform Owner is allowed through unconditionally
 * (any id, or the bare list); anyone else falls through to the EXISTING,
 * UNMODIFIED `OrganizationMembershipGuard` (reused verbatim, imported
 * from `TenancyModule`, now exported there additively for exactly this
 * reuse) — P2's tenant-member behavior is byte-for-byte unchanged for
 * every non-Platform-Owner caller. `OrganizationsController` independently
 * re-checks `is_platform_owner` itself before choosing which service to
 * call (never trusting this guard's decision alone) — the same "guard
 * decision is re-verified at the service layer" discipline
 * `OrganizationsService.getById` already documents for its own RLS
 * re-read.
 *
 * Reads `users.is_platform_owner` directly via the global `PrismaService`
 * rather than reusing `PlatformOwnerGuard` by decorator — `PlatformOwnerGuard`
 * itself is fine to inject here (this module already imports
 * `IdentityModule`), but its own `canActivate` always THROWS on failure
 * rather than returning `false`, which does not compose with "fall
 * through to the membership guard instead." The underlying check is
 * identical either way: a fresh per-request database re-read, never a
 * trusted JWT claim.
 */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import type { Request } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `OrganizationsAccessGuard` — a ROUTING hint only (which service branch `OrganizationsController` calls), never the sole authorization decision: whichever branch it picks still runs its own real, independent enforcement (RLS under the resolved context), so a wrong flag here would fail closed, not open. */
    isPlatformOwnerCaller?: boolean;
  }
}

@Injectable()
export class OrganizationsAccessGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly organizationMembershipGuard: OrganizationMembershipGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const userId = request.authContext?.userId;

    if (!userId) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { isPlatformOwner: true },
    });
    if (user?.isPlatformOwner) {
      request.isPlatformOwnerCaller = true;
      return true;
    }

    // Not a Platform Owner: the bare list route (`GET /organizations`, no
    // `:id`) has no organization to check membership against, and is
    // Platform-Owner-only by definition — refuse outright rather than
    // falling through to a membership check that would misinterpret a
    // missing param as "not a member."
    if (!request.params.id) {
      throw new ForbiddenException({ messageKey: 'errors.forbidden' });
    }

    return this.organizationMembershipGuard.canActivate(context);
  }
}
