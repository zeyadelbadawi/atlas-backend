/** PlatformAcademyPayoutsController — `/platform-academy-payouts*`, `PlatformOwnerGuard`-gated. The ONLY route tree that can create/mark-paid an `AcademyPayout` (see `PlatformAcademyPayoutsService`'s own doc comment for the asymmetric read/write reasoning). */
import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformAcademyPayoutsService } from '../services/platform-academy-payouts.service';
import { CreateAcademyPayoutDto } from '../dto/create-academy-payout.dto';
import { MarkAcademyPayoutPaidDto } from '../dto/mark-academy-payout-paid.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { AcademyPayoutResponse } from '../dto/academy-payout.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('platform-academy-payouts')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformAcademyPayoutsController {
  constructor(
    private readonly platformAcademyPayoutsService: PlatformAcademyPayoutsService,
  ) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<AcademyPayoutResponse>> {
    return this.platformAcademyPayoutsService.listAll(auth.userId, query);
  }

  @Post()
  async create(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: CreateAcademyPayoutDto,
  ): Promise<readonly AcademyPayoutResponse[]> {
    return this.platformAcademyPayoutsService.createPayout(auth.userId, payload);
  }

  @Post(':id/mark-paid')
  async markPaid(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') payoutId: string,
    @Body() payload: MarkAcademyPayoutPaidDto,
  ): Promise<AcademyPayoutResponse> {
    return this.platformAcademyPayoutsService.markPaid(
      auth.userId,
      payoutId,
      payload.providerReference,
    );
  }
}
