/**
 * ProvisioningRequestsController — `organizations/:id/provisioning-requests*`
 * (master plan §10 — `ProvisioningService`'s own `resource = 'organizations'`
 * confirms the nesting). Reuses `OrganizationMembershipGuard` verbatim,
 * exactly like `CheckoutController` — `:id` here IS the organization id
 * directly, no transitive resolution needed.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { ProvisioningRequestsService } from '../services/provisioning-requests.service';
import { CreateProvisioningRequestDto } from '../dto/create-provisioning-request.dto';
import { AttachProvisioningLogoDto } from '../dto/attach-provisioning-logo.dto';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';
import type { ProvisioningRequestResponse } from '../dto/provisioning-request.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
export class ProvisioningRequestsController {
  constructor(
    private readonly provisioningRequestsService: ProvisioningRequestsService,
  ) {}

  @Post(':id/provisioning-requests')
  async create(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Body() payload: CreateProvisioningRequestDto,
  ): Promise<ProvisioningRequestResponse> {
    // `request.authContext` is guaranteed set — `JwtAuthGuard` runs first.
    return this.provisioningRequestsService.createRequest(
      organizationId,
      request.authContext!.userId,
      payload,
    );
  }

  @Get(':id/provisioning-requests')
  async list(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Query() query: CollectionQueryDto,
  ): Promise<PaginatedResult<ProvisioningRequestResponse>> {
    return this.provisioningRequestsService.listRequests(
      organizationId,
      request.authContext!.userId,
      query,
    );
  }

  @Get(':id/provisioning-requests/:requestId')
  async get(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.provisioningRequestsService.getRequest(
      organizationId,
      request.authContext!.userId,
      requestId,
    );
  }

  @Post(':id/provisioning-requests/:requestId/retry')
  async retry(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.provisioningRequestsService.retryRequest(
      organizationId,
      request.authContext!.userId,
      requestId,
    );
  }

  /** W2 — attaches the setup form's logo (already uploaded to the new Academy's media library) by media-asset id. */
  @Put(':id/provisioning-requests/:requestId/brand-logo')
  async attachLogo(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
    @Body() payload: AttachProvisioningLogoDto,
  ): Promise<ProvisioningRequestResponse> {
    return this.provisioningRequestsService.attachLogo(
      organizationId,
      request.authContext!.userId,
      requestId,
      payload.mediaAssetId,
    );
  }

  @Post(':id/provisioning-requests/:requestId/cancel')
  async cancel(
    @Req() request: Request,
    @Param('id') organizationId: string,
    @Param('requestId') requestId: string,
  ): Promise<ProvisioningRequestResponse> {
    return this.provisioningRequestsService.cancelRequest(
      organizationId,
      request.authContext!.userId,
      requestId,
    );
  }
}
