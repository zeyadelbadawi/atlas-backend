/**
 * Domain response contracts — match `AcademyDomainConfiguration`/
 * `SubdomainAllocation`/`DomainConnection`/`DomainVerificationRecord`/
 * `PlatformDomainConfiguration`/`InfrastructureProviderStatus`
 * (`domain.types.ts`/`provisioning.types.ts`) field-for-field.
 */
import type {
  CdnStatus as PrismaCdnStatus,
  DomainConnection as PrismaDomainConnection,
  InfrastructureProviderName as PrismaInfrastructureProviderName,
  PlatformDomainConfiguration as PrismaPlatformDomainConfiguration,
  SslStatus as PrismaSslStatus,
  SubdomainAllocation as PrismaSubdomainAllocation,
} from '@prisma/client';

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
}

export interface AcademyDomainConfigurationResponse {
  readonly academyId: string;
  readonly subdomain?: SubdomainAllocationResponse;
  readonly customDomain?: DomainConnectionResponse;
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

/** A `domain_connections` row whose `status` is still `not_configured` (the default, never-touched state) is reported as "no custom domain" — matching `AcademyDomainConfiguration.customDomain?` being genuinely absent rather than a connection object with a null hostname. */
export function toDomainConnectionResponse(
  connection: PrismaDomainConnection | null,
): DomainConnectionResponse | undefined {
  if (!connection || connection.status === 'not_configured') return undefined;
  return {
    hostname: connection.hostname ?? undefined,
    status: connection.status,
    verificationRecords:
      (connection.verificationRecords as unknown as
        DomainVerificationRecordResponse[] | null) ?? undefined,
    connectedAt: connection.connectedAt?.toISOString(),
  };
}

export function toAcademyDomainConfigurationResponse(
  academyId: string,
  subdomain: PrismaSubdomainAllocation | null,
  domainConnection: PrismaDomainConnection | null,
): AcademyDomainConfigurationResponse {
  return {
    academyId,
    subdomain: toSubdomainAllocationResponse(subdomain),
    customDomain: toDomainConnectionResponse(domainConnection),
    ssl: { status: domainConnection?.sslStatus ?? 'not_configured' },
    cdn: {
      status: domainConnection?.cdnStatus ?? 'not_configured',
      provider: domainConnection?.cdnProvider ?? undefined,
    },
  };
}

export interface PlatformDomainConfigurationResponse {
  readonly baseDomain?: string;
  readonly configured: boolean;
  readonly updatedAt?: string;
}

export function toPlatformDomainConfigurationResponse(
  configuration: PrismaPlatformDomainConfiguration,
): PlatformDomainConfigurationResponse {
  return {
    baseDomain: configuration.baseDomain ?? undefined,
    configured: configuration.configured,
    updatedAt: configuration.updatedAt.toISOString(),
  };
}

export interface InfrastructureProviderStatusResponse {
  readonly provider: PrismaInfrastructureProviderName;
  readonly connected: boolean;
}
