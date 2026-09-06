/**
 * PlansController — `/plans` (master plan §10). Platform-owned catalog,
 * reused by every legitimate SaaS-level caller (a real Organization Owner
 * deciding whether to upgrade, or a brand-new signup completing
 * self-service Owner onboarding, per Decision 5) — but NOT by an
 * Academy-level caller (Manager, Instructor, Student), even though the
 * catalog itself carries no organization/academy id to scope by.
 *
 * Foundational-audit fix (ATLAS_FOUNDATIONAL_AUTH_TENANCY_AUDIT.md, Fix
 * A) — this previously ran under `JwtAuthGuard` alone, which the audit's
 * own §5/§12 empirically confirmed let a Student account read the full
 * catalog. `SaasLevelCallerGuard` closes exactly that gap and no other —
 * see its own doc comment for the full mechanism.
 */
import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { SaasLevelCallerGuard } from '../../tenancy/guards/saas-level-caller.guard';
import { PlansService } from '../services/plans.service';
import type { PlanResponse } from '../dto/plan.contract';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('plans')
@UseGuards(JwtAuthGuard, SaasLevelCallerGuard)
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  /** Phase 4.5.3 (Change 4) — paginated; see `PlansService.getPlans`'s own doc comment. */
  @Get()
  async list(@Query() query: CollectionQueryDto): Promise<PaginatedResult<PlanResponse>> {
    return this.plansService.getPlans(query);
  }

  @Get(':key')
  async getByKey(@Param('key') key: string): Promise<PlanResponse> {
    return this.plansService.getPlanByKey(key);
  }
}
