/**
 * PlatformWatermarksController — `GET /platform/watermarks/:code`, the
 * Platform Owner's forensic watermark lookup (docs/FORENSIC_WATERMARK.md).
 *
 * Full Platform Owner stack: `JwtAuthGuard` (a real session),
 * `ManagementSurfaceGuard` (an academy-website session is refused whoever
 * holds it) and `PlatformOwnerGuard` (re-reads `is_platform_owner` per
 * request). Rate-limited twice — per client IP here, per owner in
 * `WatermarkLookupRateLimiter` — and audited on every call. RLS on
 * `forensic_watermarks` independently admits only a Platform Owner.
 *
 * The code travels in the PATH, not a query string, and the response is
 * `no-store`: it carries a person's identity and must not be cached by
 * anything between the operator and the API.
 */
import { Controller, Get, Header, Param, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { WatermarkLookupService } from '../services/watermark-lookup.service';
import type { WatermarkLookupResponse } from '../dto/forensic-watermark.contract';

@Controller('platform/watermarks')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformWatermarksController {
  constructor(private readonly lookupService: WatermarkLookupService) {}

  @Get(':code')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Header('Cache-Control', 'private, no-store')
  async lookup(
    @CurrentAuthContext() auth: AuthContext,
    @Param('code') code: string,
  ): Promise<WatermarkLookupResponse> {
    return this.lookupService.lookup(auth.userId, code.slice(0, 64));
  }
}
