# Atlas Normal-tier video gate — Cloudflare Worker

The edge component of the **Normal** video tier (master plan D10, DL-19). It sits on an
Atlas-owned delivery hostname in front of the protected R2 bucket, verifies the token
`BasicVideoProvider.issuePlaybackToken` minted, and — only then — streams the object out of
an **R2 binding**.

Turning the tier on (settings by name, canary, verification, rollback):
[`docs/HOSTED_VIDEO_ACTIVATION_RUNBOOK.md`](../../docs/HOSTED_VIDEO_ACTIVATION_RUNBOOK.md).

Validated locally under DL-22. The evidence, the measured numbers, and an explicit list of
what could not be validated without a real Cloudflare deployment are in
[`docs/ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md`](../../docs/ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md).

---

## What this Worker is NOT

**It is not the authorization authority. Atlas is.**

This is the single most important thing to understand before changing anything in here. By
the time a request reaches this Worker, `LessonContentService` has already checked all seven
entitlement conditions, the academy scope, the enrollment, the publication state and the
session lease (AD-1). The token in the URL is not a request for access — it is a *receipt*
for a decision Atlas already made.

The consequences are deliberate and load-bearing:

- **This Worker can only ever narrow an existing decision, never widen one.** There is no
  code path in it that grants access to anything Atlas did not already grant. If you find
  yourself adding one, you are moving authorization out of the backend, which AD-1 forbids.
- **It cannot mint a token.** The `CryptoKey` is imported with `['verify']` only, so the
  runtime itself refuses to sign. That is on purpose: a Worker that can mint credentials is
  an authorization authority sitting at the edge, outside the backend's guards and outside
  RLS.
- **It does not know who a user is.** It knows that Atlas said *some* user, session and
  device were entitled to *this* object until *this* second. It never queries the database,
  never sees a JWT, and never makes a judgement about a person — when it needs to know
  whether that is still true, it **asks Atlas** (`src/authz.js`) and Atlas decides.
- **It is not a substitute for the backend's checks.** If this Worker were removed entirely,
  no entitlement rule would change — playback would simply become unavailable. That is the
  right failure mode for an enforcement point.

Two more things it does not do, stated plainly so nobody assumes otherwise:

- **It does not stop a determined person from keeping the bytes.** A signed URL is a bearer
  credential; inside its lifetime, whoever holds it can fetch the object. The `Origin` check
  below is a browser-level hotlink deterrent, not an access control, because `Origin` is a
  request header and a non-browser client sets it to anything. Neither tier may claim
  "cannot be downloaded" or "DRM-protected" (investigation §6.1).
- **It does not transcode, package, thumbnail or caption.** One progressive 720p MP4, by
  decision (DL-19).

---

## What it does do

| | |
|---|---|
| Verifies | HMAC-SHA256 over the base64url claims, in constant time via `crypto.subtle.verify` |
| Rejects | missing token, malformed token, bad signature, malformed claims, expired `e`, `k` ≠ the key in the path, a token Atlas no longer honours (`revoked`), Atlas unreachable (`authz_unavailable`, 503), missing authz settings (`gate_misconfigured`, 503), foreign `Origin` |
| Serves | the object from an R2 **binding**, honouring `Range` → `206` + `Content-Range`, `416` on a seek past the end |
| Always sets | `Accept-Ranges: bytes`, `Content-Type`, `Cache-Control: private, no-store`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `ETag` |
| Revokes | by re-authorizing each token with Atlas (`POST /api/v1/video-gate/authorize`), answer cached ≤ 30 s per isolate — the property a presigned URL cannot have |
| Never logs | the token, in whole or in part |

Request shape, fixed by `src/media/video/basic-video.provider.ts`:

```
GET https://<deliveryHost>/v/<encodeURIComponent(objectKey)>?t=<payload>.<hex hmac>

payload = base64url(JSON.stringify({ k: objectKey, e: expUnixSeconds, u: userId, s: sessionId, d: deviceId,
                                     a: academyId, c: courseId, l: lessonId }))
```

---

## Layout

```
wrangler.toml     bindings, vars, route — the whole deployment config
package.json      { "type": "module" } and nothing else; there are no runtime dependencies
src/gate.js       the pure verifier: token verification, path→key, Range parsing
src/authz.js      revocation: the signed re-authorization call to Atlas and its bounded cache
src/index.js      the Worker: R2 binding, streaming, headers, CORS, logging
test/             `node --test` suite for all three files (no dependencies, no network)
```

