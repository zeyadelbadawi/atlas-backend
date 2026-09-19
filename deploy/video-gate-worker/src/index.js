/**
 * Atlas Normal-tier video gate — Cloudflare Worker entry point.
 *
 * WHAT THIS WORKER IS. It sits on an Atlas-owned delivery hostname in
 * front of the protected R2 bucket and answers exactly one question per
 * request: "may these bytes be served to this caller right now?" It
 * verifies the token `BasicVideoProvider.issuePlaybackToken` minted, and
 * on success it streams the object out of an R2 BINDING — not a presigned
 * URL, not a redirect to the S3 endpoint.
 *
 * WHY A BINDING AND NOT A PRESIGN (the decision this whole tier turns on,
 * investigation §4.3). A presigned URL only works on the S3 API hostname,
 * so a presign forgoes the Cloudflare CDN entirely — which is the one
 * thing that makes this tier cheap — and it is bound to time and key and
 * nothing else: it cannot be tied to a session and it cannot be revoked
 * before it expires. A binding keeps the bytes on an Atlas hostname behind
 * an arbitrary verifier Atlas controls. That is the entire argument for
 * the Normal tier's security posture, and it is why `capabilities()` in
 * `basic-video.provider.ts` is allowed to claim `boundToSession: true` and
 * `revocableBeforeExpiry: true`.
 *
 * WHAT THIS WORKER IS NOT. It is NOT the authorization authority. By the
 * time a token reaches this code, `LessonContentService` has already
 * checked all seven entitlement conditions, the academy scope, the
 * enrollment, the publication state and the session lease (AD-1). This
 * Worker cannot grant access to anything Atlas did not already decide to
 * grant; it can only refuse something Atlas previously allowed. Every
 * refusal path below is therefore a NARROWING of an existing decision, and
 * there is deliberately no code path in this file that widens one.
 *
 * ZERO RUNTIME DEPENDENCIES. Nothing here imports anything the Workers
 * runtime does not itself provide — Web Crypto, `URL`, `Headers`,
 * `Response`, and the R2 and KV bindings. That is a hard requirement, not
 * a preference: a security boundary with a supply chain is a security
 * boundary with somebody else's supply chain.
 */
import {
  DENY,
  contentRangeValue,
  objectKeyFromPathname,
  parseRangeHeader,
  verifyGateToken,
} from './gate.js';

/**
 * HTTP status for each refusal reason.
 *
 * `401` for "you brought no credential" and `403` for "the credential you
 * brought is not good enough" — the distinction matters to the player,
 * which retries a refresh on `403 expired` and gives up on `403
 * key_mismatch`. The reason code also travels in the `x-atlas-gate-deny`
 * header precisely so the player can make that decision without parsing a
 * body it may never read (a media element discards the body of an error
 * response).
 */
const DENY_STATUS = Object.freeze({
  [DENY.MISSING_TOKEN]: 401,
  [DENY.MALFORMED_TOKEN]: 403,
  [DENY.BAD_SIGNATURE]: 403,
  [DENY.MALFORMED_CLAIMS]: 403,
  [DENY.EXPIRED]: 403,
  [DENY.KEY_MISMATCH]: 403,
  [DENY.REVOKED]: 403,
});

/**
 * Cloudflare KV's own documented floor for `cacheTtl` is 30 seconds (the
 * API default is 60). Asking for less is an error, so a configured value
 * is clamped rather than passed through — an operator's typo must not take
 * playback down. The floor is used as the DEFAULT too, because on this
 * path `cacheTtl` is revocation latency: every second of caching is a
 * second longer that a revoked session keeps streaming from a colo that
 * has not re-read the denylist.
 */
const KV_MIN_CACHE_TTL_SECONDS = 30;

