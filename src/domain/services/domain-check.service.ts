/**
 * DomainCheckService (P63) — the ONE implementation of "ask the provider
 * what it currently knows about this hostname, and record the answer".
 *
 * Three callers share it so they cannot drift:
 *   - the customer's "Check now" (`DomainService.verifyDomain`),
 *   - the Platform Owner's "Check now" (`PlatformDomainsService.check`),
 *   - the verification sweep (`DomainVerificationSweepService`).
 *
 * Runs INSIDE the caller's transaction and expects the caller to have
 * taken the row lock (`DomainConnectionsRepository.lockByAcademyId`), so
 * overlapping checks serialize on the row and each records a consistent
 * result. It never throws for an ordinary "provider said no/unknown" — that
 * is a state to record (`lastCheckError`) and show, not a failure of the
 * request. It only ever persists what the provider or the HTTPS probe
 * actually returned.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainConnection } from '@prisma/client';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type {
  CloudflareCustomHostname,
  CloudflareProvider,
} from '../providers/cloudflare-provider.interface';
import { mapCloudflareCustomHostname } from '../providers/cloudflare-status-mapper';
import { DomainConnectionsRepository } from '../repositories/domain-connections.repository';
import { HttpsProbeService } from './https-probe.service';
import type { DomainCheckErrorCode } from '../constants/domain.constants';

export interface DomainCheckOutcome {
  readonly before: DomainConnection;
  readonly after: DomainConnection;
  readonly statusChanged: boolean;
  /** Status OR HTTPS reachability moved — either can change which host is canonical, so the public hostname cache must be invalidated. */
  readonly canonicalMayHaveChanged: boolean;
  readonly error: DomainCheckErrorCode | null;
}

/** Cloudflare phrases a "your CNAME is not pointing at us yet" verification error in a few ways; all mean the same actionable thing to a customer. */
function looksLikeDnsNotPointing(errors: readonly string[]): boolean {
  return errors.some((message) =>
    /cname|does not (point|resolve)|not pointing|dns/i.test(message),
  );
}

@Injectable()
export class DomainCheckService {
  private readonly logger = new Logger(DomainCheckService.name);

  constructor(
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly httpsProbeService: HttpsProbeService,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
  ) {}

  private async lookup(
    existing: DomainConnection,
  ): Promise<CloudflareCustomHostname | null> {
    if (existing.providerHostnameId) {
      const byId = await this.cloudflareProvider.getCustomHostnameById(
        existing.providerHostnameId,
      );
      if (byId) return byId;
    }
    return this.cloudflareProvider.getCustomHostnameByHostname(existing.hostname!);
  }

  /**
   * Re-checks `existing` (a locked, hostname-bearing row) against the
   * provider and persists the result. Returns both sides so callers can
   * audit the transition and invalidate caches only when something moved.
   */
  async check(
    tx: Prisma.TransactionClient,
    existing: DomainConnection,
  ): Promise<DomainCheckOutcome> {
    const checkedAt = new Date();

    const connected = await this.cloudflareProvider.verifyToken();
    if (!connected) {
      return this.recordFailure(tx, existing, checkedAt, 'provider_unavailable');
    }

    let customHostname: CloudflareCustomHostname | null;
    try {
      customHostname = await this.lookup(existing);
    } catch (error) {
      this.logger.warn(
        {
          academyId: existing.academyId,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'Provider lookup failed during domain check',
      );
      return this.recordFailure(tx, existing, checkedAt, 'provider_error');
    }
    if (!customHostname) {
      return this.recordFailure(tx, existing, checkedAt, 'provider_hostname_missing');
    }

    const mapped = mapCloudflareCustomHostname(customHostname);
    const wasConnected = existing.status === 'connected';
    const nowConnected = mapped.status === 'connected';

    // The HTTPS probe is only meaningful once the provider says the
    // hostname is live at the edge; before that, "unreachable" would just
    // restate "not connected yet" and look like a second problem.
    const probe = nowConnected
      ? await this.httpsProbeService.probe(existing.hostname!)
      : null;

    const error: DomainCheckErrorCode | null =
      !nowConnected && looksLikeDnsNotPointing(customHostname.verificationErrors ?? [])
        ? 'dns_not_pointing'
        : null;

    const after = await this.domainConnectionsRepository.updateByAcademyId(
      tx,
      existing.academyId,
      {
        hostname: existing.hostname,
        status: mapped.status,
        verificationRecords:
          customHostname.verificationRecords as unknown as Prisma.InputJsonValue,
        sslStatus: mapped.sslStatus,
        cdnStatus: mapped.cdnStatus,
        cdnProvider: 'cloudflare',
        providerHostnameId: customHostname.id,
        connectedAt: nowConnected
          ? wasConnected
            ? existing.connectedAt
            : checkedAt
          : null,
        lastCheckedAt: checkedAt,
        lastCheckError: error,
        ...(probe
          ? { httpsReachable: probe.reachable, httpsCheckedAt: probe.checkedAt }
          : { httpsReachable: null, httpsCheckedAt: null }),
      },
    );

    return {
      before: existing,
      after,
      statusChanged: existing.status !== after.status,
      canonicalMayHaveChanged:
        existing.status !== after.status ||
        (existing.httpsReachable ?? null) !== (after.httpsReachable ?? null),
      error,
    };
  }

  private async recordFailure(
    tx: Prisma.TransactionClient,
    existing: DomainConnection,
    checkedAt: Date,
    error: DomainCheckErrorCode,
  ): Promise<DomainCheckOutcome> {
    // The provider could not be consulted, so the previously known
    // status stands — but a hostname the provider has forgotten cannot
    // be "connected" any more: nothing serves it at the edge.
    const status =
      error === 'provider_hostname_missing' && existing.status === 'connected'
        ? 'disconnected'
        : existing.status;
    const after = await this.domainConnectionsRepository.updateByAcademyId(
      tx,
      existing.academyId,
      {
        hostname: existing.hostname,
        status,
        lastCheckedAt: checkedAt,
        lastCheckError: error,
        ...(status === 'connected'
          ? {}
          : { connectedAt: null, httpsReachable: null, httpsCheckedAt: null }),
      },
    );
    return {
      before: existing,
      after,
      statusChanged: existing.status !== after.status,
      canonicalMayHaveChanged:
        existing.status !== after.status ||
        (existing.httpsReachable ?? null) !== (after.httpsReachable ?? null),
      error,
    };
  }
}
