/**
 * FoundingModule — B2 Founding Academies: the Platform Owner management API.
 *
 * The price lock itself has no module: checkout and the plan-change notice
 * call the pure `founding-lock.ts` helpers with their own transaction, and
 * the sweep step (`FoundingNoticeService`) is provided by `PlansModule`
 * beside the sweep it rides on, so no module cycle is introduced.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { CommunicationsProvidersModule } from '../communications/communications-providers.module';
import { PlatformFoundingAcademiesController } from './controllers/platform-founding-academies.controller';
import { FoundingMembershipsService } from './services/founding-memberships.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, CommunicationsProvidersModule],
  controllers: [PlatformFoundingAcademiesController],
  providers: [FoundingMembershipsService],
})
export class FoundingModule {}
