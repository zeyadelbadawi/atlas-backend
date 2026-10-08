/**
 * Stale-tab recovery — a refresh token that ANOTHER request rotated a moment
 * ago (two tabs, or a retried request, refreshing at the same time; within
 * `REFRESH_REUSE_GRACE_MS`). The answer is the same generic 401 as any other
 * refused refresh, so nothing about the session is disclosed — but the
 * controller must NOT clear the session cookie for it: the browser already
 * holds the newer cookie the winning request set, and clearing it here would
 * sign out every tab of a session that is perfectly valid.
 */
import { UnauthorizedException } from '@nestjs/common';

export class SupersededRefreshTokenException extends UnauthorizedException {
  constructor() {
    super({ messageKey: 'errors.auth.invalidRefreshToken' });
  }
}
