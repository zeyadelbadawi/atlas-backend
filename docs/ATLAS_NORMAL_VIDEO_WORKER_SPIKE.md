# Atlas — Normal-Tier Video Worker Validation Spike (DL-22)

**Status:** Validation spike complete. A reference Worker exists and is deployable; **nothing has been deployed to Cloudflare**, and no application source was changed.
**Date:** 19 September 2026
**Trigger:** DL-22 — *"Normal-tier Worker validation spike is mandatory before the Normal architecture is production-ready. The presigned-GET probe already run is explicitly insufficient to prove the Worker path."*
**Scope:** Master plan Phase 2 §S. Establish empirically: per-request authorization, session binding, revocation before expiry, HLS/segment behaviour if HLS were used, caching behaviour, realistic concurrency, Worker request volume and cost at realistic segment counts, hotlink behaviour, failure behaviour, expiry behaviour.

**Artefacts produced**

| Path | What it is |
|---|---|
| `deploy/video-gate-worker/src/gate.js` | The verifier: token verification, path→key extraction, `Range` parsing. Runtime-agnostic. |
| `deploy/video-gate-worker/src/index.js` | The Worker: R2 binding, streaming, headers, CORS, revocation, logging. |
| `deploy/video-gate-worker/wrangler.toml` | Bindings, vars, route, secret instructions. |
| `deploy/video-gate-worker/package.json` | `{"type":"module"}` and nothing else. Zero runtime dependencies. |
| `deploy/video-gate-worker/README.md` | Deployment, rotation, revocation, and what the Worker is **not**. |

---

## 1. Executive summary

**The architecture is sound, and the claim DL-22 was written to test is true — with one wording correction and one structural gap.**

Every security property `BasicVideoProvider.capabilities()` advertises for the Normal tier was exercised against real HMAC-SHA256 and the real S3 protocol, and every one behaved as claimed. The decisive result is the **control experiment**: at the moment a revocation rule changed, a gate token with **600 seconds of life remaining** stopped working, while a presigned URL for *the same object*, minted at the same time, kept returning `206`. That is the property §4.3 of the tiers investigation says a presign cannot have, and it is now demonstrated rather than asserted.

Five things came out of the spike that were not known going in.

**(1) The token format cannot express an HLS asset.** The claim `k` is a single exact object key and the gate enforces exact equality. HLS means many keys per asset (a playlist plus hundreds of segments), so the Normal tier as currently specified is *structurally* progressive-MP4-only. Supporting HLS later is not a Worker change — it is a **token-format change in `basic-video.provider.ts`** (`k` would have to become a prefix, with prefix containment replacing equality). §6.

**(2) "Bound to session, at the edge" is true only in a specific sense, and the capability matrix should say which.** The gate proves the token *names* a session unforgeably, and refuses any request whose named session has been revoked. It does **not** prove the caller *is* that session. The same token was accepted from three unrelated HTTP clients, including one presenting a `yt-dlp` user agent and a forged `Referer`. This is still strictly stronger than Stream — where the session name is not actionable at the edge at all (defect D-5) — but it is enforcement-by-name, not proof-of-possession. §4.2.

**(3) `Cache-Control: private, no-store` means the CDN cache contributes nothing, and that is correct.** Cloudflare documents that it does not cache a response carrying that header, so every request reaches the Worker and R2. The tier is cheap because R2 egress is free, **not** because of cache hits. Anyone who later proposes caching these bytes is proposing to keep a copy of a gated object that outlives the credential which authorised it. §7.

**(4) The investigation's cache-key caveat is partly out of date.** §4.3 says a query-string token "defeats the default cache key; the fix is Enterprise-only". The token does defeat the default cache key — the query string is in it — but **"Ignore query string" is available on all plans** through Cache Rules; only fine-grained custom cache keys (named params, headers, cookie, host) remain Enterprise. §7.

**(5) Cloudflare's built-in Hotlink Protection will not protect video.** It is documented as applying to `gif`, `ico`, `jpg`, `jpeg` and `png` only. An MP4 hotlink rule must be a WAF custom rule (available on all plans) or, as implemented here, an `Origin` check inside the Worker — with the honest caveat that `Origin` is forgeable and that a plain `<video src>` element sends none at all. §10.

**Cost is confirmed, and now the Worker request volume behind it is quantified.** At the Enterprise quota the Worker path costs **≈ $6.41/month** — $5.00 Workers Paid + $1.41 R2 storage + $0 egress + $0 in operations, all of it inside Cloudflare's included allowances. The investigation's §5.1 figure of $8.35 is confirmed as the right order of magnitude and slightly conservative. Even the most pessimistic HLS scenario modelled (2-second segments, 4.53M Worker requests/month) stays inside the 10M requests included in the $5 plan. §9.

**The verdict and the first-deployment checklist are in §14.**

---

## 2. Method, and the limits of the method

### 2.1 What was actually run

A Node HTTP server that calls the **real Worker module** — `deploy/video-gate-worker/src/index.js`, unmodified, imported as an ES module — with a Web `Request` built from each incoming request, streaming its `Response` back out. Tokens were minted by the **real provider**: the compiled `dist/media/video/basic-video.provider.js` instantiated with a stub `ConfigService`, so the credential under test is produced by the same code the API runs.

Nothing in the security path is a re-implementation. The verifier that ran locally is the verifier that will run at the edge, byte for byte; that is the entire reason `gate.js` is written against Web Crypto and the standard string globals only.

**Fixture.** A real 60-second 1280×720 H.264/AAC progressive MP4 with `+faststart`, **1,391,751 bytes**, `sha256 fa2d6acc…67a73`, stored in the local MinIO protected bucket `atlas-media-dev-protected` at a real Atlas key shape:

```
academies/3f1c9d2a-7b64-4e51-9a0d-8c25ee41b7aa/courses/9b7e4c10-52af-4d83-8a61-0f3d6c92e4b5/d41f6b28-1c0a-4f77-93e5-6ab8f0c4d312.mp4
```

Harness scripts live outside the repository, in the session scratchpad, as required.

### 2.2 What is emulated — and therefore what no local number proves

