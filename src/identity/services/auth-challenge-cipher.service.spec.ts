/**
 * The two primitives the whole email-OTP step rests on (P64 C4).
 *
 * These are not "does the helper work" tests. Each one pins a property
 * that, if it silently stopped holding, would leave the feature looking
 * completely functional in a browser while providing no security:
 *
 *  - a sealed reference that could be FORGED would let anyone open
 *    somebody else's challenge without ever seeing a code;
 *  - a sealed reference that leaked its ids in plaintext would hand a
 *    half-authenticated client a user id it has no business knowing;
 *  - a code hash that did not bind the challenge row would let a
 *    `code_hash` lifted from one challenge satisfy another;
 *  - a comparison that was not constant-time would leak the digest a
 *    byte at a time to anyone willing to measure.
 */
import { ConfigService } from '@nestjs/config';
import { randomBytes, randomUUID } from 'node:crypto';
import { AuthChallengeCipher } from './auth-challenge-cipher.service';

function build(keyHex = randomBytes(32).toString('hex')): AuthChallengeCipher {
  const configService = {
    getOrThrow: () => ({ credentialEncryptionKeyHex: keyHex }),
  } as unknown as ConfigService;
  return new AuthChallengeCipher(configService);
}

describe('AuthChallengeCipher', () => {
  const challengeRowId = randomUUID();
  const userId = randomUUID();

  it('refuses to construct without a real 32-byte key', () => {
    expect(() => build('abcd')).toThrow(/32 bytes/);
  });

  describe('challenge references', () => {
    it('round-trips the owner and the row id', () => {
      const cipher = build();
      const sealed = cipher.sealChallengeRef({ challengeRowId, userId });
      expect(cipher.openChallengeRef(sealed)).toEqual({ challengeRowId, userId });
    });

    it('never exposes either id in the token itself', () => {
      const cipher = build();
      const sealed = cipher.sealChallengeRef({ challengeRowId, userId });
      expect(sealed).not.toContain(userId);
      expect(sealed).not.toContain(challengeRowId);
    });

    it('produces a different token every time for the same input', () => {
      // A deterministic token would be a stable identifier for the
      // account across sign-ins, and would leak that two challenges
      // belong to the same person.
      const cipher = build();
      const first = cipher.sealChallengeRef({ challengeRowId, userId });
      const second = cipher.sealChallengeRef({ challengeRowId, userId });
      expect(first).not.toBe(second);
      expect(cipher.openChallengeRef(second)).toEqual({ challengeRowId, userId });
    });

    it('refuses a token whose ciphertext was edited (the GCM tag fails closed)', () => {
      const cipher = build();
      const sealed = cipher.sealChallengeRef({ challengeRowId, userId });
      const raw = Buffer.from(sealed, 'base64url');
      raw[raw.length - 1] ^= 0xff;
      expect(cipher.openChallengeRef(raw.toString('base64url'))).toBeNull();
    });

    it('refuses a token whose authentication tag was edited', () => {
      const cipher = build();
      const sealed = cipher.sealChallengeRef({ challengeRowId, userId });
      const raw = Buffer.from(sealed, 'base64url');
      raw[13] ^= 0xff;
      expect(cipher.openChallengeRef(raw.toString('base64url'))).toBeNull();
    });

    it('refuses a token sealed under a different server key', () => {
      const sealed = build().sealChallengeRef({ challengeRowId, userId });
      expect(build().openChallengeRef(sealed)).toBeNull();
    });

    it.each([
      ['empty', ''],
      ['not base64url at all', '!!!!not-a-token!!!!'],
      ['too short to contain an IV and tag', Buffer.alloc(8).toString('base64url')],
      ['absurdly long', 'A'.repeat(10_000)],
    ])('refuses a %s reference', (_label, token) => {
      expect(build().openChallengeRef(token)).toBeNull();
    });

    it('refuses a reference whose plaintext is not two uuids', () => {
      // Guards the decrypt path itself: anything that somehow decrypted
      // to a non-id must never reach a `WHERE` clause.
      const cipher = build();
      const forged = (
        cipher as unknown as {
          sealChallengeRef(input: { challengeRowId: string; userId: string }): string;
        }
      ).sealChallengeRef({ challengeRowId: 'not-a-uuid', userId });
      expect(cipher.openChallengeRef(forged)).toBeNull();
    });
  });

  describe('code hashing', () => {
    it('is stable for the same challenge, salt and code', () => {
      const cipher = build();
      const salt = cipher.newSalt();
      const a = cipher.hashCode({ challengeRowId, salt, code: '123456' });
      const b = cipher.hashCode({ challengeRowId, salt, code: '123456' });
      expect(a).toBe(b);
      expect(a).toHaveLength(64);
    });

    it('never stores anything resembling the code', () => {
      const cipher = build();
      const hash = cipher.hashCode({
        challengeRowId,
        salt: cipher.newSalt(),
        code: '123456',
      });
      expect(hash).not.toContain('123456');
    });

    it('differs for a different code', () => {
      const cipher = build();
      const salt = cipher.newSalt();
      expect(cipher.hashCode({ challengeRowId, salt, code: '123456' })).not.toBe(
        cipher.hashCode({ challengeRowId, salt, code: '123457' }),
      );
    });

    it('binds the CHALLENGE, so a hash cannot be replayed onto another one', () => {
      const cipher = build();
      const salt = cipher.newSalt();
      expect(cipher.hashCode({ challengeRowId, salt, code: '123456' })).not.toBe(
        cipher.hashCode({ challengeRowId: randomUUID(), salt, code: '123456' }),
      );
    });

    it('binds the SALT, so two challenges never share a digest for one code', () => {
      const cipher = build();
      expect(
        cipher.hashCode({ challengeRowId, salt: cipher.newSalt(), code: '123456' }),
      ).not.toBe(
        cipher.hashCode({ challengeRowId, salt: cipher.newSalt(), code: '123456' }),
      );
    });

    it('binds the SERVER KEY, so a stolen table yields nothing without it', () => {
      const salt = 'fixed-salt';
      expect(build().hashCode({ challengeRowId, salt, code: '123456' })).not.toBe(
        build().hashCode({ challengeRowId, salt, code: '123456' }),
      );
    });

    it('tolerates whitespace a user copied out of the email', () => {
      const cipher = build();
      const salt = cipher.newSalt();
      expect(cipher.hashCode({ challengeRowId, salt, code: ' 123 456 ' })).toBe(
        cipher.hashCode({ challengeRowId, salt, code: '123456' }),
      );
    });

    it('generates a fresh salt each time', () => {
      const cipher = build();
      expect(cipher.newSalt()).not.toBe(cipher.newSalt());
    });
  });

  describe('digestsEqual', () => {
    it('accepts identical digests and refuses different ones', () => {
      const cipher = build();
      const salt = cipher.newSalt();
      const digest = cipher.hashCode({ challengeRowId, salt, code: '123456' });
      const other = cipher.hashCode({ challengeRowId, salt, code: '654321' });
      expect(cipher.digestsEqual(digest, digest)).toBe(true);
      expect(cipher.digestsEqual(digest, other)).toBe(false);
    });

    it('refuses empty and mismatched-length input rather than throwing', () => {
      // `timingSafeEqual` throws on a length mismatch; a comparison that
      // propagated that would turn malformed stored data into a 500 on
      // the sign-in path.
      const cipher = build();
      expect(cipher.digestsEqual('', '')).toBe(false);
      expect(cipher.digestsEqual('ab', 'abcd')).toBe(false);
      expect(cipher.digestsEqual('zz', 'zz')).toBe(false);
    });
  });
});
