# Atlas — Two-Tier Video Provider Investigation

**Status:** Investigation only. Nothing in this document has been implemented, and the Master Plan has not been amended.
**Date:** 19 September 2026
**Trigger:** Owner requirement for two video security tiers, raised mid-Phase-2.
**Scope:** Whether Atlas can support a low-cost "basic" video tier alongside Cloudflare Stream without Atlas authorization becoming provider-specific, and what it would cost to do so from the current Phase 2 working state.

---

## 1. Executive summary

**The requirement is achievable, the current Phase 2 work is architecturally valid, and almost none of it needs to be thrown away.** The parts of Phase 2 that decide *who may watch what* contain no provider knowledge at all. The coupling to Cloudflare is confined to plumbing: four closed type unions, six TypeScript filters, one Cloudflare-shaped configuration object, and a provider-named webhook route. There are zero provider references in the migration SQL.

Five findings changed the shape of the answer, and three of them were not anticipated when the investigation began.

**(1) Cloudflare's CDN terms decide the provider question before cost does.** Cloudflare prohibits serving video through its CDN unless the video is hosted on a Cloudflare service, and names R2 as one of the sanctioned hosts. This eliminates the obvious cheap option — serving video from the Atlas VPS behind the orange cloud — on licensing grounds, independently of Atlas's own AD-1, which already forbade it. It also eliminates Backblaze B2 + Cloudflare, otherwise the cheapest storage available.

**(2) The cost gap is enormous, and it is entirely delivery, not storage.** At the Enterprise tier's own quota (5,000 minutes stored, 150,000 delivered per month), Cloudflare Stream costs ~$175/month, of which $150 is delivery. R2 behind the Cloudflare CDN costs ~$8/month, because R2 egress is free. That is a ~95% reduction on the dominant line item, and it is available only because R2 is the licence-clean path.

**(3) The secure tier does not enforce what Atlas's own code comment claims it enforces.** `CloudflareStreamProvider` mints `accessRules: [{type:'any', action:'allow'}]` and puts Atlas's session and device identifiers in custom JWT claims. Cloudflare does not read custom claims. A Stream token lifted from one browser therefore works in another browser for its full two-hour life. The binding is enforced by Atlas **at grant-issue time only** — which is exactly what the basic tier would also do. This is recorded below as defect D-5 and it materially narrows the honest difference between the two tiers.

**(4) A Worker-gated R2 tier is *stronger* than Stream on revocation — but not on binding.** *(Corrected 19 Sep 2026 during implementation review; the original claim is preserved in the next sentence so the error is visible.)* This section originally asserted that a Worker-gated tier "can bind each segment request to the viewer's session". **It cannot**: the delivery host is Atlas-owned and cross-site from the academy, so no Atlas session reaches the gate — the same trap that produced finding D-5 for Cloudflare. What the gate genuinely adds is **revocation before expiry**, per request, which Stream cannot do at all (its only kill switch invalidates every token minted with a signing key). The truthful framing of the tiers is therefore **self-managed versus platform-managed delivery** — not "less secure versus secure" — and neither tier may claim edge-enforced session or device binding.

**(5) Five defects exist in the uncommitted Phase 2 code** (D-1 … D-5, §2.4), one of which — `media_assets.provider` recording a hardcoded constant rather than the acting adapter — is a hard prerequisite for any two-provider design, because per-asset playback resolution reads exactly that column.

**Recommendation:** proceed with two tiers. Basic = Cloudflare R2 behind the Cloudflare CDN, gated by a Worker validating an Atlas-minted token. Secure = Cloudflare Stream, unchanged. Keep every line of the Phase 2 policy layer. Fix the five defects, replace one ternary with a registry, split *security tier* from *provider* in the data model, and make `capabilities()` load-bearing so a grant reports what is actually enforced rather than what was hoped for.

**The single largest hidden cost** is that R2 stores bytes and does not encode them: Atlas inherits the entire transcoding pipeline that Stream provides free. Section 5.4 treats this as the main argument against the recommendation.

---

## 2. Current implementation state

Phase 2 was partially implemented before this investigation and is **preserved intact**: 69 uncommitted files in the backend, 34 in the frontend, nothing committed, pushed, merged or deployed.

### 2.1 Verified state at the checkpoint

| Check | Result |
|---|---|
| Backend typecheck | 0 errors |
| Backend unit tests | 87 suites / 1,079 tests passing |
| Backend boot | `/health` 200, database up, Redis up |
| Phase 2 routes mapped | 19 |
| Frontend typecheck | 0 errors |
| Frontend tests | 50 files / 523 tests passing |
| Committed / pushed / deployed | **none** |
| Production video configuration | **none** — no `VIDEO_PROVIDER`, no `CLOUDFLARE_STREAM_*`, no Phase 2 flag is set on the production host |

The last row matters commercially: no production behaviour and no customer data depends on the Cloudflare choice yet, so changing course now costs nothing in migration terms.

### 2.2 Built

Database (one migration, applied locally only): `lesson_contents`, `lesson_resources`, `content_access_log`, `student_devices`, `access_policies`, the `can_access_lesson()` SECURITY DEFINER predicate and its RLS policies, plus additive columns on `media_assets`, `course_lessons`, `lesson_progress`, `course_progress`, `refresh_tokens`, `academies` and `tenant_usage`.

Backend: the seven-condition policy decision point (`LessonContentService`), `ContentGrantSigner`, the protected R2 tier, `VideoProvider` with Cloudflare and fake adapters, the device registry and Redis lease, takeover with audit, the unified sequence endpoint, playback heartbeats with server-credited evidence, the learner dashboard aggregates, owner-only protection and device-policy settings, `videoStorageMinutes` end to end, and five per-academy rollout flags.

Frontend: the `/my/*` learner shell, nine route skeletons, D2 redirects and dashboard learner-route removal, EN/AR i18n, and the accessibility carry-overs.

### 2.3 Not built (was still outstanding when this investigation began)

The staff authoring UI (including any write path for `course_lessons.video_asset_id`, which has none), the player itself, `POST …/playback/refresh`, the `content_access_log` retention sweep, the stalled-video status-poll scheduler, and the Phase 2 §U metrics.

### 2.4 Defects found during this investigation

All five are in uncommitted code. Each was verified directly against the source.

**D-1 — `media_assets.provider` records a constant, not a fact.** `src/media/services/protected-media.service.ts:227` writes the literal `provider: 'cloudflare_stream'` rather than `this.videoProvider.key`. With `VIDEO_PROVIDER=fake` the row still claims Cloudflare. The three quota and reconciliation filters happen to agree with the falsehood, which is why nothing visibly breaks today — and precisely why a naively-added second provider would be silently attributed to Cloudflare and silently consume the secure tier's quota. **Prerequisite for any two-provider design.**

