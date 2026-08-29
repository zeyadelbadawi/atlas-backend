/**
 * OrganizationsController — `POST /organizations` (Phase P19). The
 * self-service creation endpoint `Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md`
 * (P0-1) found entirely missing. Deliberately a SEPARATE controller from
 * `PlatformModule`'s `organizations.controller.ts` (the flat, read-only,
 * Platform-Owner-only cross-tenant view) — same base path, disjoint
 * routes, exactly like `CheckoutController`/`PaymentController`/
 * `ProvisioningRequestsController` already coexist under
 * `@Controller('organizations')` in their own modules. No
 * `OrganizationMembershipGuard` here: there is no `:id` yet — the caller
 * doesn't have a membership to verify until this endpoint creates one.
 */
import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { OrganizationsService } from '../services/organizations.service';
import { CreateOrganizationDto } from '../dto/create-organization.dto';
import type { OrganizationResponse } from '../dto/organization.contract';

@Controller('organizations')
@UseGuards(JwtAuthGuard)
export class OrganizationsController {
  constructor(private readonly organizationsService: OrganizationsService) {}

  @Post()
  async create(
    @Req() request: Request,
    @Body() payload: CreateOrganizationDto,
  ): Promise<OrganizationResponse> {
    // `request.authContext` is guaranteed set — `JwtAuthGuard` runs first.
    return this.organizationsService.create(request.authContext!.userId, payload);
  }
}
