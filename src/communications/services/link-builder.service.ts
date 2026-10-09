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
import type {
  CommunicationAudience,
  CommunicationLocale,
} from '../catalog/communication-catalog';
import { resolveCanonicalHost } from '../../domain/utils/canonical-host.util';
import { PrismaService } from '../../database/prisma.service';
import type { UnsubscribeCategory } from '../campaigns/campaign.types';
import {
  signUnsubscribeToken,
  unsubscribeKeyringFromConfig,
  type UnsubscribeKeyring,
} from '../campaigns/unsubscribe-token';

@Injectable()
export class LinkBuilderService {
  private readonly platformWebUrl: string;
  private readonly environmentBaseDomain: string | undefined;
  /** W3-compose — HMAC key of the one-click unsubscribe token (derived, never the raw secret). */
  private readonly unsubscribeKeys: UnsubscribeKeyring | null;

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
    this.unsubscribeKeys = unsubscribeKeyringFromConfig(configService);
  }

  /**
   * W3-compose — the one-click unsubscribe URL for one recipient and one
   * preference category (RFC 8058). It points at the API through the
   * platform host (`/api/v1`, the same origin the web app calls), because
   * a mail client POSTs it directly. `null` when no signing key is
   * configured: no link is better than a link that cannot be verified.
   */
  unsubscribe(userId: string, category: UnsubscribeCategory): string | null {
    if (!this.unsubscribeKeys) return null;
    const token = signUnsubscribeToken(this.unsubscribeKeys, userId, category);
    return `${this.platformWebUrl}/api/v1/communications/unsubscribe?token=${encodeURIComponent(token)}`;
  }

  platform(path = '/'): string {
    return `${this.platformWebUrl}${normalizePath(path)}`;
  }

  /**
   * Where the recipient actually manages their email preferences.
   *
   * This used to return `/settings/notifications`, which is a route on
   * NEITHER surface — so the "Manage email settings" line in the footer
   * of every single email led to a not-found page. It also prefixed
   * `/ar` on the platform host, which mounts no `/ar` subtree at all, so
   * the Arabic footer was dead twice over.
   *
   * The destination depends on WHO is reading, which is why the audience
   * is a parameter now rather than something this could infer: a learner
   * manages preferences at `/my/profile` on their academy's host, and
   * staff or platform recipients at `/dashboard/profile` on the platform
   * host. `/dashboard/*` is not mounted on an academy host — that tree
   * falls into the CMS catch-all and renders the academy's own 404 —
   * which is exactly how the old value stayed invisible.
   *
   * The locale prefix applies ONLY to the academy host, because that is
   * the one place `withPublicWebsiteLocale` mounts it.
   */
  settings(
    locale: CommunicationLocale,
    academyHost: string | null,
    audience: CommunicationAudience = 'platform',
  ): string {
    if (audience === 'learner' && academyHost) {
      return `https://${academyHost}${localePrefix(locale)}${LEARNER_PROFILE_PATH}`;
    }
    // Staff and platform recipients read the management surface, which
    // only exists on the platform host and carries no locale prefix.
    return this.platform(MANAGEMENT_PROFILE_PATH);
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

  /**
   * ATO review F4 — the academy's host on Atlas's OWN domain
   * (`<subdomain>.<base domain>`), never a connected custom domain, or
   * `null` when it has none. Links that carry a credential (password reset,
   * account setup, email verification) are built here: a custom domain's
   * DNS belongs to the tenant, who could repoint it at a server of their
   * own while it still reads as connected — and a reset token for a GLOBAL
   * account must never reach a host Atlas does not control.
   */
  async academyAtlasHost(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<string | null> {
    const [allocation, baseDomain] = await Promise.all([
      tx.subdomainAllocation.findUnique({ where: { academyId } }),
      this.effectiveBaseDomain(),
    ]);
    const canonical = resolveCanonicalHost({
      connectedCustomHostname: null,
      customHttpsReachable: false,
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

/** `LEARNER_ROUTES.profile` — renders `ProfilePreferencesSection` on the academy surface. */
const LEARNER_PROFILE_PATH = '/my/profile';
/** `DASHBOARD_ROUTES.profile` — the same section on the management surface. */
const MANAGEMENT_PROFILE_PATH = '/dashboard/profile';

function localePrefix(locale: CommunicationLocale): string {
  return locale === 'ar' ? '/ar' : '';
}
