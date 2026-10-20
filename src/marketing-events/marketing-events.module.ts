/**
 * MarketingEventsModule — B1 F.5, the Atlas marketing website's cookieless
 * beacon (`POST /mkt/events`) and its 25-month retention prune.
 *
 * A leaf module: nothing imports it. `PrismaService` comes from the
 * `@Global()` database module. Owns its own retention queue, ONE
 * processor and one repeatable job, like `PlatformContactModule`.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MarketingEventsController } from './marketing-events.controller';
import { MarketingEventsRepository } from './marketing-events.repository';
import { MarketingEventsService } from './marketing-events.service';
import { MarketingEventsRetentionProcessor } from './queue/marketing-events-retention.processor';
import { MarketingEventsRetentionScheduler } from './queue/marketing-events-retention.scheduler';
import { MKT_RETENTION_QUEUE } from './marketing-events.vocabulary';

@Module({
  imports: [BullModule.registerQueue({ name: MKT_RETENTION_QUEUE })],
  controllers: [MarketingEventsController],
  providers: [
    MarketingEventsRepository,
    MarketingEventsService,
    MarketingEventsRetentionProcessor,
    MarketingEventsRetentionScheduler,
  ],
  // Exported so the e2e suite can read aggregates and drive a prune directly.
  exports: [MarketingEventsService],
})
export class MarketingEventsModule {}
