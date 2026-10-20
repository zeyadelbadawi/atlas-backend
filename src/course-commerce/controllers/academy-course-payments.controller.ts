/**
 * AcademyCoursePaymentsController — `academies/:id/course-payments*`, the
 * Client Owner's review of learners' payments to the academy (Academy
 * Manual Payments). Same guard chain as `AcademyCourseOrdersController`; the
 * service applies the Organization-Owner-only rule and pins every query to
 * this academy's `academy_manual` payments.
 *
 * LAPSED SUBSCRIPTION. Approve and reject carry `@AllowInactiveSubscription`
 * (the same exemption support and billing have): a pending payment is money
 * the learner ALREADY sent to the academy, so refusing the review while the
 * academy's own Atlas subscription is lapsed would strand the learner's
 * money and access, not the academy's. The exemption is exactly these two
 * handlers, and they can only settle a payment that is already waiting for
 * review (`loadReviewable` → 409 otherwise) — no new sale, price or
 * payment-method change. Payment-method setup and everything else stay
 * read-only until the subscription is active again.
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';
import { AcademyCoursePaymentsService } from '../services/academy-course-payments.service';
import { AcademyCoursePaymentQueryDto } from '../dto/academy-course-payment-query.dto';
import {
  ApproveAcademyCoursePaymentDto,
  RejectAcademyCoursePaymentDto,
} from '../dto/review-academy-course-payment.dto';
import type {
  AcademyCoursePaymentCountsResponse,
  AcademyCoursePaymentDetailResponse,
  AcademyCoursePaymentResponse,
} from '../dto/academy-course-payment.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyCoursePaymentsController {
  constructor(
    private readonly academyCoursePaymentsService: AcademyCoursePaymentsService,
  ) {}

  @Get(':id/course-payments')
  async list(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Query() query: AcademyCoursePaymentQueryDto,
  ): Promise<
    PaginatedResult<AcademyCoursePaymentResponse> & {
      counts: AcademyCoursePaymentCountsResponse;
    }
  > {
    return this.academyCoursePaymentsService.list(
      request.academyContext!,
      academyId,
      query,
    );
  }

  @Get(':id/course-payments/:paymentId')
  async get(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    return this.academyCoursePaymentsService.get(
      request.academyContext!,
      academyId,
      paymentId,
    );
  }

  @Get(':id/course-payments/:paymentId/proof/file')
  async getProofFile(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Param('paymentId') paymentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } =
      await this.academyCoursePaymentsService.getProofFile(
        request.academyContext!,
        academyId,
        paymentId,
      );
    response
      .status(200)
      .set('Content-Type', mimeType)
      .set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`)
      .set('Cache-Control', 'private, no-store')
      .set('X-Content-Type-Options', 'nosniff')
      .send(buffer);
  }

  @Post(':id/course-payments/:paymentId/approve')
  @HttpCode(200)
  @AllowInactiveSubscription()
  async approve(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: ApproveAcademyCoursePaymentDto,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    return this.academyCoursePaymentsService.approve(
      request.academyContext!,
      request.authContext!.userId,
      academyId,
      paymentId,
      payload,
    );
  }

  @Post(':id/course-payments/:paymentId/reject')
  @HttpCode(200)
  @AllowInactiveSubscription()
  async reject(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: RejectAcademyCoursePaymentDto,
  ): Promise<AcademyCoursePaymentDetailResponse> {
    return this.academyCoursePaymentsService.reject(
      request.academyContext!,
      request.authContext!.userId,
      academyId,
      paymentId,
      payload,
    );
  }
}
