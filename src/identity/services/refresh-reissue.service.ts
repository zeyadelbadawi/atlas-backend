/**
 * RefreshReissueService — U-14d / OD-21, lost-response refresh recovery.
 *
 * THE FAILURE. A cookie refresh rotates the session token server-side, but
 * the response (and its `Set-Cookie`) never reaches the browser: the
 * connection drops, the tab is closed, the request times out. The browser
 * still holds the token that was just retired and, on its next attempt,
 * presents it again. Rotation alone cannot tell that from a stolen copy, so
 * the person was signed out (refused within the stale-tab grace, the whole
 * family revoked after it).
 *
 * THE MECHANISM. When a cookie refresh rotates token A into its successor S,
 * this service keeps — for at most `REFRESH_REISSUE_WINDOW_SECONDS` (≤ 30) —
 * a short Redis record keyed by A's hash holding:
 *   - S, AES-256-GCM-encrypted under a key DERIVED FROM RAW A (HKDF). Only a
 *     caller presenting A itself can open it; a read of Redis, of the
 *     database (which holds only SHA-256(A)), or of both yields nothing
 *     usable;
 *   - a digest of the presenting client (cookie transport, User-Agent,
 *     `atlas_device` cookie, host), bound into the ciphertext as AAD so it
 *     cannot be swapped.
 * `AuthService.refresh` consults it only after A failed to rotate, and hands
 * back the SAME S — never a new token — only when the record opens, the
 * client digest matches and the database confirms S is A's direct, still
 * unused, live successor. Re-issuing mints nothing, so it can never create a
 * second chain; every other presentation of A follows the existing reuse
 * rules. See docs/REFRESH_TOKEN_LOST_RESPONSE_RECOVERY.md.
 *
 * FAILURE BEHAVIOUR. Redis is best-effort here and every failure fails
 * CLOSED to the pre-existing behaviour (no recovery): a write that errors or
 * takes longer than `WRITE_BUDGET_MS` is dropped (it runs inside the
 * rotation's transaction and must never hold that row lock for long), and a
 * read that errors is treated as "no record".
 */
import { Injectable, Logger } from '@nestjs/common';
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
} from 'node:crypto';
import { RedisService } from '../../redis/redis.service';

const KEY_PREFIX = 'refresh:reissue:';
const RECORD_VERSION = 1;
const HKDF_SALT = 'atlas.refresh-reissue';
const HKDF_INFO = 'successor-v1';
/** Longest the rotation transaction waits on the Redis write. */
const WRITE_BUDGET_MS = 250;
/** Longest a failed refresh waits on the Redis read. */
const READ_BUDGET_MS = 250;

/** The presenting client, as the server itself observed it. */
export interface ReissueClientBinding {
  /** Only the HttpOnly cookie transport is ever eligible. */
  readonly channel: 'cookie' | 'body';
  readonly userAgent?: string;
  readonly deviceCookie?: string;
  readonly hostname?: string;
}

interface StoredRecord {
  readonly v: number;
  /** SHA-256 of the client binding. */
  readonly b: string;
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

/** What a failed refresh learns about a recently rotated token. */
export type ReissueLookup =
  | { readonly kind: 'none' }
  /** The token was rotated moments ago by a DIFFERENT client — or moved out of its cookie. */
  | { readonly kind: 'foreign' }
  | { readonly kind: 'successor'; readonly successorToken: string };

function withBudget<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

@Injectable()
export class RefreshReissueService {
  private readonly logger = new Logger(RefreshReissueService.name);

  constructor(private readonly redisService: RedisService) {}

