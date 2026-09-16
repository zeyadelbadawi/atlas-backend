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
  /**
   * Phase 8 — set whenever the audited mutation is Academy-scoped (Course/
   * Instructor/Learning content, an Academy-scoped support case), so a
   * Manager's "recent activity" dashboard widget can filter to their own
   * Academy without seeing another Academy's rows under the same
   * Organization. Omitted for Organization-level-only actions.
   */
  readonly academyId?: string;
  /**
   * Phase 8 — the actor's real role AT THE TIME of the action (Academy
   * membership role, or the literal `'platform_owner'`), resolved by the
   * CALLER from the actor's own membership row — this service never
   * re-derives it, matching every other "who did this" field in this
   * codebase being resolved once, at the call site, from a real row.
   */
  readonly role?: string;
  /** A dotted event name, e.g. `"academy.provisioned"`, `"payment.approved"`. */
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly targetLabel?: string;
  readonly context?: Record<string, string | number | boolean | null>;
  /**
   * P58 — a structured `{field: {from, to}}` diff of what this mutation
   * changed.
   *
   * SEPARATE FROM `context` ON PURPOSE. `context` is a flat scalar bag
   * whose safety rests on reviewing each call site (see this file's header).
   * A before/after diff is different in kind: it carries FIELD VALUES, and
   * the whole point of it is to record values that were previously only in
   * the database. That is exactly the shape that can accidentally capture a
   * password hash, a TOTP secret or an encrypted credential — so unlike
   * `context`, this one IS machine-scrubbed before it is written, by
   * `redactChanges` below. Because the shape is known and narrow, the
   * scrub is enforceable rather than a convention.
   */
  readonly changes?: Record<string, AuditFieldChange>;
  /**
   * P58 — non-identifying request metadata. Deliberately narrow: a request
   * id, the method and route, and whether the action succeeded. No headers,
   * no bodies, no tokens.
   */
  readonly requestContext?: AuditRequestContext;
}

/** One field's before/after. `unknown` because a plan's `limits` is an object while its `displayOrder` is a number. */
export interface AuditFieldChange {
  readonly from: unknown;
  readonly to: unknown;
}

export interface AuditRequestContext {
  readonly requestId?: string;
  readonly method?: string;
  readonly route?: string;
  readonly outcome?: 'succeeded' | 'failed';
}

/**
 * Field names whose VALUES must never reach the audit log, matched
 * case-insensitively as substrings so `passwordHash`, `totpSecret`,
 * `refreshToken` and `encryptedClientSecret` are all caught by their stem.
 *
 * Deliberately an allow-nothing list on the sensitive side rather than an
 * allowlist of safe fields: a new sensitive column added later is caught by
 * its name, whereas an allowlist would silently let it through. The
 * replacement is a marker string, not removal, so the audit still records
 * THAT the field changed — which is itself the security-relevant fact —
 * without recording what it changed to.
 */
const REDACTED_FIELD_STEMS: readonly string[] = [
  'password',
  'secret',
  'token',
  'credential',
  'privatekey',
  'apikey',
  'signature',
  'totp',
  'recoverycode',
  'hash',
  'salt',
  'cipher',
  'encrypted',
];

const REDACTED = '[redacted]';

/** Scrubs a before/after diff. Exported for direct testing — this is a security boundary, not a formatting helper. */
export function redactChanges(
  changes: Record<string, AuditFieldChange>,
): Record<string, AuditFieldChange> {
  const out: Record<string, AuditFieldChange> = {};
  for (const [field, change] of Object.entries(changes)) {
    const lowered = field.toLowerCase();
    if (REDACTED_FIELD_STEMS.some((stem) => lowered.includes(stem))) {
      out[field] = { from: REDACTED, to: REDACTED };
      continue;
    }
    out[field] = {
      from: redactValue(change.from),
      to: redactValue(change.to),
    };
  }
  return out;
}

/**
 * Recurses one level into object values, because a plan's `pricing` is
 * `{amount, currency, billingCycle}` and a future audited object could
 * nest a sensitive key inside it. Arrays and scalars pass through; depth is
 * bounded so a pathological payload cannot spin here.
 */
function redactValue(value: unknown, depth = 0): unknown {
  if (value === null || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const lowered = key.toLowerCase();
    out[key] = REDACTED_FIELD_STEMS.some((stem) => lowered.includes(stem))
      ? REDACTED
      : redactValue(inner, depth + 1);
  }
  return out;
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
      academyId: input.academyId,
      role: input.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: input.targetLabel,
      context: (input.context as Prisma.InputJsonValue | undefined) ?? undefined,
      // Scrubbed here, at the single choke point every mutation in the
      // backend already funnels through — never at the call sites, which
      // would make the guarantee only as strong as the least careful one.
      changes: input.changes
        ? (redactChanges(input.changes) as unknown as Prisma.InputJsonValue)
        : undefined,
      requestContext:
        (input.requestContext as unknown as Prisma.InputJsonValue | undefined) ??
        undefined,
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
