/**
 * `GET /metrics` — the Prometheus scrape endpoint (master plan Phase 2 §U).
 *
 * PLATFORM OWNER ONLY. Metrics are platform-shaped and carry no tenant
 * labels by design (see `LearningMetricsService`), but they still describe
 * the platform's internal behaviour — grant volumes, refusal rates,
 * provider error rates — and that is not something any authenticated
 * customer should be able to read. `PlatformOwnerGuard` is the same gate
 * every other cross-tenant surface uses.
 *
 * A scraper authenticates as a platform owner like any other caller. That
 * is deliberately simpler than a second, bespoke auth mechanism for one
 * endpoint: a shared bearer token for metrics would be a credential with
 * no rotation story and no audit trail.
 *
 * Outside `/api/v1` versioning for the same reason `/health` is: this is
 * infrastructure, not a business API, and a scrape configuration should
 * not have to follow a product's version bumps.
 */
import { Controller, Get, Header, Res, UseGuards, Version, VERSION_NEUTRAL } from '@nestjs/common';
import type { Response } from 'express';
import { ApiExcludeController } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { LearningMetricsService } from './learning-metrics.service';

@ApiExcludeController()
@Controller('metrics')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class MetricsController {
  constructor(private readonly metrics: LearningMetricsService) {}

  @Get()
  @Version(VERSION_NEUTRAL)
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) response: Response): Promise<string> {
    const { contentType, body } = await this.metrics.render();
    response.setHeader('Content-Type', contentType);
    return body;
  }
}
