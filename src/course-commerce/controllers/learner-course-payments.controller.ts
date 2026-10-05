/** LearnerCoursePaymentsController — `GET course-payments`, the learner's own payment history. Self-scoped: the learner id is the session's, never a parameter. */
import { Controller, Get, Query, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { LearnerCoursePaymentsService } from '../services/learner-course-payments.service';
import { LearnerCoursePaymentQueryDto } from '../dto/learner-course-payment-query.dto';
import type { LearnerCoursePaymentResponse } from '../dto/learner-course-payment.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('course-payments')
@UseGuards(JwtAuthGuard)
export class LearnerCoursePaymentsController {
  constructor(
    private readonly learnerCoursePaymentsService: LearnerCoursePaymentsService,
  ) {}

  @Get()
  async list(
    @Req() request: Request,
    @Query() query: LearnerCoursePaymentQueryDto,
  ): Promise<PaginatedResult<LearnerCoursePaymentResponse>> {
    return this.learnerCoursePaymentsService.list(request.authContext!.userId, query);
  }
}
