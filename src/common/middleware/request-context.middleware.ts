/**
 * Request-context foundation.
 *
 * P0's scope here is deliberately narrow: a request-scoped correlation id
 * for logging/tracing/error-response purposes (master plan §19,
 * "Request IDs" / "Correlation IDs"), nothing more. This is NOT the
 * multi-tenant request-context mechanism — the `organizationId`-scoped
 * session variable that backs Row-Level Security is Phase P2's job
 * (`TenancyContextService`, master plan §21 P2 entry), since no tenant
 * concept exists yet in P0. Do not extend this middleware with tenant
 * fields before P2 — it would be inventing that phase's work early.
 */
import { randomUUID } from 'node:crypto';
import { Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

export const REQUEST_ID_HEADER = 'x-request-id';

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by `RequestContextMiddleware` on every inbound request. */
    requestId: string;
  }
}

@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    // Trust an inbound `x-request-id` only as a courtesy (e.g. an upstream
    // load balancer already assigned one) — always generate our own if
    // absent, never require the caller to supply one.
    const incoming = req.header(REQUEST_ID_HEADER);
    const requestId = incoming && incoming.trim().length > 0 ? incoming : randomUUID();

    req.requestId = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);
    next();
  }
}
