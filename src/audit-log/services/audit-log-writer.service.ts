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
import { Prisma } from '@prisma/client';
import { AuditLogEntriesRepository } from '../repositories/audit-log-entries.repository';
import {
  getAuditEventDefinition,
  type AuditAction,
  type AuditEventDefinition,
} from '../catalog/audit-event-catalog';
import {
  maskEmailsInValue,
  sanitizeAuditContext,
  sanitizeTargetLabel,
  type AuditContextValue,
} from '../utils/audit-sanitize.util';
import { computeAuditChanges, type AuditSnapshot } from '../utils/audit-diff.util';

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
  /**
   * Filtered at write time against the action's catalogue allowlist
   * (`audit-event-catalog.ts`); keys outside it are dropped, and
   * tenant-visible rows lose any email/IP value. `undefined` values are
   * omitted.
   */
  readonly context?: Readonly<Record<string, AuditContextValue | undefined>>;
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
 * Input to `AuditLogWriterService.record` — the preferred entry point for
 * new call sites. Compared with `write`:
 *   - `action` is the typed catalogue union, so a typo is a compile error;
 *   - `targetType` defaults to the catalogue's;
 *   - `organizationId` and `role` may be omitted when `academyId` is given —
 *     they are resolved inside the caller's transaction with ONE query, and
 *     only when missing (callers that already hold them pay nothing);
 *   - `before`/`after` snapshots are diffed over the catalogue's
 *     `diffFields` (or `diffFields` here) into `changes`.
 * Context should carry related entity NAMES (`courseTitle`,
 * `sectionTitle`, `studentName`...) — never emails.
 */
export interface AuditRecordInput {
  readonly actorUserId: string;
  readonly action: AuditAction;
  readonly targetId: string;
  readonly targetType?: string;
  readonly targetLabel?: string | null;
  readonly academyId?: string | null;
  readonly organizationId?: string | null;
  readonly role?: string | null;
  readonly context?: Readonly<Record<string, AuditContextValue | undefined>>;
  readonly before?: AuditSnapshot | null;
  readonly after?: AuditSnapshot | null;
  readonly diffFields?: readonly string[];
  /** Explicit changes, merged over (and winning against) the computed diff. */
  readonly changes?: Record<string, AuditFieldChange>;
  readonly requestContext?: AuditRequestContext;
}

/** Thrown in non-production for an action missing from the catalogue, so a new event cannot ship without its visibility decision. */
export class UnknownAuditActionError extends Error {
  constructor(action: string) {
    super(
      `Audit action "${action}" is not in the audit event catalogue (src/audit-log/catalog/audit-event-catalog.ts).`,
    );
    this.name = 'UnknownAuditActionError';
  }
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

  /**
   * The real write — part of the caller's own transaction. Throws like any
   * other write in that transaction would (the caller's own transaction
   * rolls back with it, matching every other write in this codebase).
   *
   * Every row is checked against the event catalogue here, at the single
   * choke point: an unknown action throws outside production (so it is
   * caught by tests before it ships) and is logged — but still written,
   * never failing a customer's committed action — in production. `context`
   * is reduced to the action's allowlist and, like `targetLabel` and
   * `changes`, stripped of emails when the row is tenant-visible.
   */
  async write(tx: Prisma.TransactionClient, input: AuditLogWriteInput): Promise<void> {
    const definition = this.resolveDefinition(input.action);
    const { context, dropped } = sanitizeAuditContext(definition, input.context);
    if (dropped.length > 0 && process.env.NODE_ENV !== 'production') {
      this.logger.debug(
        { action: input.action, dropped },
        'Audit context keys outside the catalogue allowlist were not stored.',
      );
    }

    let changes = input.changes ? redactChanges(input.changes) : undefined;
    if (changes && definition?.visibleToTenant) {
      changes = Object.fromEntries(
        Object.entries(changes).map(([field, change]) => [
          field,
          { from: maskEmailsInValue(change.from), to: maskEmailsInValue(change.to) },
        ]),
      );
    }

    await this.auditLogEntriesRepository.create(tx, {
      actorUserId: input.actorUserId,
      organizationId: input.organizationId,
      academyId: input.academyId,
      role: input.role,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      targetLabel: sanitizeTargetLabel(definition, input.targetLabel),
      context: (context as Prisma.InputJsonValue | undefined) ?? undefined,
      // Scrubbed here, at the single choke point every mutation in the
      // backend already funnels through — never at the call sites, which
      // would make the guarantee only as strong as the least careful one.
      changes: changes ? (changes as unknown as Prisma.InputJsonValue) : undefined,
      requestContext:
        (input.requestContext as unknown as Prisma.InputJsonValue | undefined) ??
        undefined,
    });
  }

