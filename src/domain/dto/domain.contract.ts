/**
 * Domain response contracts — match `AcademyDomainConfiguration`/
 * `SubdomainAllocation`/`DomainConnection`/`DomainVerificationRecord`/
 * `PlatformDomainConfiguration`/`InfrastructureProviderStatus`
 * (`domain.types.ts`/`provisioning.types.ts`) field-for-field.
 *
 * P63 additions are all derived from stored or freshly-measured facts:
 * `canonicalHost` (see `canonical-host.util.ts`), the last-check fields,
 * the HTTPS probe result and the DNS instructions (records the provider
 * returned plus the CNAME target read from the zone's fallback origin).
 * Nothing here is a default that pretends to be a measurement.
 */
import type {
  CdnStatus as PrismaCdnStatus,
  DomainConnection as PrismaDomainConnection,
  InfrastructureProviderName as PrismaInfrastructureProviderName,
  PlatformDomainConfiguration as PrismaPlatformDomainConfiguration,
  SslStatus as PrismaSslStatus,
  SubdomainAllocation as PrismaSubdomainAllocation,
} from '@prisma/client';
import type { CanonicalHostSource } from '../utils/canonical-host.util';
import { isCustomDomainLive } from '../utils/domain-liveness.util';
import type {
  DomainCheckErrorCode,
  DomainDnsBlockedReason,
  HttpsFailureReason,
  OriginSslModeState,
  ProviderErrorCategory,
} from '../constants/domain.constants';

export interface SubdomainAllocationResponse {
  readonly subdomain: string;
  readonly status: PrismaSubdomainAllocation['status'];
  readonly fullHost?: string;
}

export interface DomainVerificationRecordResponse {
  readonly type: string;
  readonly name: string;
  readonly value: string;
}

export interface DomainConnectionResponse {
  readonly hostname?: string;
  readonly status: PrismaDomainConnection['status'];
  readonly verificationRecords?: readonly DomainVerificationRecordResponse[];
  readonly connectedAt?: string;
  /** P63 — when Atlas last asked the provider about this hostname. Absent until the first check. */
  readonly lastCheckedAt?: string;
  /** P63 — stable code for the latest failed check; absent after a successful one. */
  readonly lastCheckError?: DomainCheckErrorCode;
  /** P63d — the provider's certificate state for this hostname (the same value as the top-level `ssl.status`, repeated here so a row on its own can say whether the certificate is issued). */
  readonly sslStatus: PrismaDomainConnection['sslStatus'];
  /** P63 — Atlas's own outbound HTTPS probe. Absent when never probed. */
  readonly httpsReachable?: boolean;
  readonly httpsCheckedAt?: string;
  /** P63d — the HTTP status the probe received, when a response arrived (a 5xx makes the probe fail and is reported here). */
  readonly httpsStatusCode?: number;
  /** P63d — why the probe found the hostname unreachable; absent when reachable or never probed. */
  readonly httpsFailureReason?: HttpsFailureReason;
  /**
   * P63d/P63e — the ONE answer to "does this domain serve the website?":
   * provider `connected` AND Atlas's own probe got a trusted TLS
   * handshake and a non-5xx answer (`isCustomDomainLive`). `status =
   * connected` alone is not live — the edge may be returning 525 — and the
   * UI must never say "live" unless this is true. The provider's own
   * certificate state (`sslStatus`) is reported alongside: a live domain
   * whose Atlas-managed certificate is still pending is served over HTTPS
   * by something outside Atlas (e.g. the customer's own proxy).
   */
  readonly live: boolean;
  /** P63c — whether the provider currently holds this hostname (Atlas has its id). `false` means there is nothing for the customer to configure yet. */
  readonly providerRegistered: boolean;
  /** P63c — the provider's own numeric error code for the latest refusal, for operators. A number, never a message. */
  readonly providerErrorCode?: string;
}

/** P63 — what the customer must configure at their DNS provider. */
export interface DomainDnsInstructionsResponse {
  /**
   * The hostname the customer's CNAME must point at — the zone's
   * Cloudflare-for-SaaS fallback origin. Absent when the platform has not
   * configured one (the Platform Owner readiness view says so); the UI
   * then tells the customer honestly that Atlas is not ready for custom
   * domains rather than inventing a target.
   */
  readonly cnameTarget?: string;
  readonly records: readonly DomainVerificationRecordResponse[];
  /** P63c — `true` only when there is genuinely something for the customer to add or keep: the provider holds the hostname AND there is a CNAME target. `records` may be empty once ownership/certificate validation is complete (P63f). */
  readonly ready: boolean;
  /** P63c — why not, when `ready` is false. Always Atlas-side. */
  readonly blockedReason?: DomainDnsBlockedReason;
}

