/**
 * `/metrics` access — two doors, both authenticated (alert routing,
 * owner decision 26 Sep 2026).
 *
 *   1. SCRAPE CREDENTIAL. `Authorization: Bearer <METRICS_SCRAPE_TOKEN>`,
 *      a dedicated, high-entropy host secret used only by the internal
 *      Prometheus on the compose network. Compared in constant time over
 *      SHA-256 digests (no length oracle). When the variable is unset the
 *      door does not exist at all.
 *   2. PLATFORM OWNER. Exactly the previous chain, unchanged:
 *      `JwtAuthGuard` then `PlatformOwnerGuard` (re-read from the DB).
 *
 * Nothing is weakened: an anonymous or wrong-token request still reaches
 * the JWT guard and gets 401; a non-owner JWT still gets 403. `/metrics`
 * also remains unreachable from the public edge (Caddy proxies only
 * `/api/*`). The token is never logged — this guard logs nothing.
 */
import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';

@Injectable()
export class MetricsAccessGuard implements CanActivate {
  constructor(
    private readonly configService: ConfigService,
    private readonly jwtAuthGuard: JwtAuthGuard,
    private readonly platformOwnerGuard: PlatformOwnerGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.presentsScrapeCredential(context.switchToHttp().getRequest<Request>())) {
      return true;
    }
    return (
      (await this.jwtAuthGuard.canActivate(context)) &&
      (await this.platformOwnerGuard.canActivate(context))
    );
  }

  private presentsScrapeCredential(request: Request): boolean {
    const expected = this.configService.get<string>('METRICS_SCRAPE_TOKEN');
    if (!expected) return false;
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
    const presented = createHash('sha256')
      .update(header.slice('Bearer '.length))
      .digest();
    const wanted = createHash('sha256').update(expected).digest();
    return timingSafeEqual(presented, wanted);
  }
}
