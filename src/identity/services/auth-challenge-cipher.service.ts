/**
 * AuthChallengeCipher — the two cryptographic primitives the email-OTP
 * step needs (P64 Communications C4, §12).
 *
 * 1. `hashCode` — HMAC-SHA256 of an emailed code under a SERVER key plus
 *    the challenge's own random salt and its row id. §12 specifies exactly
 *    this: "codeHash (HMAC-SHA256 with a server secret + per-challenge
 *    salt)". A raw code is therefore never stored, and a stolen database
 *    dump does not yield working codes without the server key. Binding the
 *    row id into the message as well means a `code_hash` lifted from one
 *    challenge cannot be pasted onto another.
 *
 *    SHA-256 rather than Argon2 is deliberate and safe HERE, for the same
 *    reason `TwoFactorService.hashRecoveryCode` documents: the guessing
 *    budget is five attempts on a server-side counter, not an offline
 *    dictionary attack, and this runs on a login path that must stay fast.
 *    The attempt ceiling, not the KDF cost, is what makes six digits safe.
 *
 * 2. `sealChallengeRef` / `openChallengeRef` — the opaque `challengeId`
 *    the client is given. It is AES-256-GCM over `"<rowId>.<userId>"`.
 *
 *    WHY ENCRYPTED RATHER THAN A RANDOM LOOKUP KEY. `POST /auth/otp/verify`
 *    is reached by a caller holding no session, so the server has no user
 *    id until it has resolved the challenge — and resolving it from the
 *    database first would mean reading a user-owned row with NO tenancy
 *    context set, which this codebase does not do for user data. Sealing
 *    the owner into the reference inverts that: the user id is recovered
 *    from the reference itself, in memory, and EVERY database statement
 *    that follows runs inside `runInUserContext(userId)` where
 *    `auth_email_challenges`/`trusted_devices` RLS can independently agree
 *    with the service's own `WHERE user_id = ...` scoping.
 *
 *    The reference is opaque to the client (ciphertext, so it leaks
 *    neither id), tamper-evident (the GCM tag fails closed — a forged or
 *    edited reference decrypts to nothing and is refused before any query
 *    runs), and it is NOT a credential: it authenticates nothing on its
 *    own, is accepted by exactly two endpoints, and still requires the
 *    emailed code, which is what the challenge actually tests.
 *
 * KEY MATERIAL. Both keys are HKDF-SHA256 derivations of the existing
 * `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under distinct, purpose-specific
 * labels — the identical reasoning `TotpSecretCipher` sets out at length:
 * real cryptographic domain separation without a new REQUIRED secret that
 * would stop the application booting wherever it is not yet configured.
 * Rotating the underlying key invalidates in-flight challenges and every
 * trusted-device row's usefulness; both are cheap to re-establish (sign in
 * again, prove the code again), unlike a TOTP secret.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { PaymentConfigurationConfig } from '../../config/configuration';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH_BYTES = 12;
const TAG_LENGTH_BYTES = 16;
const KEY_LENGTH_BYTES = 32;

/** Domain-separation labels. Changing one invalidates everything sealed/hashed under it — treat as frozen. */
const HKDF_INFO_REF = 'atlas.auth.challenge.ref.v1';
const HKDF_INFO_CODE = 'atlas.auth.challenge.code.v1';
/** Fixed, non-secret salt: the input key material is already a 256-bit key, so the salt's job is separation, not entropy. */
const HKDF_SALT = 'atlas.auth.challenge.hkdf.salt.v1';

/** A sealed reference never exceeds this; anything longer is refused before it is decoded. */
const MAX_REFERENCE_LENGTH = 512;

export interface ChallengeReference {
  /** The `auth_email_challenges` row id. */
  readonly challengeRowId: string;
  /** The account the challenge belongs to — recovered from the seal, never from the client. */
  readonly userId: string;
}

@Injectable()
export class AuthChallengeCipher {
  private readonly referenceKey: Buffer;
  private readonly codeKey: Buffer;

