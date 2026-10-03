/**
 * Write-time scrubbing for the two free-text-ish parts of an audit row that
 * `redactChanges` does not cover: `context` and `targetLabel`.
 *
 * `context` is filtered against the action's catalogue allowlist FIRST (an
 * unknown key is dropped, not stored), then every surviving value passes the
 * same sensitive-name check `changes` gets. For tenant-visible actions two
 * further rules apply, because those rows are shown to Academy/Organization
 * owners about OTHER people: no email address survives in `context`,
 * `targetLabel` or a string `changes` value, and no IP-shaped key survives.
 * Names are the vocabulary of a tenant feed; emails are not.
 */
import type { AuditEventDefinition } from '../catalog/audit-event-catalog';

export type AuditContextValue = string | number | boolean | null;
export type AuditContext = Record<string, AuditContextValue>;

/** Same stems as `redactChanges` — duplicated deliberately small and local to avoid an import cycle with the writer. */
const SENSITIVE_KEY_STEMS: readonly string[] = [
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

const IP_KEY = /(^ip$|ipaddress|ip_address|remoteaddr|clientip)/i;

// Deliberately broad: anything with an @ between word-ish runs and a dotted
// domain. A false positive costs a masked label; a false negative leaks PII.
const EMAIL_PATTERN = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Context strings are short diagnostics, never documents. */
const MAX_CONTEXT_STRING_LENGTH = 300;
const MAX_LABEL_LENGTH = 200;

export function isSensitiveKey(key: string): boolean {
  const lowered = key.toLowerCase();
  return SENSITIVE_KEY_STEMS.some((stem) => lowered.includes(stem));
}

export function containsEmail(value: string): boolean {
  EMAIL_PATTERN.lastIndex = 0;
  const found = EMAIL_PATTERN.test(value);
  EMAIL_PATTERN.lastIndex = 0;
  return found;
}

/** Removes every email address from a string; `undefined` when nothing meaningful is left. */
export function stripEmails(value: string): string | undefined {
  const stripped = value
    .replace(EMAIL_PATTERN, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/^[\s→·,:;-]+|[\s→·,:;-]+$/g, '')
    .trim();
  return stripped.length > 0 ? stripped : undefined;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

export interface SanitizedContext {
  readonly context: AuditContext | undefined;
  /** Keys that were present but not stored — reported by the writer in non-production. */
  readonly dropped: readonly string[];
}

/**
 * Applies the catalogue allowlist and the sensitive/IP/email rules to one
 * context bag. `undefined` values are omitted (a call site's
 * `...(x !== undefined ? {x} : {})` pattern and a plain `x: undefined` mean
 * the same thing); `null` is kept because "explicitly none" is information.
 */
export function sanitizeAuditContext(
  definition: AuditEventDefinition | undefined,
  context: Readonly<Record<string, AuditContextValue | undefined>> | undefined,
): SanitizedContext {
  if (!context) return { context: undefined, dropped: [] };

  const allowed = definition ? new Set(definition.context) : undefined;
  const tenantVisible = definition?.visibleToTenant ?? false;
  const out: AuditContext = {};
  const dropped: string[] = [];

  for (const [key, raw] of Object.entries(context)) {
    if (raw === undefined) continue;
    if (allowed && !allowed.has(key)) {
      dropped.push(key);
      continue;
    }
    if (isSensitiveKey(key)) {
      dropped.push(key);
      continue;
    }
    if (tenantVisible && IP_KEY.test(key)) {
      dropped.push(key);
      continue;
    }
    if (typeof raw === 'string') {
      let value: string | undefined = truncate(raw, MAX_CONTEXT_STRING_LENGTH);
      if (tenantVisible && containsEmail(value)) value = stripEmails(value);
      if (value === undefined) {
        dropped.push(key);
        continue;
      }
      out[key] = value;
      continue;
    }
    out[key] = raw;
  }

  return { context: Object.keys(out).length > 0 ? out : undefined, dropped };
}

/** `targetLabel` scrub: truncated always, email-free for tenant-visible actions. */
export function sanitizeTargetLabel(
  definition: AuditEventDefinition | undefined,
  label: string | null | undefined,
): string | undefined {
  if (label === null || label === undefined) return undefined;
  let value: string | undefined = truncate(label.trim(), MAX_LABEL_LENGTH);
  if (definition?.visibleToTenant && value && containsEmail(value)) {
    value = stripEmails(value);
  }
  return value && value.length > 0 ? value : undefined;
}

export const EMAIL_HIDDEN = '[email hidden]';

/**
 * For tenant-visible rows, a `changes` value that is (or contains) an email
 * is replaced by a marker: the owner learns THAT the field changed, not the
 * address. Recurses like `redactChanges` does, with the same depth bound.
 */
export function maskEmailsInValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return containsEmail(value) ? EMAIL_HIDDEN : value;
  if (value === null || typeof value !== 'object' || depth > 3) return value;
  if (Array.isArray(value))
    return value.map((item) => maskEmailsInValue(item, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] = maskEmailsInValue(inner, depth + 1);
  }
  return out;
}
