/**
 * ProvisioningProducer — the `Service → Domain Event → BullMQ Queue` half,
 * mirroring `PaymentWebhookProducer`'s pattern exactly (`__` jobId
 * separator — BullMQ rejects `:` in custom ids, see that class's own doc
 * comment for the confirmed bug this avoids).
 *
 * `jobId` is the provisioning request's own id — enqueuing the SAME
 * request twice (a customer clicking "retry" twice, or a redelivered
 * creation call) collapses to one queued job at the BullMQ level; the real
 * idempotency authority underneath is still `ProvisioningOrchestratorService`
 * itself (every step it runs is independently safe to re-run — see its own
 * doc comment), so this is a cheap first line of defense, never the only
 * one.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_PROVISIONING_JOB,
  PROVISIONING_QUEUE,
  ProcessProvisioningJobPayload,
} from './provisioning.types';

@Injectable()
export class ProvisioningProducer {
  constructor(
    @InjectQueue(PROVISIONING_QUEUE)
    private readonly queue: Queue<ProcessProvisioningJobPayload>,
  ) {}

  async enqueue(payload: ProcessProvisioningJobPayload): Promise<void> {
    await this.queue.add(PROCESS_PROVISIONING_JOB, payload, {
      jobId: `provisioning-request__${payload.provisioningRequestId}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
