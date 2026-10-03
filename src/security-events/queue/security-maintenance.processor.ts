/** The `Worker` half of the W3 security-maintenance sweep — thin; the work lives in `SecurityMaintenanceService`. */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { SecurityMaintenanceService } from '../services/security-maintenance.service';
import {
  SECURITY_MAINTENANCE_QUEUE,
  SecurityMaintenanceJobPayload,
} from './security-maintenance.types';

@Processor(SECURITY_MAINTENANCE_QUEUE)
export class SecurityMaintenanceProcessor extends WorkerHost {
  private readonly logger = new Logger(SecurityMaintenanceProcessor.name);

  constructor(private readonly maintenance: SecurityMaintenanceService) {
    super();
  }

  async process(job: Job<SecurityMaintenanceJobPayload>): Promise<void> {
    const result = await this.maintenance.run();
    this.logger.log({ jobId: job.id, ...result }, 'Security retention sweep complete');
  }
}
