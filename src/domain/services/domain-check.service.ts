/**
 * DomainCheckService (P63, reworked P63c, hardened P63g) — the ONE
 * implementation of "make sure the provider holds this hostname, ask what
 * it currently knows, and record the answer".
 *
 * Three callers share it so they cannot drift:
 *   - the customer's "Check now" (`DomainService.verifyDomain`) and the
 *     customer's add/replace (`DomainService.addCustomDomain`),
 *   - the Platform Owner's "Check now" (`PlatformDomainsService.check`),
 *   - the verification sweep (`DomainVerificationSweepService`).
 *
 * WHY REGISTRATION LIVES HERE (P63c). A production test showed the gap:
 * the provider refused to register a hostname at add time (an Atlas-side
 * provider-configuration problem), the row recorded that, and the next
 * "Check now" looked the hostname up, found nothing, and reported that the
 * provider "no longer has a record" of it — a hostname that had never been
 * accepted. So a check now first ENSURES registration when Atlas holds no
 * provider id: every retry (button or sweep) is a fresh registration
 * attempt, and the moment the provider configuration is fixed the domain
 * moves forward on its own.
 *
 * SELF-HEALING (P63g). A hostname the provider once held (Atlas has its
 * id) and no longer does — deleted out of band, or lost because an
 * earlier release ran before the database could refuse a change — is now
 * RE-REGISTERED on the next check rather than reported "missing" forever.
 * The row moves to whatever the fresh registration reports (normally
 * `verifying` with fresh records), the transition is audited by the
 * caller, and the customer is shown the records to keep. A transport
 * failure while looking the hostname up is `provider_error`, never
 * "missing": the provider must positively say the resource is gone.
 *
 * CERTIFICATE LIFECYCLE (P63g). Certificates are validated over HTTP,
 * which the provider completes by itself — at issuance AND at every
 * renewal — for any hostname whose traffic routes through it (exactly the
 * CNAME setup the customer is instructed to create). A legacy resource
 * still on TXT validation is migrated in place the first time it is seen.
 *
 * Runs INSIDE the caller's transaction with the row lock held. Never
 * throws for an ordinary "provider said no/unknown" — that is a state to
 * record (`lastCheckError`, `lastProviderErrorCode`) and show. Persists
 * only what the provider or the HTTPS probe actually returned.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { DomainConnection } from '@prisma/client';
import {
  CLOUDFLARE_PROVIDER,
  CLOUDFLARE_SSL_METHOD,
  CloudflareProviderError,
} from '../providers/cloudflare-provider.interface';
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
  /** P63g — the provider had lost the hostname and it was registered afresh during this check. */
  readonly reRegistered: boolean;
}

export interface DomainCheckOptions {
  /** The caller has already verified the provider token during this run (the sweep does it once per tick — P63g). */
  readonly providerVerified?: boolean;
}

/** Cloudflare phrases a "your CNAME is not pointing at us yet" verification error in a few ways; all mean the same actionable thing to a customer. */
function looksLikeDnsNotPointing(errors: readonly string[]): boolean {
  return errors.some((message) =>
    /cname|does not (point|resolve)|not pointing|dns/i.test(message),
  );
}

type Located =
  | {
      readonly kind: 'found';
      readonly resource: CloudflareCustomHostname;
      readonly reRegistered: boolean;
    }
  | { readonly kind: 'refused'; readonly code: number | null }
  | { readonly kind: 'failed' };

@Injectable()
export class DomainCheckService {
  private readonly logger = new Logger(DomainCheckService.name);

  constructor(
    private readonly domainConnectionsRepository: DomainConnectionsRepository,
    private readonly httpsProbeService: HttpsProbeService,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
  ) {}

