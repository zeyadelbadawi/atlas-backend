/**
 * PublicPlatformContactController — `POST public/contact`, the Atlas
 * marketing homepage's contact form.
 *
 * Deliberately UNGUARDED, like every `public/*` controller: a visitor has
 * no session. It is therefore not an "authenticated route" for the
 * route-surface inventory, and it carries nothing a session could add.
 *
 * 5 submissions per 10 minutes per client IP — overrides the global
 * `default` throttler (120/min, keyed by `ClientIpThrottlerGuard` on the
 * real client address) for this route only; excess requests get the
 * guard's normal 429. Everything else about abuse handling — honeypot,
 * minimum fill time, dedupe — lives in `PlatformContactIntakeService` and
 * is invisible in the response by design.
 */
import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import {
  resolveClientIp,
  resolveUserAgent,
} from '../../identity/utils/request-metadata.util';
import { PlatformContactIntakeService } from '../services/platform-contact-intake.service';
import { SubmitPlatformContactDto } from '../dto/submit-platform-contact.dto';
import type { PlatformContactReceiptResponse } from '../dto/platform-contact-submission.contract';
import { PLATFORM_CONTACT_THROTTLE } from '../platform-contact.constants';

@Controller('public/contact')
export class PublicPlatformContactController {
  constructor(private readonly intakeService: PlatformContactIntakeService) {}

  @Post()
  @Throttle({ default: PLATFORM_CONTACT_THROTTLE })
  @HttpCode(201)
  async submit(
    @Req() request: Request,
    @Body() body: SubmitPlatformContactDto,
  ): Promise<PlatformContactReceiptResponse> {
    return this.intakeService.submit(body, {
      ip: resolveClientIp(request),
      userAgent: resolveUserAgent(request),
    });
  }
}
