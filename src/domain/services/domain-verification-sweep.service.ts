/**
 * DomainVerificationSweepService (P63) — see the queue types for why it
 * exists. Runs under `runInUserContext(<a real platform-owner id>)`, the
 * same cross-tenant job context `SubscriptionExpiryService` uses, and
 * writes through the `domain_connections_platform_update` policy.
 *
 * Each row is checked in its OWN transaction with the row lock held, so a
 * slow provider answer for one customer never blocks another, and a
 * customer's simultaneous "Check now" simply queues behind (or ahead of)
 * the sweep for that one row. Idempotent: re-running records the same
 * provider truth again. Skips entirely — and says so — when the provider
 * is not configured, rather than stamping `provider_unavailable` on every
 * pending row every ten minutes.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { DomainCheckService } from './domain-check.service';
import { PlatformDomainService } from './platform-domain.service';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type { CloudflareProvider } from '../providers/cloudflare-provider.interface';
import {
  DOMAIN_VERIFICATION_SWEEP_BATCH_SIZE,
  DOMAIN_VERIFICATION_SWEEP_CONNECTED_RECHECK_MS,
  DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK,
  DOMAIN_VERIFICATION_SWEEP_MIN_AGE_MS,
} from '../queue/domain-verification-sweep.types';
import { resolveSubdomainHost } from '../utils/canonical-host.util';

export interface DomainVerificationSweepResult {
  readonly skipped: 'no_platform_owner' | 'provider_unavailable' | null;
  readonly checked: number;
  readonly changed: number;
  readonly failed: number;
}

@Injectable()
export class DomainVerificationSweepService {
  private readonly logger = new Logger(DomainVerificationSweepService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly usersRepository: UsersRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly domainCheckService: DomainCheckService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
  ) {}

  async run(now: Date = new Date()): Promise<DomainVerificationSweepResult> {
    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn('Domain verification sweep skipped: no platform owner exists.');
      return { skipped: 'no_platform_owner', checked: 0, changed: 0, failed: 0 };
    }
    if (!(await this.cloudflareProvider.verifyToken())) {
      this.logger.log('Domain verification sweep skipped: provider not available.');
      return { skipped: 'provider_unavailable', checked: 0, changed: 0, failed: 0 };
    }

    const checkedBefore = new Date(now.getTime() - DOMAIN_VERIFICATION_SWEEP_MIN_AGE_MS);
    const connectedBefore = new Date(
      now.getTime() - DOMAIN_VERIFICATION_SWEEP_CONNECTED_RECHECK_MS,
    );
    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();

    let checked = 0;
    let changed = 0;
    let failed = 0;
    let considered = 0;

    // Each processed row records `lastCheckedAt` and so leaves the due
    // set; batches therefore make progress until nothing is due or the
    // per-tick cap stops us. A row that could not be processed (removed
    // meanwhile, or checked by its owner a moment ago) is skipped, and a
    // batch that only contains such rows ends the tick.
    while (considered < DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK) {
      const due = await this.tenancyContextService.runInUserContext(
        platformOwner.id,
        (tx) =>
          this.domainConnectionsRepository.findManyDueForVerificationSweep(
            tx,
            checkedBefore,
            connectedBefore,
            Math.min(
              DOMAIN_VERIFICATION_SWEEP_BATCH_SIZE,
              DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK - considered,
            ),
          ),
      );
      if (due.length === 0) break;
      const processedBefore = checked + failed;
      considered += due.length;

      for (const candidate of due) {
        try {
          const outcome = await this.tenancyContextService.runInUserContext(
            platformOwner.id,
            async (tx) => {
              // Re-read under the lock: a customer may have removed or
              // re-checked the domain since the candidate list was built.
              const locked = await this.domainConnectionsRepository.lockByAcademyId(
                tx,
                candidate.academyId,
              );
              const dueBefore =
                locked?.status === 'connected' ? connectedBefore : checkedBefore;
              if (
                !locked?.hostname ||
                (locked.lastCheckedAt && locked.lastCheckedAt >= dueBefore)
              ) {
                return null;
              }
              const result = await this.domainCheckService.check(tx, locked);
              const subdomain = await this.subdomainAllocationsRepository.findByAcademyId(
                tx,
                candidate.academyId,
              );
              return { result, subdomain };
            },
          );
          if (!outcome) continue;
          checked += 1;
          if (outcome.result.error) failed += 1;
          if (outcome.result.canonicalMayHaveChanged) {
            changed += 1;
            const hosts = [outcome.result.after.hostname, outcome.subdomain?.subdomain];
            const full = resolveSubdomainHost({
              subdomainFullHost: outcome.subdomain?.fullHost,
              subdomainLabel: outcome.subdomain?.subdomain,
              baseDomain,
            });
            await this.publicWebsiteCacheService.invalidateHostnameResolution(
              [...hosts, full].filter((h): h is string => Boolean(h)),
            );
          }
        } catch (error) {
          failed += 1;
          this.logger.warn(
            {
              academyId: candidate.academyId,
              error: error instanceof Error ? error.message : 'unknown',
            },
            'Domain verification sweep: one row failed',
          );
        }
      }
      // Nothing in this batch could be processed: stop rather than spin.
      if (checked + failed === processedBefore) break;
    }

    this.logger.log(
      { considered, checked, changed, failed },
      'Domain verification sweep complete.',
    );
    return { skipped: null, checked, changed, failed };
  }
}
