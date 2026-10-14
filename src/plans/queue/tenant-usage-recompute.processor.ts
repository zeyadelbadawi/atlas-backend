/** TenantUsageRecomputeProcessor — the `Worker` half. Thin: delegates all real logic to `TenantUsageRecomputeService`, mirroring `PasswordResetEmailProcessor` delegating to a provider. Idempotent — see that service's doc comment. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { TenantUsageRecomputeService } from '../services/tenant-usage-recompute.service';
import { UsageLimitWarningService } from '../services/usage-limit-warning.service';
import {
  RecomputeOneJobPayload,
  TENANT_USAGE_RECOMPUTE_CONCURRENCY,
  TENANT_USAGE_RECOMPUTE_QUEUE,
} from './tenant-usage-recompute.types';

@Processor(TENANT_USAGE_RECOMPUTE_QUEUE, {
  concurrency: TENANT_USAGE_RECOMPUTE_CONCURRENCY,
})
export class TenantUsageRecomputeProcessor extends WorkerHost {
  private readonly logger = new Logger(TenantUsageRecomputeProcessor.name);

  constructor(
    private readonly recomputeService: TenantUsageRecomputeService,
    // B0-BIL-13 — warn the owner about a limit the fresh numbers cross.
    private readonly usageLimitWarningService: UsageLimitWarningService,
  ) {
    super();
  }

  async process(job: Job<RecomputeOneJobPayload>): Promise<void> {
    this.logger.log(
      { jobId: job.id, organizationId: job.data.organizationId },
      'Processing tenant-usage-recompute job',
    );
    await this.recomputeService.recomputeOne(job.data.organizationId);
    // Best-effort; never fails the recompute job.
    await this.usageLimitWarningService.checkAndNotify(job.data.organizationId);
  }
}
