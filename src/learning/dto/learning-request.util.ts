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
import type { Request } from 'express';
import { readCookie } from '../../common/http/cookies.util';
import { DEVICE_COOKIE_NAME } from '../../tenancy/services/student-device.service';

export interface LearningRequestContext {
  readonly userId: string | null;
  readonly sessionId: string | null;
  readonly deviceCookie?: string | null;
  readonly userAgent?: string | null;
}

export function learningRequestContext(request: Request): LearningRequestContext {
  return {
    userId: request.authContext?.userId ?? null,
    sessionId: request.authContext?.sessionId ?? null,
    deviceCookie: readCookie(request.headers.cookie, DEVICE_COOKIE_NAME),
    userAgent: request.headers['user-agent'] ?? null,
  };
}
