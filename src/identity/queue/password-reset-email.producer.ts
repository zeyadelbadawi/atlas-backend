/**
 * PasswordResetEmailProducer — the `Service → Domain Event → BullMQ Queue`
 * half of master plan §11/§12 for password-reset delivery. Since ATO F9 the
 * job carries only the typed address and host academy (the worker mints the
 * token); it is still never logged, as it names an address.
 */
import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  PasswordResetEmailJobPayload,
  PasswordResetRequestJobPayload,
} from './password-reset-email.types';

@Injectable()
export class PasswordResetEmailProducer {
  constructor(
    @InjectQueue(PASSWORD_RESET_EMAIL_QUEUE)
    private readonly queue: Queue<PasswordResetEmailJobPayload>,
  ) {}

  async enqueue(payload: PasswordResetRequestJobPayload): Promise<void> {
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
      // ATO review F12 — a failed job (it names an address) is kept long
      // enough to investigate, then removed, never held in Redis forever.
      removeOnFail: { age: 24 * 60 * 60 },
    });
  }
}