  constructor(private readonly configService: ConfigService) {
    const { credentialEncryptionKeyHex } =
      this.configService.getOrThrow<PaymentConfigurationConfig>('paymentConfiguration');

    const rootKey = Buffer.from(credentialEncryptionKeyHex, 'hex');
    if (rootKey.length !== KEY_LENGTH_BYTES) {
      throw new Error(
        'PAYMENT_CREDENTIALS_ENCRYPTION_KEY must decode to exactly 32 bytes.',
      );
    }

    this.referenceKey = Buffer.from(
      hkdfSync('sha256', rootKey, HKDF_SALT, HKDF_INFO_REF, KEY_LENGTH_BYTES),
    );
    this.codeKey = Buffer.from(
      hkdfSync('sha256', rootKey, HKDF_SALT, HKDF_INFO_CODE, KEY_LENGTH_BYTES),
    );
  }

  /** A fresh per-challenge salt, stored in `auth_email_challenges.salt`. */
  newSalt(): string {
    return randomBytes(16).toString('hex');
  }

  /**
   * HMAC of one code, bound to its own challenge row and salt.
   *
   * The code is normalised (whitespace stripped) first so a user who
   * copied "123 456" out of an email is not failed for the space.
   */
  hashCode(input: {
    readonly challengeRowId: string;
    readonly salt: string;
    readonly code: string;
  }): string {
    const normalised = input.code.replace(/\s/g, '');
    return createHmac('sha256', this.codeKey)
      .update(`${input.challengeRowId}.${input.salt}.${normalised}`)
      .digest('hex');
  }

  /**
   * Constant-time comparison of two hex digests.
   *
   * `timingSafeEqual` throws on a length mismatch, so the lengths are
   * compared first — and because both operands are always our own
   * 32-byte HMAC output, that check never distinguishes two real
   * candidates, only malformed stored data.
   */
  digestsEqual(a: string, b: string): boolean {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length === 0 || bufA.length !== bufB.length) return false;
    return timingSafeEqual(bufA, bufB);
  }

  /** Seals `{challengeRowId, userId}` into the opaque reference handed to the client. */
  sealChallengeRef(reference: ChallengeReference): string {
    const iv = randomBytes(IV_LENGTH_BYTES);
    const cipher = createCipheriv(ALGORITHM, this.referenceKey, iv, {
      authTagLength: TAG_LENGTH_BYTES,
    });
    const ciphertext = Buffer.concat([
      cipher.update(`${reference.challengeRowId}.${reference.userId}`, 'utf8'),
      cipher.final(),
    ]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
  }

  /**
   * Recovers a sealed reference, or `null` for ANY failure — unknown
   * encoding, wrong length, a failed GCM tag, an unexpected payload
   * shape. The caller turns `null` into the same generic refusal a wrong
   * code gets, so a forged reference and a real one that has expired look
   * identical from outside.
   */
  openChallengeRef(token: string): ChallengeReference | null {
    if (typeof token !== 'string' || token.length === 0) return null;
    if (token.length > MAX_REFERENCE_LENGTH) return null;

    let raw: Buffer;
    try {
      raw = Buffer.from(token, 'base64url');
    } catch {
      return null;
    }
    if (raw.length <= IV_LENGTH_BYTES + TAG_LENGTH_BYTES) return null;

    const iv = raw.subarray(0, IV_LENGTH_BYTES);
    const tag = raw.subarray(IV_LENGTH_BYTES, IV_LENGTH_BYTES + TAG_LENGTH_BYTES);
    const ciphertext = raw.subarray(IV_LENGTH_BYTES + TAG_LENGTH_BYTES);

    try {
      // W13 — pinned: the tag slice above is always 16 bytes, and the
      // decipher must agree rather than accept whatever length it is given.
      const decipher = createDecipheriv(ALGORITHM, this.referenceKey, iv, {
        authTagLength: TAG_LENGTH_BYTES,
      });
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]).toString('utf8');

      const [challengeRowId, userId, ...rest] = plaintext.split('.');
      if (rest.length > 0) return null;
      if (!isUuid(challengeRowId) || !isUuid(userId)) return null;
      return { challengeRowId, userId };
    } catch {
      return null;
    }
  }
}

/**
 * Both halves of a sealed reference are database ids that go straight
 * into a parameterised `WHERE`. Shape-checking them here means a
 * decryption that somehow produced garbage is refused before it reaches
 * Postgres, rather than relying on the query to reject it.
 */
function isUuid(value: string | undefined): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