**D-2 — the local adapter's upload ticket is empty.** `FakeVideoProvider.createDirectUpload` returns `uploadUrl: ''` (`fake-video.provider.ts:112`), deferring the real presign to `issueUploadUrl` (`:119`), which has no caller. `ProtectedMediaService` passes the empty string straight into the ticket. The one adapter whose upload is already a presigned R2 PUT does not satisfy the `CreatedDirectUpload` contract — in-tree evidence that the method as shaped does not fit an R2-backed adapter.

**D-3 — the grant advertises an expiry the URL does not have.** `FakeVideoProvider.issuePlaybackToken` derives a TTL of up to 2 h, hands it to `ProtectedMediaStorage.presignGet`, which clamps it to `signedUrlTtlSeconds` (600 s default, 3600 s cap) at `protected-media-storage.provider.ts:130` — then returns `expiresAt` as the full two hours. The grant claims two hours for a URL dead in ten minutes. Not a typo: see §8.4.

**D-4 — a no-webhook adapter has no path to `ready`.** The only production writer of `ready` for provider-hosted video is the webhook handler; `pollStalled` has no caller. `LessonContentService:401` refuses to sign anything not `ready`, so a synchronous adapter would leave every asset stuck at `processing` forever.

**D-5 — the secure tier's device binding is not enforced by the edge.** `cloudflare-stream.provider.ts:170` mints `accessRules: [{ type: 'any', action: 'allow' }]`, and the Atlas identifiers sit in custom claims (`:171-173`) that Cloudflare does not interpret. The interface comment at `video-provider.interface.ts:96-103` — *"a token lifted from one browser carries the other browser's session and device in its own claims"* — is true about the token's contents and **false about their effect**. A lifted token works elsewhere for its full life. This is the most consequential finding for the security matrix, because it is the claim on which the secure tier's premium would otherwise rest.

---

## 3. Current architecture

```
Atlas authorization          LessonContentService — 7 conditions   ← no provider knowledge
        │                    ContentGrantSigner                    ← no provider branching
        ▼
  VideoProvider  ──────────►  CloudflareStreamProvider  (the only production adapter)
                              FakeVideoProvider         (local/test)
```

RLS sits underneath as an independent second boundary: `can_access_lesson()` gates on the *lesson*, and no Phase 2 policy references `media_assets` at all.

---

## 4. Basic provider alternatives

### 4.1 The constraint that decides it

Cloudflare's service-specific terms (read 19 Sep 2026) require that video served through the Cloudflare CDN be hosted on a Cloudflare service, naming Stream, Images and R2. Video hosted elsewhere "will still be restricted on our CDN", and Cloudflare documents that it may redirect content or take other action.

This is not a pricing preference — it eliminates two candidates outright:

- **Atlas VPS disk behind Cloudflare.** Already forbidden by Atlas's own AD-1 ("video bytes are never proxied through the backend") and independently a capacity dead end: 100 concurrent 720p streams is roughly 150 Mbps sustained from the same box running NestJS and PostgreSQL.
- **Backblaze B2 + Cloudflare**, otherwise the cheapest storage researched, because B2 is hosted outside Cloudflare. (B2's native API also returns `200` rather than `206` for `bytes=0-`, which breaks progressive-MP4 seeking; Backblaze's own remedy is to use their S3-compatible API.)

### 4.2 Options that survive

| Option | Delivery model | Verdict |
|---|---|---|
| **Cloudflare R2 + Cloudflare CDN** | Free egress; licence-clean; three possible access-control paths (§4.3) | **Recommended** |
| **Bunny.net Stream** | Free ABR transcoding, captions, thumbnails, TUS resumable upload, IP-bindable tokens | Strong on features; **Middle East / Africa delivery is $0.060/GB**, its most expensive tier, so only ~34% below Stream for a Gulf-facing platform. The cheap Volume network runs ~10 PoPs. Raw MP4 paths are directly accessible by default unless pull-zone token auth is explicitly enabled |
| **S3 + CloudFront flat-rate Pro** | $15/mo bundling 50 TB egress + 10M requests + 50 GB S3, no overage | **Best-specified access control of anything researched** — custom-policy signed cookies bind expiry *and* IPv4 CIDR, and AWS explicitly recommends signed cookies for HLS. OAC closes direct S3 access completely. ~2× the R2 cost and a second vendor |
| Mux / api.video / Gumlet | Managed video SaaS | All converge on ~$0.003/min stored and $0.001–0.0017/min delivered, each with a $99–100/month DRM floor. Better than Stream, not transformative. api.video charges **€60/month per additional custom domain**, which is fatal for Atlas's multi-tenant model |

### 4.3 The R2 access-control choice is the real design decision

R2 offers three mutually exclusive paths, and they differ far more than their cost does:

| | Presigned URL | Custom domain + WAF token | **Custom domain + Worker** |
|---|---|---|---|
| CDN caching | **No** — presign works only on the S3 API domain and *cannot* be used with custom domains | Yes | Yes |
| Binds to | **Time only** (bearer token) | Path/prefix + expiry | **Anything Atlas chooses** |
| Revoke before expiry | **No** | Only by rotating the zone secret (whole-zone blast radius) | **Yes, per request** |
| Cost | $0 | Cloudflare Pro $25/mo | Workers Paid $5/mo, 10M requests included |
| Gotcha | No CDN at all | Token in the query string defeats the default cache key; the fix ("ignore query string") is available on **all plans** — this row originally said Enterprise-only, which the Worker spike found to be out of date | Every segment request runs the Worker |

**This is the correction that most changes the picture.** My own empirical probe (§5.3) validated the presign path — and the presign path turns out to be the weakest of the three, because it forgoes the CDN entirely. The Worker path is what makes the basic tier both cheap and genuinely enforceable.

---

## 5. Cost comparison

### 5.1 At Atlas's own Enterprise quota

5,000 minutes stored, 150,000 minutes delivered per month. Bitrate assumptions are engineering estimates, not vendor figures.

| Option | Storage | Delivery | Fixed | **Total/mo** |
|---|---|---|---|---|
| **Cloudflare Stream (secure tier)** | $25.00 | $150.00 | — | **$175.00** |
| **R2 + CF CDN + Worker (recommended basic)** | $3.35 | $0.00 | $5.00 | **$8.35** |
| Bunny Stream (Volume network) | $0.55 | $8.24 | — | $8.79 |
| S3 + CloudFront flat-rate Pro | $3.99 | $0.00 | $15.00 | $18.99 |
| R2 + CF CDN + WAF token (CF Pro) | $3.35 | $0.00 | $25.00 | $28.35 |
| Bunny Stream (Standard, MEA) | $0.55 | $98.88 | — | $99.43 |

