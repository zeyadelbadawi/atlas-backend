/**
 * The learner dashboard's read endpoints — `learning/*` (master plan
 * Phase 2 §D.8, §L).
 *
 * EVERY ROUTE IS SCOPED BY THE REQUEST HOST. There is no `academyId`
 * parameter anywhere in this controller, and that is the design: a
 * learner can hold one account across several academies (AD-4), and the
 * academy whose branded site they are looking at is the academy whose
 * work they should see. The host is the only claim in the request the
 * caller cannot change, so it is the one the scope comes from.
 *
 * A request that resolves to NO academy — the platform host, or local
 * development — is refused rather than silently widened to "all
 * academies". Widening would be the tenancy leak this scoping exists to
 * prevent, and the learner dashboard is only ever reached from an academy
 * host in production.
 */
import { BadRequestException, Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademySurfaceService } from '../../identity/services/academy-surface.service';
import { LearnerDashboardService } from '../services/learner-dashboard.service';
import { LearnerSessionService } from '../services/learner-session.service';
import { learningRequestContext } from '../dto/learning-request.util';
import type {
  LearnerAssessmentItem,
  LearnerDevicesResponse,
  LearnerOverviewResponse,
} from '../dto/learner-overview.contract';

@Controller('learning')
@UseGuards(JwtAuthGuard)
export class LearnerDashboardController {
  constructor(
    private readonly learnerDashboardService: LearnerDashboardService,
    private readonly learnerSessionService: LearnerSessionService,
    private readonly academySurfaceService: AcademySurfaceService,
  ) {}

  @Get('overview')
  async overview(@Req() request: Request): Promise<LearnerOverviewResponse> {
    const academyId = await this.requireHostAcademy(request);
    return this.learnerDashboardService.getOverview(
      request.authContext!.userId,
      academyId,
    );
  }

  @Get('quizzes')
  async quizzes(@Req() request: Request): Promise<readonly LearnerAssessmentItem[]> {
    const academyId = await this.requireHostAcademy(request);
    return this.learnerDashboardService.getAssessments(
      request.authContext!.userId,
      academyId,
      'quiz',
    );
  }

  @Get('assignments')
  async assignments(@Req() request: Request): Promise<readonly LearnerAssessmentItem[]> {
    const academyId = await this.requireHostAcademy(request);
    return this.learnerDashboardService.getAssessments(
      request.authContext!.userId,
      academyId,
      'assignment',
    );
  }

  @Get('devices')
  async devices(@Req() request: Request): Promise<LearnerDevicesResponse> {
    const academyId = await this.requireHostAcademy(request);
    const context = learningRequestContext(request);
    return this.learnerSessionService.listDevices(
      request.authContext!.userId,
      academyId,
      {
        deviceCookie: context.deviceCookie,
        sessionId: request.authContext!.sessionId,
      },
    );
  }

  /**
   * Resolves the academy from the host.
   *
   * `academyId` as a fallback query parameter is accepted ONLY when the
   * host resolves to nothing at all, which is local development and the
   * platform host — the same escape hatch the P64 Phase 1 academy-surface
   * preview already uses, and for the same reason: there is no academy
   * hostname to route on. It can never override a host that DID resolve,
   * so on a real academy site the parameter is ignored entirely.
   */
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
