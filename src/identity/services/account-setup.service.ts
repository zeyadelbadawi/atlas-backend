/**
 * AccountSetupService — the onboarding email for an account somebody else
 * created for you.
 *
 * WHAT THIS REPLACES. A Client Owner adding a Manager, Instructor or
 * Student supplies a password in the create call, and the new person was
 * told NOTHING: no email, no link, no way to learn the account existed.
 * Whatever password the owner typed either got relayed out of band or the
 * account sat unusable. Neither is acceptable, and emailing a generated
 * password would be worse than both.
 *
 * WHY IT REUSES THE RESET TOKEN. "A one-time link that lets you set a
 * password" is exactly what `password_reset_tokens` already is: hashed at
 * rest, single-use, expiring, and consumed by an endpoint that is already
 * hardened. Minting a second credential type with its own storage,
 * expiry and consumption rules would be a second authentication system to
 * keep correct — the thing this codebase has consistently refused to do.
 * The link therefore lands on the SAME page as a reset, with `setup=1` so
 * the page can say "Set your password" instead of "Reset"; one flow, one
 * set of rules, correct wording.
 *
 * TTL. Longer than a reset (which is minutes, because the user asked for
 * it seconds ago and is waiting) — somebody who did not ask for this
 * account may not open their mail today. Still bounded, and the email
 * says when it lapses; afterwards "forgot password" issues a fresh one,
 * because by then the account genuinely exists.
 *
 * The raw token exists only long enough to be emitted. It is never
 * logged, never returned to the caller who triggered the creation, and
 * never stored unhashed.
 */
import { Injectable, Logger } from '@nestjs/common';
import { CommunicationService } from '../../communications/services/communication.service';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PasswordResetTokensRepository } from '../repositories/password-reset-tokens.repository';
import { generateOpaqueToken, hashOpaqueToken } from '../utils/opaque-token.util';

/**
 * Three days. Long enough for a weekend, short enough that a link
 * forwarded once and forgotten does not stay live for a month.
 */
const SETUP_TOKEN_TTL_HOURS = 72;

export type AcademyMemberInviteRole = 'manager' | 'instructor' | 'student';

export interface AccountSetupInput {
  readonly userId: string;
  readonly academyId: string;
  readonly academyName: string;
  readonly role: AcademyMemberInviteRole;
  /** Shown back to the reader so they know WHICH address signs in. */
  readonly email: string;
}

@Injectable()
export class AccountSetupService {
  private readonly logger = new Logger(AccountSetupService.name);

  constructor(
    private readonly passwordResetTokensRepository: PasswordResetTokensRepository,
    private readonly communicationService: CommunicationService,
    private readonly tenancyContextService: TenancyContextService,
  ) {}

  /**
   * Never throws. An account that exists but whose welcome email failed is
   * recoverable — the person uses "forgot password" and lands in the same
   * place. Failing the creation call instead would leave the owner unable
   * to add a member because of a transient mail problem, which is worse.
   */
  async sendInvite(input: AccountSetupInput): Promise<void> {
    try {
      const rawToken = generateOpaqueToken();
      const expiresAt = new Date(Date.now() + SETUP_TOKEN_TTL_HOURS * 60 * 60 * 1000);
      await this.passwordResetTokensRepository.create({
        userId: input.userId,
        tokenHash: hashOpaqueToken(rawToken),
        expiresAt,
      });

      const outboxId = await this.tenancyContextService.runInUserContext(
        input.userId,
        async (tx) => {
          const emitted = await this.communicationService.emit(tx, {
            // A learner signs in on the academy host, staff on the
            // management host, and the setup link has to land where the
            // person will actually sign in — otherwise they set a
            // password on a surface that then refuses them (403).
            key:
              input.role === 'student'
                ? 'academy.learner.invited'
                : 'academy.member.invited',
            recipientUserId: input.userId,
            academyId: input.academyId,
            entity: { type: 'account_setup', id: input.userId },
            values: {
              // Consumed ONLY by the catalogue's `actionUrl`, which puts
              // it in the href. No template prints it.
              token: rawToken,
              academyName: input.academyName,
              role: input.role,
              email: input.email,
              expiresInHours: SETUP_TOKEN_TTL_HOURS,
            },
          });
          return emitted.outboxId;
        },
      );
      await this.communicationService.enqueueAfterCommit(outboxId);
    } catch (error) {
      // Logged WITHOUT the token — it is a live credential until used.
      this.logger.warn(
        {
          userId: input.userId,
          academyId: input.academyId,
          error: error instanceof Error ? error.message : String(error),
        },
        'Could not send the account-setup email; the account exists and the person can use password recovery.',
      );
    }
  }
}

export { SETUP_TOKEN_TTL_HOURS };
