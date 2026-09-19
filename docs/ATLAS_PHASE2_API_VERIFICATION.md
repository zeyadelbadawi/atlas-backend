# P64 Phase 2 — Backend API & Integration Verification

**Date:** 19 September 2026
**Scope:** the Phase 2 HTTP surface — protected content grants, the two video tiers, the provider registry, the video-storage quota, and the device/session/sequence/learner endpoints that had to keep working under the new provider architecture.
**Authority:** `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` decisions D5, D10, D11; architecture decisions AD-7, AD-14, AD-15, AD-16; Phase 2 §D, §L, §V. `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` Appendix A.
**Method:** read the implementation, then prove each claim with integration tests against the real application — real Postgres with RLS, real Redis, real MinIO-backed protected bucket, real guards, real DTO validation.

---

## 1. Result

| Suite | File | Tests | Pass | Fail |
|---|---|---|---|---|
| API surface | `test/p64-phase2-api.e2e-spec.ts` | 33 | 32 | 1 |
| Quota | `test/p64-phase2-quota.e2e-spec.ts` | 11 | 11 | 0 |
| Provider independence (unit) | `src/common/p64-phase2-provider-independence.api.spec.ts` | 17 | 17 | 0 |
| **Total** | | **61** | **60** | **1** |

The single failure is **P2-API-2** below: the completion endpoint's response contract. It is a real defect and the test is its regression case.

Two further defects — **P2-API-1** and **P2-API-3** — were found and reproduced during this work and were fixed concurrently by the security-review pass (migration `20261009000300_p64_phase2_media_asset_learner_select`, recorded there as SEC-1 and SEC-2). Both are now covered by regression tests in this suite, so neither can return silently.

**P2-API-4** is an open performance defect with an availability consequence on a core learner endpoint. It is a database-role setting, not application code.

Commands:

```
npx jest --config ./test/jest-e2e.json --testPathPattern "p64-phase2-api"
npx jest --config ./test/jest-e2e.json --testPathPattern "p64-phase2-quota"
npx jest --config jest.config.js --testPathPattern "p64-phase2-provider-independence"
```

---

## 2. Defects

### P2-API-1 — a learner could never see the media asset behind their own lesson (fixed concurrently as SEC-1)

**Where:** `src/learning/services/lesson-content.service.ts:125-128` (`runInUserContext`) against the pre-existing `media_assets` policy set.

`media_assets` had exactly one SELECT policy, `media_assets_tenant_select` (P8), keyed on `app.current_organization_id`. `LessonContentService.getContent` runs the whole decision in `runInUserContext`, which sets only `app.current_user_id`. Every `media_assets` read from the grant path therefore matched zero rows.

Reproduced directly against the running database before the fix:

```
user-context(student)   {"lesson":true,"videoAsset":false,"directRows":0}
tenant-context(org)     {"lesson":true,"videoAsset":true,"directRows":1}
```

RLS does not raise on a filtered row, so `lesson.videoAsset` was simply always `null` and the grant degraded silently: a **video** lesson returned no `video`, `protection.tier: null`, and `signedUrl: true` — overstating the protection actually in force, which is exactly what AD-16 forbids. File lessons returned no `fileUrl`; `content_access_log.security_tier`/`provider` were always null; the signer's cross-academy refusal was unreachable from the learner path.

**Status:** fixed by the concurrent security pass with an additive `media_assets_lesson_access_select` policy plus a `can_access_media_asset()` definer. Verified fixed here.
**Regression coverage added:** `a learner can actually SEE the video asset behind their lesson (§V, AD-16)`, plus every tier/capability test in this suite, which cannot pass while the asset is invisible.

---

### P2-API-2 — the synchronous completion endpoint does not tell the caller the asset became ready (OPEN)

**Where:** `src/media/controllers/protected-media.controller.ts:72` → `toMediaAssetResponse` in `src/media/dto/media-asset.contract.ts:53-74`.

`POST /academies/:id/media/video-uploads/:assetId/complete` exists precisely because the Normal tier has no webhook (§D.4, finding D-4): readiness is established **synchronously, in this call**. The response is `MediaAssetResponse`, which carries none of the outcome:

