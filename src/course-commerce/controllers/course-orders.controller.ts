/**
 * CourseOrdersController — `courses/:id/course-orders` (create — matches
 * master plan §10's own "nested under courses for creation" instruction),
 * `/course-orders` (flat list/get). Buyer-self-scoped throughout —
 * `studentId` is always resolved from `request.authContext.userId`, never
 * a request parameter, matching `EnrollmentsController`'s identical rule.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseOrdersService } from '../services/course-orders.service';
import { CreateCourseOrderDto } from '../dto/create-course-order.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { CourseOrderResponse } from '../dto/course-order.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller()
@UseGuards(JwtAuthGuard)
export class CourseOrdersController {
  constructor(private readonly courseOrdersService: CourseOrdersService) {}

  @Post('courses/:id/course-orders')
  async create(
    @Req() request: Request,
    @Param('id') courseId: string,
    @Body() payload: CreateCourseOrderDto,
  ): Promise<CourseOrderResponse> {
    return this.courseOrdersService.createOrder(
      request.authContext!.userId,
      courseId,
      payload,
    );
  }

  @Get('course-orders')
  async list(
    @Req() request: Request,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<CourseOrderResponse>> {
    return this.courseOrdersService.listOrders(request.authContext!.userId, query);
  }

  @Get('course-orders/:orderId')
  async get(
    @Req() request: Request,
    @Param('orderId') orderId: string,
  ): Promise<CourseOrderResponse> {
    return this.courseOrdersService.getOrder(request.authContext!.userId, orderId);
  }
}