export interface CanonicalHostResponse {
  readonly host: string;
  readonly source: CanonicalHostSource;
}

export interface AcademyDomainConfigurationResponse {
  readonly academyId: string;
  readonly subdomain?: SubdomainAllocationResponse;
  readonly customDomain?: DomainConnectionResponse;
  /** P63 — the one address the website advertises; absent only when neither a base domain nor a connected custom domain exists. */
  readonly canonicalHost?: CanonicalHostResponse;
  /** P63 — present whenever a custom domain row exists past `not_configured`. */
  readonly dns?: DomainDnsInstructionsResponse;
  readonly ssl: { readonly status: PrismaSslStatus };
  readonly cdn: {
    readonly status: PrismaCdnStatus;
    readonly provider?: PrismaInfrastructureProviderName;
  };
}

export function toSubdomainAllocationResponse(
  allocation: PrismaSubdomainAllocation | null,
): SubdomainAllocationResponse | undefined {
  if (!allocation) return undefined;
  return {
    subdomain: allocation.subdomain,
    status: allocation.status,
    fullHost: allocation.fullHost ?? undefined,
  };
}

function toVerificationRecords(
  connection: PrismaDomainConnection,
): DomainVerificationRecordResponse[] {
  const raw = connection.verificationRecords;
  return Array.isArray(raw) ? (raw as unknown as DomainVerificationRecordResponse[]) : [];
}

/** A `domain_connections` row whose `status` is still `not_configured` (the default, never-touched state) is reported as "no custom domain" — matching `AcademyDomainConfiguration.customDomain?` being genuinely absent rather than a connection object with a null hostname. */
export function toDomainConnectionResponse(
  connection: PrismaDomainConnection | null,
): DomainConnectionResponse | undefined {
  if (!connection || connection.status === 'not_configured') return undefined;
  const records = toCustomerRecords(connection);
  return {
    hostname: connection.hostname ?? undefined,
    status: connection.status,
    verificationRecords: records.length ? records : undefined,
    connectedAt: connection.connectedAt?.toISOString(),
    lastCheckedAt: connection.lastCheckedAt?.toISOString(),
    lastCheckError:
      (connection.lastCheckError as DomainCheckErrorCode | null) ?? undefined,
    sslStatus: connection.sslStatus,
    httpsReachable: connection.httpsReachable ?? undefined,
    httpsCheckedAt: connection.httpsCheckedAt?.toISOString(),
    httpsStatusCode: connection.httpsStatusCode ?? undefined,
    httpsFailureReason:
      (connection.httpsFailureReason as HttpsFailureReason | null) ?? undefined,
    live: isCustomDomainLive(connection),
    providerRegistered: Boolean(connection.providerHostnameId),
    providerErrorCode: connection.lastProviderErrorCode ?? undefined,
  };
}

/**
 * P63g — records the CUSTOMER must create. HTTP validation records are
 * served by the provider itself once the CNAME routes traffic through it
 * (that is the point of HTTP validation), so they are never something a
 * customer adds at their DNS provider and are not shown.
 */
function toCustomerRecords(
  connection: PrismaDomainConnection,
): DomainVerificationRecordResponse[] {
  return toVerificationRecords(connection).filter(
    (record) => record.type.toUpperCase() !== 'HTTP',
  );
}

function toDnsInstructions(
  connection: PrismaDomainConnection,
  cnameTarget: string | null,
): DomainDnsInstructionsResponse {
  const records = toCustomerRecords(connection);
  // P63f — "registered" is the provider holding the hostname, full stop.
  // Once ownership is verified and the certificate issued, the provider
  // returns NO verification records any more; the CNAME is still the one
  // thing the customer must keep (and must restore when DNS breaks), so
  // the instructions stay ready with just the CNAME row.
  const registered = Boolean(connection.providerHostnameId);
  const blockedReason: DomainDnsBlockedReason | undefined = !registered
    ? 'provider_not_registered'
    : !cnameTarget
      ? 'routing_target_missing'
      : undefined;
  return {
    cnameTarget: cnameTarget ?? undefined,
    records,
    ready: blockedReason === undefined,
    blockedReason,
  };
}

