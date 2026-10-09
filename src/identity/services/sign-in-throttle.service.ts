/**
 * ATO review F7 — sign-in throttling that an attacker cannot turn into a
 * lockout of somebody else's account.
 *
 * BEFORE: one budget per typed email (10 attempts / 15 minutes) consumed by
 * every attempt from anywhere. Anyone who knew an address could keep its
 * owner out indefinitely by sending ten wrong passwords every fifteen
 * minutes.
 *
 * NOW (OWASP "device cookies" pattern), every password attempt passes:
 *
 *   1. PER IP — a broad flood limit (`ipMax`), shared by every account the
 *      address tries; generous enough for a classroom behind one NAT.
 *   2. PER ACCOUNT FROM ONE NETWORK — the strict `max` budget, keyed by the
 *      email AND the client's network (IPv4 /24, IPv6 /64). An attacker
 *      exhausts it only for their own network; the owner, elsewhere, is
 *      unaffected.
 *   3. PER ACCOUNT, ANYWHERE — a ceiling on FAILED passwords for the
 *      address across every network (`accountFailureCeiling` per
 *      `accountFailureWindowSeconds`), which is what stops a distributed
 *      guess campaign. Past it, the address is closed to unknown browsers
 *      only: a browser that has signed in to this account before carries a
 *      signed "known device" cookie and keeps its own per-device budget.
 *
 * Failures are counted for every address, existing or not, and every check
 * answers the same generic 429 — none of it says whether an account exists.
 *
 * THE KNOWN-DEVICE COOKIE is `v1.<nonce>.<mac>` with the mac an HMAC of the
 * nonce and the normalised email under a dedicated key
 * (`SIGNIN_DEVICE_COOKIE_KEY`, else HKDF of the required payment-credentials
 * key under its own label). It grants nothing but its own throttle bucket —
 * never a session, never a skipped factor — so it is stateless, and
 * rotating the key only makes every browser "unknown" again.
 */
import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IdentityConfig } from '../../config/configuration';
import { RedisService } from '../../redis/redis.service';
import { AuthRateLimiterService } from './auth-rate-limiter.service';

export const SECURE_KNOWN_DEVICE_COOKIE = '__Host-atlas_known';
export const PLAIN_KNOWN_DEVICE_COOKIE = 'atlas_known';
export const KNOWN_DEVICE_COOKIE_MAX_AGE_DAYS = 180;

const KEY_LENGTH_BYTES = 32;
const HKDF_SALT = 'atlas.signin.known-device.hkdf.salt.v1';
const HKDF_INFO = 'atlas.signin.known-device.v1';
const MAX_COOKIE_LENGTH = 128;

export type SignInThrottleRefusal = 'ip_budget' | 'account_budget' | 'account_ceiling';

export interface SignInAttempt {
  /** Normalised email, when the request names one. */
  readonly email?: string;
  readonly ipAddress?: string;
  /** The raw known-device cookie value, if the browser sent one. */
  readonly knownDeviceCookie?: string;
}

/** `cookie name` for this request's scheme (`__Host-` needs Secure). */
export function knownDeviceCookieName(secure: boolean): string {
  return secure ? SECURE_KNOWN_DEVICE_COOKIE : PLAIN_KNOWN_DEVICE_COOKIE;
}

/**
 * The network an address belongs to for throttling: IPv4 /24, IPv6 /64.
 * An IPv4-mapped IPv6 address is treated as the IPv4 it carries.
 */
export function networkOf(ipAddress: string | undefined): string {
  if (!ipAddress) return 'unknown';
  const ip = ipAddress.startsWith('::ffff:') ? ipAddress.slice(7) : ipAddress;
  if (isIP(ip) === 4) return `${ip.split('.').slice(0, 3).join('.')}.0/24`;
  if (isIP(ip) === 6) return `${expandIpv6(ip).slice(0, 4).join(':')}::/64`;
  return 'unknown';
}

