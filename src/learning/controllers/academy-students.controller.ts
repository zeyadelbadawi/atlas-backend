/**
 * AcademyStudentsController — P64 Phase 1 (Findings F4/F5).
 *
 * The academy student ROSTER and the staff-side enrollment lifecycle,
 * registration policy and invites. Management surface only
 * (`ManagementSurfaceGuard`), academy-scoped (`AcademyScopeGuard`); the
 * per-role rules (owner/manager whole academy, instructor assigned courses,
 * registration policy owner-only) live in `AcademyStudentsService`.
 *
 * Lives in `LearningModule` (not `AcademyModule`) because it reads
 * enrollments, progress, attempts and submissions — `AcademyModule` cannot
 * import `LearningModule` without a cycle.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyStudentsService } from '../services/academy-students.service';
import {
  AcademyRosterQueryDto,
  BlockStudentDto,
  CreateAcademyInviteDto,
  ManualEnrollDto,
  RevokeEnrollmentDto,
  UpdateEnrollmentExpiryDto,
  UpdateRegistrationPolicyDto,
} from '../dto/academy-roster.dto';
import type {
  AcademyInviteResponse,
  AcademyRegistrationPolicyResponse,
  AcademyRosterStudentDetailResponse,
  AcademyRosterStudentResponse,
  RosterEnrollmentResponse,
} from '../dto/academy-roster.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyStudentsController {
  constructor(private readonly academyStudentsService: AcademyStudentsService) {}

  @Get(':id/students')
  list(
    @Req() request: Request,
    @Query() query: AcademyRosterQueryDto,
  ): Promise<PaginatedResult<AcademyRosterStudentResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.list(
      academyId,
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id/students/:userId')
  detail(
    @Req() request: Request,
    @Param('userId') userId: string,
  ): Promise<AcademyRosterStudentDetailResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.getDetail(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
    );
  }

  @Post(':id/students/:userId/block')
  @HttpCode(HttpStatus.OK)
  block(
    @Req() request: Request,
    @Param('userId') userId: string,
    @Body() body: BlockStudentDto,
  ): Promise<AcademyRosterStudentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.block(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
      body,
    );
  }

  @Post(':id/students/:userId/unblock')
  @HttpCode(HttpStatus.OK)
  unblock(
    @Req() request: Request,
    @Param('userId') userId: string,
  ): Promise<AcademyRosterStudentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.unblock(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
    );
  }

  @Post(':id/students/:userId/approve')
  @HttpCode(HttpStatus.OK)
  approve(
    @Req() request: Request,
    @Param('userId') userId: string,
  ): Promise<AcademyRosterStudentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.approve(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
    );
  }

  @Post(':id/students/:userId/reject')
  @HttpCode(HttpStatus.OK)
  reject(
    @Req() request: Request,
    @Param('userId') userId: string,
  ): Promise<AcademyRosterStudentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.reject(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
    );
  }

  @Post(':id/students/:userId/enrollments')
  @HttpCode(HttpStatus.CREATED)
  enroll(
    @Req() request: Request,
    @Param('userId') userId: string,
    @Body() body: ManualEnrollDto,
  ): Promise<RosterEnrollmentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.enrollManually(
      academyId,
      organizationId,
      request.authContext!.userId,
      userId,
      body,
    );
  }

  @Post(':id/enrollments/:enrollmentId/revoke')
  @HttpCode(HttpStatus.OK)
  revoke(
    @Req() request: Request,
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: RevokeEnrollmentDto,
  ): Promise<RosterEnrollmentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.revoke(
      academyId,
      organizationId,
      request.authContext!.userId,
      enrollmentId,
      body,
    );
  }

  @Patch(':id/enrollments/:enrollmentId/expiry')
  updateExpiry(
    @Req() request: Request,
    @Param('enrollmentId') enrollmentId: string,
    @Body() body: UpdateEnrollmentExpiryDto,
  ): Promise<RosterEnrollmentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.updateExpiry(
      academyId,
      organizationId,
      request.authContext!.userId,
      enrollmentId,
      body,
    );
  }

  @Get(':id/registration-policy')
  getRegistrationPolicy(
    @Req() request: Request,
  ): Promise<AcademyRegistrationPolicyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.getRegistrationPolicy(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Patch(':id/registration-policy')
  updateRegistrationPolicy(
    @Req() request: Request,
    @Body() body: UpdateRegistrationPolicyDto,
  ): Promise<AcademyRegistrationPolicyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.updateRegistrationPolicy(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Get(':id/invites')
  listInvites(@Req() request: Request): Promise<readonly AcademyInviteResponse[]> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.listInvites(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/invites')
  @HttpCode(HttpStatus.CREATED)
  createInvite(
    @Req() request: Request,
    @Body() body: CreateAcademyInviteDto,
  ): Promise<AcademyInviteResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.createInvite(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Delete(':id/invites/:inviteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  revokeInvite(
    @Req() request: Request,
    @Param('inviteId') inviteId: string,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academyStudentsService.revokeInvite(
      academyId,
      organizationId,
      request.authContext!.userId,
      inviteId,
    );
  }
}
