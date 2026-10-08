/**
 * `platform/customer-requests/*` and `platform/customer-request-routing` —
 * the Platform Owner console. Full Platform Owner stack on every route:
 * a real session, the management surface, and `PlatformOwnerGuard` (which
 * re-reads `is_platform_owner` per request). RLS repeats it underneath.
 */
import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { PlatformOwnerGuard } from '../../identity/guards/platform-owner.guard';
import { CurrentAuthContext } from '../../identity/decorators/auth-context.decorator';
import type { AuthContext } from '../../identity/guards/jwt-auth.guard';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { PlatformCustomerRequestsService } from '../services/platform-customer-requests.service';
import { ListPlatformCustomerRequestsQueryDto } from '../dto/list-customer-requests-query.dto';
import { UpdateCustomerRequestDto } from '../dto/update-customer-request.dto';
import { TeamCustomerRequestMessageDto } from '../dto/customer-request-message.dto';
import { UpdateRoutingRulesDto } from '../dto/routing-rules.dto';
import type {
  CustomerRequestCountsResponse,
  PlatformCustomerRequestDetailResponse,
  PlatformCustomerRequestSummaryResponse,
  PlatformOwnerOptionResponse,
  RoutingRuleResponse,
} from '../dto/customer-request.contract';

@Controller('platform')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard)
export class PlatformCustomerRequestsController {
  constructor(private readonly service: PlatformCustomerRequestsService) {}

  @Get('customer-requests')
  list(
    @CurrentAuthContext() auth: AuthContext,
    @Query() query: ListPlatformCustomerRequestsQueryDto,
  ): Promise<PaginatedResult<PlatformCustomerRequestSummaryResponse>> {
    return this.service.list(auth.userId, query);
  }

  /** Declared before `:requestId`. */
  @Get('customer-requests/counts')
  counts(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<CustomerRequestCountsResponse> {
    return this.service.counts(auth.userId);
  }

  @Get('customer-requests/assignees')
  owners(
    @CurrentAuthContext() auth: AuthContext,
  ): Promise<PlatformOwnerOptionResponse[]> {
    return this.service.owners(auth.userId);
  }

  @Get('customer-requests/:requestId')
  get(
    @CurrentAuthContext() auth: AuthContext,
    @Param('requestId', ParseUUIDPipe) requestId: string,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    return this.service.get(auth.userId, requestId);
  }

  @Patch('customer-requests/:requestId')
  update(
    @CurrentAuthContext() auth: AuthContext,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() payload: UpdateCustomerRequestDto,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    return this.service.update(auth.userId, requestId, payload);
  }

  @Post('customer-requests/:requestId/messages')
  message(
    @CurrentAuthContext() auth: AuthContext,
    @Param('requestId', ParseUUIDPipe) requestId: string,
    @Body() payload: TeamCustomerRequestMessageDto,
  ): Promise<PlatformCustomerRequestDetailResponse> {
    return this.service.message(
      auth.userId,
      requestId,
      payload.body,
      payload.internal === true,
    );
  }

  @Get('customer-request-routing')
  routing(@CurrentAuthContext() auth: AuthContext): Promise<RoutingRuleResponse[]> {
    return this.service.routing(auth.userId);
  }

  @Put('customer-request-routing')
  updateRouting(
    @CurrentAuthContext() auth: AuthContext,
    @Body() payload: UpdateRoutingRulesDto,
  ): Promise<RoutingRuleResponse[]> {
    return this.service.updateRouting(auth.userId, payload.rules);
  }
}
