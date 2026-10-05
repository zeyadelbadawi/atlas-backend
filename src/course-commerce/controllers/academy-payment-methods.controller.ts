/**
 * AcademyPaymentMethodsController — `academies/:id/payment-methods*`
 * (Academy Manual Payments). Same guard chain as `AcademyCourseOrdersController`
 * (`:id` is the academy id); the service applies the Organization-Owner-only
 * finance rule.
 */
import { Body, Controller, Get, Param, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyPaymentMethodsService } from '../services/academy-payment-methods.service';
import {
  SaveAcademyBankTransferMethodDto,
  SaveAcademyInstapayMethodDto,
  SaveAcademyWalletMethodDto,
} from '../dto/academy-payment-method.dto';
import type { AcademyPaymentMethodResponse } from '../dto/academy-payment-method.contract';

@Controller('academies')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
export class AcademyPaymentMethodsController {
  constructor(
    private readonly academyPaymentMethodsService: AcademyPaymentMethodsService,
  ) {}

  @Get(':id/payment-methods')
  async list(
    @Req() request: Request,
    @Param('id') academyId: string,
  ): Promise<AcademyPaymentMethodResponse[]> {
    return this.academyPaymentMethodsService.list(request.academyContext!, academyId);
  }

  @Put(':id/payment-methods/bank-transfer')
  async saveBankTransfer(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Body() payload: SaveAcademyBankTransferMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.academyPaymentMethodsService.saveBankTransfer(
      request.academyContext!,
      request.authContext!.userId,
      academyId,
      payload,
    );
  }

  @Put(':id/payment-methods/instapay')
  async saveInstapay(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Body() payload: SaveAcademyInstapayMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.academyPaymentMethodsService.saveInstapay(
      request.academyContext!,
      request.authContext!.userId,
      academyId,
      payload,
    );
  }

  @Put(':id/payment-methods/wallet')
  async saveWallet(
    @Req() request: Request,
    @Param('id') academyId: string,
    @Body() payload: SaveAcademyWalletMethodDto,
  ): Promise<AcademyPaymentMethodResponse> {
    return this.academyPaymentMethodsService.saveWallet(
      request.academyContext!,
      request.authContext!.userId,
      academyId,
      payload,
    );
  }
}
