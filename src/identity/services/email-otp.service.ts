/**
 * EmailOtpService — the emailed one-time code step of sign-in
 * (P64 Communications C4; the model approved in the plan's §12).
 *
 * WHERE THIS SITS. The password has already been verified and the surface
 * already resolved when this runs, and NOTHING has been issued: the caller
 * holds no access token, no refresh token and no session row — only a
 * challenge reference, which authenticates nothing (see
 * `AuthChallengeCipher`). That is the same position the TOTP challenge
 * occupies, and deliberately so: `TwoFactorService` and this class are
 * alternatives, never a stack. TOTP is the stronger factor, so when it is
 * confirmed for an account `AuthService.signIn` takes that branch and this
 * one is never reached.
 *
 * THE PROPERTIES THAT MATTER, AND WHERE EACH IS ENFORCED:
 *
 *  - A RAW CODE IS NEVER STORED. `auth_email_challenges.code_hash` is an
 *    HMAC-SHA256 under a server key plus the row's own random salt
 *    (`AuthChallengeCipher.hashCode`), so the table yields no working code
 *    even to someone holding it. The code exists in plaintext in exactly
 *    two places: this method's local variable, and the email.
 *
 *  - COMPARISON IS CONSTANT-TIME (`AuthChallengeCipher.digestsEqual`).
 *
 *  - GUESSING IS BOUNDED, IN POSTGRES. The attempt counter is incremented
 *    by the same statement that reads the row, so two concurrent guesses
 *    cannot both see the same count. Past the ceiling the challenge is
 *    DESTROYED (`consumed_at` stamped), not merely refused — an attacker
 *    must go back through the password, which the sign-in limiter governs.
 *
 *  - A CODE IS SINGLE-USE. Success claims the challenge with a conditional
 *    `UPDATE ... WHERE consumed_at IS NULL`; exactly one of two concurrent
 *    correct submissions can win, and the loser is told the challenge is
 *    dead rather than being handed a second session.
 *
 *  - A CHALLENGE BELONGS TO ONE ACCOUNT AND ONE SURFACE. Both are read
 *    from the row, never from the request body, and every statement names
 *    `user_id` so a reference cannot be pointed at somebody else's
 *    challenge.
 *
 *  - MAIL IS BOUNDED. 5 challenges per account per hour, at most 3 codes
 *    per challenge, 60 seconds between codes, plus a per-IP budget — so
 *    neither an account nor a network can use this endpoint as a relay.
 *
 * FAILURES ARE DELIBERATELY SPECIFIC HERE, unlike the TOTP path. Every one
 * of them has a different next step for an honest user who has ALREADY
 * proven the password, and none of them helps an attacker who has done the
 * same: wrong (attempts left), expired (resend), destroyed (sign in again),
 * undeliverable (reset the password instead). `EmailOtpChallengeForm` in
 * the frontend is built around exactly these four.
 *
 * SENDING. The code goes out through `CommunicationService.emit` inside
 * the same transaction that writes the challenge, so a rolled-back
 * challenge can never leave a live code in somebody's inbox, and the
 * dispatcher — never this service — does the sending after commit.
 */
import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomInt, randomUUID } from 'node:crypto';
import type { AuthMethod, Prisma, User } from '@prisma/client';
import type { EmailOtpPolicy, IdentityConfig } from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CommunicationService } from '../../communications/services/communication.service';
import { CommunicationMetricsService } from '../../communications/metrics/communication-metrics.service';
import { SuppressionService } from '../../communications/services/suppression.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { AuthRateLimiterService } from './auth-rate-limiter.service';
import { AuthChallengeCipher } from './auth-challenge-cipher.service';
import { TrustedDeviceService } from './trusted-device.service';
import type { SignInSurface } from '../dto/sign-in.dto';

/** Six digits, as the frontend's `EMAIL_OTP_LENGTH` and the email both assume. */
const CODE_DIGITS = 6;

