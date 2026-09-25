/**
 * PasswordResetEmailProcessor — the `Worker` half of the reset email.
 *
 * WHAT CHANGED AND WHY. This used to call the legacy
 * `EmailProvider.sendPasswordResetEmail`, which pasted the raw reset
 * token into the message body as a line of text:
 *
 *     Reset token: 9f2c1e...
 *
 * A recipient has nothing to do with that. It is an internal credential,
 * not an instruction, and a security email that hands someone an opaque
 * string with no action is both a dead end and exactly the shape a
 * phishing lookalike imitates. The email was also English-only and plain
 * text, while the product ships EN and AR.
 *
 * It now emits the catalogue event, which already existed and was never
 * wired up: `auth.password.reset` renders the real bilingual template
 * with a "Reset password" button whose href is built by
 * `LinkBuilderService` from the catalogue's `actionUrl`. The token still
 * travels — inside the link, where it belongs — and is never displayed.
 *
 * INTERNAL TOKEN != USER-FACING TOKEN. The value is unchanged; only its
 * presentation is. `job.data` is still never logged.
 *
 * The queue hop is unchanged, so this is no more asynchronous than
 * before: the outbox row is written here and the dispatcher sends it,
 * with the one-minute sweep as the backstop if the enqueue hint is lost.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CommunicationService } from '../../communications/services/communication.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import {
  PASSWORD_RESET_EMAIL_QUEUE,
  PasswordResetEmailJobPayload,
} from './password-reset-email.types';

@Processor(PASSWORD_RESET_EMAIL_QUEUE)
export class PasswordResetEmailProcessor extends WorkerHost {
  private readonly logger = new Logger(PasswordResetEmailProcessor.name);

  constructor(
    private readonly communicationService: CommunicationService,
    private readonly tenancyContextService: TenancyContextService,
  ) {
    super();
  }

  async process(job: Job<PasswordResetEmailJobPayload>): Promise<void> {
    // Deliberately does not log `job.data` — it carries `rawToken`.
    this.logger.log({ jobId: job.id }, 'Processing password-reset email job');

    const { userId, rawToken } = job.data;
    const outboxId = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const emitted = await this.communicationService.emit(tx, {
          key: 'auth.password.reset',
          recipientUserId: userId,
          entity: { type: 'password_reset', id: userId },
          // `token` is consumed ONLY by the catalogue's `actionUrl`, which
          // puts it in the href. No template prints it.
          values: { token: rawToken },
        });
        return emitted.outboxId;
      },
    );

    await this.communicationService.enqueueAfterCommit(outboxId);
  }
}
