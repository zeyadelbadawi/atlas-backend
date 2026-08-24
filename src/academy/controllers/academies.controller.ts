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
import { CreateAcademyDto } from '../dto/create-academy.dto';
import { UpdateAcademyDto } from '../dto/update-academy.dto';
import { UpdateAcademyBrandingDto } from '../dto/update-academy-branding.dto';
import { CollectionQueryDto, ListAcademiesQueryDto } from '../dto/list-query.dto';
import type { AcademyResponse } from '../dto/academy.contract';
import type { AcademyMemberResponse } from '../dto/academy-member.contract';
import type { AcademyStatsResponse } from '../dto/academy-stats.contract';
import type { AcademyActivityResponse } from '../dto/academy-activity.contract';
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

  @Post()
  @UseGuards(AcademyOrganizationScopeGuard)
  async create(
    @Req() request: Request,
    @Body() body: CreateAcademyDto,
  ): Promise<AcademyResponse> {
    // `request.authContext` is guaranteed set — `JwtAuthGuard` runs first.
    return this.academiesService.create(request.authContext!.userId, body);
  }

  @Get(':id')
  @UseGuards(AcademyScopeGuard)
  async getById(@Req() request: Request): Promise<AcademyResponse> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getById(academyId, organizationId);
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

  @Get(':id/members')
  @UseGuards(AcademyScopeGuard)
  async getMembers(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyMemberResponse>> {
    const { academyId, organizationId } = request.academyContext!;
    return this.academiesService.getMembers(academyId, organizationId, query);
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
}
