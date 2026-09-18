/**
 * SubdomainAvailabilityService — backs `GET /subdomains/availability`, the
 * one deliberately global (non-Organization-scoped) provisioning endpoint:
 * a subdomain is unique across all of Atlas, not per Tenant (frontend
 * `ProvisioningService`'s own doc comment). Server-side enforcement of
 * `RESERVED_SUBDOMAINS` is real here — the frontend schema only validates
 * shape (`provisioning.schemas.ts` never imports the reserved list), so
 * this is the one place "atlas"/"admin"/etc. are actually refused.
 */
import { Injectable } from '@nestjs/common';
import { SubdomainAllocationsRepository } from '../../domain/repositories/subdomain-allocations.repository';
import { PlatformDomainService } from '../../domain/services/platform-domain.service';
import { buildFullHost } from '../../domain/utils/effective-base-domain.util';
import { RESERVED_SUBDOMAINS } from '../dto/provisioning.constants';
import type { SubdomainAllocationResponse } from '../../domain/dto/domain.contract';

@Injectable()
export class SubdomainAvailabilityService {
  constructor(
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainService: PlatformDomainService,
  ) {}

  async checkAvailability(rawSubdomain: string): Promise<SubdomainAllocationResponse> {
    const subdomain = rawSubdomain.trim().toLowerCase();
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
      return { subdomain, status: 'reserved' };
    }

    const taken = await this.subdomainAllocationsRepository.existsBySubdomain(subdomain);
    if (taken) {
      return { subdomain, status: 'unavailable' };
    }

    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();
    return {
      subdomain,
      status: 'available',
      fullHost: buildFullHost(subdomain, baseDomain) ?? undefined,
    };
  }
}
