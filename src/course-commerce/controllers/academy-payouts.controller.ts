/** AcademyPayoutsController — `academies/:id/payouts*`, reuses `AcademyScopeGuard` verbatim (same route shape `CoursesController`/`MediaController` already established: `:id` is the academy id). */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyPayoutsService } from '../services/academy-payouts.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type {
  AcademyPayoutResponse,
  AcademyRevenueSummaryResponse,
} from '../dto/academy-payout.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, AcademyScopeGuard)
export class AcademyPayoutsController {
  constructor(private readonly academyPayoutsService: AcademyPayoutsService) {}

  @Get(':id/payouts')
  async list(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyPayoutResponse>> {
    return this.academyPayoutsService.listForAcademy(
      request.academyContext!.organizationId,
      academyId,
      query,
    );
  }

  @Get(':id/payouts/revenue-summary')
  async revenueSummary(
    @Req() request: Request,
    @Param('id') academyId: string,
  ): Promise<AcademyRevenueSummaryResponse> {
    return this.academyPayoutsService.getRevenueSummary(
      request.academyContext!.organizationId,
      academyId,
    );
  }
}
