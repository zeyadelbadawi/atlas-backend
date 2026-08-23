/**
 * JwtAuthGuard — protects every `session`-scoped endpoint (master plan §10
 * "Auth" column, §21 Phase P1 requirement #11). Mirrors the frontend
 * `RouteGuard`'s `requireAuthentication` check, fail-closed: missing,
 * malformed, or expired access token → 401, never a silent pass-through.
 *
 * Deliberately does not build any organization/academy/role/permission
 * check — that's `RouteGuard`'s `requiredPermissions`/`requiredRoles`
 * territory, owned by Phase P2 onward once real memberships exist
 * (master plan §21 P1: "Do not build a generic RBAC system. P2 owns the
 * organization/tenancy authorization layer").
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenService } from '../services/access-token.service';

export interface AuthContext {
  readonly userId: string;
  readonly sessionId: string;
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `JwtAuthGuard` once the access token verifies. */
    authContext?: AuthContext;
  }
}

const BEARER_PREFIX = 'Bearer ';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private readonly accessTokenService: AccessTokenService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization');

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    try {
      const claims = this.accessTokenService.verify(token);
      request.authContext = { userId: claims.sub, sessionId: claims.sid };
      return true;
    } catch {
      // Covers: invalid signature, malformed token, expired token — all
      // collapse to the same 401, never distinguishing which to a caller.
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }
  }
}