`src/gate.js` is separate from `src/index.js` for one specific reason: it depends on nothing
but Web Crypto and the standard string globals, so it runs **unchanged** on both the Workers
runtime and Node 18+. That is what let the DL-22 harness test *this* verifier rather than a
second copy of it that might have drifted. Keep it that way — if `gate.js` ever needs a
Workers-only API, the local validation stops being evidence.

`package.json` declares `"type": "module"`, so that Node (and therefore the harness and
`npm test`) treats these `.js` files as ES modules. It has no dependencies and must not acquire
any: **a security boundary with a supply chain is a security boundary with somebody else's
supply chain.**

---

## Deploying

```bash
cd deploy/video-gate-worker

# 1. Run the suite (Node 18+, no install needed).
npm test

# 2. Point wrangler.toml at the real bucket and route (both are commented placeholders).
#    bucket_name  must equal the API's R2_PROTECTED_BUCKET (or "${R2_BUCKET}-protected").
#    routes       must equal the API's BASIC_VIDEO_DELIVERY_HOST.

# 3. Set the shared secrets. The first must equal the API's BASIC_VIDEO_SIGNING_SECRET,
#    the second the API's BASIC_VIDEO_GATE_AUTHZ_SECRET (a DIFFERENT value).
#    Check ATLAS_AUTHZ_URL in wrangler.toml points at the API.
npx wrangler@latest secret put GATE_SIGNING_SECRET
npx wrangler@latest secret put GATE_AUTHZ_SECRET

# 4. Ship it.
npx wrangler@latest deploy

# 5. Watch the first requests. Deny reasons arrive as one JSON line each.
npx wrangler@latest tail
```

**`GATE_SIGNING_SECRET` must equal `BASIC_VIDEO_SIGNING_SECRET` on the API**, and
**`routes` must match `BASIC_VIDEO_DELIVERY_HOST`**. Neither mismatch fails loudly: the
first produces `403 bad_signature` on every request, the second produces playback URLs that
resolve to nothing. Treat each pair as one setting that happens to be written down twice.

### Rotating the signing secret

Routine rotation, no breakage window:

```bash
npx wrangler@latest secret put GATE_SIGNING_SECRET_PREVIOUS   # the value currently in use
npx wrangler@latest secret put GATE_SIGNING_SECRET            # the new value
# ...update BASIC_VIDEO_SIGNING_SECRET on the API, then wait out the longest token
# lifetime (BASIC_VIDEO_PLAYBACK_TTL_SECONDS, default 600 s)...
npx wrangler@latest secret delete GATE_SIGNING_SECRET_PREVIOUS
```

**Emergency rotation** — a suspected secret leak — skips the courtesy: set the new secret and
do **not** populate the previous slot. Every playback URL in flight dies at once. This is the
zero-latency kill switch, and its blast radius is every viewer on the tier; revoking in
Atlas (below) is the per-learner instrument for everything short of that.

`GATE_AUTHZ_SECRET` rotates the same way on both sides, but has no previous slot: set the
new value on the API and the Worker back to back, and expect `503 authz_unavailable` for
the seconds in between (fail closed, by design).

### Revoking a viewer

There is nothing to do at the edge. Revoke in Atlas — sign the session out, remove the
device, revoke the enrollment, block the learner, delete the account — and the next
re-authorization refuses the token. `src/authz.js` caches Atlas's answer per token for at
most `AUTHZ_CACHE_TTL_SECONDS` (≤ 30), so **every new request is refused within 30 s of the
revocation**, at every edge location: there is no replication delay on top, because Atlas
answers from its own database. What the bound does not cover: a response body already
streaming at the moment of revocation is not cut off (browser players issue many short
range requests, so they stop; a single whole-object `GET` can finish).

**Why not the KV denylist this Worker used to read.** Nothing ever wrote it — Atlas held no
Cloudflare credential, and this Worker answers 405 to every POST — so it revoked nothing.
Making it work would have needed a Cloudflare API token on the API host, and would still
have been eventually consistent for *"60 seconds or more"* (no upper bound) and limited on
the free plan to 100,000 reads and 1,000 writes a day, a quota a fail-closed gate turns
into an outage. The re-authorization call needs no binding and no paid feature.

---

## Configuration

Set in `wrangler.toml` under `[vars]`; secrets via `wrangler secret put`.

