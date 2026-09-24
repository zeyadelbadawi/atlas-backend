/**
 * CommunicationsWebhookProducer — one job per parsed delivery event.
 * `jobId` = SHA-256 of `(provider, providerMessageId, event)` (BullMQ
 * refuses `:` in ids and provider message ids are free-form, hence the
 * hash) — cheap dedup before the worker's own idempotency check.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { createHash } from 'node:crypto';
import {
  COMMUNICATIONS_QUEUE,
  COMMUNICATIONS_WEBHOOK_JOB,
  type CommunicationsWebhookJobPayload,
} from './communications-queue.types';

export function webhookJobId(payload: CommunicationsWebhookJobPayload): string {
  return createHash('sha256')
    .update(`${payload.provider}\n${payload.providerMessageId}\n${payload.event}`)
    .digest('hex');
}

@Injectable()
export class CommunicationsWebhookProducer {
  constructor(
    @InjectQueue(COMMUNICATIONS_QUEUE)
    private readonly queue: Queue<CommunicationsWebhookJobPayload>,
  ) {}

  async enqueue(payload: CommunicationsWebhookJobPayload): Promise<string> {
    const jobId = webhookJobId(payload);
    await this.queue.add(COMMUNICATIONS_WEBHOOK_JOB, payload, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
    return jobId;
  }
}
