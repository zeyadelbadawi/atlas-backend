/**
 * The single-use secret for an Apple follow-up step (link with password,
 * create the account). Lives in Redis for 10 minutes; only its SHA-256 is a
 * key; taking it deletes it (`GETDEL`), and a fixable failure puts it back.
 */
import { createHash, randomBytes } from 'node:crypto';
import type Redis from 'ioredis';

export const APPLE_PENDING_PREFIX = 'ap.';
export const APPLE_PENDING_TTL_SECONDS = 10 * 60;

export interface ApplePendingState {
  readonly subject: string;
  readonly email: string;
  readonly clientId: string;
  readonly academyId: string;
  /** The host the step must be completed on. */
  readonly hostname: string;
  readonly name: string | null;
  /** Sealed Apple refresh token from the code exchange, if any. */
  readonly sealedRefreshToken: string | null;
}

const keyFor = (secret: string) =>
  `apple:pending:${createHash('sha256').update(secret).digest('hex')}`;

export class ApplePendingStore {
  /** A getter: the shared connection is opened after construction (`onModuleInit`). */
  constructor(private readonly client: () => Redis) {}

  private get redis(): Redis {
    return this.client();
  }

  async issue(state: ApplePendingState): Promise<{ pending: string; expiresAt: Date }> {
    const pending = `${APPLE_PENDING_PREFIX}${randomBytes(32).toString('base64url')}`;
    await this.redis.set(
      keyFor(pending),
      JSON.stringify(state),
      'EX',
      APPLE_PENDING_TTL_SECONDS,
    );
    return {
      pending,
      expiresAt: new Date(Date.now() + APPLE_PENDING_TTL_SECONDS * 1000),
    };
  }

  async take(pending: string): Promise<ApplePendingState | null> {
    if (!pending.startsWith(APPLE_PENDING_PREFIX) || pending.length > 128) return null;
    const raw = await this.redis.getdel(keyFor(pending));
    if (!raw) return null;
    try {
      return JSON.parse(raw) as ApplePendingState;
    } catch {
      return null;
    }
  }

  /** Puts a taken secret back for another try (wrong password, fixable input). */
  async release(pending: string, state: ApplePendingState): Promise<void> {
    await this.redis.set(
      keyFor(pending),
      JSON.stringify(state),
      'EX',
      APPLE_PENDING_TTL_SECONDS,
    );
  }
}
