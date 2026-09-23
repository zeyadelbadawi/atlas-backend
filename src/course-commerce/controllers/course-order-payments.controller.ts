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
import type { PaymentMethodResponse } from '../../billing/dto/payment-method.contract';

@Controller('course-orders')
@UseGuards(JwtAuthGuard)
export class CourseOrderPaymentsController {
  constructor(private readonly courseOrderPaymentsService: CourseOrderPaymentsService) {}

  /**
   * P64 Phase 4 — the learner checkout's method list, scoped to the
   * caller's own order. The platform catalog at `GET /payment-methods`
   * is `ManagementSurfaceGuard`-only by design; this is the learner
   * surface's equivalent and shows only what would actually be accepted
   * for this order. Self-scoped like every other route here: the order
   * id is checked against `request.authContext.userId`, never trusted
   * from the path alone.
   */
  @Get(':id/payment-methods')
  async listMethods(
    @Req() request: Request,
    @Param('id') orderId: string,
  ): Promise<PaymentMethodResponse[]> {
    return this.courseOrderPaymentsService.listAvailableMethods(
      request.authContext!.userId,
      orderId,
    );
  }

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
