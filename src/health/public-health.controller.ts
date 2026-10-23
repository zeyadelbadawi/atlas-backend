/**
 * B0-OPS-09 — `GET /api/v1/public/health`, the EXTERNAL uptime probe's
 * target (a scheduled GitHub Actions workflow in the public frontend
 * repository calls it through Cloudflare and Caddy every 10 minutes).
 *
 * The internal `GET /health` (terminus, unprefixed) stays what the
 * orchestrator and the deploy script read, and keeps its per-dependency
 * detail; it is not reachable from outside. This one says only `ok` or
 * `unavailable` — no dependency names, versions, timings or error text —
 * so a stranger learns nothing from it.
 *
 * Cheap on purpose: a `SELECT 1` and a Redis `PING`, each abandoned after
 * `CHECK_TIMEOUT_MS`, and the answer is reused for `CACHE_MS` (concurrent
 * callers share one in-flight check), so a burst of probes costs the
 * database at most one query per few seconds. No auth and no tenancy: it
 * reads nothing tenant-scoped. The global per-IP throttler still applies.
 */
import { Controller, Get, Header, HttpStatus, Res } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import { PrismaService } from '../database/prisma.service';
import { RedisService } from '../redis/redis.service';

export const PUBLIC_HEALTH_CHECK_TIMEOUT_MS = 2_000;
const CACHE_MS = 5_000;

export interface PublicHealthBody {
  readonly status: 'ok' | 'unavailable';
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

@ApiTags('health')
@Controller('public/health')
export class PublicHealthController {
  private cached: { readonly ok: boolean; readonly at: number } | null = null;
  private inFlight: Promise<boolean> | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Public uptime check: ok or unavailable, nothing else.' })
  async check(@Res({ passthrough: true }) res: Response): Promise<PublicHealthBody> {
    const ok = await this.isHealthy();
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable' };
  }

  private async isHealthy(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && now - this.cached.at < CACHE_MS) return this.cached.ok;
    if (!this.inFlight) {
      this.inFlight = this.probe()
        .then((ok) => {
          this.cached = { ok, at: Date.now() };
          return ok;
        })
        .finally(() => {
          this.inFlight = null;
        });
    }
    return this.inFlight;
  }

  private async probe(): Promise<boolean> {
    try {
      const [database, redis] = await Promise.all([
        withTimeout(this.prisma.isHealthy(), PUBLIC_HEALTH_CHECK_TIMEOUT_MS),
        withTimeout(this.redis.isHealthy(), PUBLIC_HEALTH_CHECK_TIMEOUT_MS),
      ]);
      return database && redis;
    } catch {
      return false;
    }
  }
}
