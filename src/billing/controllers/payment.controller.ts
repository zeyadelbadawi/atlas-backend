/**
 * PaymentController — `organizations/:id/payments`, `organizations/:id/invoices`
 * (master plan §10). `OrganizationMembershipGuard` plus a per-route
 * `@OrganizationPermissions(...)`: the organization's subscription payments,
 * proofs and invoices are the OWNER's — reading them needs
 * `tenant.payment.view` (invoices: `tenant.billing.view`), creating,
 * cancelling or submitting proof for one needs `tenant.payment.create`.
 * All three are owner-exclusive (`ORGANIZATION_OWNER_PERMISSIONS`), so a
 * Manager or Instructor who is an organization member gets 403.
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
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { OrganizationPermissions } from '../../tenancy/decorators/organization-permissions.decorator';
import {
  TENANT_BILLING_PERMISSION,
  TENANT_PAYMENT_CREATE_PERMISSION,
  TENANT_PAYMENT_VIEW_PERMISSION,
} from '../../tenancy/constants/organization-permissions.constants';
import { PaymentService } from '../services/payment.service';
import { CreatePaymentDto } from '../dto/create-payment.dto';
import { SubmitPaymentProofDto } from '../dto/submit-payment-proof.dto';
import { CreatePaymentIntentDto } from '../dto/create-payment-intent.dto';
import { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PaymentIntentResponse } from '../dto/payment-intent.contract';
import type { TenantInvoiceResponse } from '../dto/tenant-invoice.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';

/**
 * ALLOWED WHILE A SUBSCRIPTION IS INACTIVE.
 *
 * Submitting a payment and its proof is the recovery path itself.
 */
@AllowInactiveSubscription()
@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
export class PaymentController {
  constructor(private readonly paymentService: PaymentService) {}

  @Post(':id/payments')
  @OrganizationPermissions(TENANT_PAYMENT_CREATE_PERMISSION)
  async create(
    @Param('id') organizationId: string,
    @Body() payload: CreatePaymentDto,
  ): Promise<PaymentResponse> {
    return this.paymentService.createPayment(organizationId, payload);
  }

  @Get(':id/payments')
  @OrganizationPermissions(TENANT_PAYMENT_VIEW_PERMISSION)
  async list(
    @Param('id') organizationId: string,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<PaymentResponse>> {
    return this.paymentService.getPayments(organizationId, query);
  }

  @Get(':id/payments/:paymentId')
  @OrganizationPermissions(TENANT_PAYMENT_VIEW_PERMISSION)
  async get(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.paymentService.getPayment(organizationId, paymentId);
  }

  @Patch(':id/payments/:paymentId/proof')
  @OrganizationPermissions(TENANT_PAYMENT_CREATE_PERMISSION)
  async submitProof(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
    @Body() payload: SubmitPaymentProofDto,
  ): Promise<PaymentResponse> {
    return this.paymentService.submitProof(
      organizationId,
      paymentId,
      payload,
      auth.userId,
    );
  }

  @Post(':id/payments/:paymentId/cancel')
  @OrganizationPermissions(TENANT_PAYMENT_CREATE_PERMISSION)
  async cancel(
    @Param('id') organizationId: string,
    @Param('paymentId') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.paymentService.cancelPayment(organizationId, paymentId);
  }

  @Post(':id/payments/intents')
  @OrganizationPermissions(TENANT_PAYMENT_CREATE_PERMISSION)
  async createIntent(
    @Param('id') organizationId: string,
    @Body() payload: CreatePaymentIntentDto,
  ): Promise<PaymentIntentResponse> {
    return this.paymentService.createPaymentIntent(organizationId, payload.checkoutId);
  }

  @Get(':id/payments/:paymentId/proof/file')
  @OrganizationPermissions(TENANT_PAYMENT_VIEW_PERMISSION)
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
  @OrganizationPermissions(TENANT_BILLING_PERMISSION)
  async listInvoices(
    @Param('id') organizationId: string,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<TenantInvoiceResponse>> {
    return this.paymentService.getInvoices(organizationId, query);
  }
}
