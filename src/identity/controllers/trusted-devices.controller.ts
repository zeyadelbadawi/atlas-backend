/**
 * TrustedDevicesController — `/auth/trusted-devices` (P64 Communications C4).
 *
 * The same authorization shape as `/auth/sessions`, and for the same
 * reason: THERE IS NO USER ID IN THE PATH OR QUERY ANYWHERE HERE. The
 * owner is resolved from the access token's verified `sub`, so there is
 * no parameter a caller could change in order to read or revoke somebody
 * else's remembered browsers. Organization or Academy role is irrelevant
 * and never consulted — no membership makes another user's devices
 * visible.
 *
 * A trusted device is NOT a session. Revoking one signs nothing out; it
 * only means that browser is asked for an emailed code next time. That is
 * why these rows live beside the sessions list in the UI rather than
 * inside it.
 *
 * No response here carries token material of any kind: `token_hash` never
 * leaves the service, and "is this the browser asking" is reduced to a
 * single boolean computed server-side from the real `Cookie` header.
 */
import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import type { AuthContext } from '../guards/jwt-auth.guard';
import { CurrentAuthContext } from '../decorators/auth-context.decorator';
import { readCookie } from '../../common/http/cookies.util';
import {
  TRUST_COOKIE_NAME,
  TrustedDeviceService,
} from '../services/trusted-device.service';
import type { TrustedDeviceListResponse } from '../services/trusted-device.service';
import { CommunicationMetricsService } from '../../communications/metrics/communication-metrics.service';

@Controller('auth/trusted-devices')
@UseGuards(JwtAuthGuard)
export class TrustedDevicesController {
  constructor(
    private readonly trustedDeviceService: TrustedDeviceService,
    private readonly metrics: CommunicationMetricsService,
  ) {}

  /** The caller's own remembered browsers. Matches the frontend's `TrustedDeviceList`. */
  @Get()
  @HttpCode(HttpStatus.OK)
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
  ): Promise<TrustedDeviceListResponse> {
    const items = await this.trustedDeviceService.list(
      auth.userId,
      readCookie(request.headers.cookie, TRUST_COOKIE_NAME),
    );
    return { items };
  }

  /**
   * Forgets every remembered browser EXCEPT the one making the request —
   * the fast path after losing a device.
   *
   * Declared before the parameterised route below because Nest matches in
   * declaration order, and a `:id` pattern registered first would swallow
   * this path.
   */
  @Delete()
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeOthers(
    @CurrentAuthContext() auth: AuthContext,
    @Req() request: Request,
  ): Promise<void> {
    const count = await this.trustedDeviceService.revokeOthers(
      auth.userId,
      readCookie(request.headers.cookie, TRUST_COOKIE_NAME),
    );
    if (count > 0) this.metrics.recordTrustedDevice('revoked_all');
  }

  /**
   * Forgets one remembered browser.
   *
   * `:id` is scoped by the authenticated user in the service, so another
   * account's device id revokes nothing and reports not-found rather than
   * confirming that the id exists.
   */
  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') deviceId: string,
  ): Promise<void> {
    const revoked = await this.trustedDeviceService.revoke(auth.userId, deviceId);
    if (!revoked) {
      throw new NotFoundException({ messageKey: 'errors.auth.trustedDeviceNotFound' });
    }
    this.metrics.recordTrustedDevice('revoked');
  }
}
