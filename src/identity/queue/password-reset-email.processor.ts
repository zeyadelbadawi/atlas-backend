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
 *
 * ATO review F9 — the account lookup and the token are minted HERE, not in
 * the request: `POST /auth/password-reset/request` only enqueues the typed
 * address, so it costs the same whether or not an account exists. An
 * address with no account simply ends the job.
 */
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { IdentityConfig } from '../../config/configuration';
import { CommunicationService } from '../../communications/services/communication.service';
import { PrincipalResolverService } from '../../tenancy/services/principal-resolver.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { recoveryAcademyId } from '../utils/recovery-surface.util';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';
import { UsersRepository } from '../repositories/users.repository';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
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
    private readonly principalResolver: PrincipalResolverService,
    private readonly usersRepository: UsersRepository,
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<PasswordResetEmailJobPayload>): Promise<void> {
    // Deliberately does not log `job.data` — it names an address (and a
    // legacy job carries a raw token).
    this.logger.log({ jobId: job.id }, 'Processing password-reset email job');

    const delivery = await this.resolveDelivery(job.data);
    if (!delivery) return; // No account for that address — nothing to send.
    const { userId, rawToken, hostAcademyId } = delivery;
    // Requested on an academy website by one of that academy's accounts →
    // that academy's email and reset page; otherwise the management one.
    // Decided here, after the request was already answered the same way
    // for every address (see `recoveryAcademyId`).
    const academyId = hostAcademyId
      ? recoveryAcademyId(await this.principalResolver.resolve(userId), hostAcademyId)
      : null;
    const outboxId = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const emitted = await this.communicationService.emit(tx, {
          key: 'auth.password.reset',
          recipientUserId: userId,
          // Branding and host only. Never `organizationId`: the row
          // carries a live link and must never be tenant-visible.
          academyId,
          entity: { type: 'password_reset', id: userId },
          values: {
            // `token` is consumed ONLY by the catalogue's `actionUrl`,
            // which puts it in the href. No template prints it.
            token: rawToken,
            // Selects the academy-host destination in `actionUrl`.
            ...(academyId ? { academyId } : {}),
          },
        });
        return emitted.outboxId;
      },
    );

    await this.communicationService.enqueueAfterCommit(outboxId);
  }

  /**
   * The account, token and host to deliver. A request job (ATO F9) looks
   * the address up and mints the token; a legacy job already carries them.
   */
  private async resolveDelivery(
    data: PasswordResetEmailJobPayload,
  ): Promise<{ userId: string; rawToken: string; hostAcademyId?: string | null } | null> {
    if (data.kind !== 'request') return data;
    const user = await this.usersRepository.findByEmail(data.email);
    if (!user) return null;
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const rawToken = generateOpaqueToken();
    await this.passwordResetTokensRepository.create({
      userId: user.id,
      tokenHash: hashOpaqueToken(rawToken),
      expiresAt: new Date(Date.now() + identity.passwordResetTokenTtlMinutes * 60 * 1000),
    });
    return { userId: user.id, rawToken, hostAcademyId: data.hostAcademyId };
  }
}
