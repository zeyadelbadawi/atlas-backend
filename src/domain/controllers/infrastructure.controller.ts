/**
 * InfrastructureController — `/infrastructure/:provider/status` (master
 * plan §21 Phase P11). Any authenticated caller may read this — it
 * carries only a boolean `connected` flag, never a credential, matching
 * `InfrastructureProviderStatus`'s own doc comment ("never assumed true
 * by the frontend... only reads a safe, public status flag").
 */
import { Controller, Get, Param, UseGuards } from '@nestjs/common';
import { BadRequestException } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { InfrastructureService } from '../services/infrastructure.service';
import { INFRASTRUCTURE_PROVIDER_NAMES } from '../constants/domain.constants';
import type { InfrastructureProviderStatusResponse } from '../dto/domain.contract';
import type { InfrastructureProviderName } from '@prisma/client';

@Controller('infrastructure')
@UseGuards(JwtAuthGuard)
export class InfrastructureController {
  constructor(private readonly infrastructureService: InfrastructureService) {}

  @Get(':provider/status')
  async getProviderStatus(
    @Param('provider') provider: string,
  ): Promise<InfrastructureProviderStatusResponse> {
    if (!INFRASTRUCTURE_PROVIDER_NAMES.includes(provider as InfrastructureProviderName)) {
      throw new BadRequestException({ messageKey: 'errors.domain.unknownProvider' });
    }
    return this.infrastructureService.getProviderStatus(
      provider as InfrastructureProviderName,
    );
  }
}
