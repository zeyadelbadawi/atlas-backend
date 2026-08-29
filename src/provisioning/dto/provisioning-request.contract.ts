/**
 * `ProvisioningRequest` response contract — matches `ProvisioningRequest`
 * (`provisioning.types.ts`) field-for-field. `subdomain`/`domain` are
 * resolved live from the existing `subdomain_allocations`/
 * `domain_connections` tables (via the caller-supplied, already-fetched
 * rows) rather than a redundant stored snapshot — see schema.prisma's own
 * P14 header comment for why.
 */
import type {
  ProvisioningRequest as PrismaProvisioningRequest,
  ProvisioningStep as PrismaProvisioningStep,
  SubdomainAllocation as PrismaSubdomainAllocation,
  DomainConnection as PrismaDomainConnection,
} from '@prisma/client';
import {
  toSubdomainAllocationResponse,
  toDomainConnectionResponse,
  type SubdomainAllocationResponse,
  type DomainConnectionResponse,
} from '../../domain/dto/domain.contract';
import {
  toProvisioningStepResponse,
  type ProvisioningErrorResponse,
  type ProvisioningStepResponse,
} from './provisioning-step.contract';

export interface ProvisioningRequestResponse {
  readonly id: string;
  readonly organizationId: string;
  readonly academyId?: string;
  readonly status: PrismaProvisioningRequest['status'];
  readonly currentStepKey: PrismaProvisioningRequest['currentStepKey'];
  readonly steps: readonly ProvisioningStepResponse[];
  readonly subdomain?: SubdomainAllocationResponse;
  readonly domain?: DomainConnectionResponse;
  readonly idempotencyKey: string;
  readonly attemptCount: number;
  readonly requestedAcademyName: string;
  readonly requestedSubdomain: string;
  readonly triggeringPaymentId?: string;
  /** Phase P19 — see `provisioning.constants.ts`'s 'theme' step. */
  readonly selectedThemeKey?: string;
  readonly lastError?: ProvisioningErrorResponse;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
}

export function toProvisioningRequestResponse(
  request: PrismaProvisioningRequest,
  steps: readonly PrismaProvisioningStep[],
  subdomain: PrismaSubdomainAllocation | null,
  domainConnection: PrismaDomainConnection | null,
): ProvisioningRequestResponse {
  return {
    id: request.id,
    organizationId: request.organizationId,
    academyId: request.academyId ?? undefined,
    status: request.status,
    currentStepKey: request.currentStepKey,
    steps: steps.map(toProvisioningStepResponse),
    subdomain: toSubdomainAllocationResponse(subdomain),
    domain: toDomainConnectionResponse(domainConnection),
    idempotencyKey: request.idempotencyKey,
    attemptCount: request.attemptCount,
    requestedAcademyName: request.requestedAcademyName,
    requestedSubdomain: request.requestedSubdomain,
    triggeringPaymentId: request.triggeringPaymentId ?? undefined,
    selectedThemeKey: request.selectedThemeKey ?? undefined,
    lastError:
      (request.lastError as unknown as ProvisioningErrorResponse | null) ?? undefined,
    createdAt: request.createdAt.toISOString(),
    startedAt: request.startedAt?.toISOString(),
    completedAt: request.completedAt?.toISOString(),
    failedAt: request.failedAt?.toISOString(),
  };
}