export default {
  /**
   * @param {Request} request
   * @param {Record<string, any>} env
   * @param {{ waitUntil: (p: Promise<any>) => void }} ctx
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS preflight is answered before anything else and without touching
    // the token, because a preflight legitimately carries no credentials —
    // it is the browser asking whether it MAY send them. Refusing here
    // would make a cross-origin player fail with an opaque network error
    // instead of a readable 403.
    if (request.method === 'OPTIONS') {
      return preflightResponse(request, env);
    }

    // Only reads. A gate that accepts `PUT` is an upload endpoint nobody
    // reviewed; uploads go direct-to-R2 with a presigned PUT minted by
    // `BasicVideoProvider.createDirectUpload`, never through here.
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return errorResponse(request, env, 405, 'method_not_allowed', {
        Allow: 'GET, HEAD, OPTIONS',
      });
    }

    const objectKey = objectKeyFromPathname(url.pathname);
    if (objectKey === null) {
      // Not a playback path at all. A bare 404 with no hint of what this
      // hostname does — the delivery host should be uninteresting to
      // anyone who does not already hold a token.
      return errorResponse(request, env, 404, 'not_found');
    }

    // ORIGIN ENFORCEMENT, WITH THE CAVEAT STATED HONESTLY. This is the
    // "WAF rule on the delivery hostname" the capability matrix refers to,
    // implemented in the Worker so it ships with the Worker rather than
    // living only in a dashboard nobody version-controls. Two hard truths
    // govern it:
    //   1. `Origin` is a request header, and a non-browser client sets it
    //      to whatever it likes. This is a hotlink deterrent for browsers,
    //      NOT an access control. The capability matrix already says so.
    //   2. A plain `<video src="...">` element does NOT send `Origin` on
    //      its media requests. Refusing requests that omit `Origin` would
    //      therefore break ordinary playback, so a missing `Origin` is
    //      allowed through. Only a PRESENT and FOREIGN origin is refused.
    const originVerdict = checkOrigin(request, env);
    if (!originVerdict.allowed) {
      logDeny({ reason: 'foreign_origin', objectKey, claims: null, request });
      return errorResponse(request, env, 403, 'foreign_origin');
    }

    const token = url.searchParams.get('t');
    const verdict = await verifyGateToken({
      token,
      objectKey,
      secrets: signingSecrets(env),
      nowMs: Date.now(),
    });
    if (!verdict.ok) {
      logDeny({ reason: verdict.reason, objectKey, claims: null, request });
      return errorResponse(request, env, DENY_STATUS[verdict.reason] ?? 403, verdict.reason);
    }

    // REVOCATION BEFORE EXPIRY — the property a presigned URL cannot have.
    // The token is cryptographically valid and unexpired, and we ask
    // anyway. Because the verifier is a program Atlas controls, Atlas can
    // change the answer for a credential that is already in the wild;
    // a presign's answer was fixed at the moment it was signed.
    const revoked = await isRevoked(env, verdict.claims, ctx);
    if (revoked) {
      logDeny({ reason: DENY.REVOKED, objectKey, claims: verdict.claims, request });
      return errorResponse(request, env, DENY_STATUS[DENY.REVOKED], DENY.REVOKED);
    }

    return serveObject({ request, env, objectKey, claims: verdict.claims });
  },
};

/**
 * Streams the object out of the R2 binding, honouring `Range`.
 *
 * WHY `head()` THEN `get()` RATHER THAN ONE RANGED `get()`. R2's binding
 * will happily parse a `Range` header itself, which saves a round trip —
 * but then the exact byte arithmetic behind `Content-Range`, and the `416`
 * that a player relies on after a bad seek, are R2's behaviour rather than
 * ours, and could not be validated anywhere except against R2 itself.
 * Reading the size first means the range arithmetic lives in `gate.js`,
 * where it is the SAME code the local validation harness exercises against
 * a real S3 endpoint. The cost of that choice is one extra class-B
 * operation and one extra edge-to-R2 round trip per request; at R2's
 * class-B pricing that is fractions of a dollar per million requests, and
 * the spike's measured request volumes are in that range. If start-up
 * latency ever turns out to matter more than testable arithmetic, the
 * single-`get()` form is a three-line change — but then the range
 * behaviour must be re-validated against R2 directly.
 */
async function serveObject({ request, env, objectKey, claims }) {
  const head = await env.VIDEO_BUCKET.head(objectKey);
  if (!head) {
    // The token proves Atlas believed this object exists, so telling the
    // caller it does not is no leak — they already knew the key.
    logDeny({ reason: 'object_missing', objectKey, claims, request });
    return errorResponse(request, env, 404, 'not_found');
  }

  const size = head.size;
  const parsed = parseRangeHeader(request.headers.get('Range'), size);

  if (parsed.kind === 'invalid') {
    // A syntactically broken `Range` is a client bug. RFC 7233 allows
    // ignoring it; we refuse instead, because silently serving 200 to a
    // player that asked for a seek produces a mysterious playback bug
    // rather than a clear error in the network panel.
    return errorResponse(request, env, 400, 'invalid_range');
  }

  if (parsed.kind === 'unsatisfiable') {
    // `416` MUST carry `Content-Range: bytes */size` — that is how a
    // player discovers the real length after seeking past the end.
    const headers = baseHeaders({ request, env, head, size });
    headers.set('Content-Range', `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }

  const isPartial = parsed.kind === 'range';
  const start = isPartial ? parsed.start : 0;
  const end = isPartial ? parsed.end : Math.max(0, size - 1);
  const length = isPartial ? parsed.length : size;

  const headers = baseHeaders({ request, env, head, size });
  headers.set('Content-Length', String(length));
  if (isPartial) headers.set('Content-Range', contentRangeValue(start, end, size));

  // HEAD is answered from the metadata we already fetched: no body, no
  // second R2 operation, and identical headers to the GET that follows it.
  // Players and `curl -I` both use this to size the file before seeking.
  if (request.method === 'HEAD') {
    return new Response(null, { status: isPartial ? 206 : 200, headers });
  }

  // An empty object, or a range of length zero, must not ask R2 for a
  // zero-length read — the binding rejects `length: 0`.
  if (length === 0) {
    return new Response(null, { status: isPartial ? 206 : 200, headers });
  }

  // A whole-object read is asked for as a whole-object read, not as a
  // range covering the whole object: the two are equivalent in bytes but
  // not in what they tell R2, and an unnecessary range is one more thing
  // that can be wrong at the boundary.
  const object = await env.VIDEO_BUCKET.get(
    objectKey,
    isPartial ? { range: { offset: start, length } } : undefined,
  );
  if (!object || !object.body) {
    // Only reachable if the object was deleted between the `head` and the
    // `get`. Fail closed rather than serving a zero-length 200 that a
    // player would interpret as a corrupt file.
    return errorResponse(request, env, 404, 'not_found');
  }

  // Deliberately NOT `object.writeHttpMetadata(headers)`. That helper
  // copies the object's stored `Cache-Control` onto the response, and a
  // stored `public, max-age=...` on a protected object would hand a shared
  // cache a copy of gated bytes. Headers here are set explicitly, from a
  // known-safe set, so no value written at upload time can weaken the
  // response.
  return new Response(object.body, { status: isPartial ? 206 : 200, headers });
}

/**
 * The header set every successful response carries.
 *
 * `Cache-Control: private, no-store` is the load-bearing one, and it has a
 * cost worth stating plainly: it means the Cloudflare CDN does not hold
 * these bytes, so every request reaches the Worker and R2, and the tier's
 * "free egress behind a CDN" economics come from R2's free egress rather
 * than from cache hits. That trade is deliberate — a cached copy of a
 * gated object is a copy that outlives the credential that authorised it,
 * and the whole point of this tier is per-request authorization. The
 * caching question is revisited in the spike document (§ caching).
 */
function baseHeaders({ request, env, head, size }) {
  const headers = new Headers();
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set(
    'Content-Type',
    (head.httpMetadata && head.httpMetadata.contentType) || 'video/mp4',
  );
  // `inline`, not `attachment`: the tier reports `downloadable: false`,
  // and a download prompt is not a security control either way — but
  // `inline` at least keeps a stray click from writing the file to disk.
  headers.set('Content-Disposition', 'inline');
  // The object is immutable (its key contains the asset id), so an ETag is
  // safe to publish and useful to a player doing its own bookkeeping.
  if (head.httpEtag) headers.set('ETag', head.httpEtag);
  headers.set('X-Content-Type-Options', 'nosniff');
  // Full object size on every response, partial or not, so a client that
  // only ever issues ranged requests can still learn the length.
  headers.set('X-Atlas-Object-Size', String(size));
  applyCors(headers, request, env);
  return headers;
}

/**
 * Checks the revocation overlay.
 *
 * WHAT IS BEING REVOKED. The SESSION is the unit, because the session is
 * what Atlas's concurrent-session lease already tracks and already ends: a
 * banned user, a cancelled enrollment or a released lease all express
 * themselves as "these session ids are no longer welcome". A user-level or
 * device-level entry would be a second source of truth, and two sources of
 * truth about who is revoked is how a revocation gets missed.
 *
 * HONEST LATENCY. A KV write is visible to other locations only after
 * propagation, and a `cacheTtl` on the read trades revocation latency for
 * cost and speed. So the property this delivers is "revoked within KV
 * propagation plus `cacheTtl`", NOT "revoked in the same millisecond". The
 * instant, zero-latency kill switch is rotating `GATE_SIGNING_SECRET`,
 * which invalidates every token minted with it at once — the whole-zone
 * blast radius the investigation ascribes to the WAF-token path, kept here
 * only as an emergency lever rather than as the routine mechanism.
 *
 * FAIL MODE. If the KV read throws, `DENYLIST_FAIL_MODE` decides. The
 * default is `closed`, matching Atlas's standing rule that an authorization
 * component which cannot reach its data refuses. An operator who would
 * rather keep playback up during a KV incident can set `open` and rely on
 * the ten-minute token lifetime plus secret rotation as the backstop — but
 * that is a decision to be taken deliberately, not a default to inherit.
 */
async function isRevoked(env, claims, ctx) {
  const mode = env.REVOCATION_MODE || 'kv';
  if (mode === 'none') return false;
  if (!env.GATE_DENYLIST) {
    // Configured for KV revocation but no namespace bound. This is a
    // deployment error, and treating it as "nothing is revoked" would
    // silently downgrade the tier's headline capability.
    console.error('gate: REVOCATION_MODE=kv but GATE_DENYLIST is not bound');
    return (env.DENYLIST_FAIL_MODE || 'closed') !== 'open';
  }
  const cacheTtl = Math.max(
    KV_MIN_CACHE_TTL_SECONDS,
    Number(env.DENYLIST_CACHE_TTL_SECONDS ?? KV_MIN_CACHE_TTL_SECONDS),
  );
  try {
    const entry = await env.GATE_DENYLIST.get(`rev:s:${claims.s}`, { cacheTtl });
    return entry !== null;
  } catch (error) {
    console.error('gate: denylist read failed', error && error.message);
    if (ctx && typeof ctx.waitUntil === 'function') {
      // Nothing to await, but keep the shape: any future telemetry write
      // belongs here rather than on the request's critical path.
    }
    return (env.DENYLIST_FAIL_MODE || 'closed') !== 'open';
  }
}

/**
 * The accepted signing secrets, current first.
 *
 * Two slots rather than one so a secret can be rotated without a window in
 * which live players break: publish the new secret as `GATE_SIGNING_SECRET`
 * and move the old one to `GATE_SIGNING_SECRET_PREVIOUS`, then delete the
 * previous slot once every ten-minute token minted under it has expired.
 * An EMERGENCY rotation simply skips that courtesy and clears both.
 */
function signingSecrets(env) {
  const secrets = [];
  if (env.GATE_SIGNING_SECRET) secrets.push(env.GATE_SIGNING_SECRET);
  if (env.GATE_SIGNING_SECRET_PREVIOUS) secrets.push(env.GATE_SIGNING_SECRET_PREVIOUS);
  return secrets;
}

/**
 * Parses `ALLOWED_ORIGINS` once per isolate.
 *
 * An empty or unset list means "no origin restriction", which is the
 * correct default for a hostname that serves plain `<video>` elements: see
 * the caveat in the fetch handler about media requests omitting `Origin`.
 */
let cachedOrigins = null;
let cachedOriginsSource = null;
function allowedOrigins(env) {
  const source = env.ALLOWED_ORIGINS || '';
  if (cachedOriginsSource !== source) {
    cachedOriginsSource = source;
    cachedOrigins = source
      .split(',')
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }
  return cachedOrigins;
}

function checkOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return { allowed: true, origin: null };
  const list = allowedOrigins(env);
  if (list.length === 0) return { allowed: true, origin };
  if (list.includes(origin)) return { allowed: true, origin };
  const enforce = (env.ENFORCE_ORIGIN || 'true') !== 'false';
  return { allowed: !enforce, origin };
}

/**
 * CORS for the case a player fetches bytes with `fetch`/MSE rather than by
 * pointing a `<video>` element at the URL.
 *
 * `Access-Control-Expose-Headers` matters more than it looks: without
 * `Content-Range` and `Content-Length` exposed, a cross-origin ranged
 * fetch succeeds but the client cannot read where the bytes belong, and a
 * media-source player fails in a way that looks like a corrupt file.
 * Credentials are deliberately NOT allowed — the credential is the token
 * in the URL, and letting cookies ride along would create a second,
 * ambient credential this gate does not verify.
 */
function applyCors(headers, request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return;
  const list = allowedOrigins(env);
  if (list.length > 0 && !list.includes(origin)) return;
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, ETag');
  // The response varies by `Origin`, and saying so is required even though
  // `no-store` means no shared cache should be holding it anyway.
  headers.append('Vary', 'Origin');
}

function preflightResponse(request, env) {
  const headers = new Headers({ 'Cache-Control': 'no-store' });
  const verdict = checkOrigin(request, env);
  if (!verdict.allowed) return new Response(null, { status: 403, headers });
  applyCors(headers, request, env);
  headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Range, If-None-Match');
  headers.set('Access-Control-Max-Age', '86400');
  return new Response(null, { status: 204, headers });
}

/**
 * A refusal.
 *
 * The body is small JSON for a human debugging with `curl`; the header
 * `x-atlas-gate-deny` is what the player actually reads, because a media
 * element throws away the body of an error response. `no-store` on every
 * refusal so that a 403 can never be cached and served to a caller whose
 * token would have been fine.
 */
function errorResponse(request, env, status, reason, extraHeaders) {
  const headers = new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'x-atlas-gate-deny': reason,
  });
  if (extraHeaders) {
    for (const [name, value] of Object.entries(extraHeaders)) headers.set(name, value);
  }
  applyCors(headers, request, env);
  return new Response(JSON.stringify({ error: { code: reason } }), { status, headers });
}

/**
 * One structured line per refusal.
 *
 * THE TOKEN IS NEVER LOGGED, in whole or in part. It is a bearer
 * credential: a log line containing one is a credential sitting in a log
 * aggregator, readable by anyone with log access for as long as retention
 * lasts. Identifiers are truncated for the same reason logs elsewhere in
 * Atlas truncate them — enough to correlate an incident, not enough to
 * rebuild a user's viewing history from the log alone.
 */
function logDeny({ reason, objectKey, claims, request }) {
  console.log(
    JSON.stringify({
      at: 'video-gate',
      deny: reason,
      key: objectKey,
      user: claims ? String(claims.u).slice(0, 8) : null,
      session: claims ? String(claims.s).slice(0, 8) : null,
      method: request.method,
      ray: request.headers.get('cf-ray') || null,
    }),
  );
}
