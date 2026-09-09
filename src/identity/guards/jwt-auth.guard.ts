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
 *
 * Phase 10 added the ONE piece of state this guard consults: a revoked
 * session check. Signature-and-expiry verification alone cannot express
 * "this session was revoked two seconds ago" — the token stays
 * cryptographically valid until it expires — so without this, revoking a
 * device would not stop that device's next request, and the roadmap's
 * acceptance criterion ("the very next request using it must fail") would
 * be unmet. `SessionRevocationService` keeps the check to a single O(1)
 * Redis lookup on the hot path; see its own doc comment for the failure
 * behaviour, which is neither fail-open nor a global lockout.
 */
import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { Request } from 'express';
import { AccessTokenService } from '../services/access-token.service';
import { SessionRevocationService } from '../services/session-revocation.service';

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
  constructor(
    private readonly accessTokenService: AccessTokenService,
    private readonly sessionRevocationService: SessionRevocationService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.header('authorization');

    if (!header || !header.startsWith(BEARER_PREFIX)) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (!token) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    let claims;
    try {
      claims = this.accessTokenService.verify(token);
    } catch {
      // Covers: invalid signature, malformed token, expired token — all
      // collapse to the same 401, never distinguishing which to a caller.
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    // A revoked session yields the same undifferentiated 401 as a bad
    // signature: a caller must not be able to tell "revoked" from
    // "forged" from "expired".
    if (await this.sessionRevocationService.isRevoked(claims.sid)) {
      throw new UnauthorizedException({ messageKey: 'errors.unauthorized' });
    }

    request.authContext = { userId: claims.sub, sessionId: claims.sid };
    return true;
  }
}
