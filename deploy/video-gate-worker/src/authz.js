/**
 * `authz.js` — revocation before expiry, by re-authorizing with Atlas.
 *
 * WHAT IT DOES. After `gate.js` has verified a token (signature, claims,
 * expiry, object binding), this module asks Atlas — `POST
 * <ATLAS_AUTHZ_URL>` (`/api/v1/video-gate/authorize`) — whether that token
 * is STILL honoured: is the account active, the session live, the device
 * registered, the enrollment and membership current, the lesson still
 * published and still pointing at these bytes. Atlas answers from its own
 * database (`VideoGateAuthorizationService`), so every revocation it has
 * ever made is visible here without a second list to keep in sync.
 *
 * THE BOUND. An answer is cached in this isolate for at most
 * `AUTHZ_MAX_CACHE_SECONDS` (30), counted from the moment the question was
 * SENT, and never longer than Atlas's own `ttlSeconds` or the token's own
 * expiry. A revocation committed in Atlas at T therefore stops every new
 * request, at every edge location, by T + 30 s. (A response body already
 * streaming at T is not cut off — see README, "Revocation".) There is no
 * stale-while-revalidate, no grace period, no "serve the last answer when
 * Atlas is down": once an answer's window closes it is gone.
 *
 * FAIL CLOSED. If Atlas cannot be asked — network error, timeout, non-200,
 * unparseable answer, missing configuration — the request is refused with
 * `503 authz_unavailable` and nothing is cached, so the very next request
 * asks again. The only requests served during an Atlas outage are those
 * still inside a positive answer's ≤ 30 s window, which is the bound
 * above, not an exception to it.
 *
 * WHY NOT WORKERS KV. A KV denylist needs a writer (Atlas holding a
 * Cloudflare API token), is eventually consistent for "60 seconds or more"
 * (no upper bound), and on the free plan allows 100 000 reads and 1 000
 * writes a day — a quota a fail-closed gate would turn into an outage on a
 * busy day. This module needs no binding and no paid feature: one
 * subrequest per (token, isolate, 30 s).
 *
 * CALLER AUTHENTICATION. Each call is HMAC-SHA256 signed over
 * `${unixSeconds}.${body}` with `GATE_AUTHZ_SECRET`, which must equal the
 * API's `BASIC_VIDEO_GATE_AUTHZ_SECRET`. It is a DIFFERENT secret from
 * `GATE_SIGNING_SECRET`: this module may sign with it, and the Worker still
 * cannot mint a playback token (that key stays `['verify']`-only in
 * `gate.js`).
 *
 * Like `gate.js`, this file uses only Web Crypto, `fetch` and standard
 * globals, so it runs unchanged on the Workers runtime and on Node 18+ —
 * which is what lets `test/` exercise this exact code.
 */

/** The longest any answer may be reused. Matches `GATE_AUTHZ_MAX_CACHE_SECONDS` on the API. */
export const AUTHZ_MAX_CACHE_SECONDS = 30;

/** Bound on the per-isolate cache. Oldest entries go first; memory stays small whatever the traffic. */
export const AUTHZ_DEFAULT_MAX_ENTRIES = 5000;

/** How long one call to Atlas may take before the request is refused. */
export const AUTHZ_DEFAULT_TIMEOUT_MS = 3000;

/** Header names — the contract with `video-gate-authorization.service.ts`. */
export const TIMESTAMP_HEADER = 'x-atlas-gate-timestamp';
export const SIGNATURE_HEADER = 'x-atlas-gate-signature';

/** Refusal codes this module adds to `gate.js`'s set. */
export const AUTHZ_DENY = Object.freeze({
  UNAVAILABLE: 'authz_unavailable',
  MISCONFIGURED: 'gate_misconfigured',
});

/**
 * A bounded, time-boxed decision cache. One per isolate (module scope in
 * `index.js`); tests construct their own.
 */
export class DecisionCache {
  /** @param {number} maxEntries */
  constructor(maxEntries = AUTHZ_DEFAULT_MAX_ENTRIES) {
    this.maxEntries = Math.max(1, maxEntries);
    /** @type {Map<string, { allow: boolean, reason: string | null, expiresAtMs: number }>} */
    this.entries = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.inFlight = new Map();
  }

  get(key, nowMs) {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAtMs <= nowMs) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  set(key, entry) {
    this.entries.delete(key);
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    this.entries.set(key, entry);
  }

  clear() {
    this.entries.clear();
    this.inFlight.clear();
  }
}

const signKeyCache = new Map();

/** The authz secret is imported with `['sign']` only — and it is not the token-signing secret. */
function importSignKey(secret) {
  let promise = signKeyCache.get(secret);
  if (!promise) {
    promise = crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    signKeyCache.set(secret, promise);
  }
  return promise;
}

