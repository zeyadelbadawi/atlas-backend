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
import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PROCESS_PROVISIONING_JOB,
  PROVISIONING_QUEUE,
  ProcessProvisioningJobPayload,
} from './provisioning.types';

/** The one job id per request — see this file's doc comment. */
export function provisioningJobId(provisioningRequestId: string): string {
  return `provisioning-request__${provisioningRequestId}`;
}

@Injectable()
export class ProvisioningProducer {
  private readonly logger = new Logger(ProvisioningProducer.name);

  constructor(
    @InjectQueue(PROVISIONING_QUEUE)
    private readonly queue: Queue<ProcessProvisioningJobPayload>,
  ) {}

  /**
   * Enqueues the request's job — or, when a job with its id is already
   * waiting/active/delayed, leaves that one alone (it will run the request
   * from wherever it stands; the orchestrator is resumable per step).
   *
   * W2 — A FINISHED JOB MUST NOT SWALLOW A RETRY. BullMQ ignores `add` for
   * an id it still holds, and `removeOnFail: false` keeps a job that
   * exhausted its `attempts` (an infrastructure failure outside
   * `executeStep`) under that id forever — so "Retry" after such a failure
   * was a silent no-op and the request stayed `running` with nothing
   * driving it. A held job in a terminal state (`failed`, or `completed`
   * if `removeOnComplete` was ever bypassed) is removed first, then the job
   * is added again. Two retries racing here are harmless: removing an
   * already-removed job is a no-op, and the second `add` collapses into
   * the first's job id.
   */
  async enqueue(payload: ProcessProvisioningJobPayload): Promise<void> {
    const jobId = provisioningJobId(payload.provisioningRequestId);
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        try {
          await existing.remove();
        } catch (error) {
          // Locked by a worker that picked it up in the meantime (or gone
          // already): either way a job for this request exists or will be
          // re-added below — never fail the caller's retry over it.
          this.logger.warn(
            {
              jobId,
              state,
              error: error instanceof Error ? error.message : String(error),
            },
            'Could not remove a finished provisioning job before re-adding it',
          );
        }
      } else if (state !== 'unknown') {
        // waiting / active / delayed / prioritized / waiting-children:
        // already queued — nothing to add.
        return;
      }
    }

    await this.queue.add(PROCESS_PROVISIONING_JOB, payload, {
      jobId,
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
