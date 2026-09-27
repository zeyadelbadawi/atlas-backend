/**
 * Query parameters that carry a credential and must never reach a log line.
 *
 * The request logger records every request's URL and parsed query. Most
 * credentials travel in bodies or headers (already redacted), but an OAuth
 * redirect cannot: Google's callback arrives as
 * `GET /auth/google/callback?code=…&state=…`. The code is single-use and
 * bound to PKCE and the client secret, but it is still a credential, and a
 * log is not a place for one. The list is by NAME, so any future GET that
 * carries one of these is covered too.
 */
export const SENSITIVE_QUERY_KEYS: readonly string[] = [
  'code',
  'state',
  'token',
  'id_token',
  'access_token',
  'refresh_token',
];

const CENSOR = '[REDACTED]';

/** `url` with every sensitive query value replaced; anything unparsable is returned as its path only. */
export function redactUrlQuery(url: string | undefined): string | undefined {
  if (!url) return url;
  const index = url.indexOf('?');
  if (index < 0) return url;
  const path = url.slice(0, index);
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(url.slice(index + 1));
  } catch {
    return path;
  }
  let changed = false;
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (params.has(key)) {
      params.set(key, CENSOR);
      changed = true;
    }
  }
  if (!changed) return url;
  // Keep the censor readable (URLSearchParams would percent-encode it).
  return `${path}?${params.toString().replace(/%5BREDACTED%5D/g, CENSOR)}`;
}

/** A parsed query object with the same keys censored (a shallow copy). */
export function redactQueryObject(
  query: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!query || typeof query !== 'object') return query;
  let copy: Record<string, unknown> | undefined;
  for (const key of SENSITIVE_QUERY_KEYS) {
    if (key in query) {
      copy ??= { ...query };
      copy[key] = CENSOR;
    }
  }
  return copy ?? query;
}