  /**
   * Finds the provider resource for `existing`, registering it when the
   * provider does not hold it (never accepted, or lost since).
   * Registration is idempotent at the provider (an existing hostname is
   * returned, never duplicated).
   */
  private async locate(existing: DomainConnection): Promise<Located> {
    const hostname = existing.hostname!;
    try {
      if (existing.providerHostnameId) {
        const byId = await this.cloudflareProvider.getCustomHostnameById(
          existing.providerHostnameId,
        );
        if (byId && byId.hostname.toLowerCase() === hostname) {
          return { kind: 'found', resource: byId, reRegistered: false };
        }
        const byHostname =
          await this.cloudflareProvider.getCustomHostnameByHostname(hostname);
        if (byHostname)
          return { kind: 'found', resource: byHostname, reRegistered: false };
        // Positively gone at the provider: register afresh (P63g).
        const registered = await this.cloudflareProvider.createCustomHostname(hostname);
        this.logger.warn(
          { academyId: existing.academyId },
          'Provider had lost the custom hostname; re-registered it',
        );
        return { kind: 'found', resource: registered, reRegistered: true };
      }
      const registered = await this.cloudflareProvider.createCustomHostname(hostname);
      return { kind: 'found', resource: registered, reRegistered: false };
    } catch (error) {
      if (error instanceof CloudflareProviderError) {
        return { kind: 'refused', code: error.code };
      }
      this.logger.warn(
        {
          academyId: existing.academyId,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'Provider request failed during domain check',
      );
      return { kind: 'failed' };
    }
  }

  /** Legacy TXT-validated resources are moved to HTTP validation so renewals no longer need a customer action. Best effort; the check proceeds either way. */
  private async ensureHttpValidation(resource: CloudflareCustomHostname): Promise<void> {
    if (!resource.sslMethod || resource.sslMethod === CLOUDFLARE_SSL_METHOD) return;
    try {
      const updated = await this.cloudflareProvider.updateCustomHostnameSslMethod(
        resource.id,
        CLOUDFLARE_SSL_METHOD,
      );
      if (!updated) {
        this.logger.warn(
          { resourceId: resource.id },
          'Could not migrate hostname to HTTP validation',
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          resourceId: resource.id,
          error: error instanceof Error ? error.message : 'unknown',
        },
        'HTTP validation migration failed',
      );
    }
  }

  /**
   * Ensures registration, re-checks `existing` (a locked, hostname-bearing
   * row) against the provider and persists the result. Returns both sides
   * so callers can audit the transition and invalidate caches only when
   * something moved.
   */
  async check(
    tx: Prisma.TransactionClient,
    existing: DomainConnection,
    options: DomainCheckOptions = {},
  ): Promise<DomainCheckOutcome> {
    const checkedAt = new Date();

    const connected =
      options.providerVerified ?? (await this.cloudflareProvider.verifyToken());
    if (!connected) {
      return this.recordFailure(tx, existing, checkedAt, 'provider_unavailable', null);
    }

    const located = await this.locate(existing);
    if (located.kind === 'refused') {
      return this.recordFailure(
        tx,
        existing,
        checkedAt,
        'provider_registration_failed',
        located.code,
      );
    }
    if (located.kind === 'failed') {
      return this.recordFailure(tx, existing, checkedAt, 'provider_error', null);
    }

    const customHostname = located.resource;
    await this.ensureHttpValidation(customHostname);
    const mapped = mapCloudflareCustomHostname(customHostname);
    const wasConnected = existing.status === 'connected';
    const nowConnected = mapped.status === 'connected';

    // The HTTPS probe is only meaningful once the provider says the
    // hostname is active at the edge; before that, "unreachable" would just
    // restate "not connected yet" and look like a second problem. Note that
    // `connected` is NOT "live": the probe may fail — see `isCustomDomainLive`.
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
        lastProviderErrorCode: null,
        consecutiveFailures: error ? existing.consecutiveFailures + 1 : 0,
        ...(probe
          ? {
              httpsReachable: probe.reachable,
              httpsCheckedAt: probe.checkedAt,
              httpsStatusCode: probe.statusCode ?? null,
              httpsFailureReason: probe.failure ?? null,
            }
          : {
              httpsReachable: null,
              httpsCheckedAt: null,
              httpsStatusCode: null,
              httpsFailureReason: null,
            }),
      },
    );

    return this.outcome(existing, after, error, located.reRegistered);
  }

  private async recordFailure(
    tx: Prisma.TransactionClient,
    existing: DomainConnection,
    checkedAt: Date,
    error: DomainCheckErrorCode,
    providerErrorCode: number | null,
  ): Promise<DomainCheckOutcome> {
    // The provider could not be consulted (or refused), so the previously
    // known status stands.
    const after = await this.domainConnectionsRepository.updateByAcademyId(
      tx,
      existing.academyId,
      {
        hostname: existing.hostname,
        lastCheckedAt: checkedAt,
        lastCheckError: error,
        lastProviderErrorCode:
          providerErrorCode === null ? null : String(providerErrorCode),
        consecutiveFailures: existing.consecutiveFailures + 1,
      },
    );
    return this.outcome(existing, after, error, false);
  }

  private outcome(
    before: DomainConnection,
    after: DomainConnection,
    error: DomainCheckErrorCode | null,
    reRegistered: boolean,
  ): DomainCheckOutcome {
    return {
      before,
      after,
      statusChanged: before.status !== after.status,
      canonicalMayHaveChanged:
        before.status !== after.status ||
        (before.httpsReachable ?? null) !== (after.httpsReachable ?? null),
      error,
      reRegistered,
    };
  }
}
