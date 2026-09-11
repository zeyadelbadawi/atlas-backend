import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { SessionActivityService } from '../services/session-activity.service';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenService } from '../services/access-token.service';
import type { SessionRevocationService } from '../services/session-revocation.service';

/** Phase 10 — the guard now consults session revocation. Default: nothing revoked, so these tests keep asserting the token-shape behaviour they were written for. */
function revocationService(isRevoked = false): SessionRevocationService {
  return {
    isRevoked: jest.fn(async () => isRevoked),
  } as unknown as SessionRevocationService;
}

function buildContext(headerValue: string | undefined): {
  context: ExecutionContext;
  request: { authContext?: unknown };
} {
  const request: { authContext?: unknown } = {};
  const req = {
    header: (name: string) =>
      name.toLowerCase() === 'authorization' ? headerValue : undefined,
    get authContext() {
      return request.authContext;
    },
    set authContext(value: unknown) {
      request.authContext = value;
    },
  };
  const context = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  return { context, request };
}

/**
 * Activity recording is fire-and-forget telemetry the guard performs
 * after authenticating. These stubs keep it inert so the tests stay about
 * authentication — and `recordActivity` resolving false means the
 * database is never touched from a unit test.
 */
const activityService = () =>
  ({
    trackRequest: jest.fn().mockResolvedValue(undefined),
    recordActivity: jest.fn().mockResolvedValue(false),
    getRecentActivity: jest.fn().mockResolvedValue(new Map()),
    forget: jest.fn().mockResolvedValue(undefined),
  }) as unknown as SessionActivityService;

describe('JwtAuthGuard', () => {
  it('rejects a request with no Authorization header', async () => {
    const accessTokenService = { verify: jest.fn() } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(
      accessTokenService,
      revocationService(),
      activityService(),
    );
    const { context } = buildContext(undefined);
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    expect(accessTokenService.verify).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', async () => {
    const accessTokenService = { verify: jest.fn() } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(
      accessTokenService,
      revocationService(),
      activityService(),
    );
    const { context } = buildContext('Basic abc123');
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('rejects when verify() throws', async () => {
    const accessTokenService = {
      verify: jest.fn(() => {
        throw new Error('invalid signature');
      }),
    } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(
      accessTokenService,
      revocationService(),
      activityService(),
    );
    const { context } = buildContext('Bearer some.jwt.token');
    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
  });

  it('attaches authContext and allows the request through on a valid token', async () => {
    const accessTokenService = {
      verify: jest.fn(() => ({ sub: 'user-1', sid: 'session-1' })),
    } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(
      accessTokenService,
      revocationService(),
      activityService(),
    );
    const { context, request } = buildContext('Bearer valid.jwt.token');

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.authContext).toEqual({ userId: 'user-1', sessionId: 'session-1' });
  });

  it('Phase 10 — rejects a cryptographically VALID token whose session was revoked', async () => {
    // The whole point of the revocation check: this token verifies
    // perfectly, so signature-and-expiry alone would let it through.
    const accessTokenService = {
      verify: jest.fn(() => ({ sub: 'user-1', sid: 'revoked-session' })),
    } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(
      accessTokenService,
      revocationService(true),
      activityService(),
    );
    const { context, request } = buildContext('Bearer valid.jwt.token');

    await expect(guard.canActivate(context)).rejects.toThrow(UnauthorizedException);
    // And no auth context is attached, so nothing downstream can act on it.
    expect(request.authContext).toBeUndefined();
  });
});
