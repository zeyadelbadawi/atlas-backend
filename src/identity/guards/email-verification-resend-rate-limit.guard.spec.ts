/**
 * `EmailVerificationResendRateLimitGuard` — its own keys (never
 * `password-reset:*`), a per-account ceiling keyed by the AUTHENTICATED
 * user id, and a looser per-IP ceiling.
 */
import { HttpException, HttpStatus } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { EmailVerificationResendRateLimitGuard } from './email-verification-resend-rate-limit.guard';
import type { AuthRateLimiterService } from '../services/auth-rate-limiter.service';

/** An in-memory stand-in with the real fixed-window semantics (no expiry needed here). */
function fakeLimiter() {
  const counts = new Map<string, number>();
  const calls: Array<{ key: string; max: number; windowSeconds: number }> = [];
  const limiter = {
    consume: jest.fn(async (key: string, max: number, windowSeconds: number) => {
      calls.push({ key, max, windowSeconds });
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return count <= max
        ? { allowed: true, retryAfterSeconds: 0 }
        : { allowed: false, retryAfterSeconds: windowSeconds };
    }),
  };
  return { limiter: limiter as unknown as AuthRateLimiterService, calls };
}

const config = {
  getOrThrow: () => ({
    emailVerificationResendRateLimit: { max: 3, ipMax: 5, windowSeconds: 3600 },
  }),
} as unknown as ConfigService;

function contextFor(userId: string | undefined, ip: string): ExecutionContext {
  const request = {
    ip,
    socket: { remoteAddress: ip },
    headers: {},
    body: { email: 'someone-else@example.test' },
    authContext: userId
      ? { userId, sessionId: 's', surface: 'management', academyId: null }
      : undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

async function expect429(promise: Promise<boolean>): Promise<void> {
  await expect(promise).rejects.toBeInstanceOf(HttpException);
  await promise.catch((error: HttpException) => {
    expect(error.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(error.getResponse()).toEqual({ messageKey: 'errors.auth.rateLimited' });
  });
}

describe('EmailVerificationResendRateLimitGuard', () => {
  it('uses its own keys — per user id and per client IP — never the password-reset budget or a body field', async () => {
    const { limiter, calls } = fakeLimiter();
    const guard = new EmailVerificationResendRateLimitGuard(limiter, config);

    await expect(guard.canActivate(contextFor('user-1', '203.0.113.7'))).resolves.toBe(
      true,
    );

    expect(calls).toEqual([
      { key: 'email-verification-resend:ip:203.0.113.7', max: 5, windowSeconds: 3600 },
      { key: 'email-verification-resend:user:user-1', max: 3, windowSeconds: 3600 },
    ]);
    expect(calls.some((call) => call.key.startsWith('password-reset:'))).toBe(false);
    expect(calls.some((call) => call.key.includes('someone-else'))).toBe(false);
  });

  it('refuses the 4th resend for one account in a window, even from different IPs', async () => {
    const { limiter } = fakeLimiter();
    const guard = new EmailVerificationResendRateLimitGuard(limiter, config);

    for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.3']) {
      await expect(guard.canActivate(contextFor('user-1', ip))).resolves.toBe(true);
    }
    await expect429(guard.canActivate(contextFor('user-1', '203.0.113.4')));

    // Another account is unaffected.
    await expect(guard.canActivate(contextFor('user-2', '203.0.113.5'))).resolves.toBe(
      true,
    );
  });

  it('refuses one IP past its own ceiling, across many accounts', async () => {
    const { limiter } = fakeLimiter();
    const guard = new EmailVerificationResendRateLimitGuard(limiter, config);

    for (let i = 0; i < 5; i += 1) {
      await expect(
        guard.canActivate(contextFor(`user-${i}`, '198.51.100.9')),
      ).resolves.toBe(true);
    }
    await expect429(guard.canActivate(contextFor('user-99', '198.51.100.9')));
  });
  it('an IP already over its limit is refused without spending the account budget', async () => {
    const { limiter, calls } = fakeLimiter();
    const guard = new EmailVerificationResendRateLimitGuard(limiter, config);
    const ip = '198.51.100.9';
    // Five different accounts use up the shared address's budget.
    for (const user of ['a', 'b', 'c', 'd', 'e']) {
      await expect(guard.canActivate(contextFor(user, ip))).resolves.toBe(true);
    }
    await expect429(guard.canActivate(contextFor('victim', ip)));
    expect(
      calls.some((call) => call.key === 'email-verification-resend:user:victim'),
    ).toBe(false);
    // The victim still has all three resends from their own address.
    for (let i = 0; i < 3; i += 1) {
      await expect(guard.canActivate(contextFor('victim', '203.0.113.50'))).resolves.toBe(
        true,
      );
    }
  });
});
