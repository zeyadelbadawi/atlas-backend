/**
 * TrustedDeviceService — P64 Communications C4 (§12, item 5).
 *
 * A trusted device is a BROWSER that has already proven, with an emailed
 * code, that the person driving it can read the account's inbox. It is
 * not a session: it holds no token, grants no access, and forgetting one
 * signs nothing out — it only stops that browser being asked for a code
 * again until the trust expires.
 *
 * WHAT IS ACTUALLY TRUSTED, AND WHY IT IS NOT "A DEVICE ID". The browser
 * presents an `atlas_trust` cookie: 32 random bytes minted by the server,
 * `HttpOnly`, stored ONLY as its SHA-256 digest (`trusted_devices.
 * token_hash`, unique). A client therefore cannot name, guess or forge a
 * trusted device — it can only present a secret the server issued, and
 * the row that secret hashes to carries the owner. Every lookup then
 * additionally requires `user_id = <the account that just proved its
 * password>` and `surface = <the surface being signed into>`, so:
 *
 *   - user B presenting user A's cookie matches nothing (different owner);
 *   - a cookie trusted for an academy website skips nothing on the
 *     management dashboard, and vice versa;
 *   - a revoked or expired row matches nothing and the code is demanded.
 *
 * The cookie is NEVER a credential on its own: it is consulted only after
 * a correct password, and the most it can ever do is remove the emailed
 * code from a sign-in that has already succeeded at the password step.
 *
 * `atlas_device` is deliberately untouched. That cookie means "which
 * device is this, for the learner CONTENT cap" (P64 Phase 2, AD-10);
 * reusing it here would silently couple an authentication decision to a
 * playback quota and make revoking one revoke the other.
 *
 * RLS. Every statement below runs inside `runInUserContext(userId)` and
 * additionally names `user_id` in its own `WHERE`, so the service's
 * decision and `trusted_devices_self_select`/`_self_update` agree.
 * Note honestly that the P64 foundation migration also carries
 * `trusted_devices_system_select`/`_system_update` with `USING (true)`
 * (the writer path runs on behalf of a user who is not yet a session),
 * and Postgres OR-combines permissive policies — so the `user_id`
 * predicate in each statement here, not RLS, is the binding constraint
 * for cross-user isolation on this table. That is why it is present on
 * every single statement without exception.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import type { TrustedDevice } from '@prisma/client';
import type { IdentityConfig } from '../../config/configuration';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { deriveDeviceLabel } from '../utils/request-metadata.util';
import type { SignInSurface } from '../dto/sign-in.dto';

/**
 * The trusted-device cookie. A distinct name from `atlas_device` on
 * purpose — see this class's own doc comment.
 */
export const TRUST_COOKIE_NAME = 'atlas_trust';

/** Anything longer than this was never issued by us; refused before it is hashed. */
const MAX_COOKIE_LENGTH = 128;

export interface TrustedDeviceResponse {
  readonly id: string;
  readonly label: string;
  readonly surface: SignInSurface;
  readonly lastUsedAt: string;
  readonly expiresAt: string;
  /** True for the browser making the request. */
  readonly current: boolean;
}

/** What `trust()` hands back so the controller can write the cookie. */
export interface MintedTrust {
  readonly deviceId: string;
  readonly cookieValue: string;
  readonly maxAgeSeconds: number;
}

export function hashTrustToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex');
}

