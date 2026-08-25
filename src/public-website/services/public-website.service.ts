/**
 * PublicWebsiteService — matches the real frontend `PublicWebsiteService`
 * exactly: `resolveHostname`/`getPublishedWebsite`/`getPublishedPages`/
 * `getPublishedPage`. No session, no `AcademyScopeGuard` — Academy
 * identity comes FROM the hostname (or, for the latter three methods, an
 * `academyId` the caller already obtained from a real `resolveHostname`
 * response), never trusted as a client-supplied parameter on its own
 * (master plan §21 P11 "Tenant Isolation": "trusted hostname → exact
 * domain/subdomain allocation → academy → published website data").
 *
 * THE CRITICAL SECURITY INVARIANT (master plan §21 P11 §5): every method
 * below makes the publication condition part of the database query
 * itself (`WebsiteConfigurationRepository.findPublishedByAcademyId`/
 * `WebsitePagesRepository.findAllPublished`/`findPublishedBySlug`, P9,
 * reused unmodified) — never "fetch, then check status." A draft/
 * unpublished/hidden row is indistinguishable, from this service's return
 * shape alone, from a row that does not exist at all.
 *
 * Reuses P9's own `toWebsiteConfigurationResponse`/`toWebsitePageResponse`
 * response mappers — the public response is byte-for-byte the same
 * `WebsiteConfiguration`/`WebsitePage` shape the authenticated dashboard
 * already returns (confirmed directly: `PublicWebsiteService`, frontend,
 * imports the exact same `WebsiteConfiguration`/`WebsitePage` types from
 * `@types`), never a second, parallel public projection.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { WebsiteConfigurationRepository } from '../../website/repositories/website-configuration.repository';
import { WebsitePagesRepository } from '../../website/repositories/website-pages.repository';
import {
  toWebsiteConfigurationResponse,
  type WebsiteConfigurationResponse,
} from '../../website/dto/website-configuration.contract';
import {
  toWebsitePageResponse,
  type WebsitePageResponse,
} from '../../website/dto/website-page.contract';
import { PublicHostnameResolutionRepository } from '../repositories/public-hostname-resolution.repository';
import { PublicWebsiteCacheService } from './public-website-cache.service';
import {
  extractSubdomainLabel,
  normalizeHostname,
} from '../utils/hostname-normalization.util';
import type { HostnameResolutionResponse } from '../dto/hostname-resolution.contract';
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';

@Injectable()
export class PublicWebsiteService {
  private readonly baseDomain?: string;

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly publicHostnameResolutionRepository: PublicHostnameResolutionRepository,
    private readonly websiteConfigurationRepository: WebsiteConfigurationRepository,
    private readonly websitePagesRepository: WebsitePagesRepository,
    private readonly cacheService: PublicWebsiteCacheService,
    configService: ConfigService,
  ) {
    this.baseDomain =
      configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;
  }

  /** Resolves the candidate subdomain label to try: the trusted-base-domain-derived one first, falling back to treating a bare, dot-free input as a direct subdomain label (this is what makes a real Academy subdomain like `harvard` — sent with no base-domain suffix at all, e.g. a local/dev lookup — resolvable without the backend needing any dev-mode-specific branch of its own). */
  private resolveSubdomainCandidate(normalizedHostname: string): string | null {
    const extracted = extractSubdomainLabel(normalizedHostname, this.baseDomain);
    if (extracted) return extracted;
    return normalizedHostname.includes('.') ? null : normalizedHostname;
  }

  async resolveHostname(rawHostname: string): Promise<HostnameResolutionResponse | null> {
    const normalized = normalizeHostname(rawHostname);
    if (!normalized) return null;

    const cached =
      await this.cacheService.getHostnameResolution<HostnameResolutionResponse>(
        normalized,
      );
    if (cached) return cached;

    const subdomainLabel = this.resolveSubdomainCandidate(normalized);
    const resolved = await this.publicHostnameResolutionRepository.resolve(
      normalized,
      subdomainLabel,
    );
    if (!resolved) return null;

    const response: HostnameResolutionResponse = {
      academyId: resolved.academyId,
      academyName: resolved.academyName,
      academySlug: resolved.academySlug,
      academyLogo: resolved.academyLogoUrl ?? undefined,
    };
    await this.cacheService.setHostnameResolution(normalized, response);
    return response;
  }

  private async resolveOrganizationId(academyId: string): Promise<string | null> {
    return this.publicHostnameResolutionRepository.resolveAcademyOrganization(academyId);
  }

  async getPublishedWebsite(
    academyId: string,
  ): Promise<WebsiteConfigurationResponse | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
    );
    if (!configuration) return null;

    const response = toWebsiteConfigurationResponse(configuration);
    const cached = await this.cacheService.getConfiguration<WebsiteConfigurationResponse>(
      academyId,
      configuration.configVersion,
    );
    if (cached) return cached;
    await this.cacheService.setConfiguration(
      academyId,
      configuration.configVersion,
      response,
    );
    return response;
  }

  async getPublishedPages(
    academyId: string,
  ): Promise<readonly WebsitePageResponse[] | null> {
    const organizationId = await this.resolveOrganizationId(academyId);
    if (!organizationId) return null;

    const configuration = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websiteConfigurationRepository.findPublishedByAcademyId(tx, academyId),
    );
    if (!configuration) return null;

    const cached = await this.cacheService.getPages<WebsitePageResponse[]>(
      academyId,
      configuration.configVersion,
    );
    if (cached) return cached;

    const pages = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.websitePagesRepository.findAllPublished(tx, academyId),
    );
    const response = pages.map(toWebsitePageResponse);
    await this.cacheService.setPages(academyId, configuration.configVersion, response);
    return response;
  }

  async getPublishedPage(
    academyId: string,
    slug: string,
  ): Promise<WebsitePageResponse | null> {
    // Reuses the already-cached full pages array — one cache read serves
    // every slug lookup for this Academy's current published version,
    // never a fourth, separately-keyed cache entry.
    const pages = await this.getPublishedPages(academyId);
    if (!pages) return null;
    return pages.find((page) => page.slug === slug) ?? null;
  }
}
