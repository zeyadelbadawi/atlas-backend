/**
 * Sign in with Apple for the Atlas mobile app (B2). Public routes, metered
 * like sign-in; academy surface only; 404 while the feature is off.
 */
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { SignInRateLimitGuard } from '../guards/signin-rate-limit.guard';
import { RegisterRateLimitGuard } from '../guards/register-rate-limit.guard';
import { sessionContextWithDeviceCookie } from '../controllers/auth.controller';
import { resolveClientIp, resolveUserAgent } from '../utils/request-metadata.util';
import type { AuthenticationResponseContract } from '../dto/contracts';
import {
  AppleCreateAccountDto,
  AppleLinkDto,
  AppleNativeSignInDto,
} from './apple-auth.dto';
import { AppleAuthService, type AppleSignInResponse } from './apple-auth.service';

@Controller('auth/apple')
export class AppleAuthController {
  constructor(private readonly apple: AppleAuthService) {}

  @Post('native')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  native(
    @Body() dto: AppleNativeSignInDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AppleSignInResponse> {
    return this.apple.nativeSignIn({
      ...dto,
      context: sessionContextWithDeviceCookie(request, response),
    });
  }

  @Post('link')
  @HttpCode(HttpStatus.OK)
  @UseGuards(SignInRateLimitGuard)
  link(
    @Body() dto: AppleLinkDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationResponseContract> {
    return this.apple.linkWithPassword({
      ...dto,
      context: sessionContextWithDeviceCookie(request, response),
    });
  }

  @Post('create-account')
  @HttpCode(HttpStatus.OK)
  @UseGuards(RegisterRateLimitGuard)
  createAccount(
    @Body() dto: AppleCreateAccountDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthenticationResponseContract> {
    return this.apple.createAccount({
      ...dto,
      context: sessionContextWithDeviceCookie(request, response),
      clientContext: {
        ipAddress: resolveClientIp(request),
        userAgent: resolveUserAgent(request),
      },
    });
  }
}
