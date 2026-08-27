/**
 * CourseOrderPaymentsController — `course-orders/:id/payments*`,
 * buyer-self-scoped throughout (see `CourseOrdersController`'s identical
 * rule). Mirrors `PaymentController`'s route shape exactly, one level
 * nested under `course-orders/:id` instead of `organizations/:id`.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Res,
  UseGuards,
  Req,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { CourseOrderPaymentsService } from '../services/course-order-payments.service';
import { CreateCourseOrderPaymentDto } from '../dto/create-course-order-payment.dto';
import { SubmitCourseOrderPaymentProofDto } from '../dto/submit-course-order-payment-proof.dto';
import type { CourseOrderPaymentResponse } from '../dto/course-order-payment.contract';

@Controller('course-orders')
@UseGuards(JwtAuthGuard)
export class CourseOrderPaymentsController {
  constructor(private readonly courseOrderPaymentsService: CourseOrderPaymentsService) {}

  @Post(':id/payments')
  async create(
    @Req() request: Request,
    @Param('id') orderId: string,
    @Body() payload: CreateCourseOrderPaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    return this.courseOrderPaymentsService.createPayment(
      request.authContext!.userId,
      orderId,
      payload,
    );
  }

  @Get(':id/payments/:paymentId')
  async get(
    @Req() request: Request,
    @Param('id') orderId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<CourseOrderPaymentResponse> {
    return this.courseOrderPaymentsService.getPayment(
      request.authContext!.userId,
      orderId,
      paymentId,
    );
  }

  @Patch(':id/payments/:paymentId/proof')
  async submitProof(
    @Req() request: Request,
    @Param('id') orderId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: SubmitCourseOrderPaymentProofDto,
  ): Promise<CourseOrderPaymentResponse> {
    return this.courseOrderPaymentsService.submitProof(
      request.authContext!.userId,
      orderId,
      paymentId,
      payload,
    );
  }

  @Get(':id/payments/:paymentId/proof/file')
  async getProofFile(
    @Req() request: Request,
    @Param('id') orderId: string,
    @Param('paymentId') paymentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } =
      await this.courseOrderPaymentsService.getProofFile(
        request.authContext!.userId,
        orderId,
        paymentId,
      );
    response
      .status(200)
      .set('Content-Type', mimeType)
      .set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`)
      .send(buffer);
  }
}
