/**
 * `POST /api/v1/rum/vitals` — where sampled browsers report Core Web
 * Vitals (P6). Unauthenticated by nature (sent as the page is left), so it
 * is treated like the CSP report endpoint: the global per-IP throttler
 * applies, the body is parsed against closed vocabularies
 * (`parseVitalsBeacon`), nothing is logged per request, no IP or user is
 * stored anywhere, and it always answers 204. `RUM_ENABLED` other than
 * "true" turns ingestion off at runtime (samples are dropped).
 */
import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseVitalsBeacon } from './web-vitals.util';
import { recordVital } from '../metrics/rum-metrics';

@Controller('rum')
export class RumController {
  constructor(private readonly configService: ConfigService) {}

  private isEnabled(): boolean {
    const value = this.configService.get<unknown>('RUM_ENABLED');
    return value === true || value === 'true';
  }

  @Post('vitals')
  @HttpCode(HttpStatus.NO_CONTENT)
  receive(@Body() body: unknown): void {
    if (!this.isEnabled()) return;
    for (const sample of parseVitalsBeacon(body)) recordVital(sample);
  }
}
