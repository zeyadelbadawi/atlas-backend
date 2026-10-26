/**
 * GrowthModule — G1: the Platform Owner's season capacity plan and CAC per
 * channel (`platform-growth/*`). A leaf module, like `LaunchChecklistModule`.
 * The PO organization detail reads the same acquisition block through the
 * plain `readOrganizationAcquisition` function (no module dependency).
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformGrowthController } from './controllers/platform-growth.controller';
import { GrowthSettingsService } from './services/growth-settings.service';
import { MarketingSpendService } from './services/marketing-spend.service';
import { GrowthReportsService } from './services/growth-reports.service';
import { OrganizationAcquisitionService } from './services/organization-acquisition.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PlatformGrowthController],
  providers: [
    GrowthSettingsService,
    MarketingSpendService,
    GrowthReportsService,
    OrganizationAcquisitionService,
  ],
})
export class GrowthModule {}
