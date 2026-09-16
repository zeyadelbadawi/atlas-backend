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
import type { DomainCheckErrorCode } from '../constants/domain.constants';

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
  /** P63 — Atlas's own outbound HTTPS probe. Absent when never probed. */
  readonly httpsReachable?: boolean;
  readonly httpsCheckedAt?: string;
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
  const records = toVerificationRecords(connection);
  return {
    hostname: connection.hostname ?? undefined,
    status: connection.status,
    verificationRecords: records.length ? records : undefined,
    connectedAt: connection.connectedAt?.toISOString(),
    lastCheckedAt: connection.lastCheckedAt?.toISOString(),
    lastCheckError:
      (connection.lastCheckError as DomainCheckErrorCode | null) ?? undefined,
    httpsReachable: connection.httpsReachable ?? undefined,
    httpsCheckedAt: connection.httpsCheckedAt?.toISOString(),
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
        ? {
            cnameTarget: cnameTarget ?? undefined,
            records: toVerificationRecords(domainConnection),
          }
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
    /** Provider vocabulary (`off`/`flexible`/`full`/`strict`); absent when unknown. */
    readonly originSslMode?: string;
    /** `true` when the origin SSL mode is one Caddy's internal certificate can satisfy (`full`). `strict` would fail on every custom hostname. Absent when the mode is unknown. */
    readonly originSslModeCompatible?: boolean;
  };
  readonly platformHttps: {
    readonly baseDomainReachable?: boolean;
    readonly wildcardReachable?: boolean;
    readonly checkedAt: string;
  };
  readonly checkedAt: string;
}
