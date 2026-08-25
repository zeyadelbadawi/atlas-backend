/**
 * PlatformDomainService — matches the real frontend `PlatformDomainService`
 * exactly: `getPlatformDomainConfiguration`/
 * `updatePlatformDomainConfiguration`. Mirrors `PlansService`'s Trial
 * Policy precedent exactly (one small, focused service for one
 * backend-configurable settings singleton) — no dedicated multi-file
 * service architecture for a single resource.
 */
import { Injectable } from '@nestjs/common';
import { PlatformDomainConfigurationRepository } from '../repositories/platform-domain-configuration.repository';
import {
  toPlatformDomainConfigurationResponse,
  type PlatformDomainConfigurationResponse,
} from '../dto/domain.contract';

@Injectable()
export class PlatformDomainService {
  constructor(
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
  ) {}

  async getPlatformDomainConfiguration(): Promise<PlatformDomainConfigurationResponse> {
    const configuration =
      await this.platformDomainConfigurationRepository.findSingleton();
    return toPlatformDomainConfigurationResponse(configuration);
  }

  async updatePlatformDomainConfiguration(
    baseDomain: string,
  ): Promise<PlatformDomainConfigurationResponse> {
    const configuration =
      await this.platformDomainConfigurationRepository.update(baseDomain);
    return toPlatformDomainConfigurationResponse(configuration);
  }
}
