/**
 * TwoFactorService — real TOTP second factor (Phase 10.3).
 *
 * Phase 10 deliberately deferred 2FA and left only a documented insertion
 * point. This replaces it with a working implementation.
 *
 * THE SECURITY PROPERTIES THAT MATTER, AND WHERE EACH IS ENFORCED:
 *
 *  - Secrets are encrypted at rest under a purpose-derived key
 *    (`TotpSecretCipher`). They are returned in plaintext exactly once,
 *    in the setup response the user needs in order to enrol, and never
 *    again.
 *
 *  - Enrolment is not enforcement. `confirmedAt` stays null until the
 *    user proves they can produce a valid code; only then does sign-in
 *    start demanding one. Enforcing earlier would lock people out over a
 *    mis-scanned QR.
 *
 *  - REPLAY IS BLOCKED. Every accepted code's TOTP time step is
 *    persisted, and a later code must have a strictly greater one. The
 *    same six digits therefore cannot be used twice even inside their own
 *    30-second window — which matters because an attacker who observes a
 *    code has ~30 seconds to reuse it.
 *
 *  - The intermediate challenge is NOT an access token. It is an opaque
 *    id in Redis with a short TTL, carrying only a user id, and it is
 *    accepted by exactly one endpoint. It cannot authenticate any other
 *    request.
 *
 *  - Recovery codes are hashed like passwords, single-use via a
 *    conditional UPDATE, and shown once.
 *
 *  - Brute force is bounded by a Redis counter keyed on the challenge,
 *    independent of the per-IP limiter, because guessing six digits is
 *    cheap and an attacker holding a valid password should get very few
 *    attempts.
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { generateSecret, generateURI, verify } from 'otplib';
import { PrismaService } from '../../database/prisma.service';
import { RedisService } from '../../redis/redis.service';
import { TotpSecretCipher } from './totp-secret-cipher.service';
import { PasswordHasherService } from './password-hasher.service';
import type { AppConfig } from '../../config/configuration';

/** How long a half-authenticated sign-in may sit unfinished. Short: it is a live credential. */
const CHALLENGE_TTL_SECONDS = 300;
/** Attempts allowed against one challenge before it is destroyed. */
const MAX_CHALLENGE_ATTEMPTS = 5;
/**
 * Clock-drift tolerance, in SECONDS — otplib's `epochTolerance` is a
 * duration, not a count of time steps. An earlier draft passed `1`
 * intending "one 30-second step", which silently meant one SECOND and
 * rejected any device whose clock was even slightly off. Phone clocks
 * routinely drift by a few seconds, so that would have produced
 * intermittent, unreproducible "invalid code" reports from real users.
 *
 * 30s either way is one full period — the standard allowance, and small
 * enough that it does not meaningfully widen the window an observed code
 * is useful for (the replay guard closes that anyway).
 */
const EPOCH_TOLERANCE_SECONDS = 30;
const RECOVERY_CODE_COUNT = 10;

const CHALLENGE_PREFIX = '2fa:challenge:';
const ATTEMPT_PREFIX = '2fa:attempts:';

export interface TwoFactorSetupResult {
  /** Base32 secret, shown ONCE so the user can enter it manually. Never returned again. */
  readonly secret: string;
  /** `otpauth://` URI encoded as a scannable QR data URI. */
  readonly qrCodeDataUri: string;
}

export interface TwoFactorStatus {
  readonly enabled: boolean;
  /** Present only while a started-but-unconfirmed enrolment exists. */
  readonly pendingSetup: boolean;
  readonly recoveryCodesRemaining: number;
}

@Injectable()
export class TwoFactorService {
  private readonly logger = new Logger(TwoFactorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redisService: RedisService,
    private readonly cipher: TotpSecretCipher,
    private readonly passwordHasher: PasswordHasherService,
    private readonly configService: ConfigService,
  ) {}

  // -----------------------------------------------------------------
  // Status and setup
  // -----------------------------------------------------------------

  async getStatus(userId: string): Promise<TwoFactorStatus> {
    const [record, remaining] = await Promise.all([
      this.prisma.userTwoFactor.findUnique({ where: { userId } }),
      this.prisma.twoFactorRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);

    return {
      enabled: Boolean(record?.confirmedAt),
      pendingSetup: Boolean(record && !record.confirmedAt),
      recoveryCodesRemaining: remaining,
    };
  }

  /**
   * Begins enrolment: mints a secret, stores it encrypted and
   * UNCONFIRMED, and returns what the user needs to enrol.
   *
   * Re-running this before confirming replaces the pending secret, so an
   * abandoned setup never leaves a stale secret that could later be
   * confirmed. It refuses outright once 2FA is already active — changing
   * an active second factor must go through disable first, which requires
   * the password.
   */
  async startSetup(userId: string): Promise<TwoFactorSetupResult> {
    const existing = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    if (existing?.confirmedAt) {
      throw new BadRequestException({
        messageKey: 'errors.auth.twoFactorAlreadyEnabled',
      });
    }

    const user = await this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      select: { email: true },
    });

