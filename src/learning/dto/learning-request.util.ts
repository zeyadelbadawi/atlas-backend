/**
 * The three request facts every P64 Phase 2 learning endpoint needs, read
 * from the REQUEST rather than from anything the caller can put in a body
 * (master plan Phase 2 §D.2's conditions 1 and 2, §G).
 *
 *   - the acting user and their session, from the verified access token;
 *   - the academy the request HOST resolved to, from the `Host` header the
 *     edge routed on;
 *   - the `atlas_device` cookie, from the real `Cookie` header.
 *
 * Collected in one place so no controller re-derives them slightly
 * differently. A caller can send any `academyId` they like in a parameter;
 * what they cannot do is change which host the edge routed to, which is
 * why the host is the tenancy claim the content path trusts.
 */
import type { Request, Response } from 'express';
import { deviceCookieOptions, readCookie } from '../../common/http/cookies.util';
import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  DEVICE_COOKIE_NAME,
} from '../../tenancy/services/student-device.service';
import { surfaceDenied } from '../../identity/guards/surface-denial.util';

export interface LearningRequestContext {
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly deviceCookie?: string | null;
  readonly userAgent?: string | null;
  /** Present when the caller passed the response: writes a new device identity, exactly as sign-in does. */
  readonly onDeviceCookie?: (value: string) => void;
}

export function learningRequestContext(
  request: Request,
  response?: Response,
): LearningRequestContext {
  return {
    userId: request.authContext?.userId ?? null,
    sessionId: request.authContext?.sessionId ?? null,
    deviceCookie: readCookie(request.headers.cookie, DEVICE_COOKIE_NAME),
    userAgent: request.headers['user-agent'] ?? null,
    ...(response
      ? {
          onDeviceCookie: (value: string) => {
            response.cookie(
              DEVICE_COOKIE_NAME,
              value,
              deviceCookieOptions({
                secure: request.secure,
                maxAgeSeconds: DEVICE_COOKIE_MAX_AGE_SECONDS,
              }),
            );
          },
        }
      : {}),
  };
}

/**
 * Launch Stabilization A1 — an academy-website session acts only for the
 * academy it was minted for. The host decides which academy a learner
 * endpoint serves; a token minted on Academy A presented to Academy B's
 * host is refused rather than quietly serving B. Sessions minted on the
 * management surface are left to the endpoint's own enrollment, staff and
 * RLS checks (staff preview relies on them), and an unresolvable host
 * (local development) has nothing to compare against.
 */
export function assertSessionServesHostAcademy(
  request: Request,
  hostAcademyId: string | null | undefined,
): void {
  const auth = request.authContext;
  if (!auth || auth.surface !== 'academy' || !hostAcademyId) return;
  if (auth.academyId !== hostAcademyId) {
    throw surfaceDenied(
      request,
      'academy_host_mismatch',
      'errors.auth.academyHostMismatch',
    );
  }
}
