/**
 * TrialPolicyController — `/trial-policy` (master plan §10). `GET` is
 * readable by any authenticated caller (mirrors `PlanService.getTrialPolicy`
 * — no role restriction on the frontend read side). `PATCH` is the ONE
 * legitimate write in P4, gated by `PlatformOwnerGuard` (reused verbatim
 * from P1/P2 — re-verifies `users.is_platform_owner` from the database on
 * every call, never trusts a client-supplied role claim), matching the
 * frontend's own `RouteGuard requiredRoles={['platform_owner']}` on
 * `PlatformTrialPolicyPage`.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { PlansService } from '../services/plans.service';
import { UpdateTrialPolicyDto } from '../dto/trial-policy.contract';
import type { TrialPolicyResponse } from '../dto/trial-policy.contract';

@Controller('trial-policy')
@UseGuards(JwtAuthGuard)
export class TrialPolicyController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  async get(): Promise<TrialPolicyResponse> {
    return this.plansService.getTrialPolicy();
  }

  @Patch()
  @UseGuards(PlatformOwnerGuard)
  async update(@Body() body: UpdateTrialPolicyDto): Promise<TrialPolicyResponse> {
    return this.plansService.updateTrialPolicy(body.enabled, body.durationDays);
  }
}
