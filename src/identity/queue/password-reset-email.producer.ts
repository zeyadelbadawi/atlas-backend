/**
 * PasswordResetEmailProducer — the `Service → Domain Event → BullMQ Queue`
 * half of master plan §11/§12 for password-reset delivery. Never logs the
 * job payload (it contains `rawToken`) — BullMQ persists it in Redis only,
 * which is expected (that's the queue doing its job), not a log leak.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  PasswordResetEmailJobPayload,
} from './password-reset-email.types';

@Injectable()
export class PasswordResetEmailProducer {
  constructor(
    @InjectQueue(PASSWORD_RESET_EMAIL_QUEUE)
    private readonly queue: Queue<PasswordResetEmailJobPayload>,
  ) {}

  async enqueue(payload: PasswordResetEmailJobPayload): Promise<void> {
    await this.queue.add('send', payload, {
      // Backoff retry, dead-letter-equivalent after N attempts (master plan
      // §12's "Transactional email" row). BullMQ has no built-in
      // dead-letter queue at this version; `attempts` exhausting simply
      // leaves the job in the `failed` set, which is what would be wired
      // to an alert in a later phase's observability work (§19) — not
      // reinvented here.
      attempts: 5,
      backoff: { type: 'exponential', delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    });
  }
}
