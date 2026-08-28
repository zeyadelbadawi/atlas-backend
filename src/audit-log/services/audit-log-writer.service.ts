/**
 * AuditLogWriterService — the ONE place any business mutation across the
 * whole backend appends an `audit_log_entries` row (master plan §5.12:
 * "backend is the sole writer... every mutation... writes one as part of
 * its own transaction, not as an optional afterthought"). Every prior
 * phase's service that performs an auditable mutation calls `write`
 * (or `writeSafely`) as the LAST statement inside its own already-open
 * transaction — never a new transaction of its own — so the audit record
 * and the business mutation share the exact same commit/rollback: if the
 * transaction rolls back, neither exists; if it commits, both do. See
 * `AuditLogEntriesRepository.create`'s own doc comment for the matching
 * RLS design this atomicity requires.
 *
 * `context` is a small, FLAT, non-secret diagnostic bag — every call site
 * is responsible for never passing a password/token/credential/secret
 * here (master plan §26); this service does not (cannot) inspect
 * arbitrary values for secrets, so the discipline is enforced by
 * reviewing each call site, matching how this codebase already trusts
 * every log statement elsewhere never to print one.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditLogEntriesRepository } from '../repositories/audit-log-entries.repository';

export interface AuditLogWriteInput {
  readonly actorUserId: string;
  readonly organizationId?: string;
  /** A dotted event name, e.g. `"academy.provisioned"`, `"payment.approved"`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetLabel?: string;
  readonly context?: Record<string, string | number | boolean | null>;
}

@Injectable()
export class AuditLogWriterService {
  private readonly logger = new Logger(AuditLogWriterService.name);

  constructor(private readonly auditLogEntriesRepository: AuditLogEntriesRepository) {}

  /** The real write — part of the caller's own transaction. Throws like any other write in that transaction would (the caller's own transaction rolls back with it, matching every other write in this codebase). */
  async write(tx: Prisma.TransactionClient, input: AuditLogWriteInput): Promise<void> {
    await this.auditLogEntriesRepository.create(tx, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      context: (input.context as Prisma.InputJsonValue | undefined) ?? undefined,
    });
  }

  /**
   * Same write, but a failure here is logged and swallowed rather than
   * propagated — for the small number of call sites where losing an
   * audit record is preferable to failing an otherwise-successful,
   * already-committed business action (e.g. after the business
   * transaction has already committed and a SEPARATE audit-only write is
   * the only option left). Prefer `write` (same-transaction, atomic)
   * everywhere it is structurally possible; this exists only for the
   * genuine exception, never as a default.
   */
  async writeBestEffort(
    tx: Prisma.TransactionClient,
    input: AuditLogWriteInput,
  ): Promise<void> {
    try {
      await this.write(tx, input);
    } catch (error) {
      this.logger.warn(
        {
          action: input.action,
          targetType: input.targetType,
          targetId: input.targetId,
          error,
        },
        'Audit log write failed (best-effort) — the underlying business action was not affected.',
      );
    }
  }
}
