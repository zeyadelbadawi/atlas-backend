/**
 * Health endpoint.
 *
 * `GET /health` — deliberately outside the `/api/v1` prefix (see main.ts):
 * infrastructure-level endpoints (load balancer checks, uptime monitors)
 * are conventionally unversioned and unprefixed, distinct from the
 * versioned business API every later phase adds under `/api/v1`. This is
 * the only endpoint Phase P0 defines (master plan §21 P0: "API changes:
 * `GET /health` only").
 */
import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './indicators/prisma-health.indicator';
import { RedisHealthIndicator } from './indicators/redis-health.indicator';

// No `@Public()`/auth-bypass marker exists yet — there is no global
// authentication guard for it to bypass. That concept belongs to Phase P1,
// once real auth guards exist to opt out of (see the master plan §9's
// authorization model). Introducing the marker now, with nothing to mark
// against, would be exactly the kind of unnecessary-abstraction-ahead-of-
// need this phase's own instructions warn against.

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly database: PrismaHealthIndicator,
    private readonly redis: RedisHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @ApiOperation({
    summary:
      'Reports whether the app, its database connection, and its Redis connection are all reachable.',
  })
  check() {
    return this.health.check([
      () => this.database.check('database'),
      () => this.redis.check('redis'),
    ]);
  }
}
