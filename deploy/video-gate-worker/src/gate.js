/**
 * `gate.js` — the pure verification core of the Atlas Normal-tier video gate.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE WORKER ENTRY POINT. Everything in
 * here depends on nothing but the Web Crypto API and the standard string
 * globals, which means it runs unchanged on the Cloudflare Workers runtime
 * AND on Node 18+. That is not tidiness for its own sake: it is the only
 * way a local harness can honestly claim to be testing "the Worker's
 * verifier" rather than a re-implementation of it that might have drifted.
 * `deploy/video-gate-worker/src/index.js` imports this file; so does the
 * validation harness used for the DL-22 spike. One source, two runtimes,
 * no second copy of the security-critical code to keep in sync.
 *
 * WHAT IT VERIFIES, AND WHAT IT DELIBERATELY DOES NOT. This module answers
 * exactly one question: "did Atlas mint this credential, for this object,
 * and is it still inside its own stated lifetime?" It does NOT decide
 * whether a person may watch a lesson. That decision belongs to
 * `LessonContentService`, which checked all seven entitlement conditions
 * before `BasicVideoProvider.issuePlaybackToken` was ever called (AD-1).
 * The gate enforces a decision Atlas already made; it never makes one.
 *
 * THE TOKEN FORMAT is fixed by `src/media/video/basic-video.provider.ts`
 * and must not be changed here unilaterally:
 *
 *     token   = base64url(JSON.stringify(claims)) + "." + hex(HMAC-SHA256(payload, secret))
 *     claims  = { k: objectKey, e: expUnixSeconds, u: userId, s: sessionId, d: deviceId }
 *
 * The HMAC is computed over the base64url PAYLOAD TEXT, not over the raw
 * JSON — that matters, because it means the verifier never has to
 * re-serialise the claims to check the signature, and therefore no JSON
 * key-ordering or unicode-escaping difference between Node and the Workers
 * runtime can turn a valid token into an invalid one.
 */

/**
 * Every reason this module can refuse a request.
 *
 * Refusal reasons are a closed, named set rather than ad-hoc strings so the
 * Worker's logs can be aggregated ("how many key mismatches this hour?")
 * and so the spike's evidence table can cite a reason code rather than a
 * message that someone might later reword.
 *
 * These strings are safe to return to the client. None of them reveals
 * anything the caller did not already supply: a caller who sent a bad
 * signature already knows they sent a signature.
 */
export const DENY = Object.freeze({
  MISSING_TOKEN: 'missing_token',
  MALFORMED_TOKEN: 'malformed_token',
  BAD_SIGNATURE: 'bad_signature',
  MALFORMED_CLAIMS: 'malformed_claims',
  EXPIRED: 'expired',
  KEY_MISMATCH: 'key_mismatch',
  REVOKED: 'revoked',
});

/**
 * The longest token this gate will even look at.
 *
 * A signature check on a multi-megabyte query string is free CPU for an
 * attacker and metered CPU for Atlas — Workers bills CPU time, so an
 * unbounded input is a cost-amplification vector, not just a performance
 * question. Real tokens are ~250 bytes; 4 KiB is an order of magnitude of
 * headroom and still small enough that rejecting oversize input costs
 * nothing.
 */
const MAX_TOKEN_BYTES = 4096;

/** HMAC-SHA256 hex digests are always exactly this long. Anything else is not a signature. */
const HEX_SHA256_LENGTH = 64;

/**
 * Per-isolate cache of imported HMAC keys.
 *
 * `crypto.subtle.importKey` is not free, and a Worker isolate serves many
 * requests, so importing the signing key once per isolate rather than once
 * per request is the single largest CPU saving available in this codepath —
 * directly relevant to DL-22's "Worker request volume and cost" question,
 * because Workers charges for CPU milliseconds.
 *
 * The cache is keyed by the secret's own text. That is safe: the map lives
 * inside one isolate's memory, is never serialised, and an isolate only
 * ever sees the secrets bound to this Worker. It also means a secret
 * rotation naturally produces a new entry rather than silently reusing the
 * old key material.
 */
const hmacKeyCache = new Map();

/**
 * Imports (or returns the cached) HMAC-SHA256 verification key.
 *
 * `verify` is the only usage requested. The Worker must never be able to
 * MINT a token — only Atlas may do that — and restricting the `CryptoKey`
 * to `['verify']` makes that a runtime guarantee rather than a convention.
 * If a future edit to this Worker ever tries to sign something, Web Crypto
 * will throw instead of quietly producing a credential from the edge.
 */
