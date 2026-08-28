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
import { PlatformDomainConfigurationRepository } from '../../domain/repositories/platform-domain-configuration.repository';
import { RESERVED_SUBDOMAINS } from '../dto/provisioning.constants';
import type { SubdomainAllocationResponse } from '../../domain/dto/domain.contract';

@Injectable()
export class SubdomainAvailabilityService {
  constructor(
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
  ) {}

  async checkAvailability(subdomain: string): Promise<SubdomainAllocationResponse> {
    if (RESERVED_SUBDOMAINS.includes(subdomain)) {
      return { subdomain, status: 'reserved' };
    }

    const taken = await this.subdomainAllocationsRepository.existsBySubdomain(subdomain);
    if (taken) {
      return { subdomain, status: 'unavailable' };
    }

    const platformDomainConfig =
      await this.platformDomainConfigurationRepository.findSingleton();
    return {
      subdomain,
      status: 'available',
      fullHost: platformDomainConfig.baseDomain
        ? `${subdomain}.${platformDomainConfig.baseDomain}`
        : undefined,
    };
  }
}