  /**
   * The preferred entry point for new call sites — see `AuditRecordInput`.
   * Resolves the missing organization id and actor role from the academy in
   * the caller's own transaction (one query, only when something is
   * missing), computes `changes` from before/after over an allowlist, then
   * delegates to `write` so every guarantee above still applies.
   *
   * A mutation that changed nothing auditable still records the event (the
   * person did press save); the row simply carries no `changes`.
   */
  async record(tx: Prisma.TransactionClient, input: AuditRecordInput): Promise<void> {
    const definition = this.resolveDefinition(input.action);

    let organizationId = input.organizationId ?? undefined;
    let role = input.role ?? undefined;
    if (input.academyId && (!organizationId || !role)) {
      const resolved = await this.resolveAttribution(
        tx,
        input.academyId,
        input.actorUserId,
      );
      organizationId = organizationId ?? resolved.organizationId;
      role = role ?? resolved.role;
    }

    const diffFields = input.diffFields ?? definition?.diffFields ?? [];
    const computed =
      input.before !== undefined || input.after !== undefined
        ? computeAuditChanges(input.before, input.after, diffFields)
        : undefined;
    const changes =
      computed || input.changes
        ? { ...(computed ?? {}), ...(input.changes ?? {}) }
        : undefined;

    await this.write(tx, {
      actorUserId: input.actorUserId,
      organizationId,
      academyId: input.academyId ?? undefined,
      role,
      action: input.action,
      targetType: input.targetType ?? definition?.targetType ?? 'unknown',
      targetId: input.targetId,
      targetLabel: input.targetLabel ?? undefined,
      context: input.context,
      changes,
      requestContext: input.requestContext,
    });
  }

  private resolveDefinition(action: string): AuditEventDefinition | undefined {
    const definition = getAuditEventDefinition(action);
    if (!definition) {
      if (process.env.NODE_ENV !== 'production') {
        throw new UnknownAuditActionError(action);
      }
      this.logger.error(
        { action },
        'Audit action is not in the event catalogue — written without visibility rules (hidden from tenants).',
      );
    }
    return definition;
  }

  /**
   * One read in the caller's transaction: the academy's organization, the
   * actor's academy role, or `'owner'` when the actor owns the organization
   * without an academy-member row. Under RLS the row may be invisible to the
   * caller's context (e.g. a learner); both fields then stay undefined,
   * exactly as if the caller had not passed them — never an error, because
   * a SELECT that RLS filters returns no rows rather than failing the
   * transaction.
   */
  private async resolveAttribution(
    tx: Prisma.TransactionClient,
    academyId: string,
    actorUserId: string,
  ): Promise<{ organizationId?: string; role?: string }> {
    const rows = await tx.$queryRaw<
      {
        organization_id: string;
        member_role: string | null;
        owner_user_id: string | null;
      }[]
    >(Prisma.sql`
      SELECT a."organization_id" AS organization_id,
             m."role"::text AS member_role,
             o."owner_user_id" AS owner_user_id
      FROM "academies" a
      LEFT JOIN "academy_members" m
        ON m."academy_id" = a."id" AND m."user_id" = ${actorUserId}
      LEFT JOIN "organizations" o ON o."id" = a."organization_id"
      WHERE a."id" = ${academyId}
      LIMIT 1
    `);
    const row = rows[0];
    if (!row) return {};
    return {
      organizationId: row.organization_id,
      role: row.member_role ?? (row.owner_user_id === actorUserId ? 'owner' : undefined),
    };
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
