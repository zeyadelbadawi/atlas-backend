# P64 Phase 2 — Automated Coverage Report (QA / regression worker)

**Date:** 19 September 2026
**Scope:** automated coverage for the amended Phase 2 testing strategy (`ATLAS_SECURE_LEARNING_MASTER_PLAN.md` §M as amended, §V acceptance criteria) and protection of Phase 1 behaviour.
**Authority:** master plan §M/§V, `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` §2.4 (D-1…D-5), `ATLAS_PHASE2_RECONCILIATION.md` §5 (MUST NOT TOUCH).

Work was carried out while several other workers were editing the same tree. Numbers below are labelled with when they were taken, because the tree moved underneath them.

---

## 1. Baselines

### 1.1 Recorded at the start of this work

| Suite | Command | Result |
|---|---|---|
| Phase 1 regression | `npx jest --config ./test/jest-e2e.json --testPathPattern "p64-\|auth-signin\|auth-refresh"` | **10 suites / 66 tests — all passing** |
| Full unit suite | `npx jest` | **91 suites / 1,134 tests — all passing** |

(The reconciliation document's "87 suites / 1,079 tests" was already stale when this started; four suites and 55 tests had been added by other workers before the first measurement.)

### 1.2 Recorded at the end

| Suite | Result |
|---|---|
| Full unit suite | **95 suites / 1,228 tests — all passing** |
| This worker's two e2e suites | **2 suites / 25 tests — all passing** |
| All Phase 2 e2e suites (six files, all workers) | 149 tests; 147 passing at time of measurement — the 2 failures were in `p64-phase2-api.e2e-spec.ts` (another worker's file), see §6 |

### 1.3 Phase 1 behaviour — unchanged

The Phase 1 pattern now also matches the new `p64-phase2-*` files, so a raw re-run is not comparable to the baseline. Isolating the genuinely Phase 1 files:

- `p64-roster-lifecycle`, `p64-critical-fixes`, `p64-identity-surfaces`, `p64-rbac-review`, `p64-rls-review-and-published`, `p64-browser-findings`, `p64-surface-enforce-flag`, `auth-signin`, `auth-refresh`, `auth-refresh-concurrency` — **all pass**.
- During one heavily loaded run, `p64-roster-lifecycle` (2) and `p64-critical-fixes` (1) failed with `500`s. Every one was Prisma `Transaction API error: Transaction already closed … timeout 5000 ms, however 5112 / 6530 ms passed`, raised from **pre-existing Phase 1 code** (`src/course/repositories/courses.repository.ts:327` and `:331`) — not from anything Phase 2 touched. Re-run in isolation, all three pass. This is the same shared-dev-database load flake `test/utils/test-app.ts` documents at length. **No Phase 1 behaviour change.**

---

## 2. Files created

| File | Contents |
|---|---|
| `src/media/video/p64-phase2-defects.regression.spec.ts` | 33 unit tests — the D-1…D-5 regression suite §V requires, plus one newly found defect |
| `test/p64-phase2-tiers.e2e-spec.ts` | 16 e2e tests — the resolution chain as three separate steps, SEC-2 refusal forensics, the lease/takeover |
| `test/p64-phase2-downgrade.e2e-spec.ts` | 9 e2e tests — Premium → Normal downgrade migrates nothing (D11) |
| `docs/ATLAS_PHASE2_COVERAGE_REPORT.md` | this document |

`src/plans/services/video-tier.service.spec.ts` already existed when this work started and was therefore left to its owner.

**No non-test file was modified.**

---

## 3. Coverage added, by area

### 3.1 Findings D-1 … D-5 (§V: "each have a regression test")

`src/media/video/p64-phase2-defects.regression.spec.ts`. Each block asserts the **failure mode**, not the shape of the fix, so it survives a refactor of the fix:

| Finding | What the regression pins |
|---|---|
| **D-1** | Every adapter's `storedAs` round-trips through `VideoProviderRegistry.forProvider` back to that same adapter; the local stand-in records `r2_worker` (a storage fact) and not its own `key`; the two production adapters never share a `storedAs`. The DB write itself is covered e2e by `p64-phase2-api`. |
| **D-2** | Both no-webhook adapters return a real, absolute upload URL, signed for the object key the asset's bytes are expected at; `BasicVideoProvider` refuses to invent a key when tenancy metadata is missing, and signs nothing on that path; the ticket's expiry is the presign's real ceiling. |
| **D-3** | Five cases. The adapter's advertised `expiresAt` is compared against the TTL it **actually signed with**, captured from the storage call — including a sweep over seven requested lifetimes, and a check that a deliberately short request is honoured rather than always reporting the ceiling (the same lie inverted). `BasicVideoProvider`'s signed `e` claim must equal its advertised expiry, so D-3 cannot reappear one layer down. |
| **D-4** | Both synchronous adapters report `reportsReadinessAsynchronously: false` and refuse a forged or unsigned webhook; the Normal-tier adapter has **no** webhook door at all (`verifyWebhookSignature` false, `parseWebhookEvent` null, `fetchAsset` null), so the completion endpoint is the single writer of `ready`; Cloudflare still reports itself asynchronous so the two paths stay distinguishable. |
| **D-5** | Cross-adapter, which `cloudflare-stream.provider.spec.ts` does not do: **no** adapter reports `boundToSession`/`boundToDevice` true, none claims DRM, none mints a downloadable descriptor. `BasicVideoProvider`'s `revocableBeforeExpiry` and `originRestricted` are asserted to come from **configuration** (true when wired, false when not) rather than from aspiration — the exact shape of D-5 on the tier the plan presents as the stronger one. The session/device identifiers are still asserted present in the token, because D-5 is about the claim's effect, not about removing the claims. |

### 3.2 The resolution chain as three independent steps (§M)

`test/p64-phase2-tiers.e2e-spec.ts`, table-driven over all six `(family, tier)` variants against the real database and RLS:

1. `VideoTierService.entitledTier()` — the plan **family** alone decides the ceiling.
2. `VideoTierService.resolve()` — returns `{tier, entitled, source}`.
3. `VideoProviderRegistry.forTier()` — and only here does anything name a provider (D10: `premium` is nowhere hard-wired to a provider class in the authorization layer).

Plus the fail-closed case: an organization with **no subscription at all** resolves to `normal` through the real database, never `premium`.

This is deliberately at the **service** boundary. `p64-phase2-api`'s six-variant test asserts the same chain over HTTP, where one upload ticket necessarily carries steps 2 and 3 as a single answer; §M asks for them "as separate, independently asserted steps".

### 3.3 Downgrade migrates nothing (D11, §V)

`test/p64-phase2-downgrade.e2e-spec.ts` — nine tests, all written about state that existed **before** the plan changed and read **after** it changed:

- the whole asset row is byte-identical across the downgrade (not just the tier — a migration that rewrote `provider_id` or `duration_source` on the way past would be as destructive and harder to notice);
- an old Premium lesson still plays, still as HLS, still reports `tier: premium`, `adaptiveBitrate: true` and `boundToDevice: false`;
- the access log still records `premium` / `cloudflare_stream` for it;
- **new** uploads do land on Normal, so "migrates nothing" is not satisfied by a no-op;
- the academy's stored Premium preference is ignored but **not erased**, and `GET /academies/:id/video-tier` reports the real ceiling while `PATCH` refuses Premium;
- the old Premium minutes keep consuming quota — a downgrade is not a way to stop paying for storage in use;
- **symmetry**: upgrading back does not promote the Normal assets created while downgraded, and the owner's original preference returns on its own;
- both tiers coexist in one course for the rest of the assets' lives.

### 3.4 Refusal forensics — SEC-2 regression

Three e2e cases asserting that a refusal for an **identified** learner reaches `content_access_log`: `notEnrolled`, `deviceLimit` and `sessionConflict`. All three **failed when first written**, on two independent causes (§5). Both have since been fixed by another worker; these tests are now the regression that keeps them fixed. A fourth case pins the anonymous refusal, whose insert used to fail on its own `RETURNING` clause.

### 3.5 The single-session lease and takeover (AD-10, D4)

Six e2e tests covering ground the device-cap tests in `p64-phase2-security` do not:

- one device is registered per academy-surface sign-in, and the browser that would be the third is refused `errors.learning.deviceLimit` without registering anything;
- the **same** browser reloading **renews** the same lease rather than being told it is competing with itself;
- a second concurrent device gets `409` with the `deviceLabel` and `since` the takeover dialog needs to name the other device;
- a deliberate `playback/release` hands the lease over immediately, without a takeover;
- a takeover actually moves the lease (the displaced device's browser gets a grant afterwards) and writes `learning.device_session_takeover` naming the academy, course and lesson;
- a takeover from a browser that is **not** a registered device is refused, so takeover cannot be used to walk around the device cap.

---

## 4. Duplication removed (important for the owner)

When this work began there was **zero** e2e coverage for Phase 2. Four other Phase 2 e2e suites landed during it: `p64-phase2-api`, `p64-phase2-quota`, `p64-phase2-rls-tiers`, `p64-phase2-security`.

`test/p64-phase2-tiers.e2e-spec.ts` originally carried 38 passing tests. Everything another suite asserts at the same level was then **removed rather than left as a second copy**, taking it to 16. What was removed, and where it now lives:

| Removed from this file | Covered by |
|---|---|
| Normal upload lifecycle — ticket, real PUT to the protected bucket, completion, `parsed` provenance, idempotency, "object never landed" | `p64-phase2-api` (six-variant ticket assertions, completion block), `p64-phase2-quota` (reconciliation) |
| `videoStorageMinutes` across both providers, the 409 body, the exact boundary, protected files excluded | `p64-phase2-quota` (ten tests, more thorough) |
| Normal and Premium playback capability reports, processing-state refusal | `p64-phase2-security`, `p64-phase2-api` |
| Mixed Normal/Premium in one academy | `p64-phase2-rls-tiers`, `p64-phase2-api` |
| Cross-academy isolation and the signer's cross-academy refusal | `p64-phase2-security` |
| The academy tier choice and its refusal | `p64-phase2-api`, `p64-phase2-rls-tiers` |
| The mandatory refresh and revocation-at-next-refresh | `p64-phase2-api`, `p64-phase2-security` |
| Access log on a **grant** | `p64-phase2-security` |

Residual overlap the owner may still want to consolidate: `p64-phase2-api` also has a six-variant matrix (at HTTP level) and a single downgrade test. Both are kept deliberately — see §3.2 and §3.3 for why the versions here assert something the HTTP versions cannot — but they are the two places worth a second look during review.

---

## 5. Defects found

### 5.1 Fixed during this work (now regression-covered here)

| # | Defect | Evidence |
|---|---|---|
| **SEC-2 cause 1** | `content_access_log_insert` admitted a row only when `user_id = current_setting('app.current_user_id')`, but `LessonContentService.logRefusal` writes outside any context on purpose. Out of context the comparison is `user_id = NULL` → NULL → not TRUE, so **every authenticated refusal was rejected** with Postgres `42501` and swallowed by `ContentAccessLogRepository.record`. | Observed live: five occurrences of `new row violates row-level security policy for table "content_access_log"` in a single run. Fixed by `prisma/migrations/20261009000300_p64_phase2_media_asset_learner_select` (another worker, independently, as SEC-2). |
| **SEC-2 cause 2** | The `sessionConflict` refusal was logged **inside** the caller's transaction and the `ConflictException` thrown from the same callback, aborting it and taking the row with it. | Now carried on the exception and logged outside the transaction (`src/learning/services/lesson-content.service.ts:303`, `:375`). |
| **Response contract gap** | `toMediaAssetResponse` (`src/media/dto/media-asset.contract.ts:53`) carried no `processingStatus`, `provider`, `securityTier`, `durationSeconds` or `durationSource`, so the D-4 completion endpoint could not tell its caller that the transition it had just performed happened. | Fixed while this report was being written: `ProtectedMediaController` now returns `toProtectedMediaAssetResponse` from a dedicated `protected-media-asset.contract.ts`. |

### 5.2 Open — reported, not patched (outside this worker's file ownership)

| # | Defect | Location | Impact |
|---|---|---|---|
| **P2-Q1** | `VideoProviderRegistry.forTier()` is called **before** the two guards that exist to refuse an unavailable tier. An unconfigured tier therefore throws a plain `Error` (no HTTP status) and produces a **500**, never the intended `403 errors.media.videoNotEnabled` — and the feature-flag guard below it is unreachable too. Phase 2 §S says Premium waits for Stream onboarding, so "Premium entitled, Stream not configured" is the expected state on day one of the Premium rollout. The registry's own comment asserts "the caller turns this into the same `videoNotEnabled` refusal", which the ordering makes impossible. | `src/media/services/protected-media.service.ts:204` (the call) vs `:210` and `:213` (the guards); `src/media/video/video-provider.registry.ts:86` (the throw) | 500 instead of a clean 403 for a foreseeable, documented operational state. Suggested fix: move the `isTierAvailable` + flag checks above the `forTier` call. |
| **P2-Q2** | `ProtectedMediaService`'s own unit spec stubs the registry as `forTier: () => provider`, so its test *"refuses when the tier has no configured provider"* passes against a registry that cannot throw. It therefore does not cover P2-Q1. | `src/media/services/protected-media.service.spec.ts:87` and `:193` | A green test for a path that is broken in production. The registry half of P2-Q1 is asserted in `p64-phase2-defects.regression.spec.ts` ("throws a PLAIN Error for an unconfigured tier"). |
| **P2-Q3** | `FakeVideoProvider` reports `reportsReadinessAsynchronously: false` but implements a fully working webhook pair (it signs its own local webhooks), so for that adapter `ready` is reachable by two doors while the capability says one. Not a security hole — verification is real — but a divergence between a reported capability and the adapter's behaviour, in the one adapter whose whole job is to behave like the real ones. | `src/media/video/fake-video.provider.ts:84-101` vs `:241-264` | Local/test only. Recorded in the D-4 block's comment. |
| **P2-Q4 (fragility, not a defect)** | `CourseSequenceService.getSequence` issues four `findMany` calls inside one interactive transaction against a 5 s Prisma budget, and `CoursesRepository.countSections`/`countLessons` do the same. Under load these are the first things to time out, producing 500s (observed in `p64-phase2-api`'s sequence test and in two Phase 1 suites). | `src/learning/services/course-sequence.service.ts:117-135`; `src/course/repositories/courses.repository.ts:327`, `:331` | Currently a test flake on a loaded shared database; on a busy production box it is a 500 on a learner-facing endpoint. Worth a look before rollout. |

---

## 6. Remaining gaps

| Gap | Why it is not covered here |
|---|---|
| `p64-phase2-api.e2e-spec.ts` had 2 failures at the time of measurement — the completion-response assertion (now fixed upstream, see §5.1) and a sequence-endpoint 500 (P2-Q4). | Another worker's file; not repaired here. Both should go green once those two items settle. |
| Cloudflare Stream's own HTTP API (`createDirectUpload`, `fetchAsset`, `syncAllowedOrigins`). | Stubbing `fetch` would assert what Atlas sends, never what Cloudflare accepts — the illusion `zoom.provider.spec.ts` already refuses to build. Premium assets are seeded at the state that API would have left them in, and everything downstream is real. §S's onboarding step remains the only real validation. |
| The Normal-tier Worker gate itself (per-request authorization, revocation before expiry, segment/caching behaviour). | DL-22's validation spike, explicitly out of scope for automated tests; the presigned-GET probe already run is recorded as **not** sufficient. |
| `content_access_log` 90-day retention sweep; the stalled-video poll scheduler; `course_lessons.video_asset_id` staff write path. | Listed in the reconciliation document as still-outstanding Phase 2 scope — there is nothing to test yet. |
| Frontend component tests, Playwright J1/J5, axe, k6. | Frontend repo and separate tooling; outside this worker's ownership. |

---

## 7. Tests repaired

**None.** No existing `*.spec.ts` failed because it assumed Cloudflare was the only provider, or because it assumed the old `'protected' | 'unprotected'` capability shape. This was checked directly: no spec outside the video module references `cloudflare_stream` at all, and no spec anywhere asserts the superseded protection union. The reconciliation document's claim that the pre-existing suite is provider-independent holds.

The only spec-level problem found is **P2-Q2** above — a stub that hides a real defect rather than an assertion that is now wrong — and it belongs to another worker's file, so it is reported rather than edited.

---

## 8. Commands

```bash
# The D-1…D-5 regression suite
npx jest src/media/video/p64-phase2-defects.regression.spec.ts

# This worker's two e2e suites
npx jest --config ./test/jest-e2e.json --testPathPattern "p64-phase2-tiers|p64-phase2-downgrade"

# Phase 1 regression (note: the pattern now also matches the Phase 2 files)
npx jest --config ./test/jest-e2e.json --testPathPattern "p64-|auth-signin|auth-refresh"
```

Both e2e files configure **both** video tiers through `process.env` at module load, snapshot those keys first and restore them in `afterAll` — Jest reuses one worker process across spec files, so without that this suite's configuration would leak into the next file's application boot.
