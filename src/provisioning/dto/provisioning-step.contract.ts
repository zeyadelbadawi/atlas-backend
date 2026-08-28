/** `ProvisioningStep` response contract — matches `ProvisioningStep` (`provisioning.types.ts`) field-for-field. */
import type { ProvisioningStep as PrismaProvisioningStep } from '@prisma/client';

export interface ProvisioningErrorResponse {
  readonly code: string;
  readonly messageKey: string;
  readonly detail?: string;
}

export interface ProvisioningStepResponse {
  readonly key: PrismaProvisioningStep['key'];
  readonly status: PrismaProvisioningStep['status'];
  readonly attemptNumber: number;
  readonly startedAt?: string;
  readonly completedAt?: string;
  readonly failedAt?: string;
  readonly error?: ProvisioningErrorResponse;
}

export function toProvisioningStepResponse(
  step: PrismaProvisioningStep,
): ProvisioningStepResponse {
  return {
    key: step.key,
    status: step.status,
    attemptNumber: step.attemptNumber,
    startedAt: step.startedAt?.toISOString(),
    completedAt: step.completedAt?.toISOString(),
    failedAt: step.failedAt?.toISOString(),
    error: (step.error as unknown as ProvisioningErrorResponse | null) ?? undefined,
  };
}
