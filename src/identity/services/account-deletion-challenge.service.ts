/**
 * Account deletion is confirmed by a code emailed to the account's verified
 * address (authentication audit, Decision 1).
 *
 * WHY A CHALLENGE OF ITS OWN. A sign-in code proves "the person at the
 * keyboard reads this mailbox" for ONE purpose: finishing a sign-in. A
 * deletion code must prove the same thing for a different, irreversible
 * purpose, so it lives in its own table (`account_deletion_challenges`) that
 * no sign-in path reads, and a sign-in challenge can never be presented here.
 *
 * THE BINDINGS.
 *   - the ACCOUNT: rows are read and written only in the account's own RLS
 *     context, and every statement also filters on `user_id`;
 *   - the SESSION: the `sid` that asked for the code — another session of
 *     the same account (a second stolen token included) cannot use it;
 *   - PURPOSE: the table itself.
 *
 * THE LIFECYCLE. 6 CSPRNG digits; only HMAC(serverKey, id.salt.code) is
 * stored; 10 minutes; 5 wrong attempts burn the challenge; a new request
 * retires every open one; a 60-second resend cooldown and at most 5
 * requests an hour per account (on top of the per-account/IP credential
 * limiter on both routes). Consumption is ONE conditional UPDATE, so two
 * concurrent confirmations cannot both proceed — and deletion itself is
 * idempotent besides. Failures are uniform to the caller.
 *
 * The code is never logged and never audited; the audit trail records
 * requested / failed / locked-out / confirmed.
 *
 * B0-SEC-13 — the same mechanism also confirms FILING a privacy request
 * (data deletion or export). That is a second PURPOSE, recorded on the row:
 * a code is accepted only for the purpose it was issued for, a new code
 * retires only open codes of its own purpose, and the budgets count per
 * purpose. A privacy-request code can therefore never delete an account.
 */
import {
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  UnauthorizedException,
} from '@nestjs/common';
import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AuthChallengeCipher } from './auth-challenge-cipher.service';
import { maskEmail } from './email-otp.service';
import {
  SecurityEventsService,
  type SecurityEventInput,
  type SecurityEventReason,
} from '../../security-events/services/security-events.service';

const CODE_DIGITS = 6;
export const DELETION_CODE_TTL_MS = 10 * 60 * 1000;
export const DELETION_CODE_MAX_ATTEMPTS = 5;
export const DELETION_RESEND_COOLDOWN_MS = 60 * 1000;
export const DELETION_MAX_REQUESTS_PER_HOUR = 5;

export type EmailedCodePurpose = 'account_deletion' | 'privacy_request';

interface PurposeSpec {
  readonly template: 'auth.account.deletion_code' | 'auth.account.privacy_request_code';
  readonly entityType: string;
  /** Audit action prefix: `<prefix>.requested`, `.code_failed`, `.locked_out`, `.confirmed`. */
  readonly auditPrefix: string;
  /** The W3 security events are defined for account deletion only. */
  readonly securityEvents: boolean;
  readonly platformOwnerRefusal: string;
}

const PURPOSES: Readonly<Record<EmailedCodePurpose, PurposeSpec>> = {
  account_deletion: {
    template: 'auth.account.deletion_code',
    entityType: 'account_deletion_challenge',
    auditPrefix: 'account.deletion',
    securityEvents: true,
    platformOwnerRefusal: 'errors.auth.platformOwnerCannotSelfDelete',
  },
  privacy_request: {
    template: 'auth.account.privacy_request_code',
    entityType: 'privacy_request_challenge',
    auditPrefix: 'privacy_request.code',
    securityEvents: false,
    platformOwnerRefusal: 'errors.forbidden',
  },
};

export interface AccountDeletionChallengeContract {
  readonly challengeId: string;
  readonly expiresAt: string;
  readonly resendAvailableAt: string;
  readonly maskedEmail: string;
}

interface ChallengeRow {
  readonly id: string;
  readonly code_hash: string;
  readonly salt: string;
  readonly attempts: number;
}

