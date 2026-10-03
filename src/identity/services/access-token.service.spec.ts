import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { AccessTokenService } from './access-token.service';
import type { IdentityConfig } from '../../config/configuration';

function buildIdentityConfig(overrides: Partial<IdentityConfig> = {}): IdentityConfig {
  return {
    jwtAccessSecret: 'unit-test-secret-at-least-32-characters-long',
    jwtAccessTtlSeconds: 900,
    refreshTokenTtlDays: 30,
    passwordResetTokenTtlMinutes: 45,
    emailVerificationTokenTtlMinutes: 1440,
    signupOrganizationMode: 'off',
    emailDeliverabilityCheckEnabled: false,
    signInRateLimit: { max: 10, windowSeconds: 900 },
    passwordResetRateLimit: { max: 5, windowSeconds: 3600 },
    emailVerificationResendRateLimit: { max: 3, ipMax: 20, windowSeconds: 3600 },
    registerRateLimit: { max: 5, windowSeconds: 3600 },
    // P64 Communications C4 — irrelevant to access tokens, present
    // because `IdentityConfig` is one object; the §12 defaults.
    emailOtp: {
      management: 'off',
      academy: 'off',
      codeTtlSeconds: 600,
      maxAttempts: 5,
      maxCodesPerChallenge: 3,
      resendCooldownSeconds: 60,
      challengesPerHour: 5,
      trustedDeviceDaysManagement: 90,
      trustedDeviceDaysAcademy: 180,
    },
    ...overrides,
  };
}

describe('AccessTokenService', () => {
  function build(config: IdentityConfig): AccessTokenService {
    const configService = { getOrThrow: () => config } as unknown as ConfigService;
    return new AccessTokenService(new JwtService(), configService);
  }

  it('issues a token that verifies back to the same claims', () => {
    const service = build(buildIdentityConfig());
    const issued = service.issue({ sub: 'user-1', sid: 'session-1' });
    expect(issued.expiresInSeconds).toBe(900);

    const claims = service.verify(issued.token);
    expect(claims.sub).toBe('user-1');
    expect(claims.sid).toBe('session-1');
  });

  it('rejects a token verified with a different secret', () => {
    const issuer = build(
      buildIdentityConfig({ jwtAccessSecret: 'secret-a-at-least-32-characters!!' }),
    );
    const verifier = build(
      buildIdentityConfig({ jwtAccessSecret: 'secret-b-at-least-32-characters!!' }),
    );
    const issued = issuer.issue({ sub: 'user-1', sid: 'session-1' });
    expect(() => verifier.verify(issued.token)).toThrow();
  });

  it('rejects an expired token', async () => {
    const service = build(buildIdentityConfig({ jwtAccessTtlSeconds: 1 }));
    const issued = service.issue({ sub: 'user-1', sid: 'session-1' });
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(() => service.verify(issued.token)).toThrow();
  });

  it('rejects a malformed token', () => {
    const service = build(buildIdentityConfig());
    expect(() => service.verify('not-a-jwt')).toThrow();
  });
});
