/**
 * SubdomainAvailabilityController — `GET /subdomains/availability`,
 * deliberately global/non-Organization-scoped, matching
 * `ProvisioningService.checkSubdomainAvailability`'s own doc comment: a
 * subdomain is unique across all of Atlas, not per Tenant. `JwtAuthGuard`
 * only (no membership check) — the same "authenticated, not tenant-scoped"
 * precedent `InfrastructureController` already establishes for a global
 * read.
 */
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../identity/guards/jwt-auth.guard';
import { SubdomainAvailabilityService } from '../services/subdomain-availability.service';
import { CheckSubdomainAvailabilityDto } from '../dto/check-subdomain-availability.dto';
import type { SubdomainAllocationResponse } from '../../domain/dto/domain.contract';

@Controller('subdomains')
@UseGuards(JwtAuthGuard)
export class SubdomainAvailabilityController {
  constructor(
    private readonly subdomainAvailabilityService: SubdomainAvailabilityService,
  ) {}

  @Get('availability')
  async checkAvailability(
    @Query() query: CheckSubdomainAvailabilityDto,
  ): Promise<SubdomainAllocationResponse> {
    return this.subdomainAvailabilityService.checkAvailability(query.subdomain);
  }
}
