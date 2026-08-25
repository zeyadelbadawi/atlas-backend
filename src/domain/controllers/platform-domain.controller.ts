/**
 * PlatformDomainController — `/platform-domain` (master plan §21 Phase
 * P11). Mirrors `TrialPolicyController` exactly: `GET` readable by any
 * authenticated caller, `PATCH` additionally gated by `PlatformOwnerGuard`
 * (reused verbatim, unmodified — its very first real route attachment;
 * P15 will be the next) — matching the real frontend's own
 * `PlatformDomainSettingsPage` (`requiredRoles: ['platform_owner']`).
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { PlatformDomainService } from '../services/platform-domain.service';
import { UpdatePlatformDomainConfigurationDto } from '../dto/update-platform-domain-configuration.dto';
import type { PlatformDomainConfigurationResponse } from '../dto/domain.contract';

@Controller('platform-domain')
@UseGuards(JwtAuthGuard)
export class PlatformDomainController {
  constructor(private readonly platformDomainService: PlatformDomainService) {}

  @Get()
  async get(): Promise<PlatformDomainConfigurationResponse> {
    return this.platformDomainService.getPlatformDomainConfiguration();
  }

  @Patch()
  @UseGuards(PlatformOwnerGuard)
  async update(
    @Body() body: UpdatePlatformDomainConfigurationDto,
  ): Promise<PlatformDomainConfigurationResponse> {
    return this.platformDomainService.updatePlatformDomainConfiguration(body.baseDomain);
  }
}