| Emulated | Consequence for the evidence |
|---|---|
| R2 binding → an adapter over the **real S3 protocol** against MinIO (`HeadObject` + ranged `GetObject`) | Range/`Content-Range`/416 semantics are validated against a real S3 implementation. R2's own binding semantics are **NOT VERIFIED**. |
| KV denylist → an in-process `Map` | Revocation *logic* is validated. Revocation *latency* is **NOT VERIFIED**: the emulator is instant; Cloudflare documents KV writes taking "up to 60 seconds or more" to propagate. |
| `Request`/`Response`/`crypto.subtle` → Node 20 (undici + Node WebCrypto) | Verification *correctness* is validated. `workerd` CPU cost is **NOT VERIFIED**. |
| No CDN, no colo, no WAF, no CPU metering | Everything about cache behaviour, edge capacity, WAF and real billing is **NOT VERIFIED** and is cited from official Cloudflare documentation instead, or marked UNKNOWN. |

**A local Node server is not a Cloudflare Worker.** Every number below is labelled with which of the two produced it. Where a claim rests on Cloudflare's behaviour rather than on a measurement, the official source is cited inline and was read on 19 September 2026.

---

## 3. Results table — what was measured

All rows are **LOCAL VERIFIED** unless stated. Observed output is quoted from the run, not paraphrased.

| # | Test | Observed | Verdict |
|---|---|---|---|
| a | Valid token, full object | `HTTP 200`, `content-length: 1391751`, `content-type: video/mp4`, `accept-ranges: bytes`, `cache-control: private, no-store`, `etag: "d5f0868…c4ce"`. Returned `sha256 fa2d6acc…67a73` — **byte-identical** to the source file | PASS |
| b | `Range: bytes=500000-500099` | `HTTP 206`, `content-range: bytes 500000-500099/1391751`, `content-length: 100`, bytes match the source slice exactly | PASS |
| b | `Range: bytes=0-1023` (moov read) | `206`, `bytes 0-1023/1391751`, slice-exact | PASS |
| b | `Range: bytes=1387655-` (open-ended) | `206`, `bytes 1387655-1391750/1391751`, 4,096 bytes, slice-exact | PASS |
| b | `Range: bytes=-1024` (suffix) | `206`, `bytes 1390727-1391750/1391751`, slice-exact | PASS |
| b | `Range: bytes=0-0` | `206`, `bytes 0-0/1391751`, 1 byte | PASS |
| b | `Range: bytes=1391751-` (past end) | `HTTP 416`, `content-range: bytes */1391751` | PASS |
| b | `Range: bytes=abc-def` | `HTTP 400`, `x-atlas-gate-deny: invalid_range` | PASS |
| b | `Range: bytes=0-99,200-299` (multi) | `HTTP 200`, full object — ignored per RFC 7233 §3.1 | PASS (by design) |
| c | One hex char of the signature changed | `HTTP 403`, `x-atlas-gate-deny: bad_signature` | PASS |
| c | Claims rewritten, `e` extended by 24 h, old signature kept | `HTTP 403`, `bad_signature` | PASS |
| c | Non-hex signature | `HTTP 403`, `malformed_token` | PASS |
| d | Valid token, path swapped to **another object that exists** | `HTTP 403`, `key_mismatch` | PASS |
| d | Valid token, path swapped to another **academy's** key | `HTTP 403`, `key_mismatch` | PASS |
| d | `…%2F..%2F..%2Fetc%2Fpasswd` | `HTTP 404`, `not_found` (rejected before storage) | PASS |
| e | Backdated token (`e` 8 s in the past) | `HTTP 403`, `expired` | PASS |
| e | 2-second token, before expiry | `HTTP 206` | PASS |
| e | Same token, 2.6 s later | `HTTP 403`, `expired` | PASS |
| f | **Revocation**: token with **600 s of life left**, before | `HTTP 206`, 65,536 bytes | — |
| f | Same token, after one denylist write | `HTTP 403`, `x-atlas-gate-deny: revoked` | **PASS — the headline result** |
| f | Same token, after the denylist entry is removed | `HTTP 206` again | PASS |
| f | Same token, after signing-secret rotation | `HTTP 403`, `bad_signature` | PASS |
| f | Same token, rotation with the previous secret still accepted | `HTTP 206` — zero-downtime rotation works | PASS |
| f | **Presign control**, same object, before revocation | `HTTP 206` | — |
| f | **Presign control, after the denylist write** | `HTTP 206` — **still serving** | **Presign cannot be revoked. Proven.** |
| f | **Presign control, after secret rotation** | `HTTP 206` — **still serving** | Same |
| g | 50 concurrent 256 KiB ranged reads | 104.7–146.1 req/s, 26.2–36.5 MiB/s, all `206`, all byte-exact, 0 errors | PASS — see §8 |
| h | No `t` parameter | `HTTP 401`, `missing_token` | PASS |
| h | `?t=` (empty) | `HTTP 401`, `missing_token` | PASS |
| h | `?t=garbage` | `HTTP 403`, `malformed_token` | PASS |
| h | Wrong path prefix (no `/v/`) | `HTTP 404`, `not_found` | PASS |
| h | `POST` with a valid token | `HTTP 405`, `method_not_allowed`, `Allow: GET, HEAD, OPTIONS` | PASS |
| h | `HEAD` with a valid token | `HTTP 200`, `content-length: 1391751`, no body, **one** storage op | PASS |
| — | Foreign `Origin` with `ALLOWED_ORIGINS` set | `HTTP 403`, `foreign_origin` | PASS |
| — | Allowed `Origin` | `206` + `access-control-allow-origin` echoed | PASS |
| — | **No `Origin` header** (a plain `<video>` element) | `HTTP 206` — **allowed, deliberately** | PASS (see §10) |
| — | `OPTIONS` preflight | `HTTP 204`, `allow-methods: GET, HEAD, OPTIONS`, `allow-headers: Range, If-None-Match` | PASS |
| — | Denylist read throws, `DENYLIST_FAIL_MODE=closed` | `HTTP 403`, `revoked` | PASS — fails closed |
| — | Denylist read throws, `DENYLIST_FAIL_MODE=open` | `HTTP 206` | PASS — documented alternative |
| — | Valid token for an object that does not exist | `HTTP 404`, `not_found` | PASS |
| — | Worker deployed with **no** signing secret | `HTTP 403`, `bad_signature` — refuses everything | PASS — fails closed |
| — | Same token replayed from 3 unrelated clients (undici, curl, curl with a `yt-dlp` UA and forged `Referer`) | `206`, `206`, `206` | **Expected — the token is a bearer credential.** §4.2 |
| — | Unhandled exceptions across all 39 recorded probes | **zero `5xx`** — statuses observed: 200, 204, 206, 400, 401, 403, 404, 405, 416 | PASS |