async function importVerifyKey(secret) {
  const cached = hmacKeyCache.get(secret);
  if (cached) return cached;
  const promise = crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  // The PROMISE is cached, not the resolved key: two concurrent requests
  // arriving on a cold isolate would otherwise both import the same key.
  hmacKeyCache.set(secret, promise);
  return promise;
}

/**
 * Decodes a lowercase hex string to bytes, or returns null.
 *
 * Deliberately strict — no uppercase, no `0x`, no whitespace, no odd
 * length. A lenient decoder here would mean two different strings verify
 * as the same signature, which is exactly the kind of "harmless"
 * flexibility that turns into a signature-confusion bug. Atlas emits
 * `digest('hex')`, which is always lowercase, so strictness costs nothing.
 */
function hexToBytes(hex) {
  if (hex.length !== HEX_SHA256_LENGTH) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const hi = hexNibble(hex.charCodeAt(i * 2));
    const lo = hexNibble(hex.charCodeAt(i * 2 + 1));
    if (hi < 0 || lo < 0) return null;
    out[i] = (hi << 4) | lo;
  }
  return out;
}

function hexNibble(code) {
  if (code >= 48 && code <= 57) return code - 48; // 0-9
  if (code >= 97 && code <= 102) return code - 87; // a-f
  return -1;
}

/**
 * base64url → UTF-8 string, or null on anything malformed.
 *
 * Runs only AFTER the signature has been verified. That ordering is the
 * point: this function parses attacker-supplied bytes, and it is only ever
 * handed bytes Atlas has already vouched for. Decoding before
 * authenticating would hand an unauthenticated caller the JSON parser.
 */
