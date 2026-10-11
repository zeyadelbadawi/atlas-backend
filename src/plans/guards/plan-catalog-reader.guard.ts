/**
 * PlanCatalogReaderGuard — who may read the plan/add-on catalog
 * (`GET /plans`, `GET /add-ons`).
 *
 * The catalog is read by SaaS-level callers choosing a plan (the
 * `SaasLevelCallerGuard` rule, unchanged) AND by the Platform Owner, whose
 * Plans & Add-ons and Compose and Send pages list it. A Platform Owner who
 * also holds an Academy staff role (e.g. Manager in one Academy) failed the
 * SaaS-level rule, so those pages showed "You do not have access" and an
 * empty catalog. `isPlatformOwner` is checked first; everyone else gets the
 * exact SaaS-level check. Read-only routes — no write path is widened, and
 * `ManagementSurfaceGuard` still runs before this guard.
 */
import { ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { SaasLevelCallerGuard } from '../../tenancy/guards/saas-level-caller.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationMembershipsRepository } from '../../tenancy/repositories/organization-memberships.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { AcademyStaffRepository } from '../../tenancy/repositories/academy-staff.repository';
import { UsersRepository } from '../../identity/repositories/users.repository';

@Injectable()
export class PlanCatalogReaderGuard extends SaasLevelCallerGuard {
  constructor(
    tenancyContextService: TenancyContextService,
    membershipsRepository: OrganizationMembershipsRepository,
    academyStudentsRepository: AcademyStudentsRepository,
    academyStaffRepository: AcademyStaffRepository,
    private readonly usersRepository: UsersRepository,
  ) {
    super(
      tenancyContextService,
      membershipsRepository,
      academyStudentsRepository,
      academyStaffRepository,
    );
  }

  override async canActivate(context: ExecutionContext): Promise<boolean> {
    const userId = context.switchToHttp().getRequest<Request>().authContext?.userId;
    if (userId) {
      const user = await this.usersRepository.findById(userId);
      if (user?.isPlatformOwner) return true;
    }
    return super.canActivate(context);
  }
}
