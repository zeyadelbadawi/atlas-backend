/**
 * `POST /learning/watermarks/tamper` — the player's watchdog reports that the
 * forensic overlay was removed or hidden (docs/FORENSIC_WATERMARK.md).
 *
 * Optional identity, because an anonymous course preview is watermarked too.
 * The database function decides what is counted: only the caller's own
 * record (or, anonymously, the record its own device cookie opened), at most
 * once per 30 seconds. The answer is always 204 — whether anything was
 * counted is not disclosed, so the endpoint cannot be used to test whether a
 * code exists. Throttled per client IP on top.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Logger,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { OptionalJwtAuthGuard } from '../../identity/guards/optional-jwt-auth.guard';
import { readCookie } from '../../common/http/cookies.util';
import { DEVICE_COOKIE_NAME } from '../../tenancy/services/student-device.service';
import { ForensicWatermarkService } from '../services/forensic-watermark.service';
import { normalizeWatermarkCode } from '../utils/watermark-code.util';
import { WatermarkTamperDto } from '../dto/watermark-tamper.dto';

@Controller('learning/watermarks')
export class WatermarkEventsController {
  private readonly logger = new Logger(WatermarkEventsController.name);

  constructor(private readonly watermarks: ForensicWatermarkService) {}

  @Post('tamper')
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttle({ default: { limit: 12, ttl: 60_000 } })
  async tamper(@Req() request: Request, @Body() body: WatermarkTamperDto): Promise<void> {
    const normalized = normalizeWatermarkCode(body.code);
    if (!normalized.ok) return;
    try {
      await this.watermarks.recordTamper({
        userId: request.authContext?.userId ?? null,
        code: normalized.code,
        deviceCookie: readCookie(request.headers.cookie, DEVICE_COOKIE_NAME) ?? null,
      });
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        'Could not record a forensic watermark tamper report.',
      );
    }
  }
}
