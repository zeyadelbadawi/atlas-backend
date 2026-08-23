/**
 * PasswordResetEmailProcessor — the `Worker` half. Idempotent: re-sending
 * the same "an email would go out" side effect on retry has no harmful
 * duplicate-application risk (unlike, say, applying a payment twice) — the
 * stub provider's own idempotency posture (overwrite the last-seen token
 * for that address) makes redelivery safe by construction.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { EMAIL_PROVIDER, EmailProvider } from '../services/email-provider.interface';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  PasswordResetEmailJobPayload,
} from './password-reset-email.types';

@Processor(PASSWORD_RESET_EMAIL_QUEUE)
export class PasswordResetEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(PasswordResetEmailProcessor.name);

  constructor(@Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider) {
    super();
  }

  async process(job: Job<PasswordResetEmailJobPayload>): Promise<void> {
    // Deliberately does not log `job.data` — it carries `rawToken`.
    this.logger.log({ jobId: job.id }, 'Processing password-reset email job');
    await this.emailProvider.sendPasswordResetEmail(job.data.email, job.data.rawToken);
  }
}