### 3.1 Verbatim wire output

```
$ curl -sS -o /dev/null -D - '<gate>/v/<key>?t=$TOKEN'
HTTP/1.1 200 OK
accept-ranges: bytes
cache-control: private, no-store
content-disposition: inline
content-length: 1391751
content-type: video/mp4
etag: "d5f086838bcc2e7310bb61ae96efc4ce"
x-atlas-object-size: 1391751
x-content-type-options: nosniff

$ curl -sS -o /dev/null -D - -H 'Range: bytes=500000-500099' '<gate>/v/<key>?t=$TOKEN'
HTTP/1.1 206 Partial Content
accept-ranges: bytes
cache-control: private, no-store
content-length: 100
content-range: bytes 500000-500099/1391751
content-type: video/mp4
etag: "d5f086838bcc2e7310bb61ae96efc4ce"

$ curl -sS -D - -H 'Range: bytes=1391751-' '<gate>/v/<key>?t=$TOKEN'
HTTP/1.1 416 Range Not Satisfiable
content-range: bytes */1391751

$ curl -sS -D - '<gate>/v/<key>'                 # no token at all
HTTP/1.1 401 Unauthorized
cache-control: no-store
x-atlas-gate-deny: missing_token

{"error":{"code":"missing_token"}}

$ curl -sS -D - '<gate>/v/<key>?t=<one hex char of the signature changed>'
HTTP/1.1 403 Forbidden
x-atlas-gate-deny: bad_signature

$ curl -sS -D - '<gate>/v/<OTHER EXISTING key>?t=<token minted for <key>>'
HTTP/1.1 403 Forbidden
x-atlas-gate-deny: key_mismatch
```

And the revocation sequence, with the token still ten minutes from expiry:

```
$ curl -sS -o /dev/null -D - -H 'Range: bytes=0-65535' '<gate>/v/<key>?t=$TOKEN'
HTTP/1.1 206 Partial Content
content-range: bytes 0-65535/1391751

$ curl -sS '<harness>/_control/revoke-session?s=ses_wire_demo'
{"revoked":"ses_wire_demo","denylistSize":1}

$ curl -sS -D - -H 'Range: bytes=0-65535' '<gate>/v/<key>?t=$TOKEN'   # same token, seconds later
HTTP/1.1 403 Forbidden
x-atlas-gate-deny: revoked

{"error":{"code":"revoked"}}
```

---

## 4. Per-request authorization and session binding

### 4.1 Per-request authorization — LOCAL VERIFIED

Every request is verified independently. There is no session state at the edge, no first-request-only check, and no path that serves bytes without a verdict. The ordering is deliberate and was validated by the tampering cases: shape → **signature** → claims shape → expiry → object binding → revocation. Nothing downstream ever looks at unauthenticated data; the claims JSON is parsed only after the HMAC has been verified.

The object binding is the load-bearing half. A valid token whose path was swapped to **a different object that genuinely exists** was refused with `key_mismatch` — the failure was the binding, not a missing file. The same held for a key belonging to a different academy, which is the multi-tenancy case that matters (Phase 2 §H).

**NOT VERIFIED:** that Cloudflare's edge presents the request path to the Worker in the form the gate expects. The path carries the object key percent-encoded into a single segment. Cloudflare's URL normalization is **on by default** for new zones and Cloudflare documents that it decodes only *unreserved* characters, listing the reserved set it does **not** touch — which includes `/`, so `%2F` should survive. Two documented normalizations remain relevant: `%2E` (period) **is** decoded, and successive `/` are merged. The gate is written to survive all of this — it decodes the path and accepts both the encoded and already-decoded forms, and it rejects any key containing `..` or `//` — but the actual shape a real zone delivers is a **first-deployment check** (§14).

### 4.2 Session binding — LOCAL VERIFIED, with a correction to how it is described

What the gate does enforce, and it was measured:

- the token **names** a user, a session and a device, and the HMAC makes those names unforgeable — rewriting the claims and keeping the signature yields `bad_signature`;
- a token missing any of `u`, `s`, `d` is refused as `malformed_claims` rather than accepted as "partially bound";
- the named **session** is checked against the revocation denylist on **every request**, which is what makes the name actionable at the edge.

What it does **not** do, and this is the correction: it does not prove the caller *is* that session. There is no session credential at the edge to check against — only the token. The same token was accepted from three unrelated clients, one of them presenting a `yt-dlp` user agent and a forged `Referer`, all returning `206`. **A gate token is a bearer credential**, exactly as investigation §6.1 says of both tiers.

The honest statement of the tier's advantage, which is still a real advantage:

> Stream puts Atlas's session id in a custom JWT claim that Cloudflare does not read, so the session name is inert at the edge (defect D-5). The Worker reads the same name on every request and can refuse it. The difference is not stronger binding at issue time — it is that **the name becomes actionable**.

**Recommended wording change.** `capabilities()` currently reports `boundToSession: true` / `boundToDevice: true` with the comment *"The Worker re-checks these on EVERY request"*. What is re-checked is the **signed value**, and what is enforced is **revocation by session**. Device is carried and signed but nothing at the edge acts on it. Either narrow the comment, or make the denylist support `rev:d:<deviceId>` so the claim is literally true. This is a documentation/accuracy issue, not a security hole — but the capability matrix is meant to be load-bearing, and today it over-promises slightly.

---

## 5. Revocation before expiry — the central claim

**LOCAL VERIFIED, and proven by a control experiment.**

The sequence, all against the same object, in one run:

