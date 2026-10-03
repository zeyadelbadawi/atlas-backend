/**
 * SecurityEventHasher — the two keyed hashes `security_events` stores in
 * place of an email address and a client IP (W3, investigation §4.3).
 *
 * KEY MATERIAL. Both keys are HMAC derivations of the server's existing
 * `JWT_ACCESS_SECRET` under fixed, purpose-specific labels — the same
 * pattern `PlatformContactIntakeService` uses for its `ip_hash`. No new
 * required secret: the application boots wherever it booted before, and
 * a database dump alone yields nothing reversible (six-digit codes are not
 * stored here at all; emails and IPs need the server secret to even test a
 * guess). Rotating the JWT secret simply starts new hashes.
 *
 *  - `subjectHash(email)` — HMAC-SHA256 over the NORMALISED address, so
 *    "User@X.com " and "user@x.com" correlate. Stable, so the Platform Owner
 *    can filter by an address they were given in a support case: the server
 *    hashes the input and compares, the address is never stored.
 *  - `ipHash(ip, at)` — HMAC-SHA256 under a MONTHLY key (`YYYY-MM` mixed
 *    into the derivation). Requests from one address correlate within a
 *    month; across months they do not, which bounds how long a network can
 *    be tracked. A filter by IP hashes the input under each month the
 *    query window spans (`ipHashesForWindow`).
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { IdentityConfig } from '../../config/configuration';
import { normalizeEmail } from '../../identity/utils/email.util';

const SUBJECT_KEY_LABEL = 'atlas:security-events:subject-hash:v1';
const IP_KEY_LABEL = 'atlas:security-events:ip-hash:v1';

/** `YYYY-MM` in UTC — the IP key's rotation period. */
export function ipKeyPeriod(at: Date): string {
  return at.toISOString().slice(0, 7);
}

@Injectable()
export class SecurityEventHasher {
  private readonly subjectKey: Buffer;
  private readonly ipBaseKey: Buffer;

  constructor(configService: ConfigService) {
    const secret = configService.getOrThrow<IdentityConfig>('identity').jwtAccessSecret;
    this.subjectKey = createHmac('sha256', secret).update(SUBJECT_KEY_LABEL).digest();
    this.ipBaseKey = createHmac('sha256', secret).update(IP_KEY_LABEL).digest();
  }

  /** Keyed hash of a normalised email, or `null` when there is none. */
  subjectHash(email: string | null | undefined): string | null {
    if (typeof email !== 'string' || email.trim() === '') return null;
    return createHmac('sha256', this.subjectKey)
      .update(normalizeEmail(email))
      .digest('hex');
  }

  /** Keyed hash of a client IP under the key of `at`'s month, or `null`. */
  ipHash(ip: string | null | undefined, at: Date = new Date()): string | null {
    if (typeof ip !== 'string' || ip.trim() === '') return null;
    const monthKey = createHmac('sha256', this.ipBaseKey)
      .update(ipKeyPeriod(at))
      .digest();
    return createHmac('sha256', monthKey).update(ip.trim().toLowerCase()).digest('hex');
  }

  /** Every hash `ip` can have inside `[from, to]` — one per calendar month spanned. */
  ipHashesForWindow(ip: string, from: Date, to: Date): string[] {
    const hashes = new Set<string>();
    const cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1));
    while (cursor <= to) {
      const hash = this.ipHash(ip, cursor);
      if (hash) hashes.add(hash);
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }
    return [...hashes];
  }
}
