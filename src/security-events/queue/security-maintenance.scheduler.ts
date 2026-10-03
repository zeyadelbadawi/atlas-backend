/**
 * Registers the W3 security-maintenance sweep as ONE BullMQ repeatable job,
 * following `Phase2MaintenanceScheduler` exactly: a fixed `jobId` with
 * identical `repeat` options is idempotent across boots and instances.
 */
import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  SECURITY_MAINTENANCE_INTERVAL_MS,
  SECURITY_MAINTENANCE_JOB,
  SECURITY_MAINTENANCE_QUEUE,
  SECURITY_MAINTENANCE_REPEAT_JOB_ID,
  SecurityMaintenanceJobPayload,
} from './security-maintenance.types';

@Injectable()
export class SecurityMaintenanceScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(SecurityMaintenanceScheduler.name);

  constructor(
    @InjectQueue(SECURITY_MAINTENANCE_QUEUE)
    private readonly queue: Queue<SecurityMaintenanceJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.add(
      SECURITY_MAINTENANCE_JOB,
      {},
      {
        repeat: { every: SECURITY_MAINTENANCE_INTERVAL_MS },
        jobId: SECURITY_MAINTENANCE_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
      },
    );
    this.logger.log(
      { intervalMs: SECURITY_MAINTENANCE_INTERVAL_MS },
      'Registered recurring security retention job (OTP/deletion challenges, security events).',
    );
  }
}
