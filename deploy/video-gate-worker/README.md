# Atlas Normal-tier video gate — Cloudflare Worker

The edge component of the **Normal** video tier (master plan D10, DL-19). It sits on an
Atlas-owned delivery hostname in front of the protected R2 bucket, verifies the token
`BasicVideoProvider.issuePlaybackToken` minted, and — only then — streams the object out of
an **R2 binding**.

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
  never sees a JWT, and never makes a judgement about a person.
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
| Rejects | missing token, malformed token, bad signature, malformed claims, expired `e`, `k` ≠ the key in the path, revoked session, foreign `Origin` |
| Serves | the object from an R2 **binding**, honouring `Range` → `206` + `Content-Range`, `416` on a seek past the end |
| Always sets | `Accept-Ranges: bytes`, `Content-Type`, `Cache-Control: private, no-store`, `Content-Disposition: inline`, `X-Content-Type-Options: nosniff`, `ETag` |
| Revokes | per request, against a KV denylist keyed by session id — the property a presigned URL cannot have |
| Never logs | the token, in whole or in part |

Request shape, fixed by `src/media/video/basic-video.provider.ts`:

```
GET https://<deliveryHost>/v/<encodeURIComponent(objectKey)>?t=<payload>.<hex hmac>

payload = base64url(JSON.stringify({ k: objectKey, e: expUnixSeconds, u: userId, s: sessionId, d: deviceId }))
```

---

## Layout

```
wrangler.toml     bindings, vars, route — the whole deployment config
package.json      { "type": "module" } and nothing else; there are no runtime dependencies
src/gate.js       the pure verifier: token verification, path→key, Range parsing
src/index.js      the Worker: R2 binding, streaming, headers, CORS, revocation, logging
```

`src/gate.js` is separate from `src/index.js` for one specific reason: it depends on nothing
but Web Crypto and the standard string globals, so it runs **unchanged** on both the Workers
runtime and Node 18+. That is what let the DL-22 harness test *this* verifier rather than a
second copy of it that might have drifted. Keep it that way — if `gate.js` ever needs a
Workers-only API, the local validation stops being evidence.

`package.json` exists only to declare `"type": "module"`, so that Node (and therefore the
harness) treats these `.js` files as ES modules. It has no dependencies and must not acquire
any: **a security boundary with a supply chain is a security boundary with somebody else's
supply chain.**

---

## Deploying

```bash
cd deploy/video-gate-worker

# 1. Create the revocation namespace and paste the ids into wrangler.toml.
npx wrangler@latest kv namespace create GATE_DENYLIST
npx wrangler@latest kv namespace create GATE_DENYLIST --preview

# 2. Point wrangler.toml at the real bucket and route (both are commented placeholders).
#    bucket_name  must equal the API's R2_PROTECTED_BUCKET (or "${R2_BUCKET}-protected").
#    routes       must equal the API's BASIC_VIDEO_DELIVERY_HOST.

# 3. Set the shared secret. It must equal the API's BASIC_VIDEO_SIGNING_SECRET.
npx wrangler@latest secret put GATE_SIGNING_SECRET

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
zero-latency kill switch, and its blast radius is every viewer on the tier; the KV denylist
is the per-session instrument for everything short of that.

### Revoking a session

```bash
npx wrangler@latest kv key put --binding GATE_DENYLIST "rev:s:<sessionId>" 1 --ttl 600
```

The value is ignored; presence is the signal. The `--ttl` matches the longest token lifetime,
so the list stays small on its own — after that every token naming the session has expired
anyway and the entry has nothing left to revoke.

**Honest latency.** Cloudflare documents KV writes as taking *"up to 60 seconds or more to be
visible in other global network locations"*, and `DENYLIST_CACHE_TTL_SECONDS` (minimum 30)
adds a colo-local cache on top. So the property is **"revoked within KV propagation plus the
cache TTL"** — not "revoked in the same millisecond". Anyone quoting a revocation SLA to a
customer needs that sentence, not the one in the capability matrix.

---

## Configuration

Set in `wrangler.toml` under `[vars]`; secrets via `wrangler secret put`.

| Name | Default | Meaning |
|---|---|---|
| `GATE_SIGNING_SECRET` | *(secret, required)* | Must equal the API's `BASIC_VIDEO_SIGNING_SECRET`. |
| `GATE_SIGNING_SECRET_PREVIOUS` | *(secret, optional)* | Also accepted, for zero-downtime rotation. |
| `REVOCATION_MODE` | `kv` | `kv` checks the denylist per request. `none` forfeits `revocableBeforeExpiry`, which `capabilities()` advertises as true — do not ship it. |
| `DENYLIST_CACHE_TTL_SECONDS` | `30` | Colo-local cache on the denylist read. This *is* the revocation latency budget. 30 is Cloudflare's documented minimum. |
| `DENYLIST_FAIL_MODE` | `closed` | What to do when the denylist cannot be read. See below. |
| `ALLOWED_ORIGINS` | `""` | Comma-separated browser origins. Empty means no origin restriction. |
| `ENFORCE_ORIGIN` | `true` | Whether a present-but-foreign `Origin` is refused, or merely not given CORS headers. |

### `DENYLIST_FAIL_MODE`, and why it is a real decision

- **`closed`** (default) — a KV read failure refuses the request. Consistent with Atlas's
  standing rule that an authorization component which cannot reach its data says no. The cost
  is that a KV incident becomes a total playback outage for the tier.
- **`open`** — playback survives the incident; a revoked learner keeps watching for at most
  the remaining token lifetime (≤ 10 minutes), and signing-secret rotation remains available
  as the backstop.

The default is `closed` because a default should be the conservative one. If you switch it,
record it as a deliberate availability-over-strictness decision, not as a config tweak.

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

There is no test suite in this directory, by design: the Worker's behaviour was validated by
running **this exact source** under Node, backed by the local MinIO container over the real S3
protocol. The harness, the transcripts and the numbers live with the spike document. Re-run it
after any change to `gate.js`, and after bumping `compatibility_date`.
