/**
 * InfrastructureService — matches the real frontend `InfrastructureService`
 * exactly: `getProviderStatus`. A flat, account-level check, distinct
 * from `DomainService` (per-Academy domain lifecycle) — answers one
 * question only: does the backend have real, working
 * infrastructure-provider credentials configured, verified with one real
 * `CloudflareProvider.verifyToken()` round trip (never assumed from
 * credential presence alone, never cached optimistically).
 */
import { Inject, Injectable } from '@nestjs/common';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type { CloudflareProvider } from '../providers/cloudflare-provider.interface';
import type { InfrastructureProviderStatusResponse } from '../dto/domain.contract';
import type { InfrastructureProviderName } from '@prisma/client';

@Injectable()
export class InfrastructureService {
  constructor(
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
  ) {}

  async getProviderStatus(
    provider: InfrastructureProviderName,
  ): Promise<InfrastructureProviderStatusResponse> {
    // Single-entry provider union today (`cloudflare` only) — the real
    // frontend contract has no other value to branch on.
    const connected = await this.cloudflareProvider.verifyToken();
    return { provider, connected };
  }
}
