/**
 * OnboardingController — `organizations/:id/onboarding`
 * (docs/NEW_CUSTOMER_ONBOARDING.md §3.4–3.5).
 *
 * OWNER ONLY. `OrganizationMembershipGuard` proves membership of `:id`; the
 * owner-exclusive `tenant.billing.view` permission (only
 * `ORGANIZATION_OWNER_PERMISSIONS` carries it) then narrows it to the owner,
 * exactly as the subscription endpoints narrow billing to the owner. A
 * manager, instructor or learner — and anyone naming another organization —
 * gets 403.
 *
 * ALLOWED WHILE THE SUBSCRIPTION IS INACTIVE: a customer whose trial was
 * already used starts with `no_plan`, and the wizard's Plan step is how they
 * reach the paid checkout. Gating it on an active plan would be a dead end.
 */
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { ManagementSurfaceGuard } from '../../tenancy/guards/management-surface.guard';
import { OrganizationMembershipGuard } from '../../tenancy/guards/organization-membership.guard';
import { AllowInactiveSubscription } from '../../plans/decorators/allow-inactive-subscription.decorator';
import { OnboardingStatusService } from '../services/onboarding-status.service';
import { CompleteOnboardingDto } from '../dto/complete-onboarding.dto';
import type { OnboardingStatusResponse } from '../dto/onboarding.contract';

/** Owner-exclusive (see `ORGANIZATION_OWNER_PERMISSIONS`). */
const OWNER_ONLY_PERMISSION = 'tenant.billing.view';

@AllowInactiveSubscription()
@Controller('organizations')
@UseGuards(JwtAuthGuard, ManagementSurfaceGuard, OrganizationMembershipGuard)
export class OnboardingController {
  constructor(private readonly onboardingStatusService: OnboardingStatusService) {}

  @Get(':id/onboarding')
  async status(
    @Param('id') organizationId: string,
    @Req() request: Request,
  ): Promise<OnboardingStatusResponse> {
    this.assertOwner(request);
    return this.onboardingStatusService.getStatus(
      organizationId,
      request.authContext!.userId,
    );
  }

  @Post(':id/onboarding/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Param('id') organizationId: string,
    @Req() request: Request,
    @Body() dto: CompleteOnboardingDto,
  ): Promise<OnboardingStatusResponse> {
    this.assertOwner(request);
    return this.onboardingStatusService.complete(
      organizationId,
      request.authContext!.userId,
      dto.mode,
    );
  }

  private assertOwner(request: Request): void {
    const permissions = request.tenantContext?.permissions ?? [];
    if (!permissions.includes(OWNER_ONLY_PERMISSION)) {
      throw new ForbiddenException({ messageKey: 'errors.tenancy.notAMember' });
    }
  }
}
