import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { AuthCoreModule } from '../../identity/auth-core.module';
import { IdentityModule } from '../../identity/identity.module';
import { TenancyModule } from '../../tenancy/tenancy.module';
import { MediaModule } from '../../media/media.module';
import { ObservabilityController } from './observability.controller';
import { ObservabilityService } from './observability.service';
import { MonitoringSourcesClient } from './monitoring-sources.client';
import { SystemProbesService } from './system-probes.service';
import { HttpMetricsMiddleware } from './http-metrics.middleware';

/**
 * Platform Owner Observability Center. Imports its dependencies directly —
 * Nest resolves providers per module graph at BOOT, and a missing export
 * fails the whole API (see `deletion-module-graph.spec.ts`).
 */
@Module({
  imports: [AuthCoreModule, IdentityModule, TenancyModule, MediaModule],
  controllers: [ObservabilityController],
  providers: [ObservabilityService, MonitoringSourcesClient, SystemProbesService],
})
export class ObservabilityModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(HttpMetricsMiddleware).forRoutes('*');
  }
}
