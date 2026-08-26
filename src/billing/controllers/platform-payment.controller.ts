/**
 * PlatformPaymentController — `/payments` (flat, master plan §10:
 * "Payments (Platform review) | /payments (flat) | role"). A SEPARATE,
 * flat resource tree, deliberately not nested under `organizations/
 * :organizationId` — mirrors `PlatformDomainController`'s (P11) identical
 * "role-gated, cross-tenant" reasoning. `PlatformOwnerGuard` reused
 * verbatim, unmodified — the same authorization boundary every other
 * Platform Owner route in this codebase already uses.
 */
import {
  Controller,
  Get,
  Param,
  Post,
  Body,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformPaymentService } from '../services/platform-payment.service';
import { PaymentListQueryDto } from '../dto/payment-list-query.dto';
import { ApprovePaymentDto } from '../dto/approve-payment.dto';
import { RejectPaymentDto } from '../dto/reject-payment.dto';
import type { PaymentResponse } from '../dto/payment.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('payments')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformPaymentController {
  constructor(private readonly platformPaymentService: PlatformPaymentService) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: PaymentListQueryDto,
  ): Promise<PaginatedResult<PaymentResponse>> {
    return this.platformPaymentService.getPayments(auth.userId, query);
  }

  @Get(':id')
  async get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
  ): Promise<PaymentResponse> {
    return this.platformPaymentService.getPayment(auth.userId, paymentId);
  }

  @Post(':id/approve')
  async approve(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Body() payload: ApprovePaymentDto,
  ): Promise<PaymentResponse> {
    return this.platformPaymentService.approvePayment(auth.userId, paymentId, payload);
  }

  @Post(':id/reject')
  async reject(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Body() payload: RejectPaymentDto,
  ): Promise<PaymentResponse> {
    return this.platformPaymentService.rejectPayment(auth.userId, paymentId, payload);
  }

  @Get(':id/proof/file')
  async getProofFile(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') paymentId: string,
    @Res() response: Response,
  ): Promise<void> {
    const { buffer, mimeType, fileName } = await this.platformPaymentService.getProofFile(
      auth.userId,
      paymentId,
    );
    response
      .status(200)
      .set('Content-Type', mimeType)
      .set('Content-Disposition', `inline; filename="${encodeURIComponent(fileName)}"`)
      .send(buffer);
  }
}
