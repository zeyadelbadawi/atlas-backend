/**
 * PlatformDomainService — the platform's base domain and the readiness
 * of the infrastructure behind custom domains (P11; reworked P63).
 *
 * ONE SOURCE OF TRUTH FOR THE BASE DOMAIN. Two places could name it: the
 * deployment environment (`PLATFORM_BASE_DOMAIN`, which is what CORS,
 * public hostname resolution, Caddy's wildcard certificate and Cloudflare
 * DNS are actually configured for) and the `platform_domain_configuration`
 * row a Platform Owner could edit. Editing the row never changed any of
 * the real routing, so a divergent row only ever produced wrong
 * `full_host` values. The environment therefore wins whenever it is set;
 * the row remains a fallback for deployments without the variable, and
 * the API reports which one is in force (`source`) so nobody has to guess.
 */
import { ConflictException, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { PlatformDomainConfigurationRepository } from '../repositories/platform-domain-configuration.repository';
import { SubdomainAllocationsRepository } from '../repositories/subdomain-allocations.repository';
import { PublicWebsiteCacheService } from '../../public-website/services/public-website-cache.service';
import { PrismaService } from '../../database/prisma.service';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type {
  CloudflareFallbackOrigin,
  CloudflareProvider,
  CloudflareZoneSslModeRead,
} from '../providers/cloudflare-provider.interface';
import type { OriginSslModeState } from '../constants/domain.constants';
import { HttpsProbeService } from './https-probe.service';
import { resolveEffectiveBaseDomain } from '../utils/effective-base-domain.util';
import { DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS } from '../queue/domain-verification-sweep.types';
import {
  toPlatformDomainConfigurationResponse,
  type PlatformBaseDomainSource,
  type PlatformDomainConfigurationResponse,
  type PlatformDomainReadinessResponse,
} from '../dto/domain.contract';

export interface EffectiveBaseDomain {
  readonly baseDomain?: string;
  readonly source?: PlatformBaseDomainSource;
}

/**
 * Cloudflare origin SSL modes the origin can satisfy for a custom hostname.
 * Caddy answers a custom hostname's SNI with the platform certificate
 * (`fallback_sni`) — trusted, but issued for the platform name, not the
 * customer's — which `full` and `flexible` accept and `strict` (hostname
 * must match) refuses.
 */
const ORIGIN_SSL_MODES_COMPATIBLE_WITH_INTERNAL_CERT = new Set(['full', 'flexible']);

/** P63d — turns a provider read into the four states the operator must be able to tell apart. */
export function classifyOriginSslModeRead(
  connected: boolean,
  read: CloudflareZoneSslModeRead,
): OriginSslModeState {
  if (read.mode) return 'read';
  if (!connected) return 'unavailable';
  if (read.error?.category === 'permission') return 'permission_missing';
  return 'provider_error';
}

/** How long zone facts (fallback origin, SSL mode) are reused before being re-read from the provider. */
const ZONE_FACTS_TTL_MS = 5 * 60 * 1000;

/** The fallback origin status Cloudflare reports once it is deployed and usable. */
const FALLBACK_ORIGIN_ACTIVE = 'active';

/** A label no Academy can own (`RESERVED_SUBDOMAINS` protects underscores by format alone) — probing it proves the wildcard certificate and routing without touching any customer host. */
const WILDCARD_PROBE_LABEL = 'atlas-wildcard-probe';

@Injectable()
export class PlatformDomainService {
  private readonly environmentBaseDomain?: string;

  private readonly logger = new Logger(PlatformDomainService.name);

  constructor(
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
    private readonly subdomainAllocationsRepository: SubdomainAllocationsRepository,
    private readonly publicWebsiteCacheService: PublicWebsiteCacheService,
    private readonly prisma: PrismaService,
    private readonly httpsProbeService: HttpsProbeService,
    @Inject(CLOUDFLARE_PROVIDER)
    private readonly cloudflareProvider: CloudflareProvider,
    configService: ConfigService,
  ) {
    const configured = configService
      .get<PlatformDomainRuntimeConfig>('platformDomain')
      ?.baseDomain?.trim()
      .toLowerCase();
    this.environmentBaseDomain = configured || undefined;
  }

  async getEffectiveBaseDomain(): Promise<EffectiveBaseDomain> {
    if (this.environmentBaseDomain) {
      return { baseDomain: this.environmentBaseDomain, source: 'environment' };
    }
    const row = await this.platformDomainConfigurationRepository.findSingleton();
    return resolveEffectiveBaseDomain(undefined, row);
  }

  /**
   * Zone facts change rarely and every customer read of their domain tab
   * needs the CNAME target, so they are cached in-process for a short
   * while. `getReadiness` always asks live and refreshes the cache — an
   * operator pressing "Refresh" gets the truth, not the cache.
   */
  private zoneFacts?: {
    readonly fallbackOrigin: CloudflareFallbackOrigin | null;
    readonly sslMode: CloudflareZoneSslModeRead;
    readonly fetchedAt: number;
  };

  /** Drops the cached zone facts so the next read asks the provider again (tests, and any future operator action that changes the zone). */
  invalidateZoneFacts(): void {
    this.zoneFacts = undefined;
  }

  private async loadZoneFacts(
    fresh: boolean,
  ): Promise<NonNullable<typeof this.zoneFacts>> {
    const now = Date.now();
    if (!fresh && this.zoneFacts && now - this.zoneFacts.fetchedAt < ZONE_FACTS_TTL_MS) {
      return this.zoneFacts;
    }
    const [fallbackOrigin, sslMode] = await Promise.all([
      this.cloudflareProvider.getFallbackOrigin(),
      this.cloudflareProvider.getZoneSslMode(),
    ]);
    this.zoneFacts = { fallbackOrigin, sslMode, fetchedAt: now };
    return this.zoneFacts;
  }

  /** The CNAME target customers must point a custom domain at: the zone's fallback origin. `null` when none is configured or the provider is unavailable — never invented. */
  async getCnameTarget(): Promise<string | null> {
    const { fallbackOrigin } = await this.loadZoneFacts(false);
    return fallbackOrigin?.origin?.toLowerCase() ?? null;
  }

  async getPlatformDomainConfiguration(): Promise<PlatformDomainConfigurationResponse> {
    const [configuration, effective] = await Promise.all([
      this.platformDomainConfigurationRepository.findSingleton(),
      this.getEffectiveBaseDomain(),
    ]);
    return toPlatformDomainConfigurationResponse(configuration, effective);
  }

  /**
   * P63g — the provider token, verified at most once per minute. The
   * sweep, the post-commit release attempt and readiness all ask; a
   * customer's "Check now" still verifies live through `DomainCheckService`.
   */
  private providerAvailability?: { readonly value: boolean; readonly checkedAt: number };

  async isProviderAvailable(fresh = false): Promise<boolean> {
    const now = Date.now();
    if (
      !fresh &&
      this.providerAvailability &&
      now - this.providerAvailability.checkedAt < 60_000
    ) {
      return this.providerAvailability.value;
    }
    const value = await this.cloudflareProvider.verifyToken();
    this.providerAvailability = { value, checkedAt: now };
    return value;
  }

  async updatePlatformDomainConfiguration(
    baseDomain: string,
  ): Promise<PlatformDomainConfigurationResponse> {
    if (this.environmentBaseDomain) {
      // The deployment owns this value; a database edit would be a
      // silent lie about what the platform actually serves.
      throw new ConflictException({
        messageKey: 'errors.domain.baseDomainManagedByEnvironment',
      });
    }
    const normalized = baseDomain.trim().toLowerCase();
    const configuration =
      await this.platformDomainConfigurationRepository.update(normalized);
    // P63g — every allocation's advertised full host follows the base
    // domain, and every cached resolution for the old hosts is dropped.
    // Without this, existing Academies kept advertising the previous
    // domain forever (no backfill path existed).
    const rewritten = await this.subdomainAllocationsRepository.rewriteFullHosts(
      this.prisma,
      normalized,
    );
    await this.publicWebsiteCacheService.invalidateHostnameResolution(
      rewritten.flatMap((row) => [
        row.subdomain,
        ...(row.previousFullHost ? [row.previousFullHost] : []),
      ]),
    );
    this.invalidateZoneFacts();
    return toPlatformDomainConfigurationResponse(configuration, {
      baseDomain: configuration.baseDomain?.toLowerCase(),
      source: 'database',
    });
  }

  /** P63g — the sweep records its last completed tick here so the readiness page can show it. */
  async recordSweepResult(
    result: Record<string, number | string | boolean | null>,
  ): Promise<void> {
    try {
      await this.platformDomainConfigurationRepository.recordSweep(new Date(), result);
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : 'unknown' },
        'Could not record the sweep result',
      );
    }
  }

  /** Every field a live answer or explicitly absent — see the response contract. */
  async getReadiness(): Promise<PlatformDomainReadinessResponse> {
    const checkedAt = new Date();
    const effective = await this.getEffectiveBaseDomain();

    const [connected, { fallbackOrigin, sslMode }, configuration, pendingReleases] =
      await Promise.all([
        this.cloudflareProvider.verifyToken(),
        this.loadZoneFacts(true),
        this.platformDomainConfigurationRepository.findSingleton(),
        this.platformDomainConfigurationRepository.countPendingReleases(),
      ]);
    const zoneFactsError = this.cloudflareProvider.getLastZoneFactsError();
    const originSslModeState = classifyOriginSslModeRead(connected, sslMode);

    const [baseProbe, wildcardProbe] = effective.baseDomain
      ? await Promise.all([
          this.httpsProbeService.probe(effective.baseDomain),
          this.httpsProbeService.probe(`${WILDCARD_PROBE_LABEL}.${effective.baseDomain}`),
        ])
      : [null, null];

    return {
      baseDomain: effective.baseDomain,
      source: effective.source,
      provider: { name: 'cloudflare', connected },
      customHostnames: {
        ready: Boolean(
          fallbackOrigin && fallbackOrigin.status === FALLBACK_ORIGIN_ACTIVE,
        ),
        fallbackOrigin: fallbackOrigin?.origin,
        fallbackOriginStatus: fallbackOrigin?.status,
        providerErrorCode:
          zoneFactsError?.code === null || zoneFactsError?.code === undefined
            ? undefined
            : String(zoneFactsError.code),
        providerErrorCategory: zoneFactsError?.category,
        originSslMode: sslMode.mode ?? undefined,
        originSslModeCompatible: sslMode.mode
          ? ORIGIN_SSL_MODES_COMPATIBLE_WITH_INTERNAL_CERT.has(sslMode.mode)
          : undefined,
        originSslModeState,
        originSslModeErrorCode:
          sslMode.error?.code === null || sslMode.error?.code === undefined
            ? undefined
            : String(sslMode.error.code),
      },
      platformHttps: {
        baseDomainReachable: baseProbe?.reachable,
        wildcardReachable: wildcardProbe?.reachable,
        checkedAt: checkedAt.toISOString(),
      },
      sweep: {
        lastCompletedAt: configuration.lastSweepCompletedAt?.toISOString(),
        lastResult:
          (configuration.lastSweepResult as Record<
            string,
            number | string | boolean | null
          > | null) ?? undefined,
        pendingReleases,
        intervalMs: DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS,
      },
      checkedAt: checkedAt.toISOString(),
    };
  }
}
