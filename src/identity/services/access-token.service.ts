/**
 * AccessTokenService — short-lived JWT access tokens.
 *
 * Claims are deliberately minimal (master plan §21 P1: "JWT must contain
 * only claims actually needed by the current P1 contract... do not invent
 * organizationId, academyId, roles, permissions, subscription claims —
 * Organizations do not exist yet in P1"):
 *
 * - `sub`  — the authenticated user's id.
 * - `sid`  — the id of the `refresh_tokens` row this access token was
 *            issued alongside. This is *not* a new domain concept; it's the
 *            plumbing that makes `POST /auth/sign-out` work at all. The
 *            frontend's `authenticationService.signOut()` sends no body and
 *            no refresh token (`apiClient.post<void>('/auth/sign-out')`) —
 *            only the `Authorization` header. Without `sid`, the backend
 *            would have no way to know *which* refresh token to revoke and
 *            could only implement "sign out of every device," which the
 *            master plan explicitly says P1 must not do. `sid` lets
 *            sign-out revoke exactly the session tied to the presented
 *            access token, without changing the request/response shape on
 *            either side.
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
