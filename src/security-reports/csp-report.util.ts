/**
 * Authentication audit, Decision 4 — normalising Content-Security-Policy
 * violation reports.
 *
 * Browsers send two shapes to the same endpoint:
 *   - the legacy `report-uri` body, `application/csp-report`:
 *       { "csp-report": { "violated-directive", "blocked-uri", ... } }
 *   - the Reporting API (`report-to`), `application/reports+json`:
 *       [ { "type": "csp-violation", "body": { "effectiveDirective",
 *           "blockedURL", "documentURL", ... } }, ... ]
 *
 * A report is UNTRUSTED input from any visitor, and a URL in it can carry a
 * token (a reset link's query string, a signed media URL). So nothing is
 * kept verbatim: blocked resources are reduced to a scheme/origin class,
 * the document to its path with no query or fragment, free text is dropped,
 * and every string is length-bounded. What survives is exactly what is
 * needed to decide whether the policy can be enforced.
 */

export type BlockedKind =
  'inline' | 'eval' | 'wasm-eval' | 'data' | 'blob' | 'self' | 'external' | 'other';

export interface CspViolation {
  /** e.g. `script-src-elem`, `connect-src`. Lower-case, bounded. */
  readonly directive: string;
  readonly blockedKind: BlockedKind;
  /** Origin only (`https://host[:port]`) for an external resource, else null. */
  readonly blockedOrigin: string | null;
  /** Host + path of the page, never its query or fragment. */
  readonly documentPath: string | null;
  /** `report` (Report-Only) or `enforce`. */
  readonly disposition: 'report' | 'enforce';
  /** Origin of the script that caused it, when the browser says. */
  readonly sourceOrigin: string | null;
  readonly line: number | null;
}

/** At most this many violations are taken from one request (a Reporting API batch). */
export const MAX_REPORTS_PER_REQUEST = 20;
const MAX_TOKEN = 64;
const MAX_PATH = 200;

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

function directiveOf(raw: string | null): string {
  if (!raw) return 'unknown';
  // Legacy reports carry the whole directive text ("script-src 'self' …").
  const name = raw.trim().split(/\s+/, 1)[0].toLowerCase();
  return /^[a-z-]{1,40}$/.test(name) ? name : 'unknown';
}

function originOf(raw: string, base?: string): string | null {
  try {
    const url = new URL(raw, base);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.origin.slice(0, MAX_TOKEN * 2);
  } catch {
    return null;
  }
}

function classify(
  blocked: string | null,
  documentOrigin: string | null,
): { kind: BlockedKind; origin: string | null } {
  if (!blocked) return { kind: 'other', origin: null };
  const value = blocked.trim().toLowerCase();
  if (value === 'inline') return { kind: 'inline', origin: null };
  if (value === 'eval') return { kind: 'eval', origin: null };
  if (value === 'wasm-eval') return { kind: 'wasm-eval', origin: null };
  if (value === 'data' || value.startsWith('data:'))
    return { kind: 'data', origin: null };
  if (value === 'blob' || value.startsWith('blob:'))
    return { kind: 'blob', origin: null };
  if (value === 'self') return { kind: 'self', origin: null };
  const origin = originOf(blocked);
  if (!origin) return { kind: 'other', origin: null };
  if (documentOrigin && origin === documentOrigin) return { kind: 'self', origin };
  return { kind: 'external', origin };
}

function documentPathOf(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.host}${url.pathname}`.slice(0, MAX_PATH);
  } catch {
    return null;
  }
}

function lineOf(value: unknown): number | null {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < 10_000_000
    ? value
    : null;
}

function fromFields(fields: {
  directive: string | null;
  blocked: string | null;
  document: string | null;
  disposition: string | null;
  source: string | null;
  line: unknown;
}): CspViolation {
  const documentOrigin = fields.document ? originOf(fields.document) : null;
  const { kind, origin } = classify(fields.blocked, documentOrigin);
  return {
    directive: directiveOf(fields.directive),
    blockedKind: kind,
    blockedOrigin: kind === 'external' || kind === 'self' ? origin : null,
    documentPath: documentPathOf(fields.document),
    disposition: fields.disposition === 'enforce' ? 'enforce' : 'report',
    sourceOrigin: fields.source ? originOf(fields.source) : null,
    line: lineOf(fields.line),
  };
}

/** Every violation in a report body, normalised; anything unrecognisable is dropped. */
export function parseCspReports(body: unknown): CspViolation[] {
  if (isObject(body) && isObject(body['csp-report'])) {
    const r = body['csp-report'];
    return [
      fromFields({
        directive: str(r['effective-directive']) ?? str(r['violated-directive']),
        blocked: str(r['blocked-uri']),
        document: str(r['document-uri']),
        disposition: str(r['disposition']),
        source: str(r['source-file']),
        line: r['line-number'],
      }),
    ];
  }
  if (Array.isArray(body)) {
    return body
      .slice(0, MAX_REPORTS_PER_REQUEST)
      .filter(
        (entry): entry is Json =>
          isObject(entry) && entry['type'] === 'csp-violation' && isObject(entry['body']),
      )
      .map((entry) => {
        const r = entry['body'] as Json;
        return fromFields({
          directive: str(r['effectiveDirective']) ?? str(r['violatedDirective']),
          blocked: str(r['blockedURL']),
          document: str(r['documentURL']) ?? str(entry['url']),
          disposition: str(r['disposition']),
          source: str(r['sourceFile']),
          line: r['lineNumber'],
        });
      });
  }
  return [];
}
