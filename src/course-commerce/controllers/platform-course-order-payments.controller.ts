/** PlatformCourseOrderPaymentsController — `/platform-course-order-payments*`, `PlatformOwnerGuard`-gated. The Course Commerce analog of `PlatformPaymentController` (P12) — kept as its own, separate route tree (never merged into `/payments`) so the two review queues never bleed into each other, matching `PaymentsRepository`'s own `checkoutId`/`courseOrderId`-partitioned query methods. */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformCourseOrderPaymentsService } from '../services/platform-course-order-payments.service';
import { ApprovePaymentDto } from '../../billing/dto/approve-payment.dto';
import { RejectPaymentDto } from '../../billing/dto/reject-payment.dto';
import { PaymentListQueryDto } from '../../billing/dto/payment-list-query.dto';
import type { CourseOrderPaymentResponse } from '../dto/course-order-payment.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-course-order-payments')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformCourseOrderPaymentsController {
  constructor(
    private readonly platformCourseOrderPaymentsService: PlatformCourseOrderPaymentsService,
  ) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<CourseOrderPaymentResponse>> {
    return this.platformCourseOrderPaymentsService.getPayments(auth.userId, query);
  }

  @Get(':id')
  async get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
  ): Promise<CourseOrderPaymentResponse> {
    return this.platformCourseOrderPaymentsService.getPayment(auth.userId, paymentId);
  }

  @Post(':id/approve')
  async approve(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Body() payload: ApprovePaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    return this.platformCourseOrderPaymentsService.approvePayment(
      auth.userId,
      paymentId,
      payload,
    );
  }

  @Post(':id/reject')
  async reject(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Body() payload: RejectPaymentDto,
  ): Promise<CourseOrderPaymentResponse> {
    return this.platformCourseOrderPaymentsService.rejectPayment(
      auth.userId,
      paymentId,
      payload,
    );
  }

  @Get(':id/proof/file')
  async getProofFile(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } =
      await this.platformCourseOrderPaymentsService.getProofFile(auth.userId, paymentId);
    response
      .status(200)
      .set('Content-Type', mimeType)
      .set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`)
      .send(buffer);
  }
}