export interface AcademyDomainConfigurationInput {
  readonly academyId: string;
  readonly subdomain: PrismaSubdomainAllocation | null;
  readonly domainConnection: PrismaDomainConnection | null;
  readonly canonicalHost: CanonicalHostResponse | null;
  readonly cnameTarget: string | null;
}

export function toAcademyDomainConfigurationResponse(
  input: AcademyDomainConfigurationInput,
): AcademyDomainConfigurationResponse {
  const { academyId, subdomain, domainConnection, canonicalHost, cnameTarget } = input;
  const customDomain = toDomainConnectionResponse(domainConnection);
  return {
    academyId,
    subdomain: toSubdomainAllocationResponse(subdomain),
    customDomain,
    canonicalHost: canonicalHost ?? undefined,
    dns:
      customDomain && domainConnection
        ? toDnsInstructions(domainConnection, cnameTarget)
        : undefined,
    ssl: { status: domainConnection?.sslStatus ?? 'not_configured' },
    cdn: {
      status: domainConnection?.cdnStatus ?? 'not_configured',
      provider: domainConnection?.cdnProvider ?? undefined,
    },
  };
}

/** Where the effective base domain came from (P63): deployment environment wins over the database row. */
export type PlatformBaseDomainSource = 'environment' | 'database';

export interface PlatformDomainConfigurationResponse {
  readonly baseDomain?: string;
  readonly configured: boolean;
  readonly updatedAt?: string;
  /** P63 — absent when not configured at all. */
  readonly source?: PlatformBaseDomainSource;
}

export function toPlatformDomainConfigurationResponse(
  configuration: PrismaPlatformDomainConfiguration,
  effective: { readonly baseDomain?: string; readonly source?: PlatformBaseDomainSource },
): PlatformDomainConfigurationResponse {
  return {
    baseDomain: effective.baseDomain,
    configured: Boolean(effective.baseDomain),
    updatedAt: configuration.updatedAt.toISOString(),
    source: effective.source,
  };
}

export interface InfrastructureProviderStatusResponse {
  readonly provider: PrismaInfrastructureProviderName;
  readonly connected: boolean;
}

/**
 * P63 — the Platform Owner's truthful readiness view. Every field is
 * either a live provider answer, a live probe, or explicitly `unknown`.
 */
export interface PlatformDomainReadinessResponse {
  readonly baseDomain?: string;
  readonly source?: PlatformBaseDomainSource;
  readonly provider: {
    readonly name: PrismaInfrastructureProviderName;
    readonly connected: boolean;
  };
  readonly customHostnames: {
    /** `true` only when a fallback origin exists AND the provider reports it active. */
    readonly ready: boolean;
    readonly fallbackOrigin?: string;
    readonly fallbackOriginStatus?: string;
    /** P63c — why the provider refused the zone-facts read, when it did (e.g. a token without custom-hostname permissions). Code + category only. */
    readonly providerErrorCode?: string;
    readonly providerErrorCategory?: ProviderErrorCategory;
    /** Provider vocabulary (`off`/`flexible`/`full`/`strict`); absent when unknown. */
    readonly originSslMode?: string;
    /** `true` when the origin SSL mode is one the origin's certificate can satisfy (`full`/`flexible`). `strict` would fail on every custom hostname. Absent when the mode is unknown. */
    readonly originSslModeCompatible?: boolean;
    /**
     * P63d — whether the mode could be read, and if not why: `read`,
     * `permission_missing` (the token lacks the permission the provider's
     * zone-settings endpoint needs — for Cloudflare, "Zone Settings: Read"),
     * `provider_error`, or `unavailable` (no valid credentials). Lets the
     * operator tell "not exposed to Atlas" from "misconfigured" from "the
     * provider is down" — never collapsed into one warning.
     */
    readonly originSslModeState: OriginSslModeState;
    /** P63d — the provider's numeric code for a refused SSL-mode read, when there was one. */
    readonly originSslModeErrorCode?: string;
  };
  readonly platformHttps: {
    readonly baseDomainReachable?: boolean;
    readonly wildcardReachable?: boolean;
    readonly checkedAt: string;
  };
  /** P63g — proof the verification sweep is alive, and the release backlog. */
  readonly sweep: {
    readonly lastCompletedAt?: string;
    readonly lastResult?: Record<string, number | string | boolean | null>;
    /** Provider resources Atlas gave up that the provider has not yet confirmed deleted. */
    readonly pendingReleases: number;
    readonly intervalMs: number;
  };
  readonly checkedAt: string;
}
