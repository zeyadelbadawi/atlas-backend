/**
 * The signed-in HINT cookie (dashboard subdomain move, DL-63).
 *
 *   `atlas_signed_in=1; Domain=<base domain>; Path=/; Secure; SameSite=Lax`
 *
 * WHAT IT IS FOR. The marketing site on the apex and the help center are
 * static pages on other hosts than the dashboard. They cannot see the
 * dashboard's session (the session cookie is `__Host-`, HttpOnly and bound
 * to the dashboard host). This cookie only tells those pages to label the
 * header button "Open dashboard" instead of "Sign in".
 *
 * WHY IT IS SAFE.
 *   - It carries no secret and nothing about the account: the value is the
 *     constant `1`. Reading it reveals only that this browser has a
 *     management session on the platform.
 *   - Nothing on the server ever reads it. It grants nothing: no endpoint,
 *     guard or decision looks at it. A forged or stale value can only change
 *     a button label, and the dashboard then checks the real session and
 *     shows the sign-in page.
 *   - It is set and cleared ONLY by a platform host (the apex or the
 *     dashboard), only over HTTPS, only on a session the platform itself
 *     minted. Academy hosts never set it, and an academy session never
 *     touches it.
 *   - It is not HttpOnly on purpose (static pages must read it). That is the
 *     reason it holds nothing worth stealing.
 */
import type { Request, Response } from 'express';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { isPlatformHost } from '../../common/security/platform-host.util';

export const SIGNED_IN_HINT_COOKIE = 'atlas_signed_in';

/** The cookie Domain for this request, or `null` when this request may not set or clear the hint. */
function hintDomain(
  request: Pick<Request, 'secure' | 'hostname'>,
  config: PlatformDomainRuntimeConfig | undefined,
): string | null {
  const base = config?.baseDomain?.toLowerCase();
  if (!request.secure || !base) return null;
  return isPlatformHost(request.hostname?.toLowerCase(), config) ? base : null;
}

export function setSignedInHint(
  request: Pick<Request, 'secure' | 'hostname'>,
  response: Pick<Response, 'cookie'>,
  config: PlatformDomainRuntimeConfig | undefined,
  maxAgeSeconds: number,
): void {
  const domain = hintDomain(request, config);
  if (!domain) return;
  response.cookie(SIGNED_IN_HINT_COOKIE, '1', {
    domain,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
    maxAge: maxAgeSeconds * 1000,
  });
}

export function clearSignedInHint(
  request: Pick<Request, 'secure' | 'hostname'>,
  response: Pick<Response, 'clearCookie'>,
  config: PlatformDomainRuntimeConfig | undefined,
): void {
  const domain = hintDomain(request, config);
  if (!domain) return;
  response.clearCookie(SIGNED_IN_HINT_COOKIE, {
    domain,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
  });
}
