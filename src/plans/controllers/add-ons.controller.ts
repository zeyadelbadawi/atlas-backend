/**
 * AddOnsController — `/add-ons` (master plan §10). See `PlansController`'s
 * doc comment for the same "platform catalog, no tenant scoping, but
 * SaaS-level-callers only" reasoning — foundational-audit fix
 * (ATLAS_FOUNDATIONAL_AUTH_TENANCY_AUDIT.md, Fix A), one of the three
 * endpoints the roadmap names explicitly.
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { SaasLevelCallerGuard } from '../../tenancy/guards/saas-level-caller.guard';
import { PlansService } from '../services/plans.service';
import type { AddOnResponse } from '../dto/add-on.contract';

@Controller('add-ons')
@UseGuards(JwtAuthGuard, SaasLevelCallerGuard)
export class AddOnsController {
  constructor(private readonly plansService: PlansService) {}

  @Get()
  async list(): Promise<AddOnResponse[]> {
    return this.plansService.getAddOns();
  }

  @Get(':key')
  async getByKey(@Param('key') key: string): Promise<AddOnResponse> {
    return this.plansService.getAddOnByKey(key);
  }
}
