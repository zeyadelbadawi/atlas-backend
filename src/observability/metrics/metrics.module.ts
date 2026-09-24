/**
 * `MetricsModule` — P64 Phase 2 §U.
 *
 * `@Global` because the counters are incremented from four different
 * modules (learning, media, plans, identity) and threading an import
 * through each of them would add a dependency edge between modules that
 * otherwise have nothing to do with one another. The service holds a
 * process-wide registry and no tenant state, which is exactly the shape a
 * global provider should have.
 */
import { Global, Module } from '@nestjs/common';
import { AuthCoreModule } from '../../identity/auth-core.module';
import { IdentityModule } from '../../identity/identity.module';
import { LearningMetricsService } from './learning-metrics.service';
import { CommunicationMetricsService } from '../../communications/services/communication-metrics.service';
import { MetricsController } from './metrics.controller';

@Global()
@Module({
  imports: [AuthCoreModule, IdentityModule],
  controllers: [MetricsController],
  // P64 Communications — same registry, same global reach.
  providers: [LearningMetricsService, CommunicationMetricsService],
  exports: [LearningMetricsService, CommunicationMetricsService],
})
export class MetricsModule {}
