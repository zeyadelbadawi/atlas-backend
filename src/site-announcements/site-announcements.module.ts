/**
 * SiteAnnouncementsModule — B3: marketing banners and pop-ups, and the
 * dashboard banner (Platform Owner management, public reads and beacon,
 * the signed-in dashboard read). A leaf module.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformSiteAnnouncementsController } from './controllers/platform-site-announcements.controller';
import { PublicSiteAnnouncementsController } from './controllers/public-site-announcements.controller';
import { DashboardSiteAnnouncementsController } from './controllers/dashboard-site-announcements.controller';
import { SiteAnnouncementsService } from './services/site-announcements.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [
    PlatformSiteAnnouncementsController,
    PublicSiteAnnouncementsController,
    DashboardSiteAnnouncementsController,
  ],
  providers: [SiteAnnouncementsService],
})
export class SiteAnnouncementsModule {}
