/**
 * Before/after diffing for audit `changes`.
 *
 * Only ALLOWLISTED fields are compared (the catalogue's `diffFields`, or an
 * explicit list from the call site), so adding a column to a table never
 * silently starts copying it into the audit log. Values are normalised to
 * JSON-safe shapes first (Date → ISO string, bigint/Decimal → string,
 * undefined → null) so "unchanged" means the same thing it would after a
 * round-trip through the `jsonb` column.
 */
import type { AuditFieldChange } from '../services/audit-log-writer.service';

export type AuditSnapshot = Readonly<Record<string, unknown>>;

export function normalizeAuditValue(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalizeAuditValue(item));
  if (typeof value === 'object') {
    // Prisma.Decimal and friends expose a meaningful toString/toJSON.
    const candidate = value as {
      toJSON?: () => unknown;
      constructor?: { name?: string };
    };
    if (
      candidate.constructor?.name === 'Decimal' &&
      typeof candidate.toJSON === 'function'
    ) {
      return String(candidate.toJSON());
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeAuditValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * `{field: {from, to}}` for every allowlisted field whose value differs.
 * A field absent from `after` is treated as "not part of this write" and
 * skipped, so a partial `after` (only what the request touched) never
 * reports untouched fields as cleared.
 */
export function computeAuditChanges(
  before: AuditSnapshot | null | undefined,
  after: AuditSnapshot | null | undefined,
  fields: readonly string[],
): Record<string, AuditFieldChange> | undefined {
  if (!after) return undefined;
  const out: Record<string, AuditFieldChange> = {};
  for (const field of fields) {
    if (!(field in after)) continue;
    const from = normalizeAuditValue(before?.[field]);
    const to = normalizeAuditValue(after[field]);
    if (!sameValue(from, to)) out[field] = { from, to };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Copies only `fields` out of a row — the shape `computeAuditChanges` wants. */
export function pickAuditSnapshot(
  row: Readonly<Record<string, unknown>> | null | undefined,
  fields: readonly string[],
): AuditSnapshot | undefined {
  if (!row) return undefined;
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    if (field in row) out[field] = row[field];
  }
  return out;
}

export interface ListDiffCounts {
  readonly added: number;
  readonly removed: number;
  readonly changed: number;
}

/**
 * Position-wise comparison of two ordered lists (quiz questions, page
 * sections) using a caller-supplied identity and signature:
 *   - an item whose identity exists on both sides counts as `changed` when
 *     its signature differs;
 *   - identities only in `after` are `added`, only in `before` `removed`.
 * When identities are regenerated on every save (a quiz's questions are
 * replaced wholesale), pass the position as the identity — the counts then
 * read as "question 3 changed, 1 added", which is what an author means.
 */
export function diffListCounts<T>(
  before: readonly T[],
  after: readonly T[],
  identity: (item: T, index: number) => string,
  signature: (item: T) => string,
): ListDiffCounts {
  const beforeMap = new Map(before.map((item, index) => [identity(item, index), item]));
  const afterMap = new Map(after.map((item, index) => [identity(item, index), item]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [key, item] of afterMap) {
    const previous = beforeMap.get(key);
    if (previous === undefined) added += 1;
    else if (signature(previous) !== signature(item)) changed += 1;
  }
  for (const key of beforeMap.keys()) {
    if (!afterMap.has(key)) removed += 1;
  }
  return { added, removed, changed };
}
