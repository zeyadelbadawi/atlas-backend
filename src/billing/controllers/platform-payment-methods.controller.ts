/** Platform Owner configuration of the manual payment methods (bank transfer, mobile wallets, InstaPay) — see `PlatformPaymentMethodsService`. */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { PlatformPaymentMethodsService } from '../services/platform-payment-methods.service';
import {
  CreatePlatformBankTransferMethodDto,
  CreatePlatformInstapayMethodDto,
  CreatePlatformWalletMethodDto,
  UpdatePlatformPaymentMethodDto,
} from '../dto/platform-payment-method.dto';
import type { PlatformPaymentMethodResponse } from '../dto/payment-method.contract';

@Controller('platform-payment-methods')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformPaymentMethodsController {
  constructor(private readonly service: PlatformPaymentMethodsService) {}

  @Get()
  async list(
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<PlatformPaymentMethodResponse>> {
    return this.service.list(query);
  }

  @Post('bank-transfer')
  async createBankTransfer(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: CreatePlatformBankTransferMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.service.createBankTransfer(auth.userId, payload);
  }

  @Post('wallet')
  async createWallet(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: CreatePlatformWalletMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.service.createWallet(auth.userId, payload);
  }

  @Post('instapay')
  async createInstapay(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: CreatePlatformInstapayMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.service.createInstapay(auth.userId, payload);
  }

  @Patch(':id')
  async update(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() payload: UpdatePlatformPaymentMethodDto,
  ): Promise<PlatformPaymentMethodResponse> {
    return this.service.update(auth.userId, id, payload);
  }
}
