/**
 * Purges an Academy's edge-cached website pages after any successful write
 * through the controller it decorates (`@UseInterceptors(
 * PurgeAcademyEdgeCacheInterceptor)`) — the course, curriculum and
 * Academy-profile controllers, whose writes change what the public website
 * shows (a course's title, price, curriculum outline or instructors, the
 * Academy's name or logo). One decorator per controller instead of one call
 * per method, so a write added later is covered too.
 *
 * Runs only once the handler has returned (its transaction has committed);
 * a failed write purges nothing. The Academy is the route's `:academyId`
 * (or `:id` on `/academies/:id/...`). See `EdgeCachePurgeService`.
 */
import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { EdgeCachePurgeService } from './edge-cache-purge.service';

export const SKIP_ACADEMY_EDGE_PURGE = 'atlas:skip-academy-edge-purge';

/** A write through a decorated controller that changes nothing a visitor sees (an editing-presence heartbeat, a page's draft). */
export const SkipAcademyEdgePurge = (): MethodDecorator =>
  SetMetadata(SKIP_ACADEMY_EDGE_PURGE, true);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class PurgeAcademyEdgeCacheInterceptor implements NestInterceptor {
  constructor(
    private readonly edgeCachePurgeService: EdgeCachePurgeService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET' || request.method === 'HEAD') return next.handle();
    if (this.reflector.get<boolean>(SKIP_ACADEMY_EDGE_PURGE, context.getHandler()))
      return next.handle();
    const params = (request.params ?? {}) as Record<string, string | undefined>;
    const academyId = params.academyId ?? params.id;
    if (!academyId || !UUID.test(academyId)) return next.handle();
    return next
      .handle()
      .pipe(tap(() => this.edgeCachePurgeService.purgeAcademy(academyId)));
  }
}
