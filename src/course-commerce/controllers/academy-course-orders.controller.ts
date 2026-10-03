/** AcademyCourseOrdersController — `academies/:id/course-orders*`, read-only. Same guard chain as `AcademyPayoutsController` (`:id` is the academy id); the service applies the Organization-Owner-only finance rule. */
import { Controller, Get, Param, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyCourseOrdersService } from '../services/academy-course-orders.service';
import { AcademyCourseOrderQueryDto } from '../dto/academy-course-order-query.dto';
import type {
  AcademyCourseOrderDetailResponse,
  AcademyCourseOrderResponse,
} from '../dto/academy-course-order.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyCourseOrdersController {
  constructor(private readonly academyCourseOrdersService: AcademyCourseOrdersService) {}

  @Get(':id/course-orders')
  async list(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Query() query: AcademyCourseOrderQueryDto,
  ): Promise<PaginatedResult<AcademyCourseOrderResponse>> {
    return this.academyCourseOrdersService.listForAcademy(
      request.academyContext!,
      academyId,
      query,
    );
  }

  @Get(':id/course-orders/:orderId')
  async get(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Param('orderId') orderId: string,
  ): Promise<AcademyCourseOrderDetailResponse> {
    return this.academyCourseOrdersService.getForAcademy(
      request.academyContext!,
      academyId,
      orderId,
    );
  }
}
