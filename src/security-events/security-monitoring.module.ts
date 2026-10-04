/**
 * SecurityMonitoringModule — W3: the Platform Owner's read side of
 * `security_events` plus the daily security-maintenance (retention) sweep.
 *
 * The writer (`SecurityEventsService`) is provided globally by
 * `SecurityEventsModule`; this module only reads and prunes. It owns the
 * `security-maintenance` queue and its single processor
 * (`one-worker-per-queue.spec.ts`).
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AuthCoreModule } from '../identity/auth-core.module';
import { IdentityModule } from '../identity/identity.module';
import { TenancyModule } from '../tenancy/tenancy.module';
import { PlatformSecurityMonitoringController } from './controllers/platform-security-monitoring.controller';
import { SecurityMonitoringQueryService } from './services/security-monitoring-query.service';
import { SecurityMaintenanceService } from './services/security-maintenance.service';
import { SecurityMaintenanceProcessor } from './queue/security-maintenance.processor';
import { SecurityMaintenanceScheduler } from './queue/security-maintenance.scheduler';
import { SECURITY_MAINTENANCE_QUEUE } from './queue/security-maintenance.types';

@Module({
  imports: [
    AuthCoreModule,
    IdentityModule,
    TenancyModule,
    BullModule.registerQueue({ name: SECURITY_MAINTENANCE_QUEUE }),
  ],
  controllers: [PlatformSecurityMonitoringController],
  providers: [
    SecurityMonitoringQueryService,
    SecurityMaintenanceService,
    SecurityMaintenanceProcessor,
    SecurityMaintenanceScheduler,
  ],
  exports: [SecurityMaintenanceService],
})
export class SecurityMonitoringModule {}
