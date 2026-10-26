/**
 * LaunchChecklistModule — B3: the Platform Owner's launch checklist. A
 * leaf module.
 */
import { Module } from '@nestjs/common';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformLaunchChecklistController } from './controllers/platform-launch-checklist.controller';
import { LaunchChecklistService } from './services/launch-checklist.service';

@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule],
  controllers: [PlatformLaunchChecklistController],
  providers: [LaunchChecklistService],
})
export class LaunchChecklistModule {}
