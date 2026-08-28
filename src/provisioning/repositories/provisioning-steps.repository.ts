/**
 * ProvisioningStepsRepository — `provisioning_steps` is mutable state,
 * unlike the P13 revenue ledger (schema.prisma's own doc comment) — a
 * step row is updated in place across attempts, never re-inserted.
 * `@@unique([provisioningRequestId, key])` is the real database-level
 * guarantee `initializeForRequest` relies on: inserting the same 7 keys
 * twice for one request is structurally impossible, never merely an
 * application-layer convention.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { ProvisioningStep, ProvisioningStepKey } from '@prisma/client';
import { PROVISIONING_STEP_ORDER } from '../dto/provisioning.constants';

@Injectable()
export class ProvisioningStepsRepository {
  /** The full, deterministic 7-step initialization — see master plan §21 P14's own "Correct seven-step initialization" test requirement. Called once, inside the same transaction as the request row itself. */
  initializeForRequest(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
  ): Promise<Prisma.BatchPayload> {
    return tx.provisioningStep.createMany({
      data: PROVISIONING_STEP_ORDER.map((key) => ({
        provisioningRequestId,
        key,
        status: 'pending',
        attemptNumber: 0,
      })),
    });
  }

  findAllForRequest(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
  ): Promise<ProvisioningStep[]> {
    return tx.provisioningStep.findMany({
      where: { provisioningRequestId },
      orderBy: { key: 'asc' },
    });
  }

  findByRequestAndKey(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    key: ProvisioningStepKey,
  ): Promise<ProvisioningStep | null> {
    return tx.provisioningStep.findUnique({
      where: { provisioningRequestId_key: { provisioningRequestId, key } },
    });
  }

  /** Marks a step `running`, incrementing `attemptNumber` — the caller has already verified this step is not `completed`/`skipped` (see `ProvisioningOrchestratorService`'s own doc comment: a completed/skipped step never reaches this method at all). `startedAt` is set only on the FIRST attempt, never overwritten on a retry — matches every other "set once" timestamp convention in this codebase. */
  async markRunning(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    key: ProvisioningStepKey,
  ): Promise<ProvisioningStep> {
    const existing = await this.findByRequestAndKey(tx, provisioningRequestId, key);
    return tx.provisioningStep.update({
      where: { provisioningRequestId_key: { provisioningRequestId, key } },
      data: {
        status: 'running',
        attemptNumber: { increment: 1 },
        startedAt: existing?.startedAt ?? new Date(),
        failedAt: null,
        error: Prisma.JsonNull,
      },
    });
  }

  markCompleted(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    key: ProvisioningStepKey,
  ): Promise<ProvisioningStep> {
    return tx.provisioningStep.update({
      where: { provisioningRequestId_key: { provisioningRequestId, key } },
      data: {
        status: 'completed',
        completedAt: new Date(),
        failedAt: null,
        error: Prisma.JsonNull,
      },
    });
  }

  markSkipped(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    key: ProvisioningStepKey,
  ): Promise<ProvisioningStep> {
    return tx.provisioningStep.update({
      where: { provisioningRequestId_key: { provisioningRequestId, key } },
      data: {
        status: 'skipped',
        completedAt: new Date(),
        failedAt: null,
        error: Prisma.JsonNull,
      },
    });
  }

  markFailed(
    tx: Prisma.TransactionClient,
    provisioningRequestId: string,
    key: ProvisioningStepKey,
    error: Prisma.InputJsonValue,
  ): Promise<ProvisioningStep> {
    return tx.provisioningStep.update({
      where: { provisioningRequestId_key: { provisioningRequestId, key } },
      data: { status: 'failed', failedAt: new Date(), error },
    });
  }
}