### 5.2 What the table shows

Delivery is the entire game. Stream's $150 delivery charge collapses to $0 on R2 because egress is free and the Cloudflare CDN in front of it is the sanctioned path. Storage differences are noise by comparison.

### 5.3 One assumption verified empirically rather than assumed

Range support and private-by-default behaviour are load-bearing for any object-storage tier, so they were tested against the real S3 protocol using the same client the application uses, rather than taken from documentation:

```
presigned GET              → 200, accept-ranges: bytes
Range: bytes=500000-500099 → 206, content-range: bytes 500000-500099/1000000
unsigned GET               → 403
signed URL with key swapped→ 403
```

Seeking works, the object is not publicly readable, and the signature covers the key. Note the scope of this result: it validates the **presign** path, which §4.3 then argues against on CDN grounds. It says nothing about the Worker path, which must be validated separately.

### 5.4 The cost this recommendation adds

R2 stores bytes; it does not encode them. Atlas would inherit the entire pipeline Stream provides free: ffmpeg → ABR ladder → HLS packaging → thumbnails → WebVTT captions, plus a job queue, failure handling and reconciliation. On a single small VPS that is roughly 1–3 hours of near-full CPU per hour of source for a three-rendition ladder (estimate), competing with the API and the database.

Two mitigations, either of which is sufficient:
- Queue transcoding to an ephemeral worker so the VPS is never on the encode path.
- Ship the basic tier as **single-rendition 720p with no ABR ladder**, which removes most of the CPU burden and most of the storage, at the cost of adaptive bitrate — a difference that belongs in the capability matrix anyway.

---

## 6. Security capability matrix

Honest throughout. Neither tier has DRM: Cloudflare Stream does not offer it at all, which is consistent with decision D1.

| Capability | BASIC (R2 + Worker) | SECURE (Cloudflare Stream) |
|---|---|---|
| Authentication required | **Yes** — Atlas | **Yes** — Atlas |
| Enrollment checked | **Yes** — same seven conditions | **Yes** — same seven conditions |
| Academy isolation | **Yes** — same RLS, same key prefixing, same cross-academy signing refusal | **Yes** — identical |
| Course / lesson entitlement | **Yes** — `can_access_lesson()` | **Yes** — identical |
| Signed access | Yes | Yes |
| Short-lived credential | Yes (≤10 min, refreshed) | Yes (≤2 h) |
| **Bound to session** | **No at the edge** *(corrected)* — the delivery host is cross-site from the academy, so no session reaches it; Atlas enforces at grant issue only | **No at the edge** (D-5) — Atlas enforces at grant issue only |
| **Bound to device** | **No at the edge** *(corrected)* | **No at the edge** (D-5) |
| **Revocation before expiry** | **Yes — per request**, once the revocation list is wired. Prompt, not instant: bounded by denylist propagation (the spike measured up to ~1 min) plus the gate's short cache | **No** — only by revoking a signing key, which invalidates every token minted with it |
| Origin restriction | Via WAF rule (`Origin` is forgeable outside a browser) | `allowedOrigins` on the asset (same forgeability caveat) |
| Concurrent-session limit | Atlas lease — identical | Atlas lease — identical |
| Watermark | Client-side overlay, or burned in at encode | Client-side overlay, or provider watermark profile |
| Download protection | Deterrents only | Deterrents only; `downloadable` never set |
| HLS | Yes, if Atlas packages it | Yes, provider-produced |
| **Adaptive bitrate** | **Only if Atlas builds the ladder** | **Yes, free** |
| Captions / thumbnails | Atlas builds | Provider produces |
| Encoding | **Atlas's cost** | **Free** |
| Playback analytics | Atlas builds | Provider provides |
| Screenshot / screen-record deterrence | None possible | None possible |

### 6.1 What neither tier can claim

A signed URL is a bearer credential. Within its lifetime, anyone holding it can fetch the bytes — `ffmpeg -headers` and `yt-dlp` forge `Origin`, `Referer` and `User-Agent` freely. Screen recording is unstoppable without hardware DRM, and neither tier has DRM. Manifest and segment URLs are visible in devtools by construction.

**Both tiers may truthfully claim:** entitlement checked on every request, short-lived credentials, not publicly listed or indexable, per-viewer watermark.
**Neither may claim:** "cannot be downloaded", "DRM-protected", "piracy-proof".

### 6.2 The honest difference between the tiers

Given D-5 — and given the correction above, which found the same gap on the basic tier — **neither tier binds to a session or device at the delivery edge**. Both enforce identity when the grant is issued and neither re-checks it per request. The secure tier's advantage is therefore **not** stronger cryptographic binding. It is:

- free provider-side transcoding, ABR, captions and thumbnails;
- provider-side origin restriction on the asset;
- a managed delivery platform Atlas does not operate.

And the basic tier's advantage — genuinely, and now the only one — is **revocation before expiry**: a ten-minute credential plus a per-request revocation check, against Stream's two hours and a signing-key-wide kill switch. That is real, and it is narrower than this document originally claimed.

Sell them as **self-managed versus platform-managed delivery**, not as "less secure versus secure". Selling the basic tier as insecure would misrepresent it; selling the secure tier as device-bound would misrepresent it more.

---

## 7. Provider abstraction analysis

### 7.1 What already works

The most important finding of this investigation is that **the two files that decide authorization contain no provider knowledge at all**, verified by grep rather than by reading their own comments:

- `LessonContentService` (`src/learning/services/lesson-content.service.ts:110-332`) never reads `media_assets.provider`. Its only asset-derived branch is `processingStatus !== 'ready'` (`:401`), a lifecycle property every provider shares.
- `ContentGrantSigner` (`src/learning/services/content-grant.signer.ts:40-127`) branches only on `asset.access` (`:74`) and on whether a `providerId` exists (`:102`), then delegates (`:107`).

Every Phase 2 RLS policy — migration `:364-414`, `:458-496`, `:531-571`, `:627-661`, and `can_access_lesson()` at `:277-341` — reaches `media_assets` only through foreign keys. **No policy mentions the table.** The gate is the lesson, never the asset. The same holds for the device registry, the lease, the access log and the audit trail.

The requirement "Atlas authorization must not become provider-specific" is therefore **already satisfied by the parts that matter**. The work is in plumbing.

### 7.2 Where it is coupled

