/** AddOnsController — `/add-ons` (master plan §10). See `PlansController`'s doc comment for the same "platform catalog, no tenant scoping" reasoning. */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlansService } from '../services/plans.service';
import type { AddOnResponse } from '../dto/add-on.contract';

@Controller('add-ons')
@UseGuards(JwtAuthGuard)
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
