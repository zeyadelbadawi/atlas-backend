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
import {
  DEFAULT_PROVISIONING_STALL_SECONDS,
  PROVISIONING_STAGE_OF_STEP,
  TERMINAL_PROVISIONING_STATUSES,
  type ProvisioningStage,
} from './provisioning.constants';
import { summarizeRequestedBrand, type RequestedBrandSummary } from './requested-brand';

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
  /** Phase 6 — see `CreateProvisioningRequestDto.websiteSetupMode`'s own doc comment. */
  readonly websiteSetupMode?: string;
  readonly lastError?: ProvisioningErrorResponse;
  /**
   * W2 — the stage the request is really in (`PROVISIONING_STAGE_OF_STEP`
   * of `currentStepKey`), or `'ready'` once it is. On a failed/cancelled
   * request it is where it stopped.
   */
  readonly stage: ProvisioningStage | 'ready';
  /** W2 — when a step last started, finished or failed (falls back to `startedAt`/`createdAt` on older rows). */
  readonly lastProgressAt: string;
  /** W2 — non-terminal and no progress for `stallThresholdSeconds`: the UI offers Retry. */
  readonly stalled: boolean;
  readonly stallThresholdSeconds: number;
  /** W2 — what the setup form asked for (palette yes/no, logo state), never the palette itself; absent when nothing was chosen. */
  readonly requestedBrand?: RequestedBrandSummary;
  readonly createdAt: string;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
}

export interface ProvisioningProgressOptions {
  readonly now?: Date;
  readonly stallThresholdSeconds?: number;
}

export function toProvisioningRequestResponse(
  request: PrismaProvisioningRequest,
  steps: readonly PrismaProvisioningStep[],
  subdomain: PrismaSubdomainAllocation | null,
  domainConnection: PrismaDomainConnection | null,
  options: ProvisioningProgressOptions = {},
): ProvisioningRequestResponse {
  const now = options.now ?? new Date();
  const stallThresholdSeconds =
    options.stallThresholdSeconds ?? DEFAULT_PROVISIONING_STALL_SECONDS;
  const lastProgressAt = request.lastProgressAt ?? request.startedAt ?? request.createdAt;
  const stalled =
    !TERMINAL_PROVISIONING_STATUSES.has(request.status) &&
    now.getTime() - lastProgressAt.getTime() > stallThresholdSeconds * 1000;
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
    websiteSetupMode: request.websiteSetupMode ?? undefined,
    lastError:
      (request.lastError as unknown as ProvisioningErrorResponse | null) ?? undefined,
    stage:
      request.status === 'ready'
        ? 'ready'
        : PROVISIONING_STAGE_OF_STEP[request.currentStepKey],
    lastProgressAt: lastProgressAt.toISOString(),
    stalled,
    stallThresholdSeconds,
    requestedBrand: summarizeRequestedBrand(request.requestedBrand),
    createdAt: request.createdAt.toISOString(),
    startedAt: request.startedAt?.toISOString(),
    completedAt: request.completedAt?.toISOString(),
    failedAt: request.failedAt?.toISOString(),
  };
}
