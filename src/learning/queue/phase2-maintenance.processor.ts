/** The `Worker` half of the P64 Phase 2 maintenance sweep. Thin by design — all real logic lives in `Phase2MaintenanceService`, matching every other processor here. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Phase2MaintenanceService } from '../services/phase2-maintenance.service';
import {
  PHASE2_MAINTENANCE_QUEUE,
  Phase2MaintenanceJobPayload,
} from './phase2-maintenance.types';

@Processor(PHASE2_MAINTENANCE_QUEUE)
export class Phase2MaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(Phase2MaintenanceProcessor.name);

  constructor(private readonly maintenanceService: Phase2MaintenanceService) {
    super();
  }

  async process(job: Job<Phase2MaintenanceJobPayload>): Promise<void> {
    const result = await this.maintenanceService.run();
    this.logger.log(
      { jobId: job.id, ...result },
      'P64 Phase 2 maintenance sweep complete',
    );
  }
}
