/**
 * AccessTokenService — short-lived JWT access tokens.
 *
 * Claims are deliberately minimal (master plan §21 P1: "JWT must contain
 * only claims actually needed by the current P1 contract... do not invent
 * organizationId, academyId, roles, permissions, subscription claims —
 * Organizations do not exist yet in P1"):
 *
 * - `sub`  — the authenticated user's id.
 * - `sid`  — the DEVICE SESSION id (`refresh_tokens.session_id`). This is
 *            *not* a new domain concept; it's the plumbing that makes
 *            `POST /auth/sign-out` work at all. The frontend's
 *            `authenticationService.signOut()` sends no body and no refresh
 *            token (`apiClient.post<void>('/auth/sign-out')`) — only the
 *            `Authorization` header. Without `sid`, the backend would have
 *            no way to know *which* refresh token to revoke and could only
 *            implement "sign out of every device," which the master plan
 *            explicitly says P1 must not do.
 *
 *            PHASE 10 CHANGED WHAT THIS HOLDS. It used to be the
 *            `refresh_tokens` ROW id, which is a different value after
 *            every rotation. It is now the session-family id, which is
 *            stable for the life of the device session. Two things depend
 *            on that stability and would break silently if it regressed:
 *            `JwtAuthGuard` looks `sid` up on the revocation denylist (a
 *            per-rotation id could never match a revocation, leaving a
 *            revoked session usable until the token expired), and
 *            `GET /auth/sessions` compares it to mark the caller's own
 *            row `isCurrent`. Every issuance site must therefore pass
 *            `refreshToken.sessionId`, never `refreshToken.id`.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { IdentityConfig } from '../../config/configuration';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
}

export interface IssuedAccessToken {
  readonly token: string;
  readonly expiresInSeconds: number;
}

@Injectable()
export class AccessTokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  issue(claims: AccessTokenClaims): IssuedAccessToken {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    const token = this.jwtService.sign(claims, {
      secret: identity.jwtAccessSecret,
      expiresIn: identity.jwtAccessTtlSeconds,
    });
    return { token, expiresInSeconds: identity.jwtAccessTtlSeconds };
  }

  /** Throws if the token is missing, malformed, expired, or has an invalid signature. */
  verify(token: string): AccessTokenClaims {
    const identity = this.configService.getOrThrow<IdentityConfig>('identity');
    return this.jwtService.verify<AccessTokenClaims>(token, {
      secret: identity.jwtAccessSecret,
    });
  }
}