  /** SHA-256 of the client binding — stable, order-fixed, never the raw values. */
  static bindingDigest(binding: ReissueClientBinding): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          binding.channel,
          binding.userAgent ?? '',
          binding.deviceCookie ?? '',
          (binding.hostname ?? '').toLowerCase(),
        ]),
      )
      .digest('hex');
  }

  private static key(presentedHash: string): string {
    return `${KEY_PREFIX}${presentedHash}`;
  }

  private static derive(presentedToken: string): Buffer {
    return Buffer.from(hkdfSync('sha256', presentedToken, HKDF_SALT, HKDF_INFO, 32));
  }

  private static aad(presentedHash: string, bindingDigest: string): Buffer {
    return Buffer.from(`${presentedHash}|${bindingDigest}`, 'utf8');
  }

  /**
   * Records that `presentedToken` was rotated into `successorToken` by this
   * client. Called INSIDE the rotation's transaction, before commit, so a
   * concurrent duplicate that was waiting on the row lock already finds it.
   * Never throws; a slow or failed write simply means no recovery.
   */
  async remember(
    presentedToken: string,
    presentedHash: string,
    successorToken: string,
    binding: ReissueClientBinding,
    windowSeconds: number,
  ): Promise<void> {
    if (windowSeconds <= 0 || binding.channel !== 'cookie') return;
    const b = RefreshReissueService.bindingDigest(binding);
    const iv = randomBytes(12);
    const cipher = createCipheriv(
      'aes-256-gcm',
      RefreshReissueService.derive(presentedToken),
      iv,
    );
    cipher.setAAD(RefreshReissueService.aad(presentedHash, b));
    const ct = Buffer.concat([cipher.update(successorToken, 'utf8'), cipher.final()]);
    const record: StoredRecord = {
      v: RECORD_VERSION,
      b,
      iv: iv.toString('base64url'),
      tag: cipher.getAuthTag().toString('base64url'),
      ct: ct.toString('base64url'),
    };
    const written = await withBudget(
      this.redisService
        .getClient()
        .set(
          RefreshReissueService.key(presentedHash),
          JSON.stringify(record),
          'EX',
          windowSeconds,
        )
        .then(() => true),
      WRITE_BUDGET_MS,
      false,
    );
    if (!written) {
      this.logger.warn(
        { event: 'auth.refresh.reissue_record_unavailable' },
        'Could not record the rotation for lost-response recovery; a lost response will need a new sign-in.',
      );
    }
  }

  /**
   * After `presentedToken` failed to rotate: the successor it was rotated
   * into moments ago, if THIS client was the one that rotated it. The caller
   * must still confirm against the database that the successor is the
   * direct, unused, live next row of the same family.
   */
  async lookup(
    presentedToken: string,
    presentedHash: string,
    binding: ReissueClientBinding,
  ): Promise<ReissueLookup> {
    const raw = await withBudget(
      this.redisService.getClient().get(RefreshReissueService.key(presentedHash)),
      READ_BUDGET_MS,
      null,
    );
    if (!raw) return { kind: 'none' };
    let record: StoredRecord;
    try {
      record = JSON.parse(raw) as StoredRecord;
    } catch {
      return { kind: 'none' };
    }
    if (record?.v !== RECORD_VERSION || typeof record.b !== 'string')
      return { kind: 'none' };
    let successorToken: string;
    try {
      // Opened first, with the STORED client digest as AAD: only a record
      // this service wrote for this very token counts for anything — a
      // tampered, truncated or foreign record is ignored, never acted on.
      const decipher = createDecipheriv(
        'aes-256-gcm',
        RefreshReissueService.derive(presentedToken),
        Buffer.from(record.iv, 'base64url'),
      );
      decipher.setAAD(RefreshReissueService.aad(presentedHash, record.b));
      decipher.setAuthTag(Buffer.from(record.tag, 'base64url'));
      successorToken = Buffer.concat([
        decipher.update(Buffer.from(record.ct, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return { kind: 'none' };
    }
    if (!successorToken) return { kind: 'none' };
    // A genuine record, but the token comes back from another client (or out
    // of its cookie) seconds after this client rotated it.
    if (record.b !== RefreshReissueService.bindingDigest(binding))
      return { kind: 'foreign' };
    return { kind: 'successor', successorToken };
  }
}
