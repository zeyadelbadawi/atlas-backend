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
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';
import { PlatformDomainConfigurationRepository } from '../repositories/platform-domain-configuration.repository';
import { CLOUDFLARE_PROVIDER } from '../providers/cloudflare-provider.interface';
import type {
  CloudflareFallbackOrigin,
  CloudflareProvider,
} from '../providers/cloudflare-provider.interface';
import { HttpsProbeService } from './https-probe.service';
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

/** Cloudflare origin SSL modes Caddy's `tls internal` catch-all can satisfy. `strict` demands a publicly trusted origin certificate for every custom hostname, which the origin does not hold. */
const ORIGIN_SSL_MODES_COMPATIBLE_WITH_INTERNAL_CERT = new Set(['full', 'flexible']);

/** How long zone facts (fallback origin, SSL mode) are reused before being re-read from the provider. */
const ZONE_FACTS_TTL_MS = 5 * 60 * 1000;

/** The fallback origin status Cloudflare reports once it is deployed and usable. */
const FALLBACK_ORIGIN_ACTIVE = 'active';

/** A label no Academy can own (`RESERVED_SUBDOMAINS` protects underscores by format alone) — probing it proves the wildcard certificate and routing without touching any customer host. */
const WILDCARD_PROBE_LABEL = 'atlas-wildcard-probe';

@Injectable()
export class PlatformDomainService {
  private readonly environmentBaseDomain?: string;

  constructor(
    private readonly platformDomainConfigurationRepository: PlatformDomainConfigurationRepository,
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
    if (row.configured && row.baseDomain) {
      return { baseDomain: row.baseDomain.toLowerCase(), source: 'database' };
    }
    return {};
  }

  /**
   * Zone facts change rarely and every customer read of their domain tab
   * needs the CNAME target, so they are cached in-process for a short
   * while. `getReadiness` always asks live and refreshes the cache — an
   * operator pressing "Refresh" gets the truth, not the cache.
   */
  private zoneFacts?: {
    readonly fallbackOrigin: CloudflareFallbackOrigin | null;
    readonly sslMode: string | null;
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
    const configuration =
      await this.platformDomainConfigurationRepository.update(baseDomain);
    return toPlatformDomainConfigurationResponse(configuration, {
      baseDomain: configuration.baseDomain?.toLowerCase(),
      source: 'database',
    });
  }

  /** Every field a live answer or explicitly absent — see the response contract. */
  async getReadiness(): Promise<PlatformDomainReadinessResponse> {
    const checkedAt = new Date();
    const effective = await this.getEffectiveBaseDomain();

    const [connected, { fallbackOrigin, sslMode }] = await Promise.all([
      this.cloudflareProvider.verifyToken(),
      this.loadZoneFacts(true),
    ]);
    const zoneFactsError = this.cloudflareProvider.getLastZoneFactsError();

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
        originSslMode: sslMode ?? undefined,
        originSslModeCompatible: sslMode
          ? ORIGIN_SSL_MODES_COMPATIBLE_WITH_INTERNAL_CERT.has(sslMode)
          : undefined,
      },
      platformHttps: {
        baseDomainReachable: baseProbe?.reachable,
        wildcardReachable: wildcardProbe?.reachable,
        checkedAt: checkedAt.toISOString(),
      },
      checkedAt: checkedAt.toISOString(),
    };
  }
}