/**
 * How much of the hourly per-account challenge budget one IP may consume.
 *
 * IP-only budgets are shared by everyone behind the same NAT, campus or
 * office network — the identical reasoning `AUTH_REGISTER_RATE_LIMIT_MAX`
 * documents — so the per-IP ceiling is a multiple of the per-account one
 * rather than equal to it. It still stops one network from driving
 * thousands of codes.
 */
const IP_BUDGET_MULTIPLIER = 5;

/** What a fresh (or resent) challenge tells the client. Mirrors `EmailOtpChallenge` in the frontend. */
export interface EmailOtpChallengeIssued {
  readonly challengeId: string;
  readonly expiresAt: Date;
  readonly resendAvailableAt: Date;
  readonly resendsRemaining: number;
  readonly maskedEmail: string;
}

/** `POST /auth/otp/resend` — the next cooldown, nothing else. */
export interface EmailOtpResendResult {
  readonly resendAvailableAt: Date;
  readonly resendsRemaining: number;
}

/** What a verified challenge authorises the caller to mint a session for. */
/** Launch Stabilization A6 — where an emailed code is being completed. */
export interface ChallengeContextExpectation {
  readonly surface: SignInSurface;
  /** Required when `surface` is `academy`. */
  readonly academyId?: string;
}

export interface EmailOtpVerified {
  readonly userId: string;
  /** Read from the challenge row, never from the request body. */
  readonly surface: SignInSurface;
  readonly academyId?: string;
  /** Google Identity — the first factor of the sign-in this code completes (from the row). */
  readonly authMethod: AuthMethod;
}

export interface OtpRequestContext {
  readonly ipAddress?: string;
  readonly userAgent?: string;
}

/** The subset of `auth_email_challenges` every path here needs. */
interface ChallengeRow {
  readonly id: string;
  readonly user_id: string;
  readonly surface: string;
  readonly academy_id: string | null;
  readonly code_hash: string;
  readonly salt: string;
  readonly attempts: number;
  readonly resends: number;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly auth_method: AuthMethod | null;
}

@Injectable()
export class EmailOtpService {
  private readonly logger = new Logger(EmailOtpService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly tenancyContextService: TenancyContextService,
    private readonly communicationService: CommunicationService,
    private readonly metrics: CommunicationMetricsService,
    private readonly suppressionService: SuppressionService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly cipher: AuthChallengeCipher,
    private readonly trustedDeviceService: TrustedDeviceService,
  ) {}

  private get settings(): IdentityConfig['emailOtp'] {
    return this.configService.getOrThrow<IdentityConfig>('identity').emailOtp;
  }

  /** The rollout switch for one surface — see `EmailOtpConfig`. */
  policyFor(surface: SignInSurface): EmailOtpPolicy {
    const { management, academy } = this.settings;
    return surface === 'academy' ? academy : management;
  }

  /**
   * Whether this sign-in must stop and demand an emailed code.
   *
   * `always` demands one unconditionally. `new_device` demands one unless
   * this browser presents a live `atlas_trust` cookie for THIS account on
   * THIS surface — the whole trust decision lives in
   * `TrustedDeviceService`, which fails closed.
   */
  async isRequired(input: {
    readonly userId: string;
    readonly surface: SignInSurface;
    /** Launch Stabilization A6 — the academy an academy-surface sign-in is for; trust is per academy. */
    readonly academyId?: string;
    readonly trustCookie?: string;
  }): Promise<boolean> {
    const policy = this.policyFor(input.surface);
    if (policy === 'off') return false;
    if (policy === 'always') return true;
    // The cookie is renamed on the way in on purpose: `trustCookie` is
    // what the HTTP layer calls the header value it read, `cookieValue`
    // is what the device service calls the secret it hashes. Passing the
    // whole object through unchanged silently dropped the cookie and made
    // every browser look untrusted (caught by `P64-C4-040`).
    return !(await this.trustedDeviceService.isTrusted({
      userId: input.userId,
      surface: input.surface,
      academyId: input.academyId,
      cookieValue: input.trustCookie,
    }));
  }