**Four closed unions**, each of which must be widened for a third adapter to compile:

| # | Location | What it closes |
|---|---|---|
| 1 | `src/media/video/video-provider.interface.ts:165` | `key: 'fake' \| 'cloudflare_stream'` — **on the interface itself** |
| 2 | `src/config/configuration.ts:136` | `VIDEO_PROVIDER_KEYS` |
| 3 | `src/config/env.validation.ts:275` | the `z.enum` |
| 4 | `prisma/schema.prisma:2343-2348` | the `media_asset_provider` enum |

**Six `provider === 'cloudflare_stream'` sites in TypeScript — and zero in SQL:**

| # | Location | Kind |
|---|---|---|
| 1 | `protected-media.service.ts:227` | **write** — hardcoded literal (D-1) |
| 2 | `video-reconciliation.service.ts:54` | filter |
| 3 | `video-reconciliation.service.ts:119` | filter |
| 4 | `entitlement-enforcement.service.ts:367` | filter — **quota enforcement** |
| 5 | `tenant-usage-recompute.service.ts:168` | filter — **usage reporting** |
| 6 | `media.module.ts:120` | adapter-selection ternary |

Items 4 and 5 are two independent implementations of the same aggregate. They must change together, or enforcement and the Usage page will tell a customer different numbers.

**One Cloudflare-shaped configuration object.** `VideoProviderConfig` (`configuration.ts:157-168`) is a flat bag of Cloudflare field names that both adapters read; `FakeVideoProvider` keys its HMAC on `CLOUDFLARE_STREAM_WEBHOOK_SECRET`. A second provider's credentials have nowhere to live except more flat fields on the same interface.

**One provider-named webhook surface.** Route `/webhooks/video/stream`, header `webhook-signature` bound *at the controller* so an adapter never sees a differently-named header, and a Cloudflare payload shape parsed by both adapters.

### 7.3 Fit for an R2-backed adapter

Of the ten interface members, measured against a Worker-gated R2 adapter:

| Member | Verdict |
|---|---|
| `key` | **Blocking** — closed union |
| `capabilities()` | Fits — but has **zero production callers**, so an honest answer changes nothing today |
| `isConfigured()` | Fits |
| `createDirectUpload` | **Two fields cannot be honoured** — see below |
| `issuePlaybackToken` | Fits, and honours the binding *better* than the Cloudflare adapter does (§6) |
| `fetchAsset` | Meaningless — no remote to poll |
| `deleteAsset` | Fits; uncalled today |
| `verifyWebhookSignature` | Dishonest — the only safe implementation is `return false` |
| `parseWebhookEvent` | Meaningless — always `null` |
| `syncAllowedOrigins` | Meaningless — origin control is zone-level, not per-object; uncalled today |

Two fields cannot be honoured and must become capability-gated rather than silently dropped:

1. **`maxDurationSeconds`.** Its own documentation says the provider refuses anything longer *"so the reservation cannot be exceeded"*. An S3 presigned PUT can bound `Content-Length`; it cannot bound runtime minutes. An R2 adapter would accept the field and not honour it — breaking the quota guarantee the field exists to provide.
2. **`allowedOrigins`.** Meaningless per-object on R2; origin restriction is a zone/WAF concern. `FakeVideoProvider` already demonstrates the silent drop — it stores the list in a `Map` nobody reads.

### 7.4 Dead interface surface

`capabilities()`, `syncAllowedOrigins`, `deleteAsset` and `fetchAsset` (reachable only from the uncalled `pollStalled`) have **zero production callers**. This inflates what a second adapter must implement for no delivered behaviour — and, more seriously, `capabilities()` is the mechanism the interface's own header names as *the* way to avoid branching on a provider, and nothing consults it. §8.2 makes it load-bearing.

### 7.5 Verdict

**The abstraction is sufficient, with three additive changes and one widening.** It was designed for this; what it was not designed for is an adapter that finalises synchronously and has no webhook, which is §8.3.

---

## 8. Proposed multi-provider architecture

Three separations, all additive, plus the five defect fixes.

```
                        Atlas authorization  (unchanged)
                                 │
                LessonContentService — seven conditions   (unchanged)
                                 │
                       ContentGrantSigner                 (unchanged shape)
                                 │
                    VideoProviderRegistry      ← replaces a ternary
                     ├── resolve on UPLOAD   by academy security tier
                     └── resolve on PLAYBACK by media_assets.provider
                                 │
        ┌────────────────────────┴────────────────────────┐
   CloudflareStreamProvider                        BasicVideoProvider
   (tier: secure)                       (tier: basic — R2 + CDN + Worker gate)
```

### 8.1 Separation one — security tier is not provider

- **`provider`** — a *storage fact*: where the bytes live. Already modelled; needs D-1 fixed so it is true.
- **`securityTier`** — a *product promise*: `basic` | `secure`.

They must be separate because the tier is a commercial concept that has to survive a change of provider. If Atlas later moves the basic tier off R2, every customer's promise is unchanged while every asset's provider changes; collapsing them would make that a customer-facing event.

The tier is recorded in **two** places — on the academy (what new uploads get) and on the asset (what this video actually is). The second is not redundant: an academy that upgrades still has old videos on the old path until migrated, and a learner asking "is this protected?" must be told the truth about *that video*.

### 8.2 Separation two — capability-honest grants

`LessonContentGrantResponse.protection` is currently `'protected' | 'unprotected'`, derived solely from whether the content is an external embed. **Both tiers would report `protected`** — and, given D-5, so would a Stream asset whose device binding the edge never checks. That is a contract gap, not a cosmetic one.

The fix makes `capabilities()` load-bearing for the first time: the grant reports what is *actually* enforced for this asset, read from the adapter.

```
protection: {
  tier: 'basic' | 'secure',
  signedUrl: true,
  expiresInSeconds: number,
  boundToSession: boolean,     // true for Worker-gated basic; FALSE for Stream (D-5)
  boundToDevice: boolean,      // likewise
  revocableBeforeExpiry: boolean,
  originRestricted: boolean,
  watermark: boolean,
  adaptiveBitrate: boolean,
}
```

Note what this surfaces: on two of these flags the basic tier scores **higher** than the secure tier. That is the honest result, and hiding it would be the dishonest one.

### 8.3 Separation three — readiness must not assume a webhook

Add `VideoProviderCapabilities.reportsReadinessAsynchronously`. When `false`, the upload finalises through a new additive endpoint:

```
POST /academies/:id/media/video-uploads/:assetId/complete
```

