/**
 * PlansController — `/plans` (master plan §10). Platform-owned catalog:
 * every authenticated caller reads the same list, no organization/academy
 * scoping — only `JwtAuthGuard` applies, matching `PlansRepository`'s "no
 * RLS, no tenant context" design.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlansService } from '../services/plans.service';
import type { PlanResponse } from '../dto/plan.contract';

@Controller('plans')
@UseGuards(JwtAuthGuard)
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  async list(): Promise<PlanResponse[]> {
    return this.plansService.getPlans();
  }

  @Get(':key')
  async getByKey(@Param('key') key: string): Promise<PlanResponse> {
    return this.plansService.getPlanByKey(key);
  }
}
