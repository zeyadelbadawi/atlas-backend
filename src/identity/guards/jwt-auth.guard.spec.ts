import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { JwtAuthGuard } from './jwt-auth.guard';
import type { AccessTokenService } from '../services/access-token.service';

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

describe('JwtAuthGuard', () => {
  it('rejects a request with no Authorization header', () => {
    const accessTokenService = { verify: jest.fn() } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(accessTokenService);
    const { context } = buildContext(undefined);
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(accessTokenService.verify).not.toHaveBeenCalled();
  });

  it('rejects a header that is not a Bearer token', () => {
    const accessTokenService = { verify: jest.fn() } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(accessTokenService);
    const { context } = buildContext('Basic abc123');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('rejects when verify() throws', () => {
    const accessTokenService = {
      verify: jest.fn(() => {
        throw new Error('invalid signature');
      }),
    } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(accessTokenService);
    const { context } = buildContext('Bearer some.jwt.token');
    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
  });

  it('attaches authContext and allows the request through on a valid token', () => {
    const accessTokenService = {
      verify: jest.fn(() => ({ sub: 'user-1', sid: 'session-1' })),
    } as unknown as AccessTokenService;
    const guard = new JwtAuthGuard(accessTokenService);
    const { context, request } = buildContext('Bearer valid.jwt.token');

    expect(guard.canActivate(context)).toBe(true);
    expect(request.authContext).toEqual({ userId: 'user-1', sessionId: 'session-1' });
  });
});