| Step | Gate token (600 s of life remaining) | Presigned URL (same object, same moment) |
|---|---|---|
| Before | `206`, 65,536 bytes | `206`, 65,536 bytes |
| One denylist write later | **`403 revoked`** | **`206` — still serving** |
| Denylist entry removed | `206` again | `206` |
| Signing secret rotated | **`403 bad_signature`** | **`206` — still serving** |
| Rotated, previous secret still accepted | `206` — zero-downtime rotation | — |

The token's own `e` claim was **600 seconds in the future** at the moment it was refused. No expiry was waited for; no URL was re-issued; nothing about the credential changed. The verifier's rule changed, and because the verifier is a program Atlas controls, the answer changed with it.

The presign column is what makes this evidence rather than assertion. A presigned URL's answer was fixed when it was signed; neither lever touched it. This is §4.3's "Revoke before expiry: **No**" for presigns and "**Yes, per request**" for the Worker, now measured.

Two independent levers exist, with different blast radii:

- **Per-session denylist** — the routine instrument. One KV key per revoked session, written with a TTL equal to the longest token lifetime so the list self-empties.
- **Signing-secret rotation** — the emergency kill switch. Instant and global: every playback URL in flight dies at once. This is the same whole-zone blast radius §4.3 ascribes to the WAF-token path, kept as a lever of last resort rather than as the routine mechanism.

**NOT VERIFIED — revocation latency.** The harness denylist is an in-process `Map`, so the observed 3–9 ms is a property of the emulator, not of Cloudflare. In production the latency is bounded by two documented figures, neither measured here: Cloudflare states a KV write "may take up to 60 seconds or more to be visible in other global network locations", and `DENYLIST_CACHE_TTL_SECONDS` (minimum 30, default here 30) adds a colo-local cache on top. **The honest production claim is "revoked within KV propagation plus the cache TTL" — on the order of a minute, not a millisecond.** It is still categorically different from a presign, which is never revoked at all; but nobody should quote a sub-second revocation SLA to a customer.

If sub-second revocation is ever required, the architecture permits it — the verifier is Atlas's, so it could call back to the Atlas API per request instead of reading KV. That trades a subrequest and its latency on every segment for immediacy, and it reintroduces an Atlas dependency on the playback path. It is **not implemented** and **not measured**.

---

## 6. HLS / segment behaviour if HLS were used

DL-19 fixes the Normal tier as a single progressive 720p MP4, so HLS is hypothetical. It was examined anyway because DL-22 requires it, and the examination produced the most consequential structural finding in this spike.

**Finding: the current token format cannot express an HLS asset. LOCAL VERIFIED.**

The claim `k` is one exact object key, and `gate.js` enforces `claims.k !== objectKey → key_mismatch`. That is precisely the check that stopped a valid token from fetching a different existing object (§3, row d) — it is a feature, and it is also why an HLS asset does not fit: an HLS asset is a playlist plus hundreds of segment objects, each at its own key. A per-segment token would mean minting a token per segment; a single token cannot cover them.

