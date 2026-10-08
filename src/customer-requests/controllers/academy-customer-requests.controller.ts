/**
 * `academies/:id/customer-requests/*` — an academy's owner/administrator
 * files and follows custom-service requests.
 *
 * Guard stack: a real session on the MANAGEMENT surface, verified academy
 * membership (`AcademyScopeGuard`) and the owner/administrator role —
 * enforced here, not by hiding UI. RLS holds the organization boundary and
 * hides internal history underneath (`CustomerRequestsService`).
 *
 * Allowed while a subscription is inactive: asking for help is exactly what
 * a lapsed customer may need to do.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { AcademyScopeGuard } from '../../academy/guards/academy-scope.guard';
import { AcademyRoles } from '../../academy/decorators/academy-roles.decorator';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { CUSTOMER_REQUEST_ACADEMY_ROLES } from '../customer-requests.constants';
import {
  CustomerRequestsService,
  type AcademyActor,
} from '../services/customer-requests.service';
import { CreateCustomerRequestDto } from '../dto/create-customer-request.dto';
import { CustomerRequestMessageDto } from '../dto/customer-request-message.dto';
import { ListCustomerRequestsQueryDto } from '../dto/list-customer-requests-query.dto';
import type {
  CustomerRequestDetailResponse,
  CustomerRequestSummaryResponse,
} from '../dto/customer-request.contract';

function actorOf(request: Request): AcademyActor {
  const context = request.academyContext!;
  return {
    userId: request.authContext!.userId,
    organizationId: context.organizationId,
    academyId: context.academyId,
    role: context.academyRole,
  };
}

@AllowInactiveSubscription()
@Controller('academies/:id/customer-requests')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, AcademyScopeGuard)
@AcademyRoles(...CUSTOMER_REQUEST_ACADEMY_ROLES)
export class AcademyCustomerRequestsController {
  constructor(private readonly service: CustomerRequestsService) {}

  @Post()
  create(
    @Req() request: Request,
    @Body() payload: CreateCustomerRequestDto,
  ): Promise<CustomerRequestDetailResponse> {
    return this.service.create(actorOf(request), payload);
  }

  @Get()
  list(
    @Req() request: Request,
    @Query() query: ListCustomerRequestsQueryDto,
  ): Promise<PaginatedResult<CustomerRequestSummaryResponse>> {
    return this.service.list(actorOf(request), query);
  }

  @Get(':requestId')
  get(
    @Req() request: Request,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<CustomerRequestDetailResponse> {
    return this.service.get(actorOf(request), requestId);
  }

  @Post(':requestId/messages')
  reply(
    @Req() request: Request,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() payload: CustomerRequestMessageDto,
  ): Promise<CustomerRequestDetailResponse> {
    return this.service.reply(actorOf(request), requestId, payload.body);
  }

  @Post(':requestId/cancel')
  cancel(
    @Req() request: Request,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<CustomerRequestDetailResponse> {
    return this.service.cancel(actorOf(request), requestId);
  }
}