function expandIpv6(ip: string): string[] {
  const [head, tail] = ip.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const fill = tail === undefined ? [] : Array(8 - left.length - right.length).fill('0');
  return [...left, ...fill, ...right].map((part) =>
    part.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

/** Resolves the cookie key: the dedicated one, else an HKDF derivation. */
export function deriveKnownDeviceKey(source: {
  readonly dedicatedKeyHex?: string | null;
  readonly paymentCredentialsKeyHex: string;
}): Buffer {
  if (source.dedicatedKeyHex) {
    const key = Buffer.from(source.dedicatedKeyHex, 'hex');
    if (key.length !== KEY_LENGTH_BYTES) {
      throw new Error('SIGNIN_DEVICE_COOKIE_KEY must be 64 hex characters.');
    }
    return key;
  }
  const root = Buffer.from(source.paymentCredentialsKeyHex, 'hex');
  return Buffer.from(hkdfSync('sha256', root, HKDF_SALT, HKDF_INFO, KEY_LENGTH_BYTES));
}

@Injectable()
export class SignInThrottleService {
  private readonly key: Buffer;

  constructor(
    private readonly rateLimiter: AuthRateLimiterService,
    private readonly redisService: RedisService,
    private readonly configService: ConfigService,
  ) {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    this.key = deriveKnownDeviceKey(identity.knownDeviceKeySource);
  }

  /**
   * Consumes this attempt's budgets; `null` when it may proceed, otherwise
   * which limit refused it (for the caller's security event — the client
   * only ever sees the generic 429).
   */
  async check(attempt: SignInAttempt): Promise<SignInThrottleRefusal | null> {
    const limits =
      this.configService.getOrThrow<IdentityConfig>('identity').signInRateLimit;

    const ip = await this.rateLimiter.consume(
      `signin:ip:${attempt.ipAddress ?? 'unknown'}`,
      limits.ipMax,
      limits.windowSeconds,
    );
    if (!ip.allowed) return 'ip_budget';
    if (!attempt.email) return null;

    // A browser that signed in to this very account before keeps its own
    // budget and is not subject to the account-wide ceiling.
    const device = this.readKnownDevice(attempt.knownDeviceCookie, attempt.email);
    if (device) {
      const own = await this.rateLimiter.consume(
        `signin:device:${device}`,
        limits.max,
        limits.windowSeconds,
      );
      return own.allowed ? null : 'account_budget';
    }

    const failures = Number(
      (await this.redisService
        .getClient()
        .get(`ratelimit:${this.failureKey(attempt.email)}`)) ?? 0,
    );
    if (failures >= limits.accountFailureCeiling) return 'account_ceiling';

    const network = await this.rateLimiter.consume(
      `signin:account-net:${attempt.email}:${networkOf(attempt.ipAddress)}`,
      limits.max,
      limits.windowSeconds,
    );
    return network.allowed ? null : 'account_budget';
  }

  /** `check`, throwing the generic 429 when refused. */
  async enforce(attempt: SignInAttempt): Promise<void> {
    if ((await this.check(attempt)) !== null) {
      throw new HttpException(
        { messageKey: 'errors.auth.rateLimited' },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /** One failed password for this address (known or not), toward the ceiling. */
  async recordFailure(email: string): Promise<void> {
    const limits =
      this.configService.getOrThrow<IdentityConfig>('identity').signInRateLimit;
    try {
      await this.rateLimiter.consume(
        this.failureKey(email),
        Number.MAX_SAFE_INTEGER,
        limits.accountFailureWindowSeconds,
      );
    } catch {
      // Counting is best-effort; a Redis hiccup must not change the answer.
    }
  }

  /** A fresh known-device cookie value for this address. */
  mintKnownDevice(email: string): string {
    const nonce = randomBytes(16).toString('base64url');
    return `v1.${nonce}.${this.mac(nonce, email)}`;
  }

  /** The device nonce when `cookie` was minted for `email`, else `null`. */
  readKnownDevice(cookie: string | undefined, email: string): string | null {
    if (typeof cookie !== 'string' || cookie.length > MAX_COOKIE_LENGTH) return null;
    const [version, nonce, mac] = cookie.split('.');
    if (version !== 'v1' || !nonce || !mac) return null;
    const expected = Buffer.from(this.mac(nonce, email));
    const presented = Buffer.from(mac);
    if (expected.length !== presented.length) return null;
    return timingSafeEqual(expected, presented) ? nonce : null;
  }

  private mac(nonce: string, email: string): string {
    return createHmac('sha256', this.key)
      .update(`v1:${nonce}:${email}`)
      .digest('base64url');
  }

  /** Under `AuthRateLimiterService`'s `ratelimit:` namespace. */
  private failureKey(email: string): string {
    return `signin:account-failures:${email}`;
  }
}
