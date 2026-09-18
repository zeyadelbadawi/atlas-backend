/**
 * DomainVerificationSweepService (P63, hardened P63g) — see the queue
 * types for why it exists. Runs under `runInUserContext(<a real
 * platform-owner id>)`, the same cross-tenant job context
 * `SubscriptionExpiryService` uses, and writes through the
 * `domain_connections_platform_update` policy.
 *
 * Each row is checked in its OWN transaction with the row lock held, so a
 * slow provider answer for one customer never blocks another, and a
 * customer's simultaneous "Check now" simply queues behind (or ahead of)
 * the sweep for that one row. Idempotent: re-running records the same
 * provider truth again. Skips entirely — and says so — when the provider
 * is not configured, rather than stamping `provider_unavailable` on every
 * pending row every ten minutes.
 *
 * P63g:
 *   - the provider token is verified ONCE per tick and passed down;
 *   - rows whose checks keep failing back off exponentially
 *     (`domainCheckBackoffMs`) instead of being re-asked — and, for a
 *     refused registration, re-CREATED — every five minutes forever;
 *   - pending provider releases (replace/remove/archive) are retried;
 *   - a wall-clock budget stops a tick well inside the interval so ticks
 *     never queue up behind each other;
 *   - the completed tick is recorded on the platform configuration so the
 *     readiness page can show the sweep is alive.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../../identity/repositories/users.repository';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { DomainCheckService } from './domain-check.service';
import { DomainProviderReleaseService } from './domain-provider-release.service';
import { PlatformDomainService } from './platform-domain.service';
import {
  DOMAIN_VERIFICATION_SWEEP_BATCH_SIZE,
  DOMAIN_VERIFICATION_SWEEP_CONNECTED_RECHECK_MS,
  DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK,
  DOMAIN_VERIFICATION_SWEEP_MIN_AGE_MS,
  DOMAIN_VERIFICATION_SWEEP_RELEASES_PER_TICK,
  DOMAIN_VERIFICATION_SWEEP_TICK_BUDGET_MS,
} from '../queue/domain-verification-sweep.types';
import { domainCheckBackoffMs } from '../constants/domain.constants';
import { resolveSubdomainHost } from '../utils/canonical-host.util';
import { isCustomDomainSettled } from '../utils/domain-liveness.util';

export interface DomainVerificationSweepResult {
  readonly skipped: 'no_platform_owner' | 'provider_unavailable' | null;
  readonly checked: number;
  readonly changed: number;
  readonly failed: number;
  readonly skippedByBackoff: number;
  readonly releasesProcessed: number;
  readonly releasesFailed: number;
  readonly durationMs: number;
  readonly budgetExhausted: boolean;
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
    private readonly releaseService: DomainProviderReleaseService,
    private readonly platformDomainService: PlatformDomainService,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
  ) {}

  async run(now: Date = new Date()): Promise<DomainVerificationSweepResult> {
    const startedAt = Date.now();
    const finish = (
      partial: Omit<DomainVerificationSweepResult, 'durationMs'>,
    ): DomainVerificationSweepResult => ({
      ...partial,
      durationMs: Date.now() - startedAt,
    });

    const platformOwner = await this.usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      this.logger.warn('Domain verification sweep skipped: no platform owner exists.');
      return finish({
        skipped: 'no_platform_owner',
        checked: 0,
        changed: 0,
        failed: 0,
        skippedByBackoff: 0,
        releasesProcessed: 0,
        releasesFailed: 0,
        budgetExhausted: false,
      });
    }
    // Verified ONCE per tick (P63g). A `false` here skips the checks but
    // still records the tick, so the readiness page can show the sweep is
    // alive even while the provider is not.
    const providerAvailable = await this.platformDomainService.isProviderAvailable(true);
    if (!providerAvailable) {
      this.logger.log('Domain verification sweep skipped: provider not available.');
      const result = finish({
        skipped: 'provider_unavailable',
        checked: 0,
        changed: 0,
        failed: 0,
        skippedByBackoff: 0,
        releasesProcessed: 0,
        releasesFailed: 0,
        budgetExhausted: false,
      });
      await this.platformDomainService.recordSweepResult({ ...result });
      return result;
    }

    const checkedBefore = new Date(now.getTime() - DOMAIN_VERIFICATION_SWEEP_MIN_AGE_MS);
    const connectedBefore = new Date(
      now.getTime() - DOMAIN_VERIFICATION_SWEEP_CONNECTED_RECHECK_MS,
    );
    const { baseDomain } = await this.platformDomainService.getEffectiveBaseDomain();
    const deadline = startedAt + DOMAIN_VERIFICATION_SWEEP_TICK_BUDGET_MS;

    // 1. Pending provider releases first: an orphan at the edge is the
    //    most consequential thing this sweep can fix.
    const releases = await this.tenancyContextService.runInUserContext(
      platformOwner.id,
      (tx) =>
        this.releaseService.processDue(
          tx,
          providerAvailable,
          now,
          DOMAIN_VERIFICATION_SWEEP_RELEASES_PER_TICK,
        ),
    );

    let checked = 0;
    let changed = 0;
    let failed = 0;
    let skippedByBackoff = 0;
    let considered = 0;
    let budgetExhausted = false;

    // Each processed row records `lastCheckedAt` and so leaves the due
    // set; batches therefore make progress until nothing is due or the
    // per-tick cap stops us. A row that could not be processed (removed
    // meanwhile, or checked by its owner a moment ago) is skipped, and a
    // batch that only contains such rows ends the tick.
    while (considered < DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK) {
      if (Date.now() > deadline) {
        budgetExhausted = true;
        break;
      }
      const due = await this.tenancyContextService.runInUserContext(
        platformOwner.id,
        (tx) =>
          this.domainConnectionsRepository.findManyDueForVerificationSweep(
            tx,
            now,
            checkedBefore,
            connectedBefore,
            Math.min(
              DOMAIN_VERIFICATION_SWEEP_BATCH_SIZE,
              DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK - considered,
            ),
          ),
      );
      if (due.length === 0) break;
      const processedBefore = checked + failed + skippedByBackoff;
      const advancedBefore = checked + failed;
      considered += due.length;

      for (const candidate of due) {
        if (Date.now() > deadline) {
          budgetExhausted = true;
          break;
        }
        // Exponential backoff for rows that keep failing (P63g). The
        // candidate query only knows "older than five minutes"; the real
        // wait grows with `consecutiveFailures`. Such a row still counts
        // as processed for the no-progress guard below, but its
        // `lastCheckedAt` is untouched so it becomes due again on time.
        if (
          candidate.lastCheckedAt &&
          candidate.consecutiveFailures > 0 &&
          now.getTime() - candidate.lastCheckedAt.getTime() <
            domainCheckBackoffMs(candidate.consecutiveFailures)
        ) {
          skippedByBackoff += 1;
          continue;
        }
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
              // Only a SETTLED domain (live AND the provider's certificate
              // active) is on the slow cadence; a connected row still
              // waiting on its certificate or failing its probe is
              // re-checked as eagerly as a pending one.
              const dueBefore = isCustomDomainSettled(locked)
                ? connectedBefore
                : checkedBefore;
              if (
                !locked?.hostname ||
                (locked.lastCheckedAt && locked.lastCheckedAt >= dueBefore)
              ) {
                return null;
              }
              const result = await this.domainCheckService.check(tx, locked, {
                providerVerified: true,
              });
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
      if (checked + failed + skippedByBackoff === processedBefore) break;
      // Everything in this batch was backed off: the next batch would be
      // the same rows (their `lastCheckedAt` did not move), so stop.
      if (checked + failed === advancedBefore) break;
    }

    const result = finish({
      skipped: null,
      checked,
      changed,
      failed,
      skippedByBackoff,
      releasesProcessed: releases.processed,
      releasesFailed: releases.failed,
      budgetExhausted,
    });
    this.logger.log({ considered, ...result }, 'Domain verification sweep complete.');
    await this.platformDomainService.recordSweepResult({ considered, ...result });
    return result;
  }
}