function base64UrlToString(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    // `fatal: true` so an invalid UTF-8 sequence is a refusal rather than a
    // string full of replacement characters that might still parse as JSON.
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Verifies a gate token against one or more accepted signing secrets.
 *
 * ORDER OF CHECKS IS SECURITY-RELEVANT and is the same order
 * `BasicVideoProvider.verifyGateToken` uses:
 *
 *   1. shape and size  — cheap, and bounds the CPU an attacker can spend;
 *   2. signature       — nothing downstream may look at unauthenticated data;
 *   3. claims shape    — a signed token with nonsense claims is a bug on
 *                        Atlas's side, and must fail loudly rather than
 *                        being coerced into something plausible;
 *   4. expiry          — `<=` exactly as the backend does it, so a token is
 *                        never accepted here one millisecond after Atlas
 *                        would have rejected it;
 *   5. object binding  — the signed `k` must equal the key actually asked
 *                        for, which is what stops a valid token for lesson
 *                        A from fetching lesson B.
 *
 * CONSTANT-TIME COMPARISON. The signature is compared with
 * `crypto.subtle.verify`, not by comparing two strings. Web Crypto's
 * `verify` is specified to do the comparison itself, so there is no
 * byte-at-a-time early exit for an attacker to time, and — unlike Node's
 * `timingSafeEqual` — it cannot throw on a length mismatch and turn an
 * attacker-controlled input into a 500. The Workers runtime also exposes a
 * non-standard `crypto.subtle.timingSafeEqual`, which is deliberately NOT
 * used here: it does not exist in Node, and using it would break the "one
 * verifier, two runtimes" property that makes local validation meaningful.
 *
 * @param {object} args
 * @param {string | null | undefined} args.token     Raw `t` query parameter.
 * @param {string} args.objectKey                    Key derived from the request path.
 * @param {readonly string[]} args.secrets           Accepted signing secrets, current first.
 * @param {number} args.nowMs                        Verification instant, ms since epoch.
 * @returns {Promise<{ ok: true, claims: object, secretIndex: number } | { ok: false, reason: string }>}
 */
export async function verifyGateToken({ token, objectKey, secrets, nowMs }) {
  if (!token) return { ok: false, reason: DENY.MISSING_TOKEN };
  if (token.length > MAX_TOKEN_BYTES) return { ok: false, reason: DENY.MALFORMED_TOKEN };

  // `split('.')` with a length check rather than `indexOf`: a token with a
  // second dot in it is malformed, and accepting it would mean two
  // different strings could be treated as the same credential.
  const parts = token.split('.');
  if (parts.length !== 2) return { ok: false, reason: DENY.MALFORMED_TOKEN };
  const [payload, signature] = parts;
  if (!payload || !signature) return { ok: false, reason: DENY.MALFORMED_TOKEN };

  const signatureBytes = hexToBytes(signature);
  // The length and charset of a hex digest are public constants, not
  // secrets, so rejecting on them early leaks nothing an attacker could
  // not compute from the algorithm name.
  if (!signatureBytes) return { ok: false, reason: DENY.MALFORMED_TOKEN };

  const payloadBytes = new TextEncoder().encode(payload);
  let matchedSecret = -1;
  for (let i = 0; i < secrets.length; i += 1) {
    const key = await importVerifyKey(secrets[i]);
    // Iterating over accepted secrets leaks (by timing) only WHICH of the
    // operator's own keys matched — never any byte of a key, and never
    // anything about a signature that did not match. This loop is what
    // makes a zero-downtime secret rotation possible: publish the new
    // secret as current and keep the old one as previous until every
    // in-flight ten-minute token has expired.
    if (await crypto.subtle.verify('HMAC', key, signatureBytes, payloadBytes)) {
      matchedSecret = i;
      break;
    }
  }
  if (matchedSecret < 0) return { ok: false, reason: DENY.BAD_SIGNATURE };

  const json = base64UrlToString(payload);
  if (json === null) return { ok: false, reason: DENY.MALFORMED_CLAIMS };

  let claims;
  try {
    claims = JSON.parse(json);
  } catch {
    return { ok: false, reason: DENY.MALFORMED_CLAIMS };
  }
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    return { ok: false, reason: DENY.MALFORMED_CLAIMS };
  }

  // Every claim is required. A token missing `s` or `d` is not a
  // "partially bound" credential to be accepted with reduced confidence —
  // it is a token this system did not mint, and the honest answer is no.
  if (
    typeof claims.k !== 'string' ||
    claims.k.length === 0 ||
    typeof claims.u !== 'string' ||
    claims.u.length === 0 ||
    typeof claims.s !== 'string' ||
    claims.s.length === 0 ||
    typeof claims.d !== 'string' ||
    claims.d.length === 0 ||
    typeof claims.e !== 'number' ||
    !Number.isFinite(claims.e)
  ) {
    return { ok: false, reason: DENY.MALFORMED_CLAIMS };
  }

  // `<=`, matching `BasicVideoProvider.verifyGateToken` exactly. On the
  // Workers runtime `Date.now()` does not advance during synchronous
  // execution (the clock moves only on I/O), which is irrelevant to a
  // second-granularity expiry but worth knowing before anyone tries to
  // measure elapsed time inside this function.
  if (claims.e * 1000 <= nowMs) return { ok: false, reason: DENY.EXPIRED };

  // The binding that makes one token unusable for another object. Both
  // sides are non-secret (the caller supplied the path; the claim is
  // readable by anyone holding the token), so a plain comparison is
  // correct — there is no secret here whose timing could leak.
  if (claims.k !== objectKey) return { ok: false, reason: DENY.KEY_MISMATCH };

  return { ok: true, claims, secretIndex: matchedSecret };
}

/**
 * Extracts the R2 object key from a request path.
 *
 * `BasicVideoProvider` builds `/v/${encodeURIComponent(key)}`, so the key
 * arrives as ONE path segment with its slashes percent-encoded. Cloudflare
 * applies incoming-URL normalisation to a zone by default, and while RFC
 * 3986 normalisation only decodes *unreserved* characters — `%2F` is
 * reserved, so it should survive — this function is written so that BOTH
 * forms produce the same key:
 *
 *   /v/academies%2FA%2Fx.mp4   →  academies/A/x.mp4
 *   /v/academies/A/x.mp4       →  academies/A/x.mp4
 *
 * because `decodeURIComponent` of an already-decoded path is a no-op. The
 * gate therefore cannot be broken by an edge-normalisation setting, which
 * removes an entire class of "works locally, 404s in production" failure.
 * The one constraint this creates is that an object key must not contain a
 * literal `%`; Atlas keys are `academies/<uuid>/courses/<uuid>/<id>.mp4`,
 * so that constraint is already satisfied by construction.
 *
 * @returns {string | null} the decoded key, or null if the path is not a playback path.
 */