    const secret = generateSecret({ length: 20 });
    const encryptedSecret = this.cipher.encrypt(secret);

    await this.prisma.userTwoFactor.upsert({
      where: { userId },
      create: { userId, encryptedSecret },
      // Replaces any abandoned pending secret; `confirmedAt` is already
      // null here (guarded above) so this cannot un-confirm active 2FA.
      update: { encryptedSecret, lastTimeStep: null },
    });

    const app = this.configService.getOrThrow<AppConfig>('app');
    const uri = generateURI({
      issuer: 'Atlas',
      label: user.email,
      secret,
    });

    // Imported lazily so the QR dependency is not loaded on every boot
    // path that never enrols anybody.
    const { toDataURL } = await import('qrcode');
    const qrCodeDataUri = await toDataURL(uri);

    this.logger.log({ userId, environment: app.nodeEnv }, 'Two-factor setup started.');

    return { secret, qrCodeDataUri };
  }

  /**
   * Completes enrolment by proving the user can generate a valid code,
   * and issues their recovery codes.
   *
   * The returned plaintext codes are the ONLY time they exist outside a
   * hash — the caller must show them and move on.
   */
  async confirmSetup(
    userId: string,
    token: string,
  ): Promise<{ recoveryCodes: string[] }> {
    const record = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    if (!record) {
      throw new BadRequestException({ messageKey: 'errors.auth.twoFactorNotStarted' });
    }
    if (record.confirmedAt) {
      throw new BadRequestException({
        messageKey: 'errors.auth.twoFactorAlreadyEnabled',
      });
    }

    const result = await this.verifyTotp(
      record.encryptedSecret,
      token,
      record.lastTimeStep,
    );
    if (!result.valid) {
      throw new BadRequestException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    const recoveryCodes = this.generateRecoveryCodes();

    await this.prisma.$transaction(async (tx) => {
      await tx.userTwoFactor.update({
        where: { userId },
        data: { confirmedAt: new Date(), lastTimeStep: result.timeStep },
      });
      // Any codes from a previous enrolment are gone — a re-enrolment must
      // never leave old recovery codes working.
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({
          userId,
          codeHash: hashRecoveryCode(code),
        })),
      });
    });

    return { recoveryCodes };
  }

  // -----------------------------------------------------------------
  // Sign-in challenge
  // -----------------------------------------------------------------

  /** Whether sign-in must stop and demand a second factor for this user. */
  async isEnforcedFor(userId: string): Promise<boolean> {
    const record = await this.prisma.userTwoFactor.findUnique({
      where: { userId },
      select: { confirmedAt: true },
    });
    return Boolean(record?.confirmedAt);
  }

  /**
   * Issues a short-lived challenge after a correct password.
   *
   * The returned id is deliberately NOT a token: it is an opaque random
   * value that maps, in Redis only, to a user id, and only
   * `completeChallenge` will accept it. It grants access to nothing.
   */
  async createChallenge(
    userId: string,
  ): Promise<{ challengeId: string; expiresIn: number }> {
    const challengeId = randomBytes(32).toString('base64url');
    await this.redisService
      .getClient()
      .set(`${CHALLENGE_PREFIX}${challengeId}`, userId, 'EX', CHALLENGE_TTL_SECONDS);
    return { challengeId, expiresIn: CHALLENGE_TTL_SECONDS };
  }

  /**
   * Validates a challenge plus either a TOTP code or a recovery code, and
   * returns the user id the caller may now issue a real session for.
   *
   * FAILURE IS UNIFORM. An unknown challenge, an expired one, a wrong
   * code, a replayed code and an exhausted attempt budget all raise the
   * same 401 — nothing here tells an attacker which of those it was, or
   * whether the account has 2FA at all.
   */
  async completeChallenge(
    challengeId: string,
    input: { token?: string; recoveryCode?: string },
  ): Promise<string> {
    const key = `${CHALLENGE_PREFIX}${challengeId}`;
    const userId = await this.redisService.getClient().get(key);
    if (!userId) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    // Bounded guessing. Counted per challenge, so an attacker cannot get
    // a fresh budget by retrying the password — a new challenge costs
    // another password submission, which the sign-in limiter already
    // governs.
    const attemptKey = `${ATTEMPT_PREFIX}${challengeId}`;
    const attempts = await this.redisService.getClient().incr(attemptKey);
    if (attempts === 1) {
      await this.redisService.getClient().expire(attemptKey, CHALLENGE_TTL_SECONDS);
    }
    if (attempts > MAX_CHALLENGE_ATTEMPTS) {
      // Burn the challenge outright rather than merely refusing: the
      // attacker must go back through the password.
      await this.redisService.getClient().del(key);
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    const record = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    if (!record?.confirmedAt) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    if (input.recoveryCode) {
      await this.consumeRecoveryCode(userId, input.recoveryCode);
    } else if (input.token) {
      const result = await this.verifyTotp(
        record.encryptedSecret,
        input.token,
        record.lastTimeStep,
      );
      if (!result.valid) {
        throw new UnauthorizedException({
          messageKey: 'errors.auth.invalidTwoFactorCode',
        });
      }
      // Persist the accepted step BEFORE returning — this is what makes
      // the code single-use.
      await this.prisma.userTwoFactor.update({
        where: { userId },
        data: { lastTimeStep: result.timeStep },
      });
    } else {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    // One challenge, one session.
    await this.redisService.getClient().del(key, attemptKey);
    return userId;
  }

  // -----------------------------------------------------------------
  // Management
  // -----------------------------------------------------------------

  /**
   * Disables 2FA. REQUIRES THE PASSWORD, deliberately.
   *
   * A valid session is not sufficient: if it were, stealing a session
   * would be enough to strip the very control that exists to make a
   * stolen session useless. Re-authentication is the point.
   */
  async disable(userId: string, password: string): Promise<void> {
    await this.assertPassword(userId, password);

    await this.prisma.$transaction(async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.userTwoFactor.deleteMany({ where: { userId } });
    });

    this.logger.log({ userId }, 'Two-factor authentication disabled.');
  }

  /**
   * Issues a fresh set of recovery codes, invalidating every previous
   * one. Also password-gated, for the same reason as `disable`: an
   * attacker with a session could otherwise mint themselves a permanent
   * bypass.
   */
  async regenerateRecoveryCodes(
    userId: string,
    password: string,
  ): Promise<{ recoveryCodes: string[] }> {
    await this.assertPassword(userId, password);

    const record = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    if (!record?.confirmedAt) {
      throw new BadRequestException({ messageKey: 'errors.auth.twoFactorNotEnabled' });
    }

    const recoveryCodes = this.generateRecoveryCodes();
    await this.prisma.$transaction(async (tx) => {
      await tx.twoFactorRecoveryCode.deleteMany({ where: { userId } });
      await tx.twoFactorRecoveryCode.createMany({
        data: recoveryCodes.map((code) => ({ userId, codeHash: hashRecoveryCode(code) })),
      });
    });

    return { recoveryCodes };
  }

  // -----------------------------------------------------------------
  // Internals
  // -----------------------------------------------------------------

  private async assertPassword(userId: string, password: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { passwordHash: true },
    });
    if (!user || !(await this.passwordHasher.verify(user.passwordHash, password))) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidCredentials' });
    }
  }

  /**
   * Verifies a TOTP code, refusing anything at or before the last
   * accepted time step.
   *
   * `afterTimeStep` is otplib's own replay guard, so the check happens
   * inside the library's constant-time comparison rather than in
   * hand-written code here.
   */
  private async verifyTotp(
    encryptedSecret: string,
    token: string,
    lastTimeStep: number | null,
  ): Promise<{ valid: boolean; timeStep?: number }> {
    const secret = this.cipher.decrypt(encryptedSecret);
    const result = await verify({
      token: token.replace(/\s/g, ''),
      secret,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
      ...(lastTimeStep !== null ? { afterTimeStep: lastTimeStep } : {}),
    });

    return result.valid
      ? { valid: true, timeStep: (result as { timeStep: number }).timeStep }
      : { valid: false };
  }

  /**
   * Consumes one recovery code.
   *
   * The conditional `updateMany` is what makes it single-use: it matches
   * only an unused row and stamps it in the same statement, so two
   * concurrent submissions of the same code serialise and exactly one
   * wins.
   */
  private async consumeRecoveryCode(userId: string, rawCode: string): Promise<void> {
    const claim = await this.prisma.twoFactorRecoveryCode.updateMany({
      where: { userId, codeHash: hashRecoveryCode(rawCode), usedAt: null },
      data: { usedAt: new Date() },
    });

    if (claim.count !== 1) {
      throw new UnauthorizedException({ messageKey: 'errors.auth.invalidTwoFactorCode' });
    }

    this.logger.log({ userId }, 'Two-factor recovery code used.');
  }

  /** Ten codes, 10 hex chars each (40 bits of entropy per code) from a CSPRNG. */
  private generateRecoveryCodes(): string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, () =>
      randomBytes(5).toString('hex'),
    );
  }
}

/**
 * Normalises then hashes a recovery code.
 *
 * Normalising (lowercase, strip spaces and dashes) means a user reading
 * a code off paper cannot fail because of formatting. SHA-256 rather than
 * Argon2 is deliberate and safe here: unlike a password these are
 * high-entropy random values, so they are not subject to dictionary
 * attack, and verification happens on a login path that must stay fast.
 */
function hashRecoveryCode(rawCode: string): string {
  const normalised = rawCode.trim().toLowerCase().replace(/[\s-]/g, '');
  return createHash('sha256').update(normalised).digest('hex');
}

/** Kept for callers that need a constant-time compare of two digests. */
export function digestsEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
