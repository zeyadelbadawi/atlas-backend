/**
 * PasswordHasherService.
 *
 * Argon2id only (master plan §8 "Password hashing", §21 P1 requirement).
 * Parameters follow current OWASP Password Storage Cheat Sheet guidance for
 * Argon2id (m=19 MiB, t=2, p=1 is OWASP's minimum-recommended profile) —
 * kept as named constants rather than magic numbers so a future phase can
 * retune them without hunting through call sites.
 */
import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';

const ARGON2ID_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456, // KiB (~19 MiB) — OWASP minimum profile.
  timeCost: 2,
  parallelism: 1,
};

@Injectable()
export class PasswordHasherService {
  async hash(plaintext: string): Promise<string> {
    return argon2.hash(plaintext, ARGON2ID_OPTIONS);
  }

  async verify(hash: string, plaintext: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plaintext);
    } catch {
      // A malformed/foreign hash format throws rather than returning false —
      // treat that identically to "does not match" rather than leaking the
      // distinction to the caller.
      return false;
    }
  }
}
