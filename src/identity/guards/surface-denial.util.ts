/**
 * Launch Stabilization A1 (D1) — the one place a session is refused for the
 * surface (or academy) it was minted on, so every such refusal is
 * observable the same way: a `atlas_auth_surface_denied_total{reason}`
 * sample and one structured warn log. The real academy website never makes
 * such a request, so each one means a token is being used outside the
 * website it was issued to.
 *
 * The log carries ids and the route PATTERN only (`/academies/:id`), never
 * the raw URL (query strings can carry tokens), a header or a body.
 */
import { ForbiddenException, Logger } from '@nestjs/common';
import type { Request } from 'express';
import {
  recordSurfaceDenied,
  type SurfaceDenialReason,
} from '../../observability/metrics/auth-security-metrics';

const logger = new Logger('SessionSurfaceDenied');

export function surfaceDenied(
  request: Request,
  reason: SurfaceDenialReason,
  messageKey: string,
): ForbiddenException {
  recordSurfaceDenied(reason);
  const route = (request.route as { path?: string } | undefined)?.path;
  logger.warn(
    {
      event: 'auth.surface.denied',
      reason,
      userId: request.authContext?.userId ?? null,
      sessionId: request.authContext?.sessionId ?? null,
      sessionSurface: request.authContext?.surface ?? null,
      sessionAcademyId: request.authContext?.academyId ?? null,
      method: request.method,
      route: route ?? null,
    },
    'Session refused: it was not minted for this surface or academy.',
  );
  return new ForbiddenException({ messageKey });
}
