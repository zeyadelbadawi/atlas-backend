/**
 * PlatformDomainController — `platform-domain` (P11; extended P63).
 *
 * `GET /platform-domain` stays readable by any authenticated user: a
 * customer's own domain tab needs the base domain to explain their Atlas
 * address. Nothing in it is secret (it is the public hostname every
 * academy site is served on). `GET /platform-domain/readiness` is the
 * operator's infrastructure truth and is Platform Owner-only, as is the
 * legacy `PATCH` (which the service refuses when the deployment owns the
 * value).
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { PlatformDomainService } from '../services/platform-domain.service';
import { UpdatePlatformDomainConfigurationDto } from '../dto/update-platform-domain-configuration.dto';
import type {
  PlatformDomainConfigurationResponse,
  PlatformDomainReadinessResponse,
} from '../dto/domain.contract';

@Controller('platform-domain')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard)
export class PlatformDomainController {
  constructor(private readonly platformDomainService: PlatformDomainService) {}

  @Get()
  async get(): Promise<PlatformDomainConfigurationResponse> {
    return this.platformDomainService.getPlatformDomainConfiguration();
  }

  @Get('readiness')
  @UseGuards(PlatformOwnerGuard)
  async getReadiness(): Promise<PlatformDomainReadinessResponse> {
    return this.platformDomainService.getReadiness();
  }

  @Patch()
  @UseGuards(PlatformOwnerGuard)
  async update(
    @Body() body: UpdatePlatformDomainConfigurationDto,
  ): Promise<PlatformDomainConfigurationResponse> {
    return this.platformDomainService.updatePlatformDomainConfiguration(body.baseDomain);
  }
}
