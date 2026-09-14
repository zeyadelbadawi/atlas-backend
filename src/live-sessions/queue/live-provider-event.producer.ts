/**
 * Enqueues a verified provider event for processing.
 *
 * `jobId` gives BullMQ-level dedup for free, layered on top of (never
 * instead of) the real `provider_event_id` unique constraint — the
 * database is the idempotency authority; this is a cheap first line of
 * defence against re-enqueuing before the worker even runs.
 *
 * The separator is `__`, not `:`: BullMQ rejects any custom `jobId`
 * containing `:` because it reserves that for Redis key namespacing. The
 * payment webhook producer hit exactly this and documented it; repeating
 * the mistake here would have made every delivery 500.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  LIVE_PROVIDER_EVENT_QUEUE,
  PROCESS_LIVE_PROVIDER_EVENT_JOB,
  ProcessLiveProviderEventJobPayload,
} from './live-provider-event.types';

@Injectable()
export class LiveProviderEventProducer {
  constructor(
    @InjectQueue(LIVE_PROVIDER_EVENT_QUEUE)
    private readonly queue: Queue<ProcessLiveProviderEventJobPayload>,
  ) {}

  async enqueue(payload: ProcessLiveProviderEventJobPayload): Promise<void> {
    await this.queue.add(PROCESS_LIVE_PROVIDER_EVENT_JOB, payload, {
      jobId: `zoom__${payload.providerEventId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
