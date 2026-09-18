import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS,
  DOMAIN_VERIFICATION_SWEEP_JOB,
  DOMAIN_VERIFICATION_SWEEP_QUEUE,
  DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID,
  DomainVerificationSweepJobPayload,
} from './domain-verification-sweep.types';

/** Registers the one repeatable job on boot — idempotent by `jobId`, exactly like `SubscriptionSweepScheduler`. */
@Injectable()
export class DomainVerificationSweepScheduler implements OnApplicationBootstrap {
  private readonly logger = new Logger(DomainVerificationSweepScheduler.name);

  constructor(
    @InjectQueue(DOMAIN_VERIFICATION_SWEEP_QUEUE)
    private readonly queue: Queue<DomainVerificationSweepJobPayload>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    // P63g — BullMQ keys a repeatable by name + jobId + interval, so a
    // changed interval would leave the OLD schedule firing forever beside
    // the new one. Drop every repeatable of this job that is not the one
    // we are about to (re-)register.
    try {
      const existing = await this.queue.getRepeatableJobs();
      for (const job of existing) {
        if (job.name !== DOMAIN_VERIFICATION_SWEEP_JOB) continue;
        if (
          job.id === DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID &&
          job.every === String(DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS)
        )
          continue;
        await this.queue.removeRepeatableByKey(job.key);
        this.logger.warn(
          { key: job.key },
          'Removed a stale domain-verification-sweep repeatable.',
        );
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Could not inspect existing repeatables; registering anyway.',
      );
    }
    await this.queue.add(
      DOMAIN_VERIFICATION_SWEEP_JOB,
      {},
      {
        repeat: { every: DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS },
        jobId: DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID,
        removeOnComplete: true,
        removeOnFail: { count: 1000 },
        // P63g — a tick that throws before its per-row try/catch (pool
        // timeout, Redis hiccup) is retried once with a short backoff
        // instead of being lost until the next interval.
        attempts: 2,
        backoff: { type: 'fixed', delay: 30_000 },
      },
    );
    this.logger.log(
      { intervalMs: DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS },
      'Registered recurring domain-verification-sweep job.',
    );
  }
}