export function objectKeyFromPathname(pathname) {
  if (!pathname.startsWith('/v/')) return null;
  const raw = pathname.slice('/v/'.length);
  if (raw.length === 0) return null;
  let key;
  try {
    key = decodeURIComponent(raw);
  } catch {
    // A malformed percent-sequence throws `URIError`. An attacker must not
    // be able to turn a crafted path into an unhandled exception.
    return null;
  }
  // Defence in depth only: the signed claim `k` is the real authority, and
  // a key that does not equal `k` is refused a few lines later regardless.
  // These checks exist so that a malformed key never reaches the R2
  // binding at all, and so that this function can be reused by anything
  // that does not have a signed claim to compare against.
  if (key.length === 0 || key.length > 1024) return null;
  if (key.startsWith('/') || key.includes('//')) return null;
  if (key.includes('..')) return null;
  if (key.includes('\\')) return null;
  // eslint-disable-next-line no-control-regex
  if (/[ -]/.test(key)) return null;
  return key;
}

/**
 * Parses a single-range `Range` header against a known object size.
 *
 * WHY THIS MATTERS ENOUGH TO HAND-ROLL. Progressive MP4 playback IS range
 * requests: the browser opens the file, reads the `moov` atom, then seeks
 * by asking for byte ranges. A gate that mishandles `Range` does not
 * degrade gracefully — scrubbing simply stops working, and on some
 * browsers playback never starts. The Backblaze finding in §4.1 of the
 * tiers investigation (a `200` where a `206` was required) is exactly this
 * failure mode observed in the wild.
 *
 * Supported forms, all of RFC 7233 that a media element actually emits:
 *   bytes=500-999   explicit range
 *   bytes=500-      open-ended, the common seek
 *   bytes=-1024     suffix, used to find the `moov` atom in a badly muxed file
 *
 * A MULTI-RANGE request returns `kind: 'unsupported'` and the caller
 * serves the whole object with `200`. RFC 7233 explicitly permits ignoring
 * a `Range` header, and `multipart/byteranges` is not something a browser
 * media element ever asks R2 for. Implementing it would add a multipart
 * encoder to a security boundary for no player that exists.
 *
 * @returns {{kind:'none'} | {kind:'unsupported'} | {kind:'invalid'} |
 *           {kind:'unsatisfiable'} | {kind:'range', start:number, end:number, length:number}}
 */
export function parseRangeHeader(headerValue, size) {
  if (!headerValue) return { kind: 'none' };
  const match = /^bytes=(.*)$/i.exec(headerValue.trim());
  // A `Range` unit this server does not understand must be IGNORED (serve
  // 200), not rejected — RFC 7233 §3.1. Rejecting would break any client
  // that invents a unit.
  if (!match) return { kind: 'unsupported' };
  const spec = match[1].trim();
  if (spec.includes(',')) return { kind: 'unsupported' };

  const bounds = /^(\d*)-(\d*)$/.exec(spec);
  if (!bounds) return { kind: 'invalid' };
  const [, startText, endText] = bounds;
  if (startText === '' && endText === '') return { kind: 'invalid' };

  // A zero-byte object can satisfy no range at all; say so rather than
  // computing a negative length.
  if (size <= 0) return { kind: 'unsatisfiable' };

  let start;
  let end;
  if (startText === '') {
    // Suffix form: the LAST n bytes. `bytes=-0` is meaningless and
    // unsatisfiable; a suffix longer than the object means the whole object.
    const suffix = Number(endText);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { kind: 'unsatisfiable' };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    if (!Number.isSafeInteger(start)) return { kind: 'invalid' };
    // A start at or past the end of the object is the one case that must
    // produce `416` with `Content-Range: bytes */size`; players rely on
    // that response to discover the true length after a bad seek.
    if (start >= size) return { kind: 'unsatisfiable' };
    if (endText === '') {
      end = size - 1;
    } else {
      end = Number(endText);
      if (!Number.isSafeInteger(end)) return { kind: 'invalid' };
      if (end < start) return { kind: 'invalid' };
      // Clamping rather than refusing: a client asking for more than exists
      // gets what exists, which is what every CDN and every origin does.
      if (end > size - 1) end = size - 1;
    }
  }

  return { kind: 'range', start, end, length: end - start + 1 };
}

/**
 * The `Content-Range` value for a satisfied partial response.
 *
 * Trivial, but centralised because an off-by-one here is invisible in
 * testing and catastrophic in playback: the browser trusts this header to
 * decide where the bytes it just received belong in the file.
 */
export function contentRangeValue(start, end, size) {
  return `bytes ${start}-${end}/${size}`;
}
