/**
 * HTTP caching policy for every API response (academy offline work, Oct 2026).
 *
 * DEFAULT: `Cache-Control: private, no-store`. Most API responses are about a
 * signed-in person (progress, submissions, grades, orders, sessions) or carry
 * credentials (sign-in, refresh, content grants). Before this, most of them
 * carried no `Cache-Control` at all, which leaves the decision to whatever
 * sits between the API and the browser — a corporate proxy, a misconfigured
 * CDN rule, the browser's heuristic cache, the back/forward cache. `no-store`
 * removes that ambiguity: nothing about a learner is ever written to an HTTP
 * cache. Offline copies are the app's job (an explicit per-user allowlist,
 * wiped at sign-out), never the HTTP layer's.
 *
 * The default is set by `NoStoreByDefaultMiddleware` before routing, so it
 * also covers responses produced before a handler runs (guard refusals,
 * validation errors, rate limits). A handler that knows better says so:
 *
 *   - `@Header('Cache-Control', …)` or `response.setHeader(…)` in the handler
 *     (immutable media, favicons, email logos) — applied after this default
 *     and therefore wins;
 *   - `@CachePolicy(PUBLIC_WEBSITE_CACHE)` — published, tenant-public content.
 *     Applied by `CachePolicyInterceptor` ONLY to a successful GET/HEAD, so an
 *     error (a 404 for an academy that is about to go live) is never cached
 *     and a write is always `no-store`.
 *
 * WHY `private` FOR PUBLIC WEBSITE DATA. The content is public, but it is
 * resolved per academy and per host, and a shared cache (Cloudflare, a proxy)
 * keyed only by URL is the wrong place to decide which tenant's copy to
 * serve, and cannot be purged when the academy publishes. `private` lets the
 * visitor's own browser keep it briefly (a minute, then serve-stale while it
 * revalidates in the background), which is what a returning visitor or a
 * flaky connection actually needs.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  NestMiddleware,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { NextFunction, Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

export const NO_STORE = 'private, no-store';
export const PUBLIC_WEBSITE_CACHE = 'private, max-age=60, stale-while-revalidate=300';

const CACHE_POLICY_KEY = 'atlas:cache-policy';

/** Declares the `Cache-Control` a successful GET/HEAD of this handler (or controller) may carry. */
export const CachePolicy = (value: string): MethodDecorator & ClassDecorator =>
  SetMetadata(CACHE_POLICY_KEY, value);

@Injectable()
export class NoStoreByDefaultMiddleware implements NestMiddleware {
  use(_req: Request, res: Response, next: NextFunction): void {
    res.setHeader('Cache-Control', NO_STORE);
    next();
  }
}

@Injectable()
export class CachePolicyInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const policy = this.reflector.getAllAndOverride<string | undefined>(
      CACHE_POLICY_KEY,
      [context.getHandler(), context.getClass()],
    );
    const request = context.switchToHttp().getRequest<Request>();
    const cacheable = request.method === 'GET' || request.method === 'HEAD';
    if (!policy || !cacheable) return next.handle();
    const response = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      tap(() => {
        // Never on a response the handler already wrote or labelled itself.
        if (response.headersSent) return;
        if (response.getHeader('Cache-Control') !== NO_STORE) return;
        response.setHeader('Cache-Control', policy);
      }),
    );
  }
}
