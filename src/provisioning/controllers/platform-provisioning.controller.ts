/**
 * PlatformProvisioningController — `/provisioning-requests*`,
 * `PlatformOwnerGuard`-gated, matching `PlatformProvisioningService`
 * (atlas frontend)'s flat `resource = 'provisioning-requests'` exactly.
 * The Provisioning analog of `PlatformCourseOrderPaymentsController`.
 */
import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import { PlatformProvisioningService } from '../services/platform-provisioning.service';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { ProvisioningRequestResponse } from '../dto/provisioning-request.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('provisioning-requests')
@UseGuards(JwtAuthGuard, PlatformOwnerGuard)
export class PlatformProvisioningController {
  constructor(
    private readonly platformProvisioningService: PlatformProvisioningService,
  ) {}

  @Get()
  async list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<ProvisioningRequestResponse>> {
    return this.platformProvisioningService.listRequests(auth.userId, query);
  }

  @Get(':id')
  async get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.platformProvisioningService.getRequest(auth.userId, requestId);
  }

  @Post(':id/retry')
  async retry(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.platformProvisioningService.retryRequest(auth.userId, requestId);
  }

  @Post(':id/cancel')
  async cancel(
    @CurrentAuthContext() auth: AuthContext,
    @Param('id') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.platformProvisioningService.cancelRequest(auth.userId, requestId);
  }
}