@Injectable()
export class AccountDeletionChallengeService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly communicationService: CommunicationService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly cipher: AuthChallengeCipher,
    /** W3 — OTP & Security Monitoring; recorded after each transaction, never with the code. */
    @Optional() private readonly securityEvents?: SecurityEventsService,
  ) {}

  private async track(event: SecurityEventInput, spec: PurposeSpec): Promise<void> {
    if (!spec.securityEvents) return;
    await this.securityEvents?.record(event);
  }

  /**
   * `POST /users/me/delete/request` — emails a fresh code; nothing is deleted.
   * `POST /privacy-requests/code` passes `privacy_request` (B0-SEC-13).
   */
  async issue(
    userId: string,
    sessionId: string,
    purpose: EmailedCodePurpose = 'account_deletion',
  ): Promise<AccountDeletionChallengeContract> {
    const spec = PURPOSES[purpose];
    const now = Date.now();
    const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
    const salt = randomBytes(16).toString('hex');
    const challengeId = randomUUID();
    const expiresAt = new Date(now + DELETION_CODE_TTL_MS);
    // Set just before a budget refusal is thrown, so the refusal can be
    // recorded once the transaction has unwound (see the catch below).
    let refusedFor: SecurityEventReason | null = null;

    const issued = this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          email: true,
          status: true,
          isPlatformOwner: true,
          emailVerifiedAt: true,
        },
      });
      if (!user || user.status !== 'active') {
        throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
      }
      // The same refusal the deletion itself makes — no code is mailed
      // for a deletion that could never happen.
      if (user.isPlatformOwner) {
        throw new ForbiddenException({ messageKey: spec.platformOwnerRefusal });
      }
      // The code goes to a VERIFIED address only: an unverified one is
      // not yet proven to be the owner's mailbox.
      if (!user.emailVerifiedAt) {
        throw new ConflictException({
          messageKey: 'errors.account.deletionEmailUnverified',
        });
      }

      const recent = await tx.accountDeletionChallenge.findMany({
        where: { userId, purpose, createdAt: { gt: new Date(now - 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      if (recent.length >= DELETION_MAX_REQUESTS_PER_HOUR) {
        refusedFor = 'hourly_budget';
        throw new HttpException(
          { messageKey: 'errors.auth.rateLimited' },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      if (
        recent[0] &&
        now - recent[0].createdAt.getTime() < DELETION_RESEND_COOLDOWN_MS
      ) {
        refusedFor = 'cooldown';
        throw new HttpException(
          {
            messageKey: 'errors.account.deletionCodeCooldown',
            details: {
              resendAvailableAt: new Date(
                recent[0].createdAt.getTime() + DELETION_RESEND_COOLDOWN_MS,
              ).toISOString(),
            },
          },
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }

      // A new code retires every open one of its purpose: only the latest
      // email works.
      await tx.accountDeletionChallenge.updateMany({
        where: { userId, purpose, consumedAt: null },
        data: { consumedAt: new Date(now) },
      });
      await tx.accountDeletionChallenge.create({
        data: {
          id: challengeId,
          userId,
          sessionId,
          purpose,
          salt,
          codeHash: this.cipher.hashCode({ challengeRowId: challengeId, salt, code }),
          expiresAt,
        },
      });
      const emitted = await this.communicationService.emit(tx, {
        key: spec.template,
        recipientUserId: userId,
        // Never tenant-visible: the row carries a live code.
        organizationId: null,
        entity: { type: spec.entityType, id: challengeId },
        values: {
          code,
          expiresInMinutes: Math.round(DELETION_CODE_TTL_MS / 60_000),
        },
      });
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: `${spec.auditPrefix}.requested`,
        targetType: 'user',
        targetId: userId,
        context: { challengeId },
      });
      return { email: user.email, outboxId: emitted.outboxId };
    });
    let email: string;
    let outboxId: string | null;
    try {
      ({ email, outboxId } = await issued);
    } catch (error) {
      if (refusedFor) {
        await this.track(
          {
            type: 'deletion_code_rate_limited',
            surface: 'management',
            userId,
            reason: refusedFor,
          },
          spec,
        );
      }
      throw error;
    }
    await this.communicationService.enqueueAfterCommit(outboxId);
    await this.track(
      {
        type: 'deletion_code_sent',
        surface: 'management',
        userId,
        challengeId,
      },
      spec,
    );

    return {
      challengeId,
      expiresAt: expiresAt.toISOString(),
      resendAvailableAt: new Date(now + DELETION_RESEND_COOLDOWN_MS).toISOString(),
      maskedEmail: maskEmail(email),
    };
  }

  /**
   * Consumes the challenge exactly once, or throws. The attempt counter is
   * committed even when the code is wrong (the outcome is decided inside the
   * transaction and thrown after it commits).
   */
  async consume(
    userId: string,
    sessionId: string,
    challengeId: string,
    code: string,
    purpose: EmailedCodePurpose = 'account_deletion',
  ): Promise<void> {
    const spec = PURPOSES[purpose];
    const outcome = await this.tenancyContextService.runInUserContext(
      userId,
      async (tx) => {
        const rows = await tx.$queryRaw<ChallengeRow[]>`
        UPDATE "account_deletion_challenges"
           SET "attempts" = "attempts" + 1
         WHERE "id" = ${challengeId}
           AND "user_id" = ${userId}
           AND "session_id" = ${sessionId}
           AND "purpose" = ${purpose}
           AND "consumed_at" IS NULL
           AND "expires_at" > now()
        RETURNING "id", "code_hash", "salt", "attempts"
      `;
        const row = rows[0];
        if (!row) return { kind: 'invalid' as const };

        if (row.attempts > DELETION_CODE_MAX_ATTEMPTS) {
          await tx.accountDeletionChallenge.updateMany({
            where: { id: row.id, consumedAt: null },
            data: { consumedAt: new Date() },
          });
          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            action: `${spec.auditPrefix}.locked_out`,
            targetType: 'user',
            targetId: userId,
            context: { challengeId },
          });
          return { kind: 'locked' as const };
        }

        const candidate = this.cipher.hashCode({
          challengeRowId: row.id,
          salt: row.salt,
          code,
        });
        if (!this.cipher.digestsEqual(candidate, row.code_hash)) {
          await this.auditLogWriterService.write(tx, {
            actorUserId: userId,
            action: `${spec.auditPrefix}.code_failed`,
            targetType: 'user',
            targetId: userId,
            context: { challengeId, attempts: row.attempts },
          });
          return {
            kind: 'wrong' as const,
            attemptsRemaining: Math.max(0, DELETION_CODE_MAX_ATTEMPTS - row.attempts),
          };
        }

        // The one-time consumption: exactly one concurrent confirmation wins.
        const claimed = await tx.accountDeletionChallenge.updateMany({
          where: { id: row.id, userId, consumedAt: null },
          data: { consumedAt: new Date() },
        });
        if (claimed.count !== 1) return { kind: 'invalid' as const };
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          action: `${spec.auditPrefix}.confirmed`,
          targetType: 'user',
          targetId: userId,
          context: { challengeId },
        });
        return { kind: 'ok' as const };
      },
    );

    const base = { surface: 'management', userId, challengeId } as const;
    switch (outcome.kind) {
      case 'ok':
        await this.track({ ...base, type: 'deletion_code_verified' }, spec);
        break;
      case 'wrong':
        await this.track(
          {
            ...base,
            type: 'deletion_code_failed',
            reason: 'invalid_code',
            attemptsRemaining: outcome.attemptsRemaining,
          },
          spec,
        );
        break;
      case 'locked':
        await this.track(
          {
            ...base,
            type: 'deletion_code_locked',
            reason: 'attempts_exhausted',
            attemptsRemaining: 0,
          },
          spec,
        );
        break;
      default:
        await this.track(
          {
            ...base,
            type: 'deletion_code_failed',
            reason: 'dead_challenge',
          },
          spec,
        );
    }

    switch (outcome.kind) {
      case 'ok':
        return;
      case 'wrong':
        throw new UnauthorizedException({
          messageKey: 'errors.account.deletionCodeInvalid',
          details: { attemptsRemaining: outcome.attemptsRemaining },
        });
      case 'locked':
        throw new UnauthorizedException({
          messageKey: 'errors.account.deletionCodeAttemptsExceeded',
        });
      default:
        // Unknown, expired, already used, another session's or another
        // account's: one answer — request a new code.
        throw new UnauthorizedException({
          messageKey: 'errors.account.deletionCodeExpired',
        });
    }
  }
}
