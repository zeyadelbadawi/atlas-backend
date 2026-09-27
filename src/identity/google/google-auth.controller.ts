/**
 * Google Identity — `/auth/google/*` and `GET /auth/options`.
 *
 * `authorize` and `complete` run on the ORIGIN host (platform, academy
 * subdomain or custom domain — the API is same-origin everywhere); only
 * `callback` runs on the platform host, the single redirect URI registered
 * with Google. See `GoogleAuthService` for the whole flow.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { readCookie } from '../../common/http/cookies.util';
import { resolveClientIp } from '../utils/request-metadata.util';
import { sessionContextWithDeviceCookie } from '../controllers/auth.controller';
import { AcademySurfaceService } from '../services/academy-surface.service';
import { GoogleAuthorizeDto, GoogleCompleteDto } from './google-auth.dto';
import { GoogleAuthRateLimitGuard } from './google-auth-rate-limit.guard';
import { GoogleAuthService, type GoogleCompleteResponse } from './google-auth.service';

/** Host-only, HttpOnly — binds "the browser that started" to "the browser that completes". */
export const GOOGLE_BINDER_COOKIE = 'atlas_google_binder';

/** The cookie lives only under this flow's own routes, whatever the global prefix is. */
function binderCookiePath(request: Request): string {
  const path = (request.originalUrl ?? request.url).split('?')[0];
  const index = path.indexOf('/auth/google/');
  return index >= 0 ? path.slice(0, index) + '/auth/google' : '/auth/google';
}

function originOf(service: GoogleAuthService, request: Request): string | null {
  return service.requestOrigin({
    protocol: request.protocol,
    host: request.get('host'),
    originHeader: request.get('origin'),
  });
}

@Controller('auth/google')
export class GoogleAuthController {
  constructor(private readonly googleAuth: GoogleAuthService) {}

  @Post('authorize')
  @HttpCode(HttpStatus.OK)
  @UseGuards(GoogleAuthRateLimitGuard)
  async authorize(
    @Body() dto: GoogleAuthorizeDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<{ authorizationUrl: string; expiresAt: string }> {
    const started = await this.googleAuth.authorize({
      intent: dto.intent,
      returnTo: dto.returnTo,
      academyId: dto.academyId,
      hostname: request.hostname,
      origin: originOf(this.googleAuth, request),
      ipAddress: resolveClientIp(request),
    });
    response.cookie(GOOGLE_BINDER_COOKIE, started.binder, {
      httpOnly: true,
      sameSite: 'lax',
      secure: request.secure,
      path: binderCookiePath(request),
      maxAge: started.expiresAt.getTime() - Date.now(),
    });
    return {
      authorizationUrl: started.authorizationUrl,
      expiresAt: started.expiresAt.toISOString(),
    };
  }

  /**
   * Google's redirect. Answers with a 303 to the origin the flow started on
   * (handoff in the fragment), or — when no flow can be identified — a plain
   * page, because there is no safe place to send the browser.
   */
  @Get('callback')
  async callback(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('error') error: string | undefined,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    if (!(await this.googleAuth.isCallbackHost(request.hostname))) {
      throw new NotFoundException({ messageKey: 'errors.notFound' });
    }
    const outcome = await this.googleAuth.callback({
      code: typeof code === 'string' ? code : undefined,
      state: typeof state === 'string' ? state : undefined,
      error: typeof error === 'string' ? error : undefined,
    });
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    if (outcome.redirectTo) {
      response.redirect(HttpStatus.SEE_OTHER, outcome.redirectTo);
      return;
    }
    response
      .status(HttpStatus.BAD_REQUEST)
      .type('text/plain')
      .send(
        'This sign-in link has expired. Return to the page you started from and try again.',
      );
  }

  @Post('complete')
  @HttpCode(HttpStatus.OK)
  @UseGuards(GoogleAuthRateLimitGuard)
  async complete(
    @Body() dto: GoogleCompleteDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<GoogleCompleteResponse> {
    const result = await this.googleAuth.complete({
      handoff: dto.handoff,
      binder: readCookie(request.headers.cookie, GOOGLE_BINDER_COOKIE),
      origin: originOf(this.googleAuth, request),
      context: sessionContextWithDeviceCookie(request, response),
    });
    // A follow-up step still needs the binder; anything final does not.
    if (!('googleStep' in result)) {
      response.clearCookie(GOOGLE_BINDER_COOKIE, {
        httpOnly: true,
        sameSite: 'lax',
        secure: request.secure,
        path: binderCookiePath(request),
      });
    }
    return result;
  }
}

/**
 * `GET /auth/options` — which sign-in methods THIS host offers, so the sign-in
 * and sign-up pages know whether to show the Google button. Carries nothing
 * about any account. Answers `google: false` rather than 404 while off.
 */
@Controller('auth')
export class AuthOptionsController {
  constructor(
    private readonly googleAuth: GoogleAuthService,
    private readonly academySurface: AcademySurfaceService,
  ) {}

  @Get('options')
  async options(
    @Req() request: Request,
    @Query('academyId') previewAcademyId: string | undefined,
  ): Promise<{ google: boolean }> {
    if (!this.googleAuth.isAvailable()) return { google: false };
    const hostAcademyId = await this.academySurface.resolveHostAcademyId(
      request.hostname,
    );
    if (hostAcademyId) {
      return { google: this.googleAuth.isEnabledFor('academy', hostAcademyId) };
    }
    if (!(await this.academySurface.isUnresolvableHost(request.hostname))) {
      return { google: false };
    }
    return typeof previewAcademyId === 'string' && previewAcademyId.length > 0
      ? { google: this.googleAuth.isEnabledFor('academy', previewAcademyId) }
      : { google: this.googleAuth.isEnabledFor('management') };
  }
}
