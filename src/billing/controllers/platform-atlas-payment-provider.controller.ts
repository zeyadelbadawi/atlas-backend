/**
 * PlatformAtlasPaymentProviderController — `/platform-atlas-payment-provider`
 * (Atlas Subscription Payment — Generic Payment Gateway Integration
 * Readiness, 2026-08-26). Flat, `PlatformOwnerGuard`-gated — mirrors
 * `PlatformCommissionController`/`PlatformDomainController`'s identical
 * shape. The ONLY place in this codebase that can write
 * `atlas_subscription_payment_provider_config` — no Organization-facing
 * route anywhere reaches it, and it is a structurally different table from
 * `organization_gateway_credentials` (§5.8), never reused across that
 * ownership boundary.
 */
import { Body, Controller, Get, Patch, Post, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { AtlasSubscriptionPaymentProviderService } from '../services/atlas-subscription-payment-provider.service';
import { SaveAtlasSubscriptionPaymentProviderConfigDto } from '../dto/save-atlas-subscription-payment-provider-config.dto';
import type {
  AtlasSubscriptionPaymentProviderConfigResponse,
  AvailableAtlasSubscriptionPaymentProviderResponse,
} from '../dto/atlas-subscription-payment-provider.contract';

@Controller('platform-atlas-payment-provider')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformAtlasPaymentProviderController {
  constructor(
    private readonly atlasSubscriptionPaymentProviderService: AtlasSubscriptionPaymentProviderService,
  ) {}

  @Get('available-providers')
  listAvailableProviders(): readonly AvailableAtlasSubscriptionPaymentProviderResponse[] {
    return this.atlasSubscriptionPaymentProviderService.listAvailableProviders();
  }

  @Get()
  async get(): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    return this.atlasSubscriptionPaymentProviderService.getConfig();
  }

  @Patch()
  async save(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: SaveAtlasSubscriptionPaymentProviderConfigDto,
  ): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    return this.atlasSubscriptionPaymentProviderService.saveConfig(auth.userId, payload);
  }

  @Post('test-connection')
  async testConnection(): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    return this.atlasSubscriptionPaymentProviderService.testConnection();
  }

  @Post('enable')
  async enable(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    return this.atlasSubscriptionPaymentProviderService.setEnabled(auth.userId, true);
  }

  @Post('disable')
  async disable(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    return this.atlasSubscriptionPaymentProviderService.setEnabled(auth.userId, false);
  }
}
