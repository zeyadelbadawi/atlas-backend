/**
 * The hosts an academy's video may be played from (master plan Phase 2
 * §D.4/§H/§I).
 *
 * The provider's edge refuses a manifest request whose `Origin` is not on
 * this list, which is what makes "hotlinking the manifest from another
 * site fails" true at the delivery layer rather than only in Atlas's own
 * response. Built from the academy's REAL addresses:
 *
 *   - its Atlas subdomain (`{slug}.{baseDomain}`), when one is allocated;
 *   - its custom domain, but ONLY while that domain is actually connected
 *     and live — a half-verified or released domain is not an address the
 *     academy controls, and listing it would leave an origin allowed for
 *     whoever holds that hostname next;
 *   - the platform host itself, because staff preview lessons from the
 *     dashboard.
 *
 * LIVES IN `MediaModule` beside the video provider it feeds, not in
 * `LearningModule`: `ProtectedMediaService` needs it to stamp a new
 * video's allowed origins at upload time, and `LearningModule` already
 * imports `MediaModule`, so the reverse placement would be a cycle.
 *
 * In local development there is no base domain and no connected domain, so
 * the list falls back to the configured app origins. That is deliberately
 * the only place a non-derived origin appears, and it is a development
 * value, never a production one.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type { AppConfig, PlatformDomainRuntimeConfig } from '../../config/configuration';
import {
  resolveCanonicalHost,
  resolveSubdomainHost,
} from '../../domain/utils/canonical-host.util';

@Injectable()
export class AcademyOriginsService {
  constructor(private readonly configService: ConfigService) {}

  async forAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<readonly string[]> {
    const baseDomain =
      this.configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;

    const [allocation, connection] = await Promise.all([
      tx.subdomainAllocation.findUnique({ where: { academyId } }),
      tx.domainConnection.findUnique({ where: { academyId } }),
    ]);

    const hosts = new Set<string>();

    const subdomainHost = resolveSubdomainHost({
      subdomainFullHost: allocation?.fullHost,
      subdomainLabel: allocation?.subdomain,
      baseDomain,
    });
    if (subdomainHost) hosts.add(subdomainHost);

    // `resolveCanonicalHost` is reused rather than re-deriving the rule,
    // so "which custom hostname is live" has exactly one definition in the
    // codebase — the same one the public website and the dashboard use.
    const canonical = resolveCanonicalHost({
      connectedCustomHostname:
        connection?.status === 'connected' ? connection.hostname : null,
      customHttpsReachable: connection?.httpsReachable,
      subdomainFullHost: allocation?.fullHost,
      subdomainLabel: allocation?.subdomain,
      baseDomain,
    });
    if (canonical) hosts.add(canonical.host);

    if (baseDomain) hosts.add(baseDomain);

    const origins = [...hosts].map((host) => `https://${host}`);

    if (origins.length === 0) {
      // Development only: nothing above resolved, which in production
      // would mean an academy with no address at all.
      const app = this.configService.get<AppConfig>('app');
      return app?.corsAllowedOrigins ?? [];
    }
    return origins;
  }
}
