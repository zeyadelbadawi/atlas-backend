/**
 * DomainProviderReleaseService (P63g) — deletes provider resources Atlas
 * has given up, SAFELY.
 *
 * WHY A LEDGER. A production audit reproduced the failure of the previous
 * design: the old provider resource was deleted INSIDE the transaction,
 * BEFORE the database write that could still fail. A customer replacing
 * a live domain with one another tenant already held got a 409 — and
 * their working hostname was already gone at the edge. Now the intent to
 * release is written in the same transaction as the change (see
 * `DomainService`), the delete is attempted only after commit, and the
 * verification sweep retries anything that failed until the provider
 * confirms. No delete ever runs on an uncommitted decision, and no failed
 * delete can silently orphan an active hostname.
 *
 * SAFETY CHECKS BEFORE EVERY DELETE:
 *   - the provider resource must still carry the hostname the ledger row
 *     names (never delete a resource that now answers for another name);
 *   - no current `domain_connections` row may hold that hostname with the
 *     same provider id (the hostname was re-adopted, e.g. the customer
 *     re-added it — then the resource is theirs again and is NOT deleted;
 *     the row is closed as `reassigned`).
 *
 * Runs under whatever context the caller holds: the tenant transaction
 * that wrote the row (post-commit attempt uses the platform-owner context
 * through the sweep-style helper in `DomainService`), or the sweep's
 * platform context. It never throws for a provider failure — that is a
 * state to record and retry.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainProviderRelease } from '@prisma/client';
import {
  CLOUDFLARE_PROVIDER,
  CloudflareProviderError,
} from '../providers/cloudflare-provider.interface';
import type { CloudflareProvider } from '../providers/cloudflare-provider.interface';
import { DomainProviderReleasesRepository } from '../repositories/domain-provider-releases.repository';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';

export type ReleaseAttemptResult =
  | {
      readonly kind: 'released';
      readonly outcome: 'deleted' | 'not_found' | 'reassigned';
    }
  | { readonly kind: 'failed'; readonly error: string };

@Injectable()
export class DomainProviderReleaseService {
  private readonly logger = new Logger(DomainProviderReleaseService.name);

  constructor(
    private readonly releasesRepository: DomainProviderReleasesRepository,
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
  ) {}

  /** Attempts one ledger row and records the result on it. */
  async attempt(
    tx: Prisma.TransactionClient,
    row: DomainProviderRelease,
    providerAvailable: boolean,
  ): Promise<ReleaseAttemptResult> {
    const now = new Date();
    if (row.releasedAt) {
      return { kind: 'released', outcome: (row.outcome as 'deleted') ?? 'deleted' };
    }

    // Re-adopted since: the hostname is live again on an Atlas row that
    // holds the very same provider resource. It is not ours to delete.
    const current = await this.domainConnectionsRepository.findByHostname(
      tx,
      row.hostname,
    );
    if (
      current &&
      row.providerHostnameId &&
      current.providerHostnameId === row.providerHostnameId
    ) {
      await this.releasesRepository.markReleased(tx, row.id, 'reassigned', now);
      return { kind: 'released', outcome: 'reassigned' };
    }

    if (!providerAvailable) {
      await this.releasesRepository.markFailed(tx, row.id, 'provider_unavailable', now);
      return { kind: 'failed', error: 'provider_unavailable' };
    }

    try {
      const resource = row.providerHostnameId
        ? await this.cloudflareProvider.getCustomHostnameById(row.providerHostnameId)
        : await this.cloudflareProvider.getCustomHostnameByHostname(row.hostname);
      if (!resource) {
        await this.releasesRepository.markReleased(tx, row.id, 'not_found', now);
        return { kind: 'released', outcome: 'not_found' };
      }
      if (resource.hostname.toLowerCase() !== row.hostname.toLowerCase()) {
        // The id now answers for another name: never delete it. Record
        // and stop retrying this row by treating it as concluded.
        this.logger.warn(
          { releaseId: row.id },
          'Provider resource no longer carries the released hostname; not deleting',
        );
        await this.releasesRepository.markReleased(tx, row.id, 'not_found', now);
        return { kind: 'released', outcome: 'not_found' };
      }
      // A different Atlas row adopted this exact resource meanwhile (same
      // hostname, same id) — checked above; here the hostname is free.
      const outcome = await this.cloudflareProvider.deleteCustomHostname(resource.id);
      if (outcome === 'failed') {
        await this.releasesRepository.markFailed(tx, row.id, 'provider_error', now);
        return { kind: 'failed', error: 'provider_error' };
      }
      await this.releasesRepository.markReleased(tx, row.id, outcome, now);
      return { kind: 'released', outcome };
    } catch (error) {
      const code =
        error instanceof CloudflareProviderError ? 'provider_refused' : 'provider_error';
      this.logger.warn(
        { releaseId: row.id, error: error instanceof Error ? error.message : 'unknown' },
        'Provider release attempt failed',
      );
      await this.releasesRepository.markFailed(tx, row.id, code, now);
      return { kind: 'failed', error: code };
    }
  }

  /** Processes every due pending row (sweep entry point). Returns counts. */
  async processDue(
    tx: Prisma.TransactionClient,
    providerAvailable: boolean,
    now: Date,
    take: number,
  ): Promise<{
    readonly processed: number;
    readonly released: number;
    readonly failed: number;
  }> {
    const due = await this.releasesRepository.findDue(tx, now, take);
    let released = 0;
    let failed = 0;
    for (const row of due) {
      const result = await this.attempt(tx, row, providerAvailable);
      if (result.kind === 'released') released += 1;
      else failed += 1;
    }
    return { processed: due.length, released, failed };
  }
}
