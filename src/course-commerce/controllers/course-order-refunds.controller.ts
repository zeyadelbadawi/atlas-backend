/** CourseOrderRefundsController — `course-orders/:id/refund`, buyer-self-scoped and buyer-initiated (this session's product direction — see `CourseOrderRefundsService`'s own doc comment). */
import { Body, Controller, Get, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseOrderRefundsService } from '../services/course-order-refunds.service';
import { RequestCourseOrderRefundDto } from '../dto/request-course-order-refund.dto';
import type { CourseOrderRefundResponse } from '../dto/course-order-refund.contract';

@Controller('course-orders')
@UseGuards(JwtAuthGuard)
export class CourseOrderRefundsController {
  constructor(private readonly courseOrderRefundsService: CourseOrderRefundsService) {}

  @Post(':id/refund')
  async request(
    @Req() request: Request,
    @Param('id') orderId: string,
    @Body() payload: RequestCourseOrderRefundDto,
  ): Promise<CourseOrderRefundResponse> {
    return this.courseOrderRefundsService.requestRefund(
      request.authContext!.userId,
      orderId,
      payload,
    );
  }

  /** `null` (never 404) when no refund exists yet — matches `EnrollmentsController.getForCourse`'s identical `@Res()` rationale for a real, distinguishable "not requested" state. */
  @Get(':id/refund')
  async get(
    @Req() request: Request,
    @Res() response: Response,
    @Param('id') orderId: string,
  ): Promise<void> {
    const result = await this.courseOrderRefundsService.getRefund(
      request.authContext!.userId,
      orderId,
    );
    response.status(200).json(result);
  }
}
