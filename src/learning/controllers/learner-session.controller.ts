/**
 * Device removal and session TAKEOVER — `learning/session/*`,
 * `learning/devices/*` (master plan Phase 2 §D.7, §L).
 *
 * Separate from `LearnerDashboardController` because everything here
 * MUTATES: it ends sessions, revokes devices and moves the learning lease
 * between browsers. Keeping the reads and the writes apart makes the
 * blast radius of each obvious, and means the read controller can stay
 * entirely side-effect-free.
 *
 * Every route acts on the CALLER'S OWN account — the user id comes from
 * the verified access token and is never accepted from the request — and
 * on the academy the request host resolved to.
 */
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademySurfaceService } from '../../identity/services/academy-surface.service';
import { LearnerSessionService } from '../services/learner-session.service';
import type { TakeoverResult } from '../services/learner-session.service';
import { learningRequestContext } from '../dto/learning-request.util';
import { SessionTakeoverDto } from '../dto/playback.dto';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class LearnerSessionController {
  constructor(
    private readonly learnerSessionService: LearnerSessionService,
    private readonly academySurfaceService: AcademySurfaceService,
  ) {}

  @Delete('devices/:deviceId')
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeDevice(
    @Req() request: Request,
    @Param('deviceId') deviceId: string,
  ): Promise<void> {
    const academyId = await this.requireHostAcademy(request);
    await this.learnerSessionService.removeDevice(
      request.authContext!.userId,
      academyId,
      deviceId,
    );
  }

  /**
   * Moves the single learning session to THIS device.
   *
   * The confirmation the plan requires happens in the browser before this
   * is called — the frontend shows the other device's label and asks. The
   * server's part is to make the takeover real and auditable: it refuses
   * for a device that is not already registered (otherwise takeover would
   * be a way around the device cap), revokes the displaced session's
   * refresh token so it cannot take the lease straight back, and writes
   * `learning.device_session_takeover` naming both sides.
   */
  @Post('session/takeover')
  @HttpCode(HttpStatus.OK)
  async takeover(
    @Req() request: Request,
    @Body() body: SessionTakeoverDto,
  ): Promise<TakeoverResult> {
    const academyId = await this.requireHostAcademy(request);
    const context = learningRequestContext(request);
    return this.learnerSessionService.takeover(request.authContext!.userId, academyId, {
      sessionId: request.authContext!.sessionId,
      deviceCookie: context.deviceCookie,
      courseId: body.courseId,
      lessonId: body.lessonId,
    });
  }

  /** See `LearnerDashboardController.requireHostAcademy` — identical rule, stated once there. */
  private async requireHostAcademy(request: Request): Promise<string> {
    const hostAcademyId = await this.academySurfaceService.resolveHostAcademyId(
      request.hostname,
    );
    if (hostAcademyId) return hostAcademyId;
    const fallback = (request.query as Record<string, unknown>).academyId;
    if (typeof fallback === 'string' && fallback.length > 0) return fallback;
    throw new BadRequestException({ messageKey: 'errors.academy.hostUnresolved' });
  }
}
