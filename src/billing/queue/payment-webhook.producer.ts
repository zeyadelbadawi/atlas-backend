/**
 * PaymentWebhookProducer — the `Service → Domain Event → BullMQ Queue`
 * half, mirroring `TenantUsageRecomputeProducer`'s pattern exactly.
 * `jobId` gives BullMQ-level dedup for free, layered on top of (never
 * instead of) the real DB-level `(provider, event_id)` unique constraint
 * `PaymentWebhookEventsRepository.tryInsert` enforces — the DB constraint
 * is the actual idempotency authority (§18 scenario 8); the BullMQ dedup
 * is a cheap first line of defense against re-enqueuing the identical
 * event before the worker even runs.
 *
 * The separator is `__` (double underscore), not `:` — a real bug found
 * during manual smoke testing: BullMQ's custom-id validation rejects any
 * `jobId` containing `:` (`Job.validateOptions`, since it reserves `:` for
 * its own internal Redis key namespacing), which made every webhook
 * delivery 500 instead of enqueuing. Confirmed fixed by re-running the
 * exact same signed-event smoke test that first surfaced it (delivered
 * twice; second delivery correctly no-ops).
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PAYMENT_WEBHOOK_QUEUE,
  PROCESS_WEBHOOK_EVENT_JOB,
  ProcessWebhookEventJobPayload,
} from './payment-webhook.types';

@Injectable()
export class PaymentWebhookProducer {
  constructor(
    @InjectQueue(PAYMENT_WEBHOOK_QUEUE)
    private readonly queue: Queue<ProcessWebhookEventJobPayload>,
  ) {}

  async enqueue(payload: ProcessWebhookEventJobPayload): Promise<void> {
    await this.queue.add(PROCESS_WEBHOOK_EVENT_JOB, payload, {
      jobId: `${payload.provider}__${payload.eventId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