@Injectable()
export class TrustedDeviceService {
  private readonly logger = new Logger(TrustedDeviceService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly configService: ConfigService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  private get identity(): IdentityConfig {
    return this.configService.getOrThrow<IdentityConfig>('identity');
  }

  /** §12: 90 days on the management surface, 180 on an academy website. */
  trustDays(surface: SignInSurface): number {
    const { emailOtp } = this.identity;
    return surface === 'academy'
      ? emailOtp.trustedDeviceDaysAcademy
      : emailOtp.trustedDeviceDaysManagement;
  }

  /**
   * Is THIS browser already trusted for THIS account on THIS surface?
   *
   * Answers `false` for every failure mode — no cookie, a value we never
   * issued, another user's row, a different surface, revoked, expired —
   * and never throws: a trust lookup that could fail a sign-in would turn
   * a convenience into an availability risk. Failing "false" demands the
   * code, which is the safe direction.
   */
  async isTrusted(input: {
    readonly userId: string;
    readonly surface: SignInSurface;
    readonly cookieValue?: string;
  }): Promise<boolean> {
    const row = await this.findLiveDevice(input);
    if (!row) return false;
    await this.touch(input.userId, row.id);
    return true;
  }

  /**
   * Records this browser as trusted and returns the cookie to set.
   *
   * Called ONLY after a challenge has been verified — never from the
   * password step. A brand-new secret is minted every time rather than
   * refreshing an existing row's expiry, so a cookie that leaked before
   * this point does not inherit the new trust window; the browser's
   * previous row (if any) is revoked in the same transaction.
   */
  async trust(input: {
    readonly userId: string;
    readonly surface: SignInSurface;
    readonly userAgent?: string;
    readonly previousCookieValue?: string;
  }): Promise<MintedTrust> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = hashTrustToken(rawToken);
    const days = this.trustDays(input.surface);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const deviceId = await this.tenancyContextService.runInUserContext(
      input.userId,
      async (tx) => {
        const previousHash = this.safeHash(input.previousCookieValue);
        if (previousHash) {
          await tx.trustedDevice.updateMany({
            where: { userId: input.userId, tokenHash: previousHash, revokedAt: null },
            data: { revokedAt: new Date() },
          });
        }

        const created = await tx.trustedDevice.create({
          data: {
            userId: input.userId,
            surface: input.surface,
            tokenHash,
            // NOT NULL in the schema; the frontend renders its own
            // "Unknown device" when this is empty, so an unparseable
            // user agent must not become an invented label.
            label: deriveDeviceLabel(input.userAgent) ?? '',
            userAgent: input.userAgent ?? null,
            expiresAt,
          },
          select: { id: true },
        });

        // In the SAME transaction as the row it describes: a trust that
        // exists without an audit entry, or an entry without a trust, is
        // exactly the discrepancy an auth investigation cannot resolve.
        await this.auditLogWriterService.write(tx, {
          actorUserId: input.userId,
          action: 'auth.device.trusted',
          targetType: 'trusted_device',
          targetId: created.id,
          context: {
            surface: input.surface,
            trustDays: days,
            // The LABEL, never the cookie or its digest.
            label: deriveDeviceLabel(input.userAgent) ?? null,
          },
        });

        return created.id;
      },
    );

    return {
      deviceId,
      cookieValue: rawToken,
      maxAgeSeconds: days * 24 * 60 * 60,
    };
  }