- no `processingStatus` — the caller cannot tell whether the object was accepted;
- no `durationSeconds` and no `durationSource` — the caller cannot show the measured length, and an operator cannot see from the API whether the quota now rests on a measurement or on the uploader's word (D5's provenance requirement);
- no `securityTier` and no `provider` (AD-15);
- worse, `url` is derived as `` `/api/v1/public/media/${asset.storageKey}` ``. A provider-hosted video has `storageKey = ''`, so the response advertises the literal string `/api/v1/public/media/` — a **public** media path for a **protected** asset. That is the shape finding S1 exists to remove.

A staff UI therefore has to re-poll something else to learn the result of a call whose entire purpose was to return it, which is no better than the asynchronous path.

**Proposed patch** (not applied — both files are outside this worker's ownership):

```ts
// src/media/dto/media-asset.contract.ts
export interface VideoAssetResponse extends MediaAssetResponse {
  readonly processingStatus: PrismaMediaAsset['processingStatus'];
  readonly durationSeconds: number | null;
  /** `measured` | `parsed` | `declared` — how the quota figure was established (D5). */
  readonly durationSource: PrismaMediaAsset['durationSource'];
  /** What Atlas PROMISED for this asset (AD-15) — never the academy's current plan. */
  readonly securityTier: PrismaMediaAsset['securityTier'];
  /** Where the bytes are (AD-15). */
  readonly provider: PrismaMediaAsset['provider'];
}

export function toVideoAssetResponse(asset: PrismaMediaAsset): VideoAssetResponse {
  return {
    ...toMediaAssetResponse(asset),
    // A protected asset has no public address, and inventing one is the
    // mistake this tier removes (S1). Empty string says so plainly.
    url: asset.access === 'protected' ? '' : toMediaAssetUrl(asset.storageKey),
    processingStatus: asset.processingStatus,
    durationSeconds: asset.durationSeconds,
    durationSource: asset.durationSource,
    securityTier: asset.securityTier,
    provider: asset.provider,
  };
}
```

```ts
// src/media/controllers/protected-media.controller.ts
  @Post(':id/media/video-uploads/:assetId/complete')
  async completeVideoUpload(...): Promise<VideoAssetResponse> {
    ...
    return toVideoAssetResponse(asset);
  }
```

`toMediaAssetResponse` and every existing caller are untouched, so the Media Library contract does not move.

**Regression coverage added:** `the completion response tells the caller the asset is READY (§D.4 synchronous readiness)` — currently the one failing test.

---

### P2-API-3 — no content-access refusal was ever recorded (fixed concurrently as SEC-2)

**Where:** `src/learning/repositories/content-access-log.repository.ts` (`create` → `INSERT … RETURNING`) called from `LessonContentService.logRefusal`, which writes with no context by design.

Two independent failures, both swallowed by `record()`'s own try/catch (correctly — an audit write must never fail the request it audits, which is exactly why this went unnoticed):

1. the old `content_access_log_insert` WITH CHECK compared `user_id = current_setting('app.current_user_id', true)`, which is `NULL` out of context, so **every authenticated refusal** was rejected with 42501;
2. anonymous refusals passed the check and still failed, because Prisma's `create` emits `INSERT … RETURNING` and no SELECT policy admits an uncontextualised caller.

Reproduced at the SQL level (still failing at the time, with the widened WITH CHECK already in place):

```
INSERT INTO content_access_log (...) VALUES (... user_id NULL ...) RETURNING id;
ERROR:  new row violates row-level security policy for table "content_access_log"
```

Consequence while it stood: §V's "`content_access_log` records the security tier and provider for **every** decision" was false for every refusal, and §U's per-student grant-rate signal and §R's grant-flood detection had no refusal data at all.

**Status:** fixed concurrently — the repository now uses `createMany` (a plain `INSERT`, no RETURNING) and the INSERT policy admits an uncontextualised writer. Verified fixed here.
**Regression coverage added:** `an anonymous caller gets nothing for a non-preview lesson, and a refusal is logged`, and the access-log tier/provider assertions in the mixed-tier test.

---

### P2-API-4 — every learner-context read of `course_lessons` triggers ~6.5 s of PostgreSQL JIT compilation (OPEN)

**Where:** not application code — the `atlas_app` role's PostgreSQL settings, against the `course_lessons` RLS policy stack (9 policies).

`GET /learning/courses/:id/sequence` intermittently returns **500**, not a slow 200, because `CourseSequenceService.build` runs inside one Prisma interactive transaction whose ceiling is 5 s. Measured, per statement, against a course with **4** published lessons:

```
PROBE set_config            10 ms
PROBE enrollment            19 ms
PROBE course                12 ms
PROBE sections              35 ms
PROBE lessons               8756 ms   <-- SELECT id, video_asset_id FROM course_lessons WHERE course_id = $1 AND status = 'published'
PROBE quizzes               12 ms
```

and the cause, from `EXPLAIN (ANALYZE)` as `atlas_app` with a learner context:

```
Seq Scan on course_lessons  (cost=0.00..606681.84 rows=1 width=74)
...
JIT:
  Functions: 627
  Options: Inlining true, Optimization true, Expressions true, Deforming true
  Timing: Generation 75.8 ms, Inlining 154.3 ms, Optimization 3318.4 ms, Emission 2968.8 ms, Total 6517.3 ms
Execution Time: 6560.135 ms
```

With `SET jit = off`, the identical query on the identical data:

```
Planning Time: 27.158 ms
Execution Time: 4.435 ms
```

**6,560 ms → 4.4 ms.** Effectively all of it is JIT compilation of the RLS expression tree.

Why the plan is so expensive: the RLS quals are `SECURITY DEFINER` functions and therefore not leakproof, so PostgreSQL must evaluate them before the `course_id` equality can reach an index — the plan is a sequential scan, its estimated cost is ~606,000, and that is above all three JIT thresholds (`jit_above_cost` 100,000, `jit_inline_above_cost` and `jit_optimize_above_cost` 500,000), so the most aggressive JIT tier runs on every such query. The cost is a property of the SCHEMA (the policy stack), not of the data, and the estimate only grows with the table, so production is more exposed than this database, not less.

It reproduced three times consecutively in isolation on an otherwise idle database (12 connections, 1 active), and the endpoint now passes at ~4.9 s — i.e. it is currently winning a race against its own transaction ceiling.

**Proposed patch** (not applied — database role configuration, outside this worker's ownership):

```sql
-- Atlas's queries are OLTP-shaped: a handful of rows behind a large RLS
-- expression tree. That is precisely the profile where JIT is pure cost —
-- it compiles for seconds to save microseconds.
ALTER ROLE atlas_app SET jit = off;
```

If JIT is wanted for anything else, the narrower form is `ALTER ROLE atlas_app SET jit_above_cost = 5000000;`. Either belongs in a migration or the deploy's role provisioning, alongside the existing `atlas_app` grants.

**Regression coverage added:** `the unified sequence endpoint answers within the learner request budget (§D.3)` — its doc comment names this finding so a future 500 is diagnosed rather than retried.

---

## 3. What was verified, and how

Numbered against the verification brief.

### 1. Upload resolves the TIER via `VideoTierService` and the PROVIDER via `VideoProviderRegistry` — not a process-wide setting

`ProtectedMediaService.createVideoUpload` resolves `videoTierService.resolve(tx, …)` first and `videoProviders.forTier(resolved.tier)` second; the process-wide `VIDEO_PROVIDER` setting is not consulted on this path at all.

Proved rather than read: the test process is configured with `video.provider === 'fake'` (asserted directly from `ConfigService`), and two academies in that **same process** land on `r2_worker` and `cloudflare_stream` respectively. Under the pre-registry ternary that was impossible.

> `the provider comes from the resolved TIER, not from the process-wide VIDEO_PROVIDER setting (AD-7)`

### 2. The completion endpoint — the Normal provider's synchronous readiness path

| Question | Answer | Test |
|---|---|---|
| Does it verify the object, or believe the client? | Verifies: `HEAD` the object, then parse the real duration from the container. A file declared as 600 s whose `mvhd` says 240 s is stored as **240**, `durationSource: 'parsed'`. | `completes a Normal upload by VERIFYING the object and PARSING its real duration (D5)` |
| A duration it cannot parse? | Keeps the declared figure and **labels** it `declared` — never silently trusted. Proved with a real non-faststart MP4 (`moov` past the 512 KB ranged read). | `records 'declared' provenance…` |
| Idempotent? | Yes — a retried completion returns the ready asset and does not re-measure. | `is idempotent — a retried completion returns the same ready asset` |
| Object never landed? | `400 errors.media.uploadNotFound`, and the asset stays `processing`. | `refuses completion when the object never landed` |
| Provider that reports readiness asynchronously? | `400 errors.media.completionNotApplicable`. An uploader cannot mark a Premium asset ready before Cloudflare has finished. | `refuses completion for a provider that reports readiness ASYNCHRONOUSLY (§D.4)` |
| Upload never started / unknown asset / other tenant? | `400 errors.media.uploadNotStarted`, `404`, and `404`/`403` across academies. | `refuses completion before the upload was ever started…`, `never lets one academy complete another academy's upload` |

Uploads are real: the presigned PUT from the ticket is exercised with real MP4 bytes against the real protected bucket, and the completion endpoint parses those bytes.

### 3. `POST …/playback/refresh` re-runs the FULL entitlement decision

`LessonContentController.refreshGrant` calls the same `LessonContentService.getContent` as the initial grant — one code path, no cheaper variant. Proved behaviourally rather than structurally: mid-lesson changes to three different conditions each stop the **refresh**, not just a later login.

- enrollment revoked → `403 errors.learning.accessEnded` (condition 3);
- course unpublished → `404` (condition 4);
- drip date moved into the future → `403 errors.learning.lessonScheduled` (condition 5);
- restored → `200` again.

Also: the refreshed credential's expiry never moves backwards, the response carries `Cache-Control: private, no-store`, and refresh requires a session even where the initial grant may be anonymous (a preview lesson opens anonymously; `…/playback/refresh` is `401`).

> `refresh re-issues a live credential and re-runs every entitlement condition`, `refresh requires a session, where the initial grant may be anonymous for a preview lesson`

### 4. `GET …/content` returns the AD-16 capability object, and `protection.expiresInSeconds` never exceeds the real credential lifetime

Every field is read from the delivering adapter's `capabilities()`; nothing is inferred from the tier's name.

**Normal** reports `boundToSession: false` / `boundToDevice: false` — the corrected position, because the delivery host is Atlas-owned and cross-site from the academy, so no Atlas session reaches the gate. Asserting `true` here would have reproduced finding D-5 on the tier the plan presents as the stronger one.

**Normal** reports `revocableBeforeExpiry` and `originRestricted` **from configuration**, and the test proves both directions on the same running app: with the denylist and origin list wired, `true`; with them unwired, `false`; rewired, `true` again. A capability is a statement about what is enforced, not about what the Worker could enforce.

**Premium** reports `boundToSession: false`, `boundToDevice: false`, `revocableBeforeExpiry: false`, `adaptiveBitrate: true`, `drm: false` — asserted against the real `CloudflareStreamProvider` class (only its four HTTP calls are replaced in the harness; `capabilities()` and the RSA token signing are the production implementations).

**Expiry honesty (finding D-3)** is proved against the credential itself, not against the response's own claim: the Normal gate token's `e` claim and the Premium JWT's `exp` claim are decoded from the returned playback URL, and the grant's `expiresAt` is asserted to be **no later** than the credential inside it. `expiresInSeconds` is additionally bounded by each tier's real TTL (600 s Normal, 7,200 s Premium).

Content with no hosted video reports `tier: null` and no video-shaped claims; an external embed reports `signedUrl: false` and `expiresInSeconds: 0` — Atlas hosts nothing there and says so.

> `a NORMAL grant reports the capabilities the Worker gate actually enforces (AD-16)`, `an UNWIRED Normal gate reports revocation and origin restriction as FALSE (AD-16)`, `a PREMIUM grant reports boundToDevice: false…`, `content with no hosted video reports a null tier…`

### 5. Quota enforced BEFORE the URL is issued, and reconciled after

D5's own arithmetic, at the HTTP boundary: with 1,850 minutes used against a 2,000-minute entitlement, a 180-minute request is refused **409** with

```json
{ "used": 1850, "quota": 2000, "requested": 180, "remaining": 150 }
```

and a 100-minute request is accepted. The refusal is proved to happen **before** the provider is asked for anything: the adapter's direct-upload counter stays at zero and no `media_assets` reservation row exists.

Also proved:

- an in-flight reservation counts immediately, so concurrent uploads cannot collectively overflow;
- reservations round **up**, so short clips cannot be used to exceed a minute-denominated quota;
- a plan with no `videoStorageMinutes` key resolves to **zero**, never unlimited;
- `granted_limits` wins over the live catalog;
- `unlimited` skips the ceiling;
- **usage goes DOWN** on reconciliation: a reservation of 10 minutes settles to the measured 4, on both the enforcement gate and the Usage page;
- a provider failure **releases** the reservation (`processing_status: failed`, `status: archived`) and the minutes become available again;
- both hosted providers count against the one quota and a protected **file** (`provider: 'r2'`) does not;
- Normal-tier video does **not** additionally consume the `videoStorage` gigabyte quota, so the tiers stay comparable;
- the two aggregates agree: on a mixed-provider academy carrying ready Normal video, ready Premium video, an in-flight reservation, a failed upload and a protected PDF, `EntitlementEnforcementService.videoMinutesSnapshot` and `GET /organizations/:id/usage` both report **15** minutes against the same limit.

### 6. All six variants resolve the right entitlement, tier and provider

Parameterised over `NORMAL_BASIC`, `NORMAL_GROWTH`, `NORMAL_ENTERPRISE`, `PREMIUM_BASIC`, `PREMIUM_GROWTH`, `PREMIUM_ENTERPRISE`. Each asserts the entitlement (`GET /academies/:id/video-tier` → `entitled`, `source: 'plan'`), the ticket (`securityTier`, `reservedMinutes`, `requiresCompletionCall`, a non-empty `uploadUrl` — finding D-2), and the stored row (`provider`, `securityTier`, `processingStatus`, `durationSeconds`, `durationSource: null` while it is still a reservation).

### 7. Plan resolution, tier resolution and provider resolution are three separate steps

Shown as three independently observable steps on one academy: the plan family entitles **premium**; the academy deliberately selects **normal** (`source: 'academy'`, `entitled: 'premium'`); the upload lands on `r2_worker`. The subscription's plan family is asserted unchanged afterwards.

The structural half of D10 — "`premium` is nowhere hard-wired to a provider class in the authorization layer" — is asserted as a source property, because no request can demonstrate the absence of a hard-wiring. `src/common/p64-phase2-provider-independence.api.spec.ts` strips comments and asserts that the seven authorization-layer files name no adapter class and contain no `'cloudflare_stream'`/`'r2_worker'` literal, and that exactly **one** file in `src/` pairs `'premium'` with `'cloudflare_stream'`: `media/video/video-provider.registry.ts`. The same file asserts §V's "no provider price in the codebase".

### 8. Asset-level `provider` and `security_tier` come from the acting adapter and the entitled tier

Asserted on every one of the six variants, and again after a plan change: moving the organization to a Normal-family plan leaves the existing asset at `provider: 'cloudflare_stream'`, `security_tier: 'premium'`. Neither column is ever derived from the academy's current plan.

### 9. Mixed Normal and Premium assets coexist in one academy

One academy holds a Premium asset created under the Premium default and a Normal asset created after the default was switched. Both play; each grant reports its **own** tier (`premium`/`hls`, `normal`/`mp4`); and `content_access_log` records `security_tier`/`provider` per decision — `premium`+`cloudflare_stream` for one lesson, `normal`+`r2_worker` for the other, in the same academy.

### 10. Premium → Normal downgrade migrates NOTHING

After the organization moves to a Normal-family plan: the existing asset's `provider` and `security_tier` are unchanged; `GET …/video-tier` now reports `entitled: 'normal'`; `PATCH …/video-tier {premium}` is **403 `errors.entitlement.videoTierNotEntitled`**; a new upload is `normal`/`r2_worker`; and the **old Premium asset still plays through Premium**, its grant reporting `tier: 'premium'`, `adaptiveBitrate: true`, `format: 'hls'` — the truth about that video, not about the subscription.

### 11. Device/session APIs, the sequence endpoint and the learner content APIs still work

`GET /learning/courses/:id/sequence` (see P2-API-4), `POST …/playback` heartbeat with lease renewal, resume position surviving into the next grant, `DELETE …/progress/complete-lesson/:lessonId`, `GET /learning/overview` / `/quizzes` / `/assignments`, `GET /learning/devices`, `POST /learning/session/takeover`, `DELETE /learning/devices/:id` — all exercised end to end against a Normal-tier video lesson.

### 12. DTO validation, guards, service boundaries, error shapes and status codes

- `CreateVideoUploadDto`: missing `fileName`, missing/zero/negative/fractional/over-12-hour `maxDurationSeconds`, a 256-character `fileName`, and — via `forbidNonWhitelisted` — an attempt to smuggle `securityTier` or `provider` in the body, all **400**. A `courseId` belonging to another academy is **404**.
- `PlaybackHeartbeatDto`: negative, over-24-hour and fractional `positionSeconds`, a missing `lessonId`, and an extra `watchedSeconds` field (which would make the completion rule decorative) all **400**.
- `UpdateVideoTierDto`: an unknown tier and an empty body are **400**.
- Guards: no session **401**; a learner session on a staff endpoint **403** (refused at the management-surface boundary before any media code runs); staff of another organization **403**; an **instructor** of this academy **403 `errors.media.insufficientRole`**; a **manager** on the owner-only tier setting **403** (D8).
- Error envelope: every refusal is `{ error: { status, messageKey, code?, details?, requestId, retryable } }`, asserted including D5's `used/quota/requested/remaining` and D10's `requested/entitled`.
- Anonymous access to a non-preview lesson is **404 `errors.notFound`** with no delivery host anywhere in the body, and the refusal is recorded as `notAuthenticated`.

---

## 4. Observations recorded, not changed

1. **§L names `GET /auth/devices` and `DELETE /auth/devices/:id`; the implementation serves `GET /learning/devices` and `DELETE /learning/devices/:deviceId`.** Functionally complete and arguably better placed (they are learner-surface, host-scoped routes), but the Master Plan's §L list and any client written from it will not match. A documentation correction, not a code change.

2. **Master Plan §I's amended tier table still claims the Normal tier is "Bound to session/device **at the edge** — Yes — the Worker validates per request".** The investigation was corrected during implementation review (§1 finding (4)) to state that it *cannot* be, and `BasicVideoProvider.capabilities()` now correctly reports `boundToSession: false` / `boundToDevice: false`. The plan's table is stale relative to both the investigation and the code. Worth amending before §V is signed off, since "No learner-facing response overstates the protection actually enforced" is checked against that table.

3. **`FakeVideoProvider` occupies the `r2_worker` registry slot whenever the Normal adapter is unconfigured**, which is the default local environment (`BASIC_VIDEO_DELIVERY_HOST` and `BASIC_VIDEO_SIGNING_SECRET` are unset in `.env` and `.env.example` documents them as optional). Its capabilities differ from the real Normal tier's, so any local or CI validation of "the Normal tier" that does not configure those two variables is validating the stand-in. This suite configures the real adapter for exactly that reason; the Chrome validation in §Q should do the same or record which adapter it exercised.

4. **A refreshed Normal-tier credential can be byte-identical to the one it replaces** when both are minted inside the same wall-clock second, because the gate token's expiry has second granularity. Harmless, but a client that detects "a new credential" by comparing URLs will occasionally conclude it did not get one.

---

## 5. Files added by this work

| File | Purpose |
|---|---|
| `test/p64-phase2-api.e2e-spec.ts` | 33 integration tests — tier/provider resolution, the completion endpoint, the AD-16 capability object, refresh, mixed tiers, downgrade, the learner surface, DTOs and guards. |
| `test/p64-phase2-quota.e2e-spec.ts` | 11 integration tests — D5 arithmetic, reservations, provenance, reconciliation, release, cross-provider counting, aggregate agreement. |
| `src/common/p64-phase2-provider-independence.api.spec.ts` | 17 unit tests — the two §V acceptance criteria that are properties of the source tree. |
| `docs/ATLAS_PHASE2_API_VERIFICATION.md` | This report. |

No production code was modified. The three defects that required a code or configuration change are reported above with proposed patches; two of them were fixed concurrently by the security-review pass and are now under regression test.
