/**
 * PlatformSettingsController — `platform-settings` (master plan §21
 * Phase P15), matching `PlatformSettingsService` (atlas frontend)'s
 * singleton resource exactly.
 */
import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformSettingsService } from '../services/platform-settings.service';
import { UpdatePlatformSettingsDto } from '../dto/update-platform-settings.dto';
import type { PlatformConfigurationResponse } from '../dto/platform-settings.contract';

@Controller('platform-settings')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformSettingsController {
  constructor(private readonly platformSettingsService: PlatformSettingsService) {}

  @Get()
  async getConfiguration(): Promise<PlatformConfigurationResponse> {
    return this.platformSettingsService.getConfiguration();
  }

  @Patch()
  async updateConfiguration(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: UpdatePlatformSettingsDto,
  ): Promise<PlatformConfigurationResponse> {
    return this.platformSettingsService.updateConfiguration(auth.userId, payload);
  }
}
