/**
 * PaymentController — `organizations/:id/payments`, `organizations/:id/invoices`
 * (master plan §10). Reuses `OrganizationMembershipGuard` verbatim, exactly
 * like `CheckoutController`.
 *
 * `getProofFile` bypasses Nest's default response handling via `@Res()` —
 * this is the one endpoint in this module that returns raw bytes, not
 * JSON — matching `EnrollmentsController.getForCourse`'s established
 * precedent for the same reason (see that controller's own doc comment
 * for the general `@Res()`-usage rule this follows).
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { PaymentService } from '../services/payment.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { SubmitPaymentProofDto } from '../dto/submit-payment-proof.dto';
import { CreatePaymentIntentDto } from '../dto/create-payment-intent.dto';
import { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PaymentIntentResponse } from '../dto/payment-intent.contract';
import type { TenantInvoiceResponse } from '../dto/tenant-invoice.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, OrganizationMembershipGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post(':id/payments')
  async create(
    @Param('id') organizationId: string,
    @Body() payload: CreatePaymentDto,
  ): Promise<PaymentResponse> {
    return this.paymentService.createPayment(organizationId, payload);
  }

  @Get(':id/payments')
  async list(
    @Param('id') organizationId: string,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<PaymentResponse>> {
    return this.paymentService.getPayments(organizationId, query);
  }

  @Get(':id/payments/:paymentId')
  async get(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.paymentService.getPayment(organizationId, paymentId);
  }

  @Patch(':id/payments/:paymentId/proof')
  async submitProof(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: SubmitPaymentProofDto,
  ): Promise<PaymentResponse> {
    return this.paymentService.submitProof(organizationId, paymentId, payload);
  }

  @Post(':id/payments/:paymentId/cancel')
  async cancel(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.paymentService.cancelPayment(organizationId, paymentId);
  }

  @Post(':id/payments/intents')
  async createIntent(
    @Param('id') organizationId: string,
    @Body() payload: CreatePaymentIntentDto,
  ): Promise<PaymentIntentResponse> {
    return this.paymentService.createPaymentIntent(organizationId, payload.checkoutId);
  }

  @Get(':id/payments/:paymentId/proof/file')
  async getProofFile(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } = await this.paymentService.getProofFile(
      organizationId,
      paymentId,
    );
    response
      .status(200)
      .set('Content-Type', mimeType)
      .set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`)
      .send(buffer);
  }

  @Get(':id/invoices')
  async listInvoices(
    @Param('id') organizationId: string,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<TenantInvoiceResponse>> {
    return this.paymentService.getInvoices(organizationId, query);
  }
}