  /**
   * Opens a challenge and queues the code.
   *
   * Refuses BEFORE writing anything when the address is on the
   * do-not-mail list: a challenge whose code can never arrive is a dead
   * end, and §12 is explicit that the honest answer is to send the person
   * to a password reset or to support rather than to a code field that
   * will never be satisfied. The account is not locked — the password
   * still works everywhere the policy does not demand a code.
   */
  async issue(input: {
    readonly user: Pick<User, 'id' | 'email'>;
    readonly surface: SignInSurface;
    readonly academyId?: string;
    readonly context?: OtpRequestContext;
    /** Google Identity — the first factor this code completes; carried to the session. Defaults to `password`. */
    readonly authMethod?: AuthMethod;
  }): Promise<EmailOtpChallengeIssued> {
    const settings = this.settings;

    if (await this.isSuppressed(input.user.email)) {
      this.metrics.recordOtp('suppressed');
      throw new ForbiddenException({ messageKey: 'errors.auth.otpSuppressedAddress' });
    }

    await this.consumeIssueBudget(input.user.id, input.context?.ipAddress);

    const now = new Date();
    const challengeRowId = randomUUID();
    const code = generateCode();
    const salt = this.cipher.newSalt();
    const codeHash = this.cipher.hashCode({ challengeRowId, salt, code });
    const expiresAt = new Date(now.getTime() + settings.codeTtlSeconds * 1000);

    const outboxId = await this.tenancyContextService.runInUserContext(
      input.user.id,
      async (tx) => {
        // A new sign-in supersedes any challenge still open for this
        // account on this surface: two live codes would double an
        // attacker's guessing budget for the price of one password
        // submission.
        await tx.$executeRaw`
          UPDATE "auth_email_challenges"
          SET "consumed_at" = ${now}
          WHERE "user_id" = ${input.user.id}
            AND "surface" = ${input.surface}
            AND "consumed_at" IS NULL
        `;

        await tx.$executeRaw`
          INSERT INTO "auth_email_challenges"
            ("id", "user_id", "surface", "academy_id", "code_hash", "salt",
             "attempts", "resends", "ip_address", "auth_method", "expires_at", "created_at")
          VALUES (
            ${challengeRowId}, ${input.user.id}, ${input.surface},
            ${input.academyId ?? null}, ${codeHash}, ${salt},
            0, 0, ${input.context?.ipAddress ?? null},
            CAST(${input.authMethod ?? 'password'} AS "auth_method"), ${expiresAt}, ${now}
          )
        `;

        const emitted = await this.emitCode(tx, {
          userId: input.user.id,
          academyId: input.academyId,
          challengeRowId,
          code,
          expiresAt,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: input.user.id,
          action: 'auth.otp.issued',
          targetType: 'user',
          targetId: input.user.id,
          ...(input.academyId ? { academyId: input.academyId } : {}),
          context: {
            surface: input.surface,
            challengeId: challengeRowId,
            outboxId: emitted.outboxId,
            resend: false,
          },
        });

        return emitted.outboxId;
      },
    );

    await this.communicationService.enqueueAfterCommit(outboxId);
    this.metrics.recordOtp('requested');

    return {
      challengeId: this.cipher.sealChallengeRef({
        challengeRowId,
        userId: input.user.id,
      }),
      expiresAt,
      resendAvailableAt: new Date(now.getTime() + settings.resendCooldownSeconds * 1000),
      resendsRemaining: Math.max(0, settings.maxCodesPerChallenge - 1),
      maskedEmail: maskEmail(input.user.email),
    };
  }

