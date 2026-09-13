/**
 * Live Sessions API — academy-scoped, mounted under the same
 * `academies/:id/...` tree every other academy resource already uses, and
 * guarded by the identical pair.
 *
 * AUTHORIZATION IS LAYERED, AND EACH LAYER ANSWERS A DIFFERENT QUESTION:
 *
 *   JwtAuthGuard        — who is this?
 *   AcademyScopeGuard   — do they belong to this academy's organization,
 *                         and what is the tenant context? (reused
 *                         verbatim, unmodified)
 *   assertCanManage     — do they hold a MANAGING academy role? Reused
 *                         from the same rule `CoursesService` applies,
 *                         because scheduling a session is a course-write
 *                         action, not a new privilege tier.
 *   AddOnAccessService  — is the Live Sessions add-on installed, enabled
 *                         and entitled for this tenant?
 *   RLS                 — independently, underneath all of it.
 *
 * A student never reaches these routes at all; their surface is the
 * separate join/list endpoints on the learning side, which enforce
 * enrollment rather than academy management.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { LiveSessionService } from '../services/live-session.service';
import { AttendanceService } from '../services/attendance.service';
import { AddOnAccessService } from '../services/add-on-access.service';
import { RecordingQuotaService } from '../services/recording-quota.service';
import {
  CreateLiveSessionDto,
  ReorderLiveSessionDto,
  UpdateLiveSessionDto,
} from '../dto/live-session.dto';
import { toLiveSessionResponse } from '../dto/live-session.contract';
import type { LiveSessionResponse } from '../dto/live-session.contract';

/**
 * Academy roles permitted to manage sessions — identical to
 * `CoursesService`'s `MANAGING_ROLES`. Instructors are included because
 * running a live class is their job; students never are.
 */