function toHex(buffer) {
  const bytes = new Uint8Array(buffer);
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/** The configured cache window, clamped to [0, 30]. 0 disables caching (every request asks Atlas). */
export function cacheWindowSeconds(env) {
  const raw = Number(env.AUTHZ_CACHE_TTL_SECONDS ?? AUTHZ_MAX_CACHE_SECONDS);
  if (!Number.isFinite(raw)) return AUTHZ_MAX_CACHE_SECONDS;
  return Math.min(AUTHZ_MAX_CACHE_SECONDS, Math.max(0, Math.floor(raw)));
}

/**
 * Whether the token `gate.js` already verified is still honoured by Atlas.
 *
 * @param {object} args
 * @param {string} args.token          The raw `t` parameter (already verified by `gate.js`).
 * @param {string} args.objectKey      The key from the path (already equal to the signed `k`).
 * @param {{ e: number }} args.claims  The verified claims; only the expiry is read here.
 * @param {Record<string, any>} args.env
 * @param {DecisionCache} args.cache
 * @param {number} args.nowMs
 * @param {typeof fetch} [args.fetchImpl]
 * @returns {Promise<{ ok: true, cached: boolean } | { ok: false, reason: string, status: number, detail: string | null, cached: boolean }>}
 */
export async function authorizeWithAtlas({ token, objectKey, claims, env, cache, nowMs, fetchImpl }) {
  const url = env.ATLAS_AUTHZ_URL;
  const secret = env.GATE_AUTHZ_SECRET;
  // A Worker that cannot ask is a Worker that must not serve: treating a
  // missing setting as "nothing is revoked" would silently remove the
  // capability Atlas reports to learners.
  if (!url || !secret || !String(url).startsWith('https://')) {
    return { ok: false, reason: AUTHZ_DENY.MISCONFIGURED, status: 503, detail: null, cached: false };
  }

  const key = `${objectKey}\n${token}`;
  const hit = cache.get(key, nowMs);
  if (hit) return verdictFrom(hit, true);

  // Concurrent range requests from one player on a cold cache share one call.
  let pending = cache.inFlight.get(key);
  if (!pending) {
    pending = askAtlas({ token, objectKey, url, secret, env, nowMs, fetchImpl }).finally(() => {
      cache.inFlight.delete(key);
    });
    cache.inFlight.set(key, pending);
  }
  const answer = await pending;
  if (!answer) {
    // Never cached: the next request asks again.
    return { ok: false, reason: AUTHZ_DENY.UNAVAILABLE, status: 503, detail: null, cached: false };
  }

  // The window starts when the question was SENT, so the bound holds even
  // if the answer was slow to arrive.
  const windowSeconds = Math.min(cacheWindowSeconds(env), answer.ttlSeconds);
  const expiresAtMs = Math.min(nowMs + windowSeconds * 1000, claims.e * 1000);
  const entry = { allow: answer.allow, reason: answer.reason, expiresAtMs };
  if (expiresAtMs > nowMs) cache.set(key, entry);
  return verdictFrom(entry, false);
}

function verdictFrom(entry, cached) {
  if (entry.allow) return { ok: true, cached };
  return { ok: false, reason: 'revoked', status: 403, detail: entry.reason, cached };
}

/** One signed call. Resolves to the parsed answer, or null for ANY failure. Never throws. */
async function askAtlas({ token, objectKey, url, secret, env, nowMs, fetchImpl }) {
  try {
    const body = JSON.stringify({ token, objectKey });
    const timestamp = String(Math.floor(nowMs / 1000));
    const signature = toHex(
      await crypto.subtle.sign(
        'HMAC',
        await importSignKey(secret),
        new TextEncoder().encode(`${timestamp}.${body}`),
      ),
    );
    const timeoutMs = Number(env.AUTHZ_TIMEOUT_MS ?? AUTHZ_DEFAULT_TIMEOUT_MS);
    const response = await (fetchImpl ?? fetch)(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [TIMESTAMP_HEADER]: timestamp,
        [SIGNATURE_HEADER]: signature,
      },
      body,
      signal: AbortSignal.timeout(
        Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : AUTHZ_DEFAULT_TIMEOUT_MS,
      ),
    });
    if (response.status !== 200) return null;
    const parsed = await response.json();
    if (!parsed || typeof parsed.allow !== 'boolean') return null;
    const ttl = Number(parsed.ttlSeconds);
    return {
      allow: parsed.allow,
      reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 64) : null,
      ttlSeconds: Number.isFinite(ttl)
        ? Math.min(AUTHZ_MAX_CACHE_SECONDS, Math.max(0, Math.floor(ttl)))
        : 0,
    };
  } catch (error) {
    console.error('gate: authorization call failed', error && error.name);
    return null;
  }
}