Supporting HLS is therefore **a change to `src/media/video/basic-video.provider.ts`, not to the Worker**: `k` would have to become a prefix (for example the asset's directory), and the gate's equality check would become a prefix-containment check with the traversal guards that implies. That is a security-relevant change to a signed claim's meaning and belongs in its own decision, not in an implementation ticket.

The rest, if that change were ever made:

- **Per-segment enforcement works unchanged** — the gate is path-and-token based and re-verifies every request, so each segment is authorized individually. This is the property §4.3's "Every segment request runs the Worker" row anticipates, and §9 quantifies the cost.
- **Token delivery becomes the hard part. NOT VERIFIED.** Segment URLs are written by the packager, so a query-string token would require the Worker to rewrite the playlist on the fly, or Atlas to rewrite it at mint time. The alternative — a cookie-carried token, which the browser attaches to segment requests automatically — is exactly what investigation §19 flags as unvalidated ("whether cookie-carried tokens behave as assumed"). **It remains unvalidated. This spike did not test cookies**, because the provider mints a query-string token and testing a format the provider does not emit would prove nothing about Atlas.
- **Request volume multiplies by roughly the segment count.** §9.

---

## 7. Caching behaviour

**Every successful response carries `Cache-Control: private, no-store`, and that is a deliberate architectural choice, not a default.** LOCAL VERIFIED that the header is present on every 200/206/416; its effect at the CDN is **NOT VERIFIED** and rests on Cloudflare's documentation:

- Cloudflare documents that it does **not** cache a resource when `Cache-Control` is `private`, `no-store`, `no-cache` or `max-age=0`. So the CDN cache contributes **nothing** to this tier, and every request reaches the Worker and R2.
- MP4 **is** in Cloudflare's default-cacheable extension list, which is exactly why the explicit header matters: without it, a protected object has a cacheable extension.
- The Worker also deliberately does **not** call `object.writeHttpMetadata(headers)`, because that helper copies the object's *stored* `Cache-Control` onto the response — a `public, max-age=…` written at upload time would otherwise hand a shared cache a copy of gated bytes. Headers are set explicitly from a known-safe set instead.

**This is the tier's central tension, and it should be stated plainly rather than discovered later:** per-request authorization and CDN caching are mutually exclusive for the same bytes. The Normal tier is cheap because **R2 egress is free**, not because of cache hits. Cloudflare's pricing page states egress from R2, including via the Workers API, is free.

If caching is ever proposed, four documented facts have to be dealt with first:

1. Cloudflare does **not** automatically cache a `Response` a Worker built from an R2 binding — it would have to be put into the Cache API explicitly, and that cache is **per data centre**, not global.
2. `cache.put()` **throws** on a `206`. Only a full `200` can be cached, and the cache then slices ranges out of it. Cloudflare's Workers cache limitations page says so directly: a 206 returned by a Worker is not stored.
3. The default cache key **includes the query string**, and the token is in the query string, so every viewer would miss.
4. **Correction to investigation §4.3:** the fix is *not* Enterprise-only. "Ignore query string" and "sort query string" are available on **all plans** via Cache Rules; only fine-grained custom cache keys (named query params, headers, cookie, host, user features) remain Enterprise. But "ignore query string" means the cache key no longer contains the credential — which is the whole security question restated as a cache setting.

**NOT VERIFIED:** any real cache hit ratio, `cf-cache-status` value, or edge behaviour. There is no CDN in the harness.

One related caveat for a future cache design: Cloudflare aligns origin range requests to 1 MiB cache boundaries, so a 1 KiB client range can pull a 1 MiB origin range. That changes the R2 operation arithmetic in §9 if caching is ever enabled. **NOT VERIFIED here**, cited only.

---

## 8. Realistic concurrency

**N = 50 concurrent viewers, each issuing a 256 KiB ranged read with its own distinct token.** Four measured runs after a warm-up run; the first ever run on a cold process was ~4.5× slower and is excluded as a cold-start artefact (noted for honesty, not hidden).

| Metric | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|
| Wall time, 50 requests | 433.9 ms | 477.6 ms | 342.2 ms | 358.0 ms |
| Throughput | 115.2 req/s | 104.7 req/s | 146.1 req/s | 139.7 req/s |
| Throughput | 28.8 MiB/s | 26.2 MiB/s | 36.5 MiB/s | 34.9 MiB/s |
| Latency p50 (total) | 354.1 ms | 314.6 ms | 258.1 ms | 277.5 ms |
| Latency p95 | 417.5 ms | 451.2 ms | 331.6 ms | 347.9 ms |
| Latency p99 | 421.4 ms | 465.3 ms | 334.8 ms | 351.4 ms |
| Worker decision p50 | 323.6 ms | 287.3 ms | 249.1 ms | 236.6 ms |
| All `206`, byte-exact | yes | yes | yes | yes |
| Errors | 0 | 0 | 0 | 0 |

Two further shapes, to separate the gate from the storage:

| Shape | Result |
|---|---|
| 50 concurrent **HEAD** (verification + one storage head, **no body streaming**) | 108.0–110.1 ms wall, **454–463 req/s**, p50 86–94 ms, decision p50 70–79 ms |
| 50 viewers × 8 sequential 256 KiB chunks = **400 requests** | 2,806–3,250 ms wall, **123–143 req/s**, exactly **1 head + 1 get + 1 KV read per request** |
| Per-request revocation check on/off (`REVOCATION_MODE=kv` vs `none`, 50 HEAD) | 627 / 704 req/s with, 615 / 683 req/s without — **within noise**, i.e. the check adds no measurable in-process work |

**What these numbers do and do not mean.**

They establish, LOCAL VERIFIED: **correctness under concurrency**. Fifty simultaneous authenticated ranged reads all returned `206` with byte-exact content, zero errors and zero `5xx`, and each consumed exactly three backend operations. The gate's own logic is not the bottleneck — the HEAD-only path, which does everything the gate does minus streaming, ran 3–4× faster than the full GET path.

They do **NOT** establish Cloudflare capacity. The absolute latencies are dominated by (i) a Docker MinIO on a laptop and (ii) the harness's web-stream→Node-stream bridging, which a Worker does not do at all — `new Response(r2Object.body)` in workerd is a stream handoff. A raw MinIO baseline measured from a cold process ran *slower* (37–45 req/s) than the warm gate server, which is itself evidence that these figures measure the local environment's connection pooling rather than any property of the architecture. **Real edge concurrency is NOT VERIFIED and cannot be inferred from this.**

Two further observations that make the same point, recorded rather than smoothed over: the very first run on a cold Node process managed 10.9 req/s, ~13× below the warm figure; and a confirmation run executed while a `tsc --noEmit` and a `nest start` watcher were competing for the same CPU returned **37.2 req/s** with identical correctness (all `206`, all byte-exact). The correctness results were stable across every run; the throughput results moved by an order of magnitude with machine load alone. **Treat the correctness column as evidence and the throughput column as a sanity check, not as a capacity model.**

**Verifier cost, NODE not workerd.** The HMAC verification path (`crypto.subtle.verify` + base64url + `JSON.parse`, no I/O) measured **72–88 µs** per call in the spike harness and **41–332 µs** in a dedicated micro-benchmark, the spread being per-call async dispatch through Node's libuv threadpool rather than the cryptography (`node:crypto`'s synchronous HMAC of the same payload measured 40–61 µs). `workerd` implements Web Crypto differently and Cloudflare publishes no per-operation figure, so **the Worker's real CPU-ms is UNVERIFIED**. §9 therefore models cost with a deliberately pessimistic 1 ms/request ceiling, which is 10–25× the highest local measurement.

---

## 9. Worker request volume and realistic request cost

### 9.1 Stated assumptions

- Enterprise quota, from investigation §5.1: **5,000 minutes stored, 150,000 minutes delivered per month**.
- **Single 720p H.264 rendition at 2.5 Mbps** (DL-19: no ABR ladder) → **18.75 MB per minute**. *Engineering estimate, not a vendor figure.*
- Average lesson **10 minutes** → **15,000 lesson-views/month**.
- The gate as written costs **2 R2 class-B operations** (`head` + `get`) and **1 KV read** per request. §11 explains why, and what the one-operation alternative costs.

### 9.2 Request volume

| Delivery shape | Requests per lesson-view | Worker requests/month |
|---|---|---|
| **Progressive MP4 (as designed)** | 3–10 — **ESTIMATE, NOT MEASURED** | **45,000 – 150,000** |
| HLS, 6 s segments | 100 segments + 2 playlists = 102 | 1,530,000 |
| HLS, 4 s segments | 150 + 2 = 152 | 2,280,000 |
| HLS, 2 s segments | 300 + 2 = 302 | 4,530,000 |