which verifies the object landed, resolves its real duration, and transitions `processing → ready`. The Cloudflare path is untouched. This closes D-4 and removes the webhook trio from the set of methods a synchronous adapter must pretend to implement.

**Duration is the open technical question.** Cloudflare measures it; R2 does not. In ascending cost:

1. **Trust the declared duration** — rejected: it makes `videoStorageMinutes` self-reported and therefore gameable, defeating D5.
2. **Parse the MP4 `mvhd` box via a ranged read** — cheap, no transcoding; fails on files whose `moov` atom is at the end, which is common for unprocessed uploads. **Needs validation before being relied on.**
3. **`ffprobe` in the existing media worker** — always correct, costs CPU.

Recommendation: attempt (2), fall back to (3), record which source produced the figure. Never fall back to (1) silently.

### 8.4 The TTL conflict is a requirement, not a bug

Defect D-3 is the surface of a real constraint:

| | Secure (Stream) | Basic (R2) |
|---|---|---|
| Credential lifetime | 2 h, honoured by the provider | ≤1 h ceiling, 10 min default |
| Revocation latency | up to 2 h (key revocation only) | **≤10 min, or immediate with the Worker** |

A 90-minute lecture on the basic tier cannot be served by one credential under the current ceiling. Two ways out:

- **(a) Raise the ceiling for video** — weakens a deliberate default.
- **(b) Keep the short credential and make grant refresh mandatory for the basic tier.**

**(b) is correct**, and it is already specified: `POST …/playback/refresh` appears in the Master Plan's own §L API list and simply had not been implemented. Load check: a 90-minute lesson refreshing every ~9 minutes costs ~10 grants; the limiter allows 120 per 10 minutes per learner, so no change is needed.

### 8.5 The registry

`media.module.ts:114-121` binds one adapter with a binary ternary. Leaving it is worse than replacing it: a new enum value would silently resolve to `FakeVideoProvider`, which throws only in production. It becomes a keyed registry resolving **by academy tier on upload** and **by `media_assets.provider` on playback**. The in-repo precedent for the shape already exists in `src/billing/providers/payment-provider.registry.ts:31-46`. All four injection sites change. This is the one unavoidably structural change.

---

## 9. Product / plan mapping options

| Option | For | Against |
|---|---|---|
| **A. By plan only** | Simplest to sell; upgrade is the existing subscription flow | An academy that does not need protection overpays; a plan change silently re-tiers existing video |
| **B. Per academy, entitled by plan** | The academy is the contracting unit with one brand and one owner; D8 already puts protection settings in that owner's hands | An organisation with several academies sets it per academy |
| **C. Per course** | Real use case: free intro on basic, flagship on secure | Two quota units in one academy; learners get inconsistent protection with no explanation |
| **D. Per video** | Maximum flexibility | Nobody — including support — can answer "is my content protected?" |
| **E. Platform policy** | Needed regardless, as a ceiling | Not sufficient alone |
| **F. Plan tier + add-on upgrade** | Monetises the upgrade without a plan change; `AddOnFeatureEffect` already exists | One more moving part in billing |

**Recommendation: E → A → B**, resolved most-specific-first, with F available later as the commercial lever.

Not a preference: **this is the resolution order the codebase already implements and has already reviewed.** `AccessPolicyService` resolves the device policy academy → plan → platform, clamped to the platform maximum. Reusing that shape means one way to reason about how a ceiling, an entitlement and a choice combine.

---

## 10. Migration strategy

**Basic → Secure (upgrade) — feasible.** Atlas holds the R2 object and Stream can ingest from a URL, so Atlas hands Stream a short-lived signed R2 URL and lets it pull server-side: asynchronous, no customer re-upload, no bytes through the VPS.

**Secure → Basic (downgrade) — blocked, and this is a business decision.** Getting the original back out of Stream requires a download, and Atlas deliberately never sets `downloadable`. Stream exposes a separate downloads API, but whether it is usable for an asset created with `requireSignedURLs` and no `downloadable` flag is **unverified** and must be confirmed with the provider. If unavailable, the honest position is that **a secure-tier video cannot be downgraded; only new uploads land on the new tier** — which must be decided and communicated before a downgrade is ever sold.

**Coexistence and rollback.** Per-asset `provider` makes mixed state normal. A tier change affects **new uploads only**; existing assets keep their provider until explicitly migrated, so rollback of a tier change is free.

**Prerequisites.** Record the tier an asset was *created* under; record which migration produced an asset so retries are idempotent; and note that `course_lessons.video_asset_id` **has no write path anywhere in `src/`** — migration cannot be designed until the authoring endpoint makes that link writable.

---

## 11. Multi-tenancy implications

No RLS change. Two tenancy properties must be carried into the basic tier deliberately:

- **Object-key prefixing.** `ProtectedMediaStorage.objectKey` already prefixes by academy and course from verified context; the basic tier uses the same helper.
- **Cross-academy signing refusal.** `ContentGrantSigner.signVideo` refuses when `asset.academyId !== binding.academyId`. Provider-independent, and must remain in front of both adapters — it is the one place Atlas guarantees it will never mint a cross-tenant capability.

---

## 12. Database / schema implications

All additive; Phase 2's migration has not been applied to production, so nothing is destructive.

