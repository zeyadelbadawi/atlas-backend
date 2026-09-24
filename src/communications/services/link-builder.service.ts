/**
 * LinkBuilderService — P64 Communications C2. Every absolute URL an email
 * carries is built here, from configuration and the canonical-host rule,
 * never from a request header: emails are rendered by a worker with no
 * request, and a host taken from a header would be attacker-controlled.
 *
 *   - `platform(path)`: the platform web app (`PLATFORM_WEB_URL`).
 *   - `academy(tx, academyId, path, locale)`: the academy's canonical host
 *     (P63: a connected, reachable custom domain wins; otherwise
 *     `<subdomain>.<PLATFORM_BASE_DOMAIN>`), with the `/ar` prefix for
 *     Arabic exactly as the frontend router does (English unprefixed).
 *     Falls back to the platform URL when the academy has no host yet.
 *
 * Host lookups take the caller's transaction because
 * `subdomain_allocations`/`domain_connections` are RLS-scoped; the
 * dispatcher runs them under the platform-owner context.
 */
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import type {
  CommunicationsConfig,
  PlatformDomainRuntimeConfig,
} from '../../config/configuration';
import type { CommunicationLocale } from '../catalog/communication-catalog';
import { resolveCanonicalHost } from '../../domain/utils/canonical-host.util';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class LinkBuilderService {
  private readonly platformWebUrl: string;
  private readonly environmentBaseDomain: string | undefined;

  constructor(
    configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.platformWebUrl = configService
      .getOrThrow<CommunicationsConfig>('communications')
      .platformWebUrl.replace(/\/+$/, '');
    this.environmentBaseDomain =
      configService.get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain ??
      undefined;
  }

  platform(path = '/'): string {
    return `${this.platformWebUrl}${normalizePath(path)}`;
  }

  /** The recipient's communication-settings page, on the branded host when one is known. */
  settings(locale: CommunicationLocale, academyHost: string | null): string {
    const path = '/settings/notifications';
    return academyHost
      ? `https://${academyHost}${localePrefix(locale)}${path}`
      : this.platform(`${localePrefix(locale)}${path}`);
  }

  /** The academy's canonical host, or `null` when it has none yet. */
  async academyHost(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<string | null> {
    const [allocation, connection, baseDomain] = await Promise.all([
      tx.subdomainAllocation.findUnique({ where: { academyId } }),
      tx.domainConnection.findUnique({ where: { academyId } }),
      this.effectiveBaseDomain(),
    ]);
    const canonical = resolveCanonicalHost({
      connectedCustomHostname:
        connection?.status === 'connected' ? connection.hostname : null,
      customHttpsReachable: connection?.httpsReachable,
      subdomainFullHost: allocation?.fullHost,
      subdomainLabel: allocation?.subdomain,
      baseDomain,
    });
    return canonical?.host ?? null;
  }

  async academy(
    tx: Prisma.TransactionClient,
    academyId: string,
    path: string,
    locale: CommunicationLocale,
  ): Promise<string> {
    const host = await this.academyHost(tx, academyId);
    return this.onHost(host, path, locale);
  }

  /** Builds a branded URL from an already-resolved host (or the platform when `host` is null). */
  onHost(host: string | null, path: string, locale: CommunicationLocale): string {
    const localized = `${localePrefix(locale)}${normalizePath(path)}`;
    return host ? `https://${host}${localized}` : this.platform(localized);
  }

  private async effectiveBaseDomain(): Promise<string | undefined> {
    if (this.environmentBaseDomain) return this.environmentBaseDomain;
    // Same singleton `PlatformDomainService.getEffectiveBaseDomain` reads;
    // read directly so this module does not import `DomainModule`.
    const row = await this.prisma.platformDomainConfiguration.findFirst();
    return row?.baseDomain?.toLowerCase() ?? undefined;
  }
}

function normalizePath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

function localePrefix(locale: CommunicationLocale): string {
  return locale === 'ar' ? '/ar' : '';
}