The progressive row is the weakest number in this document and is labelled accordingly. Browser media elements vary: a single long-running ranged GET that streams to the end, versus many short ranges, is a per-browser behaviour this spike did not measure (the harness's 256 KiB chunking is synthetic). **Measuring real player request counts is a first-deployment task** (§14) — the Workers dashboard Requests metric answers it directly.

One request-volume detail worth knowing: **a mid-stream token expiry costs one extra request**. The playback TTL is 600 s and a 10-minute lesson is 600 s, so a full-length view sits exactly on the boundary and will typically need one refresh.

### 9.3 Cost, against cited Cloudflare prices

| Line | Quantity | Rate (official) | Cost |
|---|---|---|---|
| Workers Paid | account minimum; includes **10M requests** + **30M CPU-ms**; also covers KV | $5.00/mo | **$5.00** |
| Worker requests | 45k–150k (progressive) … 4.53M (HLS 2 s) | included; +$0.30/M beyond 10M | **$0.00** |
| Worker CPU | ≤ 4.53M CPU-ms at a pessimistic 1 ms/req = **15% of the included 30M** | included; +$0.02/M beyond | **$0.00** |
| R2 storage | 5,000 min × 18.75 MB = **93.75 GB** | $0.015/GB-mo | **$1.41** |
| R2 egress | 2.81 TB | **free** | **$0.00** |
| R2 class B (`head`+`get`) | 90k–300k (progressive) … 9.06M (HLS 2 s) | 10M/mo free, then $0.36/M | **$0.00** |
| R2 class A (uploads) | ~500–2,000 ops | 1M/mo free, then $4.50/M | **$0.00** |
| KV reads | 45k–150k … 4.53M | 10M/mo included, then $0.50/M | **$0.00** |
| **Total** | | | **≈ $6.41/month** |

**This confirms investigation §5.1's $8.35/month** and is slightly under it, because §5.1's $3.35 storage line implies ~223 GB — roughly 6 Mbps, i.e. a multi-rendition assumption that DL-19 removed.

Three honest caveats on this table:

1. The $5 Workers Paid charge is an **account minimum**, not a per-Worker fee. If Atlas already pays it for anything else, the marginal cost of this Worker is the R2 storage line alone.
2. **Even the worst case has headroom.** HLS at 2-second segments — the most request-hungry shape modelled — consumes 45% of the included Worker requests and 91% of the free R2 class-B allowance. Beyond that, the marginal rates are $0.30/M requests and $0.36/M class-B operations, so a 10× traffic increase costs single-digit dollars per month, not a step change.
3. **NOT VERIFIED:** every figure in the "Cost" column is arithmetic over published list prices, not an invoice. Real billing must be read from the Cloudflare dashboard after the first month.

---

## 10. Hotlink behaviour

**LOCAL VERIFIED at the Worker layer:**

| Request | Result |
|---|---|
| `Origin: https://evil.example` with `ALLOWED_ORIGINS=https://app.atlas.example` | `403 foreign_origin` |
| `Origin: https://app.atlas.example` | `206`, with `access-control-allow-origin` echoed |
| **No `Origin` header** | `206` — allowed |
| `OPTIONS` preflight from an allowed origin | `204`, `allow-methods: GET, HEAD, OPTIONS`, `allow-headers: Range, If-None-Match` |

**The missing-`Origin` row is the important one, and it is a deliberate design decision.** A plain `<video src="…">` element does not send `Origin` on its media requests. A rule that refused requests without an `Origin` would therefore refuse ordinary playback. Only a *present and foreign* origin is refused. Combined with the fact that `Origin` is a request header a non-browser client sets freely — demonstrated in §3, where a request carrying a `yt-dlp` user agent and a forged `Referer` was served — **this is a browser-level hotlink deterrent, not an access control**, exactly as investigation §6 already states for both tiers.

**Finding, cited: Cloudflare's built-in Hotlink Protection will not protect video.** Its documentation states the supported file extensions are `gif`, `ico`, `jpg`, `jpeg` and `png`. An MP4 is not covered. Zone-level hotlink enforcement for this tier must therefore be a **WAF custom rule**, which is available on all plans (5 rules on Free, 20 Pro, 100 Business, 1,000 Enterprise) — or the in-Worker check implemented here, which has the advantage of shipping with the Worker instead of living in a dashboard nobody version-controls.

**NOT VERIFIED:** WAF behaviour, rule evaluation order relative to Workers, and whether a WAF rule or the Worker sees the request first. That ordering matters if both are used and is a first-deployment check.

---

## 11. Failure behaviour

**LOCAL VERIFIED.** Across 39 recorded probes, including every malformed and hostile input tried, **no request produced a `5xx`**. Statuses observed: 200, 204, 206, 400, 401, 403, 404, 405, 416. That is the property that matters most for an edge verifier — an attacker-controlled token must never be able to turn verification into a server error.

| Failure | Behaviour | Status |
|---|---|---|
| Denylist read throws, `DENYLIST_FAIL_MODE=closed` (default) | Refuses | `403 revoked` |
| Denylist read throws, `DENYLIST_FAIL_MODE=open` | Serves | `206` |
| Worker deployed with **no** signing secret | Refuses everything | `403 bad_signature` |
| Valid token, object deleted or never uploaded | Refuses | `404 not_found` |
| Malformed percent-encoding in the path | Refuses before storage | `404 not_found` |
| Non-hex / wrong-length signature | Refuses before any crypto | `403 malformed_token` |
| Token over 4 KiB | Refuses before any crypto | `403 malformed_token` |

Design notes behind those rows:

- **Fail-closed is the default, and it is a real trade-off.** A KV incident becomes a total playback outage for the tier. The alternative (`open`) keeps playback up and relies on the ≤10-minute token lifetime plus secret rotation as the backstop. `closed` is the default because a default should be the conservative one, and because it matches Atlas's standing rule that an authorization component which cannot reach its data says no. Switching it is a deliberate availability-over-strictness decision to be recorded as one.
- **An unconfigured Worker refuses rather than serves.** With no secret, the accepted-secrets list is empty, no signature can match, and everything is refused. A misconfiguration produces a visible outage, never silent open access.
- **Input is bounded before it is expensive.** Token length, signature charset and signature length are checked before any cryptography, so an attacker cannot make Atlas spend metered CPU on a multi-megabyte query string. All three bounds are public constants, so rejecting on them leaks nothing.
- **The token is never logged**, in whole or in part. Deny lines carry the reason, the key, 8-character prefixes of the user and session ids, and the `cf-ray`.

**NOT VERIFIED:** Worker exception behaviour under `workerd` (a thrown exception surfaces as a Cloudflare `1101`, not as the harness's 500), R2 binding error semantics, and behaviour when a Worker exceeds its CPU limit. The default CPU limit on the Paid plan is documented as 30 s per invocation, configurable to 5 minutes, and Cloudflare states that time waiting on network requests — it names `fetch()`, KV reads and database queries — does not count toward CPU time. **Cloudflare's limits page does not explicitly name R2 binding reads or response-body streaming in that exclusion**, so "streaming a large object does not burn CPU time" is a reasonable inference from the same I/O principle but is *not* a citable fact. It is on the first-deployment checklist.

---

## 12. Expiry behaviour

**LOCAL VERIFIED.**

- A backdated token (`e` 8 seconds in the past) → `403 expired`.
- A token minted with a 2-second lifetime → `206` before expiry, `403 expired` 2.6 seconds later. The boundary was crossed during the test rather than assumed.
- The comparison is `claims.e * 1000 <= now`, **identical** to `BasicVideoProvider.verifyGateToken`, so the edge never accepts a token one millisecond after the backend would have rejected it.
- The provider clamps the requested expiry to `playbackTtlSeconds` (600 s) and returns the **real** expiry in `PlaybackDescriptor.expiresAt` — the D-3 lesson applied. Observed: a request for a longer lifetime came back reporting the clamped one.
- Signature verification happens **before** expiry parsing, so a forged token with an extended `e` fails as `bad_signature`, not as an accepted long-lived credential. Measured: claims rewritten with `e + 86400`, old signature kept → `403 bad_signature`.

**NOT VERIFIED:** clock skew between Atlas's server and the Cloudflare edge. The gate uses `Date.now()` at the edge and the claim was minted against the API's clock; a skew of a few seconds shortens or lengthens the effective credential by that amount. With a 600-second TTL this is not material, but it is worth confirming once against a real deployment. Note also that `Date.now()` in the Workers runtime does not advance during synchronous execution — irrelevant to a second-granularity expiry, but relevant to anyone who later tries to measure elapsed time inside the Worker.

---

## 13. What the Worker deliberately does not do

Restated here because the capability matrix depends on it, and because the README is not where a reviewer of the master plan will look.

- **It is not the authorization authority.** `LessonContentService` checks all seven entitlement conditions before a token is minted (AD-1). The Worker can only narrow that decision, never widen it. It has no database, no JWT, and no opinion about a person. If it were removed, no entitlement rule would change — playback would simply become unavailable, which is the correct failure mode for an enforcement point.
- **It cannot mint a token.** The `CryptoKey` is imported with `['verify']` only, so the runtime refuses to sign. A Worker that can mint credentials is an authorization authority at the edge, outside the backend's guards and outside RLS.
- **It does not stop a determined person from keeping the bytes.** Bearer credential; screen recording is unstoppable without DRM; neither tier has DRM. Neither tier may claim "cannot be downloaded" or "piracy-proof" (§6.1 of the investigation, unchanged).
- **It does not transcode, package, caption or thumbnail.** One progressive 720p rendition, by decision (DL-19). The transcoding cost the investigation calls the largest hidden cost of this recommendation is **not** addressed by this spike and remains open.

---

## 14. Verdict

### Is the architecture sound?

**Yes.** Every security property the Normal tier advertises was exercised against real HMAC-SHA256 and the real S3 protocol, and every one behaved as claimed: per-request authorization, unforgeable claims, object binding across academies, correct `Range`/`206`/`416` semantics with byte-exact content, expiry at the exact backend boundary, fail-closed behaviour on every misconfiguration and outage tried, and **zero `5xx` across 39 probes including hostile input**.

The claim DL-22 exists to test — that a Worker gate gives per-request authorization and revocation before expiry, which a presign cannot — is **proven**, and proven the right way: by a control experiment in which a presigned URL for the same object kept serving after both revocation levers had killed the gate token with 600 seconds of life still on it.

Three qualifications go with that "yes", and none of them is a reason to change course:

1. **Revocation is prompt, not instantaneous.** In production it is bounded by KV propagation ("up to 60 seconds or more", per Cloudflare) plus a 30-second colo cache. Categorically better than a presign, which is never revoked at all — but not a sub-second SLA, and it must not be sold as one.
2. **"Bound to session" means the session name is unforgeable and actionable, not that the caller proved possession.** The token is a bearer credential. This is still strictly stronger than Stream, where the name is inert at the edge (D-5), but `capabilities()`'s comment currently over-promises slightly and should be narrowed — or the denylist extended to devices so it becomes literally true.
3. **HLS would require a token-format change**, not a Worker change. The tier is structurally progressive-MP4-only today. That is consistent with DL-19 and is only a problem if ABR is later reinstated.

### What must be checked on the first real deployment

In priority order. Items 1–4 are go/no-go; the rest are measurements that turn UNVERIFIED rows in this document into verified ones.

1. **Path shape at the edge.** Confirm the Worker receives `/v/<key with %2F intact>` on the real zone, with the zone's actual URL-normalization setting. Cloudflare's docs say reserved characters including `/` are not decoded, and the gate accepts both forms, but this is the one failure that would produce a blanket `404` and it must be checked first. Also confirm no key containing `%2E` exists, since period **is** decoded.
2. **Secret and host parity.** `GATE_SIGNING_SECRET` must equal `BASIC_VIDEO_SIGNING_SECRET`, and the Worker `routes` pattern must equal `BASIC_VIDEO_DELIVERY_HOST`. Neither mismatch fails loudly: the first gives `403 bad_signature` on everything, the second gives playback URLs that resolve to nothing.
3. **R2 binding range semantics.** Re-run the §3 range matrix against the real binding — in particular `416` on a seek past the end, the suffix form, and that `head.size` is the full object size on a ranged read. The harness validated these against S3/MinIO, not against R2.
4. **Real revocation latency.** Write a denylist key and measure, from more than one region, how long a live stream keeps serving. This converts the single most customer-visible claim in the capability matrix from "documented bound" to "measured".
5. **Real player request counts.** Read the Workers dashboard Requests metric for one real lesson view per target browser. This is the weakest number in §9 and the one the cost model rests on.
6. **Real CPU time.** Read `CPUTimeMs` from the Workers Trace Events dataset (or the dashboard's CPU-time-per-execution chart) and confirm the per-request figure is far below the 30 s limit and consistent with the §9 model. Confirm specifically that streaming a large object does not accumulate CPU time — Cloudflare's I/O exclusion does not name R2 reads or body streaming explicitly.
7. **Cache behaviour.** Confirm `cf-cache-status` shows no caching of gated bytes, and that no MP4 is being cached by the default extension rules despite `private, no-store`.
8. **WAF ordering**, if a zone-level hotlink rule is added alongside the Worker's own `Origin` check: confirm which evaluates first.
9. **First invoice.** Compare the real Cloudflare bill against §9.3. Every number in that table is arithmetic over list prices.
10. **Clock skew** between the API host and the edge, once, to confirm the effective credential lifetime matches the advertised one.

### Recommended follow-ups outside this spike

- **Narrow the `capabilities()` comment** on `boundToSession` / `boundToDevice`, or add device support to the denylist. (Documentation accuracy; the capability matrix is meant to be load-bearing.)
- **Correct investigation §4.3's cache-key note** — "ignore query string" is available on all plans, not Enterprise-only.
- **Record the HLS token-format finding** against DL-19, so that any future reinstatement of ABR starts from "this needs a signed-claim change", not from "the Worker handles it".
- The **transcoding pipeline** remains the largest unaddressed cost in the recommendation (investigation §5.4). This spike says nothing about it.

---

## Appendix A — Sources

Cloudflare documentation, all read **19 September 2026**:

| Fact used | Page |
|---|---|
| Workers Paid: $5/mo, 10M requests, 30M CPU-ms, +$0.30/M, +$0.02/M | `developers.cloudflare.com/workers/platform/pricing/` |
| CPU limits: 30 s default (paid), 5 min max; I/O waiting excluded (names `fetch()`, KV, DB) | `developers.cloudflare.com/workers/platform/limits/` |
| R2 pricing: $0.015/GB-mo, class A $4.50/M, class B $0.36/M, free tiers 1M/10M ops | `developers.cloudflare.com/r2/pricing/` |
| R2 egress free, including via the Workers API | `developers.cloudflare.com/r2/pricing/` |
| R2 Workers API: `range` accepts `R2Range \| Headers`, `suffix`, `onlyIf`, `httpEtag`, `writeHttpMetadata` | `developers.cloudflare.com/r2/api/workers/workers-api-reference/` |
| R2 binding operations are metered | `developers.cloudflare.com/billing/understand/how-charges-accrue/` |
| Subrequests: R2/KV binding calls count; 50 (free) / 10,000 (paid) per invocation | `developers.cloudflare.com/workers/platform/limits/#subrequests` |
| Web Crypto fully implemented; HMAC sign/verify/importKey supported; non-standard `crypto.subtle.timingSafeEqual` exists | `developers.cloudflare.com/workers/runtime-apis/web-crypto/` |
| Default cache key includes the query string; "ignore query string" on all plans, fine-grained keys Enterprise-only | `developers.cloudflare.com/cache/how-to/cache-keys/` |
| Cloudflare does not cache `private`, `no-store`, `no-cache`, `max-age=0`; MP4 is default-cacheable by extension | `developers.cloudflare.com/cache/concepts/default-cache-behavior/` |
| A Worker's `Response` is not auto-cached; Cache API is per data centre | `developers.cloudflare.com/workers/reference/how-the-cache-works/` |
| `cache.put()` throws on `206`; a Worker's 206 is not stored | `developers.cloudflare.com/workers/runtime-apis/cache/`, `developers.cloudflare.com/workers/cache/limitations/` |
| Range requests: 206 served from cache; origin ranges aligned to 1 MiB boundaries | `developers.cloudflare.com/cache/reference/range-requests/` |
| WAF custom rules on all plans: 5 / 20 / 100 / 1,000 | `developers.cloudflare.com/waf/custom-rules/` |
| Hotlink Protection covers `gif`, `ico`, `jpg`, `jpeg`, `png` only | `developers.cloudflare.com/waf/tools/scrape-shield/hotlink-protection/` |
| URL normalization on by default; decodes unreserved only; `/` not decoded; `%2E` decoded; `//` merged | `developers.cloudflare.com/rules/normalization/settings/`, `.../how-it-works/` |
| KV: eventually consistent, "up to 60 seconds or more" to propagate; `cacheTtl` min 30 s, default 60 s | `developers.cloudflare.com/kv/concepts/how-kv-works/`, `developers.cloudflare.com/kv/api/read-key-value-pairs/` |
| KV pricing: 10M reads included on Paid, +$0.50/M | `developers.cloudflare.com/kv/platform/pricing/` |
| `CPUTimeMs` per invocation in Workers Trace Events; CPU-time quantile chart in the dashboard | `developers.cloudflare.com/logs/reference/log-fields/account/workers_trace_events/`, `developers.cloudflare.com/workers/observability/metrics-and-analytics/` |
| Video over the CDN must use a Cloudflare paid service (Developer Platform, Images, Stream) | `cloudflare.com/service-specific-terms-application-services/` |

**Three things could not be sourced officially and are treated as unknown rather than assumed:** that R2 binding reads and response-body streaming are excluded from CPU time; Hotlink Protection's plan availability; and the specific quantiles the dashboard's CPU-time chart reports.

## Appendix B — Reproducing the measurements

The harness is three scripts in the session scratchpad, outside the repository:

| Script | Purpose |
|---|---|
| `seed.mjs` | Builds the 720p `+faststart` fixture with ffmpeg and uploads it to the MinIO protected bucket at a real Atlas key. |
| `gate-server.mjs` | Serves the **real Worker module** over HTTP, with an S3-backed R2-shaped binding, an in-memory KV-shaped denylist, an injectable KV failure, and a harness-only control plane for mutating the verifier's rules mid-flight. |
| `spike.mjs` | Mints tokens with the **real compiled provider** and runs cases (a)–(h) plus the origin, failure and concurrency matrices; writes `spike-results.json`. |
| `baseline.mjs` | Raw MinIO and presigned-URL floors, and the isolated verifier micro-benchmark. |

Re-run after any change to `gate.js`, and after bumping `compatibility_date` in `wrangler.toml`.