  /**
   * Issues a fresh code for an OPEN challenge.
   *
   * The new code replaces the old one in the same row — §12's "a new code
   * invalidates the previous" — and resets the attempt counter, because
   * the attempts spent guessing a code the user never received should not
   * be charged against the one they are about to read.
   *
   * The cooldown is derived from the row rather than from a separate
   * column: a send always sets `expires_at = sent_at + ttl`, so
   * `sent_at = expires_at - ttl` exactly, with no schema change and no
   * second source of truth that could disagree.
   */
  async resend(
    challengeId: string,
    context?: OtpRequestContext,
  ): Promise<EmailOtpResendResult> {
    const settings = this.settings;
    const reference = this.cipher.openChallengeRef(challengeId);
    if (!reference) throw this.deadChallenge();

    await this.consumeResendBudget(context?.ipAddress);

    const now = new Date();
    const row = await this.readChallenge(reference.userId, reference.challengeRowId);
    if (!row || row.consumed_at !== null) throw this.deadChallenge();

    const remainingBefore = Math.max(0, settings.maxCodesPerChallenge - 1 - row.resends);
    if (remainingBefore === 0) {
      throw new HttpException(
        { messageKey: 'errors.auth.otpResendExhausted' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const lastSentAt = new Date(
      row.expires_at.getTime() - settings.codeTtlSeconds * 1000,
    );
    const availableAt = new Date(
      lastSentAt.getTime() + settings.resendCooldownSeconds * 1000,
    );
    if (availableAt > now) {
      throw new HttpException(
        { messageKey: 'errors.auth.otpResendCooldown' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    // Checked here as well as at issue: an address can be added to the
    // suppression list BY the first code's own hard bounce, which is
    // exactly the case the frontend's terminal "we cannot reach your
    // inbox" state exists for.
    const email = await this.recipientEmail(reference.userId);
    if (!email || (await this.isSuppressed(email))) {
      this.metrics.recordOtp('suppressed');
      throw new ForbiddenException({ messageKey: 'errors.auth.otpSuppressedAddress' });
    }

    const code = generateCode();
    const salt = this.cipher.newSalt();
    const codeHash = this.cipher.hashCode({
      challengeRowId: reference.challengeRowId,
      salt,
      code,
    });
    const expiresAt = new Date(now.getTime() + settings.codeTtlSeconds * 1000);

    const result = await this.tenancyContextService.runInUserContext(
      reference.userId,
      async (tx) => {
        // Conditional on the row still being open AND on the resend count
        // the cooldown was computed from, so two simultaneous resends
        // cannot both spend the same allowance.
        const claimed = await tx.$executeRaw`
          UPDATE "auth_email_challenges"
          SET "code_hash" = ${codeHash},
              "salt" = ${salt},
              "expires_at" = ${expiresAt},
              "attempts" = 0,
              "resends" = "resends" + 1
          WHERE "id" = ${reference.challengeRowId}
            AND "user_id" = ${reference.userId}
            AND "consumed_at" IS NULL
            AND "resends" = ${row.resends}
        `;
        if (claimed !== 1) return null;

        const emitted = await this.emitCode(tx, {
          userId: reference.userId,
          academyId: row.academy_id ?? undefined,
          challengeRowId: reference.challengeRowId,
          code,
          expiresAt,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId: reference.userId,
          action: 'auth.otp.issued',
          targetType: 'user',
          targetId: reference.userId,
          ...(row.academy_id ? { academyId: row.academy_id } : {}),
          context: {
            surface: row.surface,
            challengeId: reference.challengeRowId,
            outboxId: emitted.outboxId,
            resend: true,
          },
        });

        return emitted.outboxId;
      },
    );

    if (result === null) throw this.deadChallenge();

    await this.communicationService.enqueueAfterCommit(result);
    this.metrics.recordOtp('resent');

    return {
      resendAvailableAt: new Date(now.getTime() + settings.resendCooldownSeconds * 1000),
      resendsRemaining: remainingBefore - 1,
    };
  }

  /**
   * Checks one submitted code and, on success, consumes the challenge.
   *
   * Returns only what the caller needs to mint a session. It does NOT
   * mint one — `AuthService.issueSession` stays the single place a session
   * is created, exactly as the TOTP path leaves it.
   */
  async verify(
    challengeId: string,
    code: string,
    context?: OtpRequestContext,
    /**
     * Launch Stabilization A6 — the authentication context the request is
     * being completed in, derived by the caller from the request HOST (never
     * the body). A challenge issued for another context (Academy A's code on
     * Academy B's website, an academy code on the management host) is
     * answered exactly like a wrong code — an attempt is spent and nothing
     * about the other context is disclosed. `null` = no constraint (local
     * development hosts carry no context).
     */
    expected: ChallengeContextExpectation | null = null,
  ): Promise<EmailOtpVerified> {
    const settings = this.settings;
    const reference = this.cipher.openChallengeRef(challengeId);
    if (!reference) {
      this.metrics.recordOtp('failed');
      throw this.deadChallenge();
    }

    const now = new Date();

    const outcome = await this.tenancyContextService.runInUserContext(
      reference.userId,
      async (tx): Promise<VerifyOutcome> => {
        // ONE statement reads the row and spends an attempt, so two
        // concurrent guesses can never observe the same count. A row
        // belonging to anybody else, or a forged id, matches nothing.
        const rows = await tx.$queryRaw<ChallengeRow[]>`
          UPDATE "auth_email_challenges"
          SET "attempts" = "attempts" + 1
          WHERE "id" = ${reference.challengeRowId}
            AND "user_id" = ${reference.userId}
          RETURNING "id", "user_id", "surface", "academy_id", "code_hash", "salt",
                    "attempts", "resends", "expires_at", "consumed_at", "auth_method"
        `;
        const row = rows[0];
        if (!row) return { kind: 'dead' };

        // Already consumed: verified once, or destroyed by the attempt
        // ceiling, or superseded by a newer sign-in. All three mean the
        // same thing to the caller — this challenge can never work again.
        if (row.consumed_at !== null) return { kind: 'dead' };

        if (row.attempts > settings.maxAttempts) {
          await this.destroy(tx, row, now);
          await this.auditLogWriterService.write(tx, {
            actorUserId: row.user_id,
            action: 'auth.otp.locked_out',
            targetType: 'user',
            targetId: row.user_id,
            ...(row.academy_id ? { academyId: row.academy_id } : {}),
            context: {
              surface: row.surface,
              challengeId: row.id,
              attempts: row.attempts,
              ipAddress: context?.ipAddress ?? null,
            },
          });
          return { kind: 'locked' };
        }

        if (row.expires_at <= now) {
          await this.auditLogWriterService.write(tx, {
            actorUserId: row.user_id,
            action: 'auth.otp.failed',
            targetType: 'user',
            targetId: row.user_id,
            ...(row.academy_id ? { academyId: row.academy_id } : {}),
            context: {
              surface: row.surface,
              challengeId: row.id,
              reason: 'expired',
              ipAddress: context?.ipAddress ?? null,
            },
          });
          return { kind: 'expired' };
        }

        const contextMatches =
          !expected ||
          (row.surface === expected.surface &&
            (expected.surface !== 'academy' || row.academy_id === expected.academyId));
        const candidate = this.cipher.hashCode({
          challengeRowId: row.id,
          salt: row.salt,
          code,
        });
        if (!contextMatches || !this.cipher.digestsEqual(candidate, row.code_hash)) {
          const attemptsRemaining = Math.max(0, settings.maxAttempts - row.attempts);
          // The last wrong guess destroys the challenge in the same
          // transaction, so "0 attempts left" is a fact about the server's
          // state and not just a number on a screen.
          if (attemptsRemaining === 0) {
            await this.destroy(tx, row, now);
          }
          await this.auditLogWriterService.write(tx, {
            actorUserId: row.user_id,
            action: attemptsRemaining === 0 ? 'auth.otp.locked_out' : 'auth.otp.failed',
            targetType: 'user',
            targetId: row.user_id,
            ...(row.academy_id ? { academyId: row.academy_id } : {}),
            context: {
              surface: row.surface,
              challengeId: row.id,
              reason: contextMatches ? 'invalid_code' : 'context_mismatch',
              attemptsRemaining,
              ipAddress: context?.ipAddress ?? null,
            },
          });
          return attemptsRemaining === 0
            ? { kind: 'locked' }
            : { kind: 'invalid', attemptsRemaining };
        }

        // The code was right. Claiming the row is what makes it single-use:
        // only one of two concurrent correct submissions can match
        // `consumed_at IS NULL`, and the loser is told the challenge is
        // dead rather than handed a second session.
        const claimed = await tx.$executeRaw`
          UPDATE "auth_email_challenges"
          SET "consumed_at" = ${now}
          WHERE "id" = ${row.id}
            AND "user_id" = ${row.user_id}
            AND "consumed_at" IS NULL
        `;
        if (claimed !== 1) return { kind: 'dead' };

        await this.auditLogWriterService.write(tx, {
          actorUserId: row.user_id,
          action: 'auth.otp.verified',
          targetType: 'user',
          targetId: row.user_id,
          ...(row.academy_id ? { academyId: row.academy_id } : {}),
          context: {
            surface: row.surface,
            challengeId: row.id,
            attempts: row.attempts,
            ipAddress: context?.ipAddress ?? null,
          },
        });

        return {
          kind: 'verified',
          userId: row.user_id,
          surface: row.surface === 'academy' ? 'academy' : 'management',
          academyId: row.academy_id ?? undefined,
          authMethod: row.auth_method ?? 'password',
        };
      },
    );

    switch (outcome.kind) {
      case 'verified':
        this.metrics.recordOtp('verified');
        return {
          userId: outcome.userId,
          surface: outcome.surface,
          academyId: outcome.academyId,
          authMethod: outcome.authMethod,
        };
      case 'invalid':
        this.metrics.recordOtp('failed');
        throw new UnauthorizedException({
          messageKey: 'errors.auth.otpInvalid',
          details: { attemptsRemaining: outcome.attemptsRemaining },
        });
      case 'expired':
        this.metrics.recordOtp('expired');
        throw new UnauthorizedException({ messageKey: 'errors.auth.otpExpired' });
      case 'locked':
      case 'dead':
        this.metrics.recordOtp('failed');
        throw this.deadChallenge();
    }
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  /**
   * The one refusal that means "this challenge can never work again".
   *
   * A destroyed challenge, a consumed one, a superseded one and a forged
   * reference all raise it, so nothing here tells an attacker which of
   * those it was — while an honest user is given the only next step that
   * exists: sign in again.
   */
  private deadChallenge(): UnauthorizedException {
    return new UnauthorizedException({
      messageKey: 'errors.auth.otpAttemptsExceeded',
    });
  }

  private async destroy(
    tx: Prisma.TransactionClient,
    row: ChallengeRow,
    now: Date,
  ): Promise<void> {
    await tx.$executeRaw`
      UPDATE "auth_email_challenges"
      SET "consumed_at" = ${now}
      WHERE "id" = ${row.id} AND "user_id" = ${row.user_id} AND "consumed_at" IS NULL
    `;
  }

  /**
   * Writes the delivery intent for one code.
   *
   * `organizationId` is deliberately NOT set. The outbox row carries the
   * code in its `values`, and `communication_outbox_tenant_select` would
   * otherwise let an organisation's staff read a live sign-in code for
   * one of their members. With it null the row is readable only by its
   * own recipient and the platform owner.
   */
  private emitCode(
    tx: Prisma.TransactionClient,
    input: {
      readonly userId: string;
      readonly academyId?: string;
      readonly challengeRowId: string;
      readonly code: string;
      readonly expiresAt: Date;
    },
  ): Promise<{ outboxId: string | null }> {
    return this.communicationService.emit(tx, {
      key: 'auth.email.otp',
      recipientUserId: input.userId,
      organizationId: null,
      academyId: input.academyId ?? null,
      entity: { type: 'auth_email_challenge', id: input.challengeRowId },
      values: {
        code: input.code,
        expiresInMinutes: Math.max(1, Math.round(this.settings.codeTtlSeconds / 60)),
      },
    });
  }

  /** Reads one challenge under its owner's context; `null` when it is not theirs. */
  private async readChallenge(
    userId: string,
    challengeRowId: string,
  ): Promise<ChallengeRow | null> {
    const rows = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        tx.$queryRaw<ChallengeRow[]>`
        SELECT "id", "user_id", "surface", "academy_id", "code_hash", "salt",
               "attempts", "resends", "expires_at", "consumed_at"
        FROM "auth_email_challenges"
        WHERE "id" = ${challengeRowId} AND "user_id" = ${userId}
      `,
    );
    return rows[0] ?? null;
  }

  private async recipientEmail(userId: string): Promise<string | null> {
    const rows = await this.tenancyContextService.runInUserContext(
      userId,
      (tx) =>
        tx.$queryRaw<{ email: string }[]>`
        SELECT "email" FROM "users" WHERE "id" = ${userId}
      `,
    );
    return rows[0]?.email ?? null;
  }

  /** Never fails the sign-in on a suppression-list hiccup — see `SuppressionService`. */
  private async isSuppressed(email: string): Promise<boolean> {
    try {
      return await this.suppressionService.isSuppressed(email);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Suppression lookup failed; treating the address as deliverable.',
      );
      return false;
    }
  }

  /**
   * §12: 5 challenges per account per hour, plus a wider per-IP budget.
   *
   * FAILS CLOSED. Over budget the sign-in is refused outright rather than
   * admitted without the factor the policy demands — a rate limiter must
   * never become a way to skip a control.
   */
  private async consumeIssueBudget(userId: string, ipAddress?: string): Promise<void> {
    const { challengesPerHour } = this.settings;
    const account = await this.rateLimiter.consume(
      `otp:issue:account:${userId}`,
      challengesPerHour,
      3600,
    );
    const ip = ipAddress
      ? await this.rateLimiter.consume(
          `otp:issue:ip:${ipAddress}`,
          challengesPerHour * IP_BUDGET_MULTIPLIER,
          3600,
        )
      : { allowed: true };

    if (!account.allowed || !ip.allowed) {
      this.metrics.recordOtp('rate_limited');
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * The per-challenge cap and the 60-second cooldown are the real resend
   * controls; this only stops one network from driving them across many
   * accounts at once.
   */
  private async consumeResendBudget(ipAddress?: string): Promise<void> {
    if (!ipAddress) return;
    const { challengesPerHour, maxCodesPerChallenge } = this.settings;
    const check = await this.rateLimiter.consume(
      `otp:resend:ip:${ipAddress}`,
      challengesPerHour * maxCodesPerChallenge * IP_BUDGET_MULTIPLIER,
      3600,
    );
    if (!check.allowed) {
      this.metrics.recordOtp('rate_limited');
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}

type VerifyOutcome =
  | {
      readonly kind: 'verified';
      readonly userId: string;
      readonly surface: SignInSurface;
      readonly academyId?: string;
      readonly authMethod: AuthMethod;
    }
  | { readonly kind: 'invalid'; readonly attemptsRemaining: number }
  | { readonly kind: 'expired' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'dead' };

/**
 * Six uniformly distributed digits from the CSPRNG.
 *
 * `randomInt` with an exclusive upper bound is rejection-sampled by Node
 * itself, so every value from `000000` to `999999` is equally likely —
 * unlike `randomBytes % 1000000`, which is measurably biased.
 */
function generateCode(): string {
  return String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
}

/**
 * `sami@example.com` -> `s•••@example.com`.
 *
 * The only address detail the half-authenticated client is shown: enough
 * for the account's owner to recognise which inbox to open, not enough to
 * be worth harvesting.
 */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email.slice(0, 1)}•••${email.slice(at)}`;
}
