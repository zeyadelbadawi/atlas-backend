/**
 * AcademiesController — `academies/*` (master plan §10). Implements
 * `AcademyService`'s complete method set (atlas frontend
 * `src/features/academy/services/AcademyService.ts`): P3's Definition of
 * Done.
 *
 * Two distinct guard stacks, matching the two distinct tenancy-resolution
 * paths documented on `AcademyOrganizationScopeGuard`/`AcademyScopeGuard`:
 * the flat collection routes (list/create) resolve organization membership
 * directly from a caller-supplied `organizationId`; every `:id`-scoped
 * route resolves it transitively through the academy.
 */
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyOrganizationScopeGuard } from '../guards/academy-organization-scope.guard';
import { AcademyScopeGuard } from '../guards/academy-scope.guard';
import { AcademiesService } from '../services/academies.service';
import { UpdateAcademyDto } from '../dto/update-academy.dto';
import { DeleteAcademyDto } from '../dto/delete-academy.dto';
import { UpdateAcademyBrandingDto } from '../dto/update-academy-branding.dto';
import { AddAcademyManagerDto } from '../dto/add-academy-manager.dto';
import { AddAcademyInstructorDto } from '../dto/add-academy-instructor.dto';
import { CreateAcademyStudentDto } from '../dto/create-academy-student.dto';
import { UpdateContactSubmissionStatusDto } from '../dto/update-contact-submission-status.dto';
import { CollectionQueryDto, ListAcademiesQueryDto } from '../dto/list-query.dto';
import type { AcademyResponse } from '../dto/academy.contract';
import type { AcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyStudentResponse } from '../dto/academy-student.contract';
import type { AcademyStatsResponse } from '../dto/academy-stats.contract';
import type { AcademyActivityResponse } from '../dto/academy-activity.contract';
import type { ContactSubmissionResponse } from '../dto/contact-submission.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard)
export class AcademiesController {
  constructor(private readonly academiesService: AcademiesService) {}

  @Get()
  @UseGuards(AcademyOrganizationScopeGuard)
  async list(
    @Query() query: ListAcademiesQueryDto,
  ): Promise<PaginatedResult<AcademyResponse>> {
    return this.academiesService.list(query);
  }

  // ---------------------------------------------------------------------
  // THERE IS DELIBERATELY NO `POST /academies` ROUTE.
  //
  // Academy Provisioning (`POST /organizations/:id/provisioning-requests`)
  // is the single authoritative way a user creates an Academy. This route
  // used to be a second, parallel entry point into
  // `AcademiesService.create`, and having two paths caused a real
  // production outage: only the provisioning path allocated the
  // Academy's public subdomain, so every Academy created through this
  // route had a dead public website (three of five in production).
  //
  // `AcademiesService.create` still exists and is still used — but only
  // as an INTERNAL step of the provisioning orchestrator, which owns the
  // full sequence: entitlement check, Academy row, owner membership,
  // subdomain allocation, and public-website setup. Removing the route
  // rather than the method is what keeps that logic reusable while
  // leaving exactly one way in.
  //
  // Removing the route is also the actual enforcement. Hiding the button
  // in the frontend would leave the endpoint reachable by anyone willing
  // to send the request themselves.
  // ---------------------------------------------------------------------

  @Get(':id')
  @UseGuards(AcademyScopeGuard)
  async getById(@Req() request: Request): Promise<AcademyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getById(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  @Patch(':id')
  @UseGuards(AcademyScopeGuard)
  async update(
    @Req() request: Request,
    @Body() body: UpdateAcademyDto,
  ): Promise<AcademyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.update(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Patch(':id/branding')
  @UseGuards(AcademyScopeGuard)
  async updateBranding(
    @Req() request: Request,
    @Body() body: UpdateAcademyBrandingDto,
  ): Promise<AcademyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.updateBranding(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  /**
   * Deletes an Academy without recording a reason.
   *
   * Kept because it is the RESTful shape and existing callers use it. It
   * and `POST :id/delete` below run the identical service method — one
   * implementation behind two transports, not two behaviours that could
   * drift apart.
   */
  @Delete(':id')
  @HttpCode(204)
  @UseGuards(AcademyScopeGuard)
  async archive(@Req() request: Request): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.archive(
      academyId,
      organizationId,
      request.authContext!.userId,
    );
  }

  /**
   * Deletes an Academy AND records why.
   *
   * A separate POST route rather than a body on the DELETE: request
   * bodies on DELETE have no defined semantics, intermediaries are
   * permitted to drop them, and Atlas's own frontend HTTP client types
   * `delete` without a body. The explicit `confirm: true` in the payload
   * also means an accidental empty request cannot take a public website
   * offline.
   *
   * Authorization is identical to the DELETE above — the same
   * `AcademyScopeGuard`, and `archive`'s own `assertCanManage` inside the
   * transaction. This route is a different shape, never a weaker door.
   */
  @Post(':id/delete')
  @HttpCode(204)
  @UseGuards(AcademyScopeGuard)
  async deleteWithReason(
    @Req() request: Request,
    @Body() body: DeleteAcademyDto,
  ): Promise<void> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.archive(
      academyId,
      organizationId,
      request.authContext!.userId,
      { reason: body.reason, feedback: body.feedback },
    );
  }

  @Get(':id/members')
  @UseGuards(AcademyScopeGuard)
  async getMembers(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyMemberResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getMembers(
      academyId,
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Post(':id/members')
  @UseGuards(AcademyScopeGuard)
  async addManager(
    @Req() request: Request,
    @Body() body: AddAcademyManagerDto,
  ): Promise<AcademyMemberResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.addManager(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Post(':id/instructors')
  @UseGuards(AcademyScopeGuard)
  async addInstructor(
    @Req() request: Request,
    @Body() body: AddAcademyInstructorDto,
  ): Promise<AcademyMemberResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.addInstructor(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Post(':id/students')
  @UseGuards(AcademyScopeGuard)
  async createStudent(
    @Req() request: Request,
    @Body() body: CreateAcademyStudentDto,
  ): Promise<AcademyStudentResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.createStudent(
      academyId,
      organizationId,
      request.authContext!.userId,
      body,
    );
  }

  @Get(':id/stats')
  @UseGuards(AcademyScopeGuard)
  async getStats(@Req() request: Request): Promise<AcademyStatsResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getStats(academyId, organizationId);
  }

  @Get(':id/activity')
  @UseGuards(AcademyScopeGuard)
  async getActivity(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyActivityResponse>> {
    const { academyId } = request.academyContext!;
    return this.academiesService.getActivity(academyId, query);
  }

  // -------------------------------------------------------------------
  // Phase 6 — real Contact submissions (staff read/triage). The public
  // WRITE path is `POST public/websites/:academyId/contact`
  // (`PublicWebsiteController`), deliberately not here — this controller
  // requires `JwtAuthGuard`/`AcademyScopeGuard`, neither of which an
  // anonymous website visitor can satisfy.
  // -------------------------------------------------------------------

  @Get(':id/contact-submissions')
  @UseGuards(AcademyScopeGuard)
  async getContactSubmissions(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<ContactSubmissionResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getContactSubmissions(
      academyId,
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Patch(':id/contact-submissions/:submissionId')
  @UseGuards(AcademyScopeGuard)
  async updateContactSubmissionStatus(
    @Req() request: Request,
    @Param('submissionId') submissionId: string,
    @Body() body: UpdateContactSubmissionStatusDto,
  ): Promise<ContactSubmissionResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.updateContactSubmissionStatus(
      academyId,
      organizationId,
      request.authContext!.userId,
      submissionId,
      body,
    );
  }
}
