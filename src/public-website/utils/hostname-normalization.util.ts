/**
 * Public hostname normalization/matching (master plan §21 Phase P11,
 * §24 URL/Host Security). Pure functions — no I/O — so normalization and
 * subdomain extraction are directly unit-testable, independent of any
 * database or HTTP concern.
 *
 * Deliberately ASCII-only, matching the real frontend's own
 * `HOSTNAME_REGEX` (`[a-z0-9-]`, case-insensitive) exactly — no IDN/
 * punycode conversion exists anywhere in the real contract to reproduce,
 * so a non-ASCII hostname is rejected outright (`null`) rather than
 * guessed at.
 *
 * `normalizeHostname` rejects anything URL-shaped (a scheme, a path, a
 * query string, whitespace) — a public caller must supply a bare
 * hostname, never `https://example.com/path` (master plan §24: "Do not
 * accept `https://example.com/path` as a hostname"). Matching is always
 * EXACT string equality against a normalized value — never substring
 * matching — so `example.com.evil.com` can never be mistaken for
 * `example.com` (§24's own explicit example).
 */

const LABEL_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Lowercases, trims, strips a trailing FQDN dot and a `:port` suffix, and validates real DNS label shape. Returns `null` for anything URL-shaped, containing whitespace, non-ASCII, or an empty/malformed label — never a best-effort guess. */
export function normalizeHostname(raw: string | undefined | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/\s/.test(trimmed)) return null;
  if (trimmed.includes('://')) return null;
  if (/[/?#]/.test(trimmed)) return null;
  // eslint-disable-next-line no-control-regex -- an explicit non-ASCII rejection, not a control-character filter
  if (/[^\x00-\x7f]/.test(trimmed)) return null;

  let host = trimmed.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);

  const portMatch = host.match(/^(.+):(\d+)$/);
  if (portMatch) host = portMatch[1];

  if (!host || host.includes('..')) return null;

  const labels = host.split('.');
  if (labels.some((label) => !LABEL_PATTERN.test(label))) return null;

  return host;
}

/**
 * Given an already-normalized hostname and the trusted platform base
 * domain (never client-supplied — always `PlatformDomainRuntimeConfig.
 * baseDomain`, sourced from validated environment configuration), returns
 * the single-label subdomain if `hostname` is exactly `{label}.{base}`.
 * `null` for the bare base domain itself, a multi-label subdomain
 * (`a.b.{base}`), or no match at all — only a genuine single-label
 * Academy subdomain is ever extracted.
 */
export function extractSubdomainLabel(
  normalizedHostname: string,
  baseDomain: string | undefined,
): string | null {
  if (!baseDomain) return null;
  const base = baseDomain.trim().toLowerCase();
  if (!base || normalizedHostname === base) return null;

  const suffix = `.${base}`;
  if (!normalizedHostname.endsWith(suffix)) return null;

  const label = normalizedHostname.slice(0, -suffix.length);
  if (!label || label.includes('.')) return null;

  return label;
}