  /** The caller's own remembered browsers, newest activity first. */
  async list(userId: string, cookieValue?: string): Promise<TrustedDeviceResponse[]> {
    const currentHash = this.safeHash(cookieValue);
    const rows = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      tx.trustedDevice.findMany({
        where: { userId, revokedAt: null, expiresAt: { gt: new Date() } },
        orderBy: { lastUsedAt: 'desc' },
      }),
    );
    return rows.map((row) => toResponse(row, currentHash));
  }

  /**
   * Forgets one browser.
   *
   * Scoped by the authenticated user, so another account's device id
   * matches zero rows — reported as `false` (the controller turns that
   * into a 404) rather than confirming that the id exists.
   */
  async revoke(userId: string, deviceId: string): Promise<boolean> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const result = await tx.trustedDevice.updateMany({
        where: { id: deviceId, userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) return false;

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: 'auth.device.revoked',
        targetType: 'trusted_device',
        targetId: deviceId,
        context: { scope: 'one' },
      });
      return true;
    });
  }

  /** Forgets every remembered browser except the one making the request. */
  async revokeOthers(userId: string, cookieValue?: string): Promise<number> {
    const currentHash = this.safeHash(cookieValue);
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const result = await tx.trustedDevice.updateMany({
        where: {
          userId,
          revokedAt: null,
          ...(currentHash ? { NOT: { tokenHash: currentHash } } : {}),
        },
        data: { revokedAt: new Date() },
      });
      if (result.count === 0) return 0;

      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        action: 'auth.device.revoked',
        targetType: 'user',
        targetId: userId,
        context: { scope: 'others', count: result.count },
      });
      return result.count;
    });
  }

  /**
   * Forgets EVERY remembered browser for the account.
   *
   * §12: trust is revoked by a password change, a password reset and
   * "sign out everywhere". Those are precisely the moments the account
   * is being treated as possibly compromised, and a device that could
   * still skip the emailed code afterwards would keep the attacker's
   * browser privileged over the owner's.
   *
   * Never throws: it is called after the password has already been
   * rotated, where failing the whole request would be worse than logging
   * a trust row that outlived its welcome.
   */
  async revokeAllForUser(userId: string, reason: string): Promise<number> {
    try {
      return await this.tenancyContextService.runInUserContext(userId, async (tx) => {
        const result = await tx.trustedDevice.updateMany({
          where: { userId, revokedAt: null },
          data: { revokedAt: new Date() },
        });
        if (result.count === 0) return 0;

        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          action: 'auth.device.revoked',
          targetType: 'user',
          targetId: userId,
          context: { scope: 'all', reason, count: result.count },
        });
        return result.count;
      });
    } catch (error) {
      this.logger.warn(
        { userId, reason, error: error instanceof Error ? error.message : String(error) },
        'Could not revoke trusted devices; the password change itself was not affected.',
      );
      return 0;
    }
  }

  /**
   * Resolves the live row a cookie names, or `null`.
   *
   * `findFirst` rather than a unique lookup on `token_hash` alone: the
   * owner and the surface are part of the match, not a check applied
   * afterwards, so a row belonging to somebody else is never even read.
   */
  private async findLiveDevice(input: {
    readonly userId: string;
    readonly surface: SignInSurface;
    readonly cookieValue?: string;
  }): Promise<TrustedDevice | null> {
    const tokenHash = this.safeHash(input.cookieValue);
    if (!tokenHash) return null;

    try {
      return await this.tenancyContextService.runInUserContext(input.userId, (tx) =>
        tx.trustedDevice.findFirst({
          where: {
            tokenHash,
            userId: input.userId,
            surface: input.surface,
            revokedAt: null,
            expiresAt: { gt: new Date() },
          },
        }),
      );
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Trusted-device lookup failed; the sign-in will ask for a code.',
      );
      return null;
    }
  }

  /** Best-effort "this browser was used" stamp; never fails a sign-in. */
  private async touch(userId: string, deviceId: string): Promise<void> {
    try {
      await this.tenancyContextService.runInUserContext(userId, (tx) =>
        tx.trustedDevice.updateMany({
          where: { id: deviceId, userId },
          data: { lastUsedAt: new Date() },
        }),
      );
    } catch (error) {
      this.logger.debug(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not stamp trusted-device activity (ignored).',
      );
    }
  }

  /** Hashes a presented cookie, or `undefined` when there is nothing usable to hash. */
  private safeHash(cookieValue?: string): string | undefined {
    if (typeof cookieValue !== 'string') return undefined;
    const trimmed = cookieValue.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_COOKIE_LENGTH) return undefined;
    return hashTrustToken(trimmed);
  }
}

function toResponse(
  row: Pick<
    TrustedDevice,
    'id' | 'label' | 'surface' | 'lastUsedAt' | 'expiresAt' | 'tokenHash'
  >,
  currentHash: string | undefined,
): TrustedDeviceResponse {
  return {
    id: row.id,
    label: row.label,
    // Stored as the same two-value vocabulary `SignInDto` validates; a row
    // could only carry something else if it were written outside this
    // service, and the frontend renders the surface badge from it.
    surface: row.surface === 'academy' ? 'academy' : 'management',
    lastUsedAt: row.lastUsedAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    // The digest never leaves the server — only this boolean does.
    current: currentHash !== undefined && row.tokenHash === currentHash,
  };
}

/** `GET /auth/trusted-devices` — matches the frontend's `TrustedDeviceList`. */
export interface TrustedDeviceListResponse {
  readonly items: readonly TrustedDeviceResponse[];
}