const MANAGING_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'administrator',
  'manager',
  'instructor',
]);

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class LiveSessionsController {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly liveSessionService: LiveSessionService,
    private readonly attendanceService: AttendanceService,
    private readonly addOnAccessService: AddOnAccessService,
    private readonly recordingQuotaService: RecordingQuotaService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  /**
   * The add-on's own state for this academy's organization — what the
   * Live Sessions screens render before anything else, so an uninstalled
   * or disabled add-on explains itself instead of 403-ing blankly.
   */
  @Get(':id/live-sessions/status')
  async status(@Req() request: Request) {
    const { academyId, organizationId } = request.academyContext!;
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const addOn = await this.addOnAccessService.describe(
        tx,
        organizationId,
        'live-sessions',
        'liveSessions',
      );
      const connection = await tx.academyLiveProviderConnection.findUnique({
        where: { academyId },
        select: { status: true, providerKey: true, lastCheckedAt: true },
      });
      const quota = await this.recordingQuotaService.describeUsage(tx, organizationId);

      return {
        addOn,
        // The four dependencies stay visibly distinct: entitled, installed,
        // connected and quota are different problems with different fixes.
        provider: {
          status: connection?.status ?? 'not_connected',
          providerKey: connection?.providerKey ?? 'zoom',
          lastCheckedAt: connection?.lastCheckedAt ?? null,
        },
        recordingQuota: quota,
      };
    });
  }

  /** Every Live Session in one course — the course builder's curriculum read. */
  @Get(':id/courses/:courseId/live-sessions')
  async listForCourse(
    @Req() request: Request,
    @Param('courseId') courseId: string,
  ): Promise<LiveSessionResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    const sessions = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.liveSessionService.listForCourse(tx, academyId, courseId),
    );
    return sessions.map(toLiveSessionResponse);
  }

  @Post(':id/courses/:courseId/live-sessions')
  async create(
    @Req() request: Request,
    @Param('courseId') courseId: string,
    @Body() body: CreateLiveSessionDto,
  ): Promise<LiveSessionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const actorUserId = request.authContext!.userId;

    const session = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, actorUserId);

        const created = await this.liveSessionService.create(tx, {
          academyId,
          courseId,
          organizationId,
          actorUserId,
          title: body.title,
          description: body.description,
          sectionId: body.sectionId,
          scheduledStartAt: new Date(body.scheduledStartAt),
          scheduledEndAt: new Date(body.scheduledEndAt),
          hostUserId: body.hostUserId,
          recordingEnabled: body.recordingEnabled,
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action: 'live_session.created',
          targetType: 'live_session',
          targetId: created.id,
          // No provider payload, no credentials — just the business facts.
          context: {
            courseId,
            recordingEnabled: created.recordingEnabled,
            scheduledStartAt: created.scheduledStartAt.toISOString(),
          },
        });

        return created;
      },
    );

    return toLiveSessionResponse(session);
  }

  @Get(':id/live-sessions/:liveSessionId')
  async getOne(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
  ): Promise<LiveSessionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const session = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.liveSessionService.getById(tx, academyId, liveSessionId),
    );
    return toLiveSessionResponse(session);
  }

  @Patch(':id/live-sessions/:liveSessionId')
  async update(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
    @Body() body: UpdateLiveSessionDto,
  ): Promise<LiveSessionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const actorUserId = request.authContext!.userId;

    const updated = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, actorUserId);

        const session = await this.liveSessionService.update(tx, {
          academyId,
          organizationId,
          liveSessionId,
          patch: {
            title: body.title,
            description: body.description,
            sectionId: body.sectionId,
            scheduledStartAt: body.scheduledStartAt
              ? new Date(body.scheduledStartAt)
              : undefined,
            scheduledEndAt: body.scheduledEndAt
              ? new Date(body.scheduledEndAt)
              : undefined,
            hostUserId: body.hostUserId,
            recordingEnabled: body.recordingEnabled,
            status: body.status,
          },
        });

        await this.auditLogWriterService.write(tx, {
          actorUserId,
          organizationId,
          action:
            body.status === 'cancelled'
              ? 'live_session.cancelled'
              : 'live_session.updated',
          targetType: 'live_session',
          targetId: liveSessionId,
          context: { status: session.status },
        });

        return session;
      },
    );

    return toLiveSessionResponse(updated);
  }

  /** Curriculum reordering — moving a session within or between units. */
  @Patch(':id/live-sessions/:liveSessionId/order')
  async reorder(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
    @Body() body: ReorderLiveSessionDto,
  ): Promise<LiveSessionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    const actorUserId = request.authContext!.userId;

    const moved = await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actorUserId,
      async (tx) => {
        await this.assertCanManage(tx, academyId, actorUserId);
        return this.liveSessionService.reorder(tx, {
          academyId,
          liveSessionId,
          sectionId: body.sectionId,
          order: body.order,
        });
      },
    );

    return toLiveSessionResponse(moved);
  }

  /**
   * Session attendance, for the management table.
   *
   * Managing role required: one student must never be able to read the
   * whole class's participation. A student sees only their own, through
   * their own learning surface and the self-scoped RLS policy.
   */
  @Get(':id/live-sessions/:liveSessionId/attendance')
  async attendance(
    @Req() request: Request,
    @Param('liveSessionId') liveSessionId: string,
  ) {
    const { academyId, organizationId } = request.academyContext!;
    const actorUserId = request.authContext!.userId;

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      await this.assertCanManage(tx, academyId, actorUserId);
      // Proves the session belongs to this academy before any attendance
      // is read — an id from another tenant 404s here, not at the table.
      await this.liveSessionService.getById(tx, academyId, liveSessionId);

      const rows = await this.attendanceService.getSessionAttendance(tx, liveSessionId);
      return rows.map((row) => ({
        ...row,
        firstJoinedAt: row.firstJoinedAt?.toISOString() ?? null,
        lastLeftAt: row.lastLeftAt?.toISOString() ?? null,
        intervals: row.intervals.map((i) => ({
          joinedAt: i.joinedAt.toISOString(),
          leftAt: i.leftAt?.toISOString() ?? null,
          source: i.source,
        })),
      }));
    });
  }

  /**
   * The same managing-role gate `CoursesService` applies, for the same
   * reason: organization membership alone is read-sufficient, but writing
   * a course activity requires a real academy role.
   */
  private async assertCanManage(
    tx: Parameters<AcademyMembersRepository['findForUserInAcademy']>[0],
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (!membership || !MANAGING_ROLES.has(membership.role)) {
      throw new ForbiddenException({ messageKey: 'errors.course.insufficientRole' });
    }
    return membership.role;
  }
}
