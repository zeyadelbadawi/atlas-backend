/**
 * W8B — the server key behind the v2 customer-identity hash (trial ledger
 * and gifted-days ledger).
 *
 * SOURCE, IN ORDER:
 *   1. `CUSTOMER_IDENTITY_HMAC_KEY` (64 hex), when an operator provisions a
 *      dedicated key;
 *   2. otherwise an HKDF-SHA256 derivation of the existing, required
 *      `PAYMENT_CREDENTIALS_ENCRYPTION_KEY` under a fixed, purpose-specific
 *      label — the same "derive, don't add a required secret" pattern
 *      `TotpSecretCipher` and `AuthChallengeCipher` use, so the application
 *      boots everywhere it already boots.
 *
 * NON-ROTATING BY DESIGN. Every v2 `subject_hash` is only meaningful under
 * the key that produced it. Changing the key does not lock anyone out — it
 * does the opposite: every past trial and gift silently stops matching and
 * is re-granted. So:
 *   - never rotate `CUSTOMER_IDENTITY_HMAC_KEY` once set;
 *   - before rotating `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`, pin the current
 *     derived value as `CUSTOMER_IDENTITY_HMAC_KEY`
 *     (`deriveCustomerIdentityKey({ paymentCredentialsKeyHex }).toString('hex')`).
 *
 * The key never leaves the process; nothing logs it or the hash inputs.
 */
import { hkdfSync } from 'node:crypto';

const KEY_LENGTH_BYTES = 32;
/** Frozen domain-separation labels — changing either re-grants every trial and gift. */
const HKDF_SALT = 'atlas.customer.identity.hkdf.salt.v2';
const HKDF_INFO = 'atlas.customer.identity.subject.v2';

export interface CustomerIdentityKeySource {
  /** The optional dedicated key (`CUSTOMER_IDENTITY_HMAC_KEY`). */
  readonly dedicatedKeyHex?: string | null;
  /** The required `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`. */
  readonly paymentCredentialsKeyHex: string;
}

function decode32(hex: string, name: string): Buffer {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_LENGTH_BYTES || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must decode to exactly 32 bytes (64 hex characters).`);
  }
  return buf;
}

export function deriveCustomerIdentityKey(source: CustomerIdentityKeySource): Buffer {
  if (source.dedicatedKeyHex) {
    return decode32(source.dedicatedKeyHex, 'CUSTOMER_IDENTITY_HMAC_KEY');
  }
  const root = decode32(
    source.paymentCredentialsKeyHex,
    'PAYMENT_CREDENTIALS_ENCRYPTION_KEY',
  );
  return Buffer.from(hkdfSync('sha256', root, HKDF_SALT, HKDF_INFO, KEY_LENGTH_BYTES));
}

/** For scripts and tests that run outside Nest: the same resolution from `process.env`. */
export function customerIdentityKeyFromEnv(env: NodeJS.ProcessEnv = process.env): Buffer {
  const paymentCredentialsKeyHex = env.PAYMENT_CREDENTIALS_ENCRYPTION_KEY;
  if (!paymentCredentialsKeyHex) {
    throw new Error(
      'PAYMENT_CREDENTIALS_ENCRYPTION_KEY is required to derive the identity key.',
    );
  }
  return deriveCustomerIdentityKey({
    dedicatedKeyHex: env.CUSTOMER_IDENTITY_HMAC_KEY || undefined,
    paymentCredentialsKeyHex,
  });
}