| Change | Shape |
|---|---|
| `media_asset_provider` gains a value | `ALTER TYPE … ADD VALUE` (note Postgres's in-transaction restrictions) |
| New `security_tier` enum | `basic` \| `secure` |
| `media_assets.security_tier` | nullable/defaulted |
| Academy tier setting | a key beside `content_protection`, or its own column |
| Plan entitlement for the secure tier | a new `PlanFeatureKey`, following `PLAN_FEATURE_KEYS`, with a catalog backfill exactly as the Phase 2 migration already does for `videoStorageMinutes` |
| Duration provenance | a small column: measured / parsed / declared |

**One open data decision.** The byte aggregate feeding `videoStorageGb` has *no* provider filter, and provider-hosted video contributes zero bytes today because `sizeBytes` is written as `BigInt(0)`. A basic-tier MP4 genuinely in R2 would have a real size — so it would count against `videoStorage` (GB) *and* should count against `videoStorageMinutes`.

Recommendation: **minutes only, for both tiers.** Minutes is the unit the product sells and the unit D5 defines; charging one tier against two quotas makes the tiers incomparable to a customer choosing between them. The counter-argument is real and now has a concrete basis — R2 bills by gigabyte, so GB is the basic tier's actual cost driver — which is why this is listed as an open business decision rather than settled here.

---

## 13. API implications

| Endpoint | Change |
|---|---|
| `POST …/media/video-uploads` | Resolves the adapter by academy tier; response reports the tier reserved against |
| `POST …/media/video-uploads/:assetId/complete` | **New** — synchronous readiness (§8.3) |
| `POST …/playback/refresh` | **Already in §L**, not yet built; becomes **mandatory** for the basic tier (§8.4) |
| `GET …/lessons/:lessonId/content` | `protection` widens to the capability object (§8.2) — breaking, and correct |
| `PATCH /academies/:id/video-tier` | **New**, owner-only, bounded by plan entitlement and platform ceiling |
| `POST /webhooks/video/stream` | Unchanged; a no-webhook adapter never fires it |

---

## 14. Frontend implications

Smaller than expected, and a genuine argument in the basic tier's favour.

The current lesson page already plays video in a native `<video>` element (`LessonPage.tsx:257-264`) and the repository has **no `hls.js` dependency at all**. A basic tier serving progressive MP4 needs **no new player technology**, and §5.3 confirms Range requests work, so seeking works. `PlaybackDescriptor.format: 'hls' | 'mp4'`, already added in Phase 2, is exactly the discriminator the player branches on.

One real constraint from the research: **iOS Safari's ManagedMediaSource makes hls.js on iPhone a trap**, and native HLS via `<video src="…m3u8">` is the safe path. If the basic tier ever ships HLS rather than progressive MP4, it must be HLS and not DASH.

What does change:
- The player must handle **grant refresh mid-playback** without interrupting the video (§8.4) — the largest new frontend piece.
- The protection badge must report the capability object honestly, including saying plainly when playback is **not** bound to the device — which, per D-5, is the *secure* tier.
- Staff UI needs an owner-only tier selector and tier-aware quota messaging.

---

## 15. Testing implications

- **Unit:** a capability-matrix test asserting each adapter reports what it can actually do — in particular that the Cloudflare adapter reports `boundToDevice: false` (D-5) rather than inheriting an aspiration from a comment.
- **Unit:** a regression test for D-3 — a grant's `expiresAt` must never exceed the real lifetime of the URL inside it.
- **Unit:** a test that `media_assets.provider` records the acting adapter (D-1).
- **Integration:** quota counted across both providers, with the two independent aggregates asserted to agree.
- **Integration:** basic-tier playback survives a refresh cycle; entitlement revoked mid-lesson stops playback within the credential's life.
- **RLS:** unchanged — the existing spec already proves the gate is the lesson.
- **Chrome:** the matrix run on **both** tiers; no durable URL on either; an expired basic URL recovers silently.

---

## 16. Observability

Phase 2's metrics stay, with a `tier` label on `content_grants_total` and `video_token_mint_duration_ms` so the tiers can be compared rather than averaged.

New: `video_upload_completions_total{tier,result}` (the synchronous path has no webhook to alert on); a duration-provenance counter (a rise in "declared" means the quota is drifting toward self-reported); and grant-refresh rate per learner, which is both the basic tier's expected load and the signal that would reveal a TTL misconfiguration.

**Forensic gap:** `content_access_log` deliberately stores no asset or provider, so once two tiers coexist it cannot answer "which tier delivered this?". Small change; decide explicitly.

---

## 17. Rollout

1. Land the five defect fixes and the registry — no behaviour change, since no tier is enabled anywhere.
2. Enable the **basic** tier on the internal canary academy. It depends on nothing that does not already exist, so it can be exercised immediately.
3. Enable the **secure** tier only once Cloudflare Stream onboarding is genuinely complete (Phase 2 §S already requires this; it is not done).
4. Rollback for either tier is the flag, and costs nothing because existing assets keep their provider.

**Production is unaffected either way today:** no `VIDEO_PROVIDER`, no `CLOUDFLARE_STREAM_*`, no Phase 2 flag set. Every flag defaults `off` and the provider defaults to the local `fake` adapter, which refuses to run under `NODE_ENV=production`.

---

## 18. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| **D-5 shipped as-is:** the secure tier is sold on a device-binding guarantee its edge does not enforce | **High** | §8.2's capability-honest grant; correct the interface comment; never report a protection that is not enforced |
| A basic tier is sold as "protected" without qualification | **High** | Same mechanism; §6.2's self-managed/platform-managed framing |
| Secure → Basic proves impossible after a downgrade is sold | **High** | Verify with the provider *before* offering it (§10) |
| Atlas inherits the transcoding pipeline and it lands on the VPS | **High** | Queue to an ephemeral worker, or ship single-rendition 720p (§5.4) |
| Quota diverges between the two aggregate implementations | Medium | Change both together; assert agreement in an integration test |
| D-1 shipped as-is makes per-asset resolution untrustworthy | Medium | Prerequisite fix, before any second adapter |
| Duration becomes self-reported on the basic tier | Medium | §8.3's parse-then-probe, never silent trust |
| Worker request costs scale with segment count | Low–Medium | 10M requests included at $5/mo; cache carefully; or ship progressive MP4, which has one request per playback |
| Two tiers double the validation surface | Low | Capability-matrix tests rather than duplicated end-to-end suites |

---

## 19. Recommendation

**Proceed with two tiers.**

| | Choice |
|---|---|
| **BASIC** | Cloudflare R2 + Cloudflare CDN on an Atlas-owned domain, gated by a Worker validating an Atlas-minted token |
| **SECURE** | Cloudflare Stream, unchanged |

Five reasons, in order of weight:

1. **~95% cost reduction on the dominant line item** — ~$8/month against ~$175/month at the Enterprise quota — because R2 egress is free and the CDN in front of R2 is the contractually sanctioned path.
2. **It is the only cheap option that is licence-clean.** The VPS route and B2 + Cloudflare both host video "outside of Cloudflare" and are restricted by Cloudflare's own terms.
3. **Near-zero new architecture.** `VideoProvider` and `capabilities()` exist for exactly this; `ProtectedMediaStorage` already talks to R2; the plan's `format` discriminator already anticipates two playback shapes.
4. **The Worker gate restores what a presign cannot do** — per-request entitlement, session binding, and revocation before expiry — and in doing so gives the basic tier *stronger* enforcement than Stream on those axes (§6).
5. **Single vendor, single bill, and free migration out**, since R2 egress is free.

**The two strongest arguments against, stated plainly:**

1. **Atlas inherits the entire transcoding pipeline.** This is the largest hidden cost in the recommendation, and on a single small VPS it is not affordable without either an ephemeral worker or dropping the ABR ladder. Bunny and Stream both do this for free.
2. **The Worker path is the one part of this recommendation that has not been validated.** §5.3's probe tested presigned R2 — which §4.3 then argues against. Before committing, the Worker gate needs a spike: per-segment cost at realistic HLS segment counts, cache behaviour, and whether cookie-carried tokens behave as assumed.

**Runner-up worth a second look:** S3 + CloudFront flat-rate Pro ($15/month, 50 TB egress, no overage) with signed cookies — the only option with a documented, IP-bindable, HLS-appropriate credential and airtight origin lockdown. Roughly 2× the cost and a second vendor, but the best-specified access control of anything researched.

---

## 20. Exact Master Plan amendment

Every change below is stated as a precise edit. **None has been applied** — this document is the proposal, per the instruction not to silently rewrite the plan.

### 20.1 Approved Decisions

**D1 — amend.** Current text commits to "Cloudflare Stream with mandatory signed tokens … and a provider abstraction with capability flags".

> Replace *"Use Cloudflare Stream with …"* with: *"Atlas ships **two video security tiers**. **Secure** uses Cloudflare Stream with mandatory signed tokens, short-lived authorization, allowed origins, entitlement checks at academy/course/lesson level, watermarking and device binding. **Basic** uses Atlas-owned object storage with short-lived signed URLs and the same Atlas entitlement checks, and deliberately does **not** provide session/device binding, origin restriction or adaptive bitrate. Neither tier uses DRM. The tier a grant was issued under, and exactly which protections it enforces, are reported to the client rather than assumed."*

The final sentence is the load-bearing one: it is what prevents Atlas from telling a basic-tier customer their content has protections it does not have.

**D5 — amend for tier-independence.** Current text is already careful that quotas are Atlas entitlements, not Cloudflare billing. Two additions:

> Append: *"`videoStorageMinutes` is **provider- and tier-independent**: it counts every minute of Atlas-hosted video regardless of which tier delivers it. Basic-tier video does **not** additionally consume `videoStorage` (GB); minutes is the single unit for provider-hosted video, so the two tiers remain directly comparable to a customer choosing between them. Where a provider does not report a measured duration, Atlas derives it and records how it was obtained — a declared duration is never silently trusted."*

**D-new (proposed D10) — tier selection.**

> *"The video security tier resolves most-specific-first: **platform ceiling → plan entitlement → academy choice**, the same resolution `access_policies` already uses for the device policy. The Client Owner selects the tier within what the plan entitles (D8). The tier governs **new uploads only**; existing assets keep the tier and provider they were created under until explicitly migrated."*

### 20.2 Architecture Decisions

**AD-1 — amend.** Current: *"Cloudflare Stream and R2 are delivery layers…"*

> Replace with: *"Atlas is the sole authorization authority; **every video provider** is a delivery layer that only honours capabilities Atlas signs. Video bytes are never proxied through the backend, on any tier."*

The phrase "on any tier" is deliberate: it forbids the tempting shortcut of serving basic-tier video from the VPS.

**AD-7 — replace.** Current text names `CloudflareStreamProvider` as *"the only production implementation"* — the single line most directly contradicted by the new requirement — and lists capability flags that were never consulted.

> Replace with: *"**Video provider abstraction.** `VideoProvider` with `capabilities()` reporting what is actually enforced (`signedPlayback`, `boundToSession`, `boundToDevice`, `originRestricted`, `staticWatermark`, `adaptiveBitrate`, `drm`, `downloads`, `reportsReadinessAsynchronously`, `enforcesMaxDuration`). A **registry** resolves the adapter by academy tier on upload and by `media_assets.provider` on playback. Production implementations: `CloudflareStreamProvider` (secure) and `BasicVideoProvider` (basic). Capability flags are **consumed** — the content grant reports them to the client — not merely declared."*

**AD-14 — amend.** Add to the quota model:

> *"Usage counts **all** providers. The two independent aggregates (enforcement and usage reporting) must be changed together and asserted to agree. Reservations are counted; a reservation released by a failed upload stops counting."*

**AD-new (proposed AD-15) — tier is not provider.**

> *"`media_assets.provider` records **where the bytes are** (a storage fact). `security_tier` records **what Atlas promised** (a product fact). They are separate so the basic tier can change provider without changing any customer's promise, and so a learner can be told the truth about an individual video rather than about their academy's current subscription."*

### 20.3 Phase 2 sections

| Section | Change |
|---|---|
| **C. Dependencies** | Cloudflare Stream onboarding becomes a dependency of the **secure tier only**. The basic tier depends on nothing that does not already exist, so Phase 2 is no longer blocked on provider onboarding. |
| **D.4 Video provider** | Rewrite around the registry and two adapters; add the synchronous-readiness completion path; make `capabilities()` load-bearing. |
| **D.5 Quota** | Tier-independent minutes; duration provenance. |
| **F. Database** | `security_tier` enum and column; academy tier setting; plan entitlement key; duration provenance. |
| **I. Security** | State the tier difference explicitly, including that the basic tier **revokes faster** (≤ 10 min vs up to 2 h) because a short credential is the only thing enforcing it. |
| **L. API** | Add the upload-completion endpoint and the tier PATCH; note `playback/refresh` (already listed) becomes **mandatory** for the basic tier. |
| **E.3 Player** | Grant refresh mid-playback becomes a hard requirement, not an optimisation; the protection badge reports the capability object. |
| **M–P. Tests** | Capability-matrix tests; the `expiresAt` honesty regression; cross-provider quota agreement. |
| **Q. Chrome validation** | Run the matrix on **both** tiers. |
| **S/T. Rollout** | `video.stream` becomes a tier selection; the basic tier can canary immediately, the secure tier waits for onboarding. |
| **U. Observability** | `tier` label on grant metrics; upload-completion counter; duration-provenance counter; refresh rate. |
| **V. Acceptance** | Add: no learner-facing response overstates the protection actually enforced. |

### 20.4 Phase 1

**No change.** Phase 1 delivered identity, the principal model, surface-aware auth, enrollment lifecycle and review RBAC. None of it references video, a provider, or `media_assets`. No architectural dependency was found in either the audit or my own inspection, so there is no reason to reopen it.

---

## 21. Decision Log changes

| ID | Entry |
|---|---|
| **DL-new** | Two video tiers approved in principle; exact provider for the basic tier pending §19's recommendation and owner sign-off. |
| **DL-new** | `videoStorageMinutes` confirmed tier-independent; basic-tier video excluded from the GB quota so the tiers stay comparable. |
| **DL-new** | Tier resolution follows the existing `access_policies` order (platform → plan → academy). |
| **DL-new** | **Secure → Basic downgrade is unverified and possibly impossible.** Must be confirmed with the provider before any downgrade is offered commercially. |
| **DL-new** | Basic-tier playback requires grant refresh; the credential ceiling is deliberately **not** raised to accommodate long lessons. |
| **DL-new** | **D-5 recorded:** Cloudflare Stream does not enforce Atlas's session/device claims at its edge (`accessRules: any/allow`). Device binding on the secure tier is enforced at grant-issue time only. The tiers' marketing must reflect this. |
| **DL-3** | Unchanged — the Starter/Growth/Enterprise mapping is unaffected by tiering. |

---

## 22. Open business decisions

These are the owner's, not mine. Each blocks something specific.

1. **How are the two tiers described to customers?** Given D-5, the honest difference is *self-managed versus platform-managed delivery*, not *less secure versus secure* — and on session binding and revocation the basic tier is the stronger of the two. Both are entitlement-checked; neither has DRM; a signed credential is a bearer token for its lifetime on both. The wording matters legally and commercially. *Blocks: marketing copy, the protection badge's text, and the pricing rationale for the secure tier.*
2. **Is a downgrade (secure → basic) ever offered?** If yes, §10.2 must be verified with Cloudflare **first**. If it turns out to be impossible, that has to be a published limitation rather than a discovery. *Blocks: the migration feature entirely.*
3. **Which plans entitle the secure tier** — bundled with a tier, or an add-on upgrade (option F)? *Blocks: the plan catalog change and the entitlement key.*
4. **Does the basic tier consume the same `videoStorageMinutes` allowance, or its own (larger) one — and is it metered in minutes or gigabytes?** A cheaper tier with the same allowance is a weak upsell. §12 recommends minutes for both, for comparability; the counter-argument is that R2 bills by gigabyte, so GB is the basic tier's real cost driver. *Blocks: the plan catalog values.*
5. **Is adaptive bitrate a secure-tier-only feature?** Shipping the basic tier as single-rendition 720p removes most of the transcoding cost (§5.4) and is the difference that most justifies the secure tier's price. *Blocks: nothing now; determines whether Atlas needs a transcoding pipeline at all.*

7. **Is the Worker spike approved before committing?** §19's second counter-argument: the recommended delivery path is the one part of this proposal that has not been validated. *Blocks: committing to R2 + Worker rather than the CloudFront runner-up.*
6. **Retention of the tier in the access log** — useful forensically, one more field of learner activity retained. *Blocks: nothing; decide before two tiers coexist.*

---

## Appendix A — Reconciliation against the Phase 2 code already written

The question this appendix answers: **is the work already done still architecturally valid, and how much of it survives the proposal above?**

**Verdict: yes, it is valid. Roughly 90% stays untouched. Nothing needs to be thrown away.**

The reason is structural rather than lucky: the coupling never reached the policy layer. The files that decide authorization were written against the lesson and the enrollment, not against the asset or the provider, and that is what makes a second provider an addition rather than a rewrite.

### A.1 Stays unchanged — do not touch

Every one of these was checked for provider knowledge and has none.

| Area | Files |
|---|---|
| **The whole policy decision point** | `lesson-content.service.ts` — the seven conditions, the refusal vocabulary, the refusal→HTTP mapping, the staff-preview path, the access logging |
| **Every RLS policy and `can_access_lesson()`** | the Phase 2 migration — zero provider references in SQL |
| **The protected object tier** | `protected-media-storage.provider.ts` — the separate bucket, the key prefixing, the presign clamp |
| **Device registry, lease, takeover** | `student-device.service.ts`, `access-policy.service.ts`, `learning-lease.service.ts`, `learner-session.service.ts` |
| **Playback evidence and progress** | `playback-evidence.util.ts`, `playback.service.ts`, the completion gate and undo in `course-progress.service.ts` |
| **Sequence and curriculum projection** | `course-sequence.service.ts`, `course-content.service.ts`, the lesson/section contracts |
| **Learner dashboard** | `learner-dashboard.service.ts`, its contracts and controllers |
| **Owner-only settings** | `academy-protection.service.ts`, `content-protection.contract.ts` |
| **Rate limiting, access log, flags** | `content-grant.rate-limiter.ts`, `content-access-log.repository.ts`, `feature-flags.service.ts` |
| **All 1,079 backend unit tests and 523 frontend tests** | unchanged |
| **The entire frontend learner shell, routes, D2 redirects and i18n** | provider-independent by construction |

### A.2 Needs a behaviour-preserving edit

| Change | Why |
|---|---|
| Widen four closed unions (`key`, `VIDEO_PROVIDER_KEYS`, the `z.enum`, the Prisma enum) | Type-level only; a third adapter cannot compile otherwise |
| `media.module.ts:114-121` ternary → keyed registry | A new enum value currently resolves silently to the fake adapter |
| Widen the five provider filters (items 2–5 of §7.2, plus the module) | Quota and reconciliation must count both providers; items 4 and 5 **must change together** |
| `VideoProviderConfig` → nested per-provider credentials | A second provider's credentials have nowhere to live today |

### A.3 Must be fixed regardless of this decision

These are defects in the current work, not consequences of the proposal.

| | Fix |
|---|---|
| **D-1** | Write `this.videoProvider.key`, not the literal. **Must land with the filter widenings** or local quota silently reads zero |
| **D-2** | `createDirectUpload` must return a real upload URL |
| **D-3** | Never advertise an `expiresAt` beyond the credential's real life |
| **D-4** | A readiness path that does not require a webhook |
| **D-5** | Correct the interface comment; report `boundToDevice` honestly |

### A.4 Genuinely new work

The `BasicVideoProvider` adapter; the `security_tier` enum, column and academy setting; the plan entitlement key; the upload-completion endpoint; `POST …/playback/refresh` (already specified in §L, never built); the capability object on the grant; duration resolution; and the owner-facing tier selector.

### A.5 Breaking changes, accepted deliberately

1. `PlaybackDescriptor.token` becomes optional — required today, read by nobody.
2. `maxDurationSeconds`' written guarantee weakens to capability-gated.
3. `LessonContentGrantResponse.protection` widens from a two-value union to the capability object — a wire change the frontend routes on, and the correct one, because the current shape cannot express either tier honestly.

### A.6 Sequencing

1. Fix D-1 … D-5 and introduce the registry. No behaviour change; no tier is enabled anywhere.
2. Finish the outstanding Phase 2 work that is tier-independent — the authoring UI (including the `video_asset_id` write path), the player, the retention sweep, the status-poll scheduler, the §U metrics, and binding `/my/courses` to real data.
3. Add the tier model and `BasicVideoProvider`, behind the flags.
4. Canary the basic tier; hold the secure tier until Stream onboarding is genuinely complete.