| Name | Default | Meaning |
|---|---|---|
| `GATE_SIGNING_SECRET` | *(secret, required)* | Must equal the API's `BASIC_VIDEO_SIGNING_SECRET`. |
| `GATE_SIGNING_SECRET_PREVIOUS` | *(secret, optional)* | Also accepted, for zero-downtime rotation. |
| `GATE_AUTHZ_SECRET` | *(secret, required)* | Must equal the API's `BASIC_VIDEO_GATE_AUTHZ_SECRET`, and differ from `GATE_SIGNING_SECRET`. Signs the re-authorization calls. |
| `ATLAS_AUTHZ_URL` | *(required, https)* | The API's `/api/v1/video-gate/authorize`. Missing or not https → every request `503 gate_misconfigured`. |
| `AUTHZ_CACHE_TTL_SECONDS` | `30` | How long one isolate reuses Atlas's answer for one token. **This is the revocation bound.** Clamped to [0, 30]: it can be shortened (0 = ask on every request), never lengthened. |
| `AUTHZ_TIMEOUT_MS` | `3000` | How long one call to Atlas may take before the request is refused (503). |
| `ALLOWED_ORIGINS` | `""` | Comma-separated browser origins. Empty means no origin restriction. |
| `ENFORCE_ORIGIN` | `true` | Whether a present-but-foreign `Origin` is refused, or merely not given CORS headers. |

### Failure policy: fail closed, no exceptions

If Atlas cannot be asked — network error, timeout, any non-200 (including `401` from a
secret mismatch and `429` from the API's rate limit), an unparseable answer — the request is
refused `503 authz_unavailable`, **nothing is cached**, and the next request asks again. The
only requests served without a fresh answer are those still inside a positive answer's
≤ 30 s window, which is the revocation bound itself. There is no stale-while-revalidate, no
grace period and deliberately no fail-open setting: the old `DENYLIST_FAIL_MODE=open` option
is gone with the denylist. An Atlas outage is therefore a playback outage for the tier
within 30 s — the same rule every other Atlas authorization component follows.

### The `Origin` check, honestly

Two things make this a deterrent rather than a control, and both are already acknowledged in
the capability matrix:

1. `Origin` is a request header. `ffmpeg -headers` and `yt-dlp` set it to whatever they like.
2. **A plain `<video src="…">` element sends no `Origin` at all.** Refusing requests that omit
   it would break ordinary playback, so a missing `Origin` is allowed through. Only a
   *present and foreign* origin is refused.

Note also that Cloudflare's built-in **Hotlink Protection is images only** (`gif`, `ico`,
`jpg`, `jpeg`, `png`) and will not protect an MP4 — if you want a zone-level rule in addition
to this one, it has to be a WAF custom rule.

---

## Caching — read this before "optimising" it

Every successful response carries `Cache-Control: private, no-store`, and Cloudflare
documents that it does not cache a response with that header. That is not an oversight. It
means **every request reaches the Worker and R2**, which is exactly what per-request
authorization requires: a cached copy of a gated object is a copy that outlives the
credential that authorised it.

The tier is still cheap, because the saving comes from R2's free egress, not from cache hits.

If someone later proposes caching these bytes, the things they need to know first:

- Cloudflare does **not** automatically cache a `Response` a Worker built from an R2 binding;
  it would have to be put into the Cache API explicitly, and that cache is **per data centre**,
  not global.
- `cache.put()` **throws** on a `206`. Only the full `200` can be cached, and the cache then
  slices ranges out of it.
- The default cache key includes the query string, and the token lives in the query string,
  so every viewer would miss. "Ignore query string" is available on all plans through Cache
  Rules — but switching it on means the cached object is keyed *without* the credential,
  which is the whole security question in one sentence.

---

## Local validation

`npm test` (or `node --test test/*.test.js`, Node 18+, also a Backend CI step) runs **this
exact source** under Node's built-in test runner, with an in-memory R2-shaped binding and a
stub Atlas that verifies the Worker's HMAC exactly as the API does. It covers: a valid token
plays (200 and 206); expired tokens; revoked session, device and account refused within the
30 s bound and at every request after (time simulated); cross-course and cross-academy reuse
and claim tampering; Atlas unreachable, erroring or hanging → `503`, nothing cached;
no stale authorization after an answer's window closes; a mismatched authorization secret;
missing settings; the cache's size and time bounds; concurrent range requests sharing one
call; and that the token is never logged.

The API side of the same contract is `test/video-gate-authorization.e2e-spec.ts` (real
Postgres with RLS). The original DL-22 harness (MinIO-backed range/streaming measurements)
lives with the spike document; re-run it after any change to `gate.js`, and after bumping
`compatibility_date`.

**Not verifiable locally:** the real `workerd` isolate lifecycle (how long a module-scope
cache lives), real R2 binding semantics, real egress latency from an edge location to the
API, and Cloudflare's handling of a same-zone subrequest. These are first-deployment checks
in `docs/HOSTED_VIDEO_ACTIVATION_RUNBOOK.md` §4.6.
