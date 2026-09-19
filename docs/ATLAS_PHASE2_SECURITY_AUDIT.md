# P64 Phase 2 — Security and Authorization Audit

**Date:** 19 September 2026
**Scope:** the Phase 2 working tree — `LessonContentService`, `ContentGrantSigner`, the video provider registry and its three adapters, the protected R2 tier, the device registry, the learning lease and takeover, the Phase 2 RLS migration, and the plan/tier/provider model.
**Authorities:** `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (D1–D11, AD-1…AD-16, the whole `# Phase 2 —` section), `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` (§2.4 D-1…D-5, §6), `ATLAS_PHASE2_RECONCILIATION.md`.
**Method:** source review, then empirical verification against the running stack — PostgreSQL as the real `atlas_app` role (`NOBYPASSRLS`, `FORCE ROW LEVEL SECURITY`), the real S3-compatible object store, and the real Redis lease. Nothing in this document is asserted from a comment.

> This audit was performed while other workers were actively editing `src/media/` and `src/learning/`. Findings marked **(fixed during the audit)** were observed broken and then observed fixed by the owning worker; they are kept because the regression tests that pin them are part of this delivery.

---

## 1. Summary

The authorization design is sound and the reconciliation's central claim holds: **the two files that decide who may watch what contain no provider knowledge at all.** Grep across `src/learning/` returns zero `provider === '…'` comparisons; the only two reads of `media_assets.provider` are a registry lookup keyed on the asset (AD-7's playback axis) and a column written to the access log (§F). Normal and Premium are authorized identically, by construction rather than by discipline.

Two defects, however, break Phase 2's own acceptance criteria, and both are invisible from the source because both are RLS-shaped: a policy that does not exist cannot be seen in the service that depends on it.

| | Finding | Severity |
|---|---|---|
| **SEC-1** | `media_assets` is unreadable in the context the grant path runs in, so every grant is built from an asset it cannot see | **Blocking** |
| **SEC-2** | No content-access **refusal** is ever recorded; the insert is refused by RLS and the error is swallowed | **Blocking** |
| **SEC-3** | The lease is acquired before the asset-readiness check, so a refused request can hold the learner's single learning lease | Should-fix |
| **SEC-4** | `revocableBeforeExpiry` reported from configuration presence alone; `signed_out` still has no caller | Should-fix *(largely fixed during the audit)* |
| **SEC-5** | The webhook route resolves its verifier from a process-wide default rather than the registry | Should-fix |
| **SEC-6** | `FakeVideoProvider.verifyWebhookSignature` has no production guard and falls back to a public constant | Should-fix |
| **SEC-7** | `lesson_contents`/`lesson_resources` tenant policies are `FOR ALL`, so tenant context also grants SELECT | Note |
| **SEC-8** | `contentUrl` is still projected on locked lessons whenever `content.protected` is off | Note |
| **SEC-9** | Anonymous preview grants are not rate-limited | Note |
| **SEC-10** | `takeover()` does not apply the device cap, only device existence | Note |
| **SEC-11** | Three sibling authorization helpers disagree about whether membership status matters | Note |
| **SEC-12** | `access_policies_read` admits any authenticated user to every academy's policy row | Note |
| **SEC-13** | `can_access_lesson()` does not check `users.status`; the service does | Note |

Everything the brief asked to be confirmed positively **was** confirmed: the seven conditions are all enforced server-side; the host-resolved academy cannot be overridden by a query parameter; the cross-academy signing refusal has no reachable bypass; `securityTier` and `provider` are independent columns and neither is derived from the academy's current plan at read time; no protected object is reachable without a signed credential; a Premium grant reports `boundToDevice: false`; a grant never advertises an expiry longer than the credential inside it; and takeover cannot register a device.

---

## 2. Blocking findings

### SEC-1 — the grant is built from rows the grant path cannot read

**Where.** `src/learning/services/lesson-content.service.ts:125-128` (the context), `:132-140` (the read), `:402-429` (the branches that depend on it); `prisma/migrations/20260825100528_p8_media_library_object_storage/migration.sql:56` (the only SELECT policy on `media_assets`).

**What.** `LessonContentService.getContent` runs the entire decision inside

```ts
userId
  ? this.tenancyContextService.runInUserContext(userId, fn)
  : this.tenancyContextService.runWithoutContext(fn)
```

`runInUserContext` sets `app.current_user_id` and nothing else (`src/tenancy/services/tenancy-context.service.ts:75-83`). `media_assets` has exactly one SELECT policy, `media_assets_tenant_select`, and its predicate is `a.organization_id = current_setting('app.current_organization_id', true)`. That setting is never present on this path, so **every** `media_assets` row is invisible to it.

**Verified.** Against the `atlas_app` role, for a fully entitled learner of a published, public course:

```
lesson_contents rows visible : 1     ← the entitlement itself is correct
media_assets   rows visible : 0
lesson.videoAsset resolved   : false
```

**Consequences, each a Phase 2 acceptance criterion:**

1. `if (lesson.videoAsset)` at `:409` is never true for a learner, a staff previewer or an anonymous preview. No video is signed, and the grant is returned with `video: undefined`.
2. `buildProtectionReport` then takes its `!args.capabilities` branch (`:615-632`) and reports `signedUrl: true` with a ten-minute expiry — a protection claim for content the response does not contain. §V: *"No learner-facing response overstates the protection actually enforced."*
3. The `processingStatus !== 'ready'` refusal at `:410-414` can never fire.
4. `ContentGrantSigner.signVideo`'s cross-academy refusal is unreachable from the learner path; it is reachable only from the upload path and from tests.
5. `content.kind === 'file'` at `:402` requires `content.mediaAsset`, so a protected file lesson returns a grant with no `fileUrl`.
6. `lesson.resources[].mediaAsset` is null, so every protected resource is silently dropped from `resources`.
7. `content_access_log.provider` (`:323`) and `securityTier` (`:322`) are always null, defeating §F's requirement that the log say which tier delivered a decision, and §V's *"`content_access_log` records the security tier and provider for every decision."*

**Why it was not caught.** Nothing in `src/` writes `course_lessons.video_asset_id` yet (the investigation records this at §10), so no existing test builds a lesson with a video asset attached. The unit tests exercise the adapters directly and never go through RLS.

**Proposed patch — NOT applied (owned by `prisma/`).** Add a definer predicate and one additive policy, following the shape `can_access_lesson()` already established and the performance correction finding B5 recorded (an inline `EXISTS` in a policy evaluates every referenced table's own policies per candidate row):

```sql
CREATE OR REPLACE FUNCTION can_access_media_asset(p_asset_id text, p_user_id text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM "course_lessons" l
    WHERE l."video_asset_id" = p_asset_id
      AND can_access_lesson(l."id", p_user_id)
  ) OR EXISTS (
    SELECT 1 FROM "lesson_contents" lc
    WHERE lc."media_asset_id" = p_asset_id
      AND can_access_lesson(lc."lesson_id", p_user_id)
  ) OR EXISTS (
    SELECT 1 FROM "lesson_resources" lr
    WHERE lr."media_asset_id" = p_asset_id
      AND can_access_lesson(lr."lesson_id", p_user_id)
  );
$$;

CREATE POLICY "media_assets_lesson_access_select" ON "media_assets"
  FOR SELECT
  USING (can_access_media_asset("media_assets"."id",
                                current_setting('app.current_user_id', true)));
```

Additive (OR-ed with the existing tenant tier), and it grants nothing `can_access_lesson()` would not already grant on the lesson itself — which is the property that keeps "guard decides, RLS independently agrees" true rather than widening one side.

**Regressions added (currently failing, by design):**
- `test/p64-phase2-rls-tiers.e2e-spec.ts` → *FINDING SEC-1: an entitled learner can read the lesson body but NOT the media asset the grant is built from*
- `test/p64-phase2-security.e2e-spec.ts` → three cases: the file grant, the video grant, and the access log's tier/provider columns.

---

### SEC-2 — not a single content-access refusal is recorded

**Where.** `src/learning/services/lesson-content.service.ts:505-539` (`logRefusal`), `src/learning/repositories/content-access-log.repository.ts:56-83` (`record`), `prisma/migrations/20261009000000_p64_phase2_protected_content_video_devices/migration.sql:483-489` (`content_access_log_insert`).

**What.** `logRefusal` deliberately writes outside the caller's context — the comment at `:330-333` explains why, and the reasoning is right. But the insert policy is

```sql
WITH CHECK ("content_access_log"."user_id" IS NULL
            OR "content_access_log"."user_id" = current_setting('app.current_user_id', true))
```

With no context, `current_setting(...)` is `NULL`, so an **authenticated** refusal fails the check. And the **anonymous** case (`user_id IS NULL`) passes the check but fails anyway, because Prisma's `create()` always issues `INSERT … RETURNING`, and `RETURNING` additionally requires a SELECT policy to admit the new row — none of the three SELECT tiers matches a contextless row.

`ContentAccessLogRepository.record` catches and warns, so nothing 500s. The refusal is simply never written. Observed live in the application log during the e2e run, once per refusal:

```
ERROR [PrismaService] Invalid `tx.contentAccessLog.create()` …
  42501 new row violates row-level security policy for table "content_access_log"
```

**And the one refusal that is written in-context is rolled back.** `lesson-content.service.ts:263-279` logs a `sessionConflict` refusal inside the caller's own context — where the insert policy does admit it — and then throws `ConflictException` from inside the same `$transaction` callback. Prisma rolls the transaction back, taking the log row with it. Verified: after a real lease conflict, `content_access_log` holds **zero** rows with `reason = 'sessionConflict'`.

Taken together: **no content-access refusal of any kind is ever recorded.**

**Verified**, isolating the two mechanisms with raw SQL on the `atlas_app` connection:

| attempt | result |
|---|---|
| `INSERT`, `user_id NULL`, no `RETURNING` | OK |
| `INSERT`, real `user_id`, no `RETURNING` | `42501 new row violates row-level security policy` |
| `INSERT … RETURNING`, `user_id NULL` | `42501` |
| Prisma `create()`, user context set | OK |

So only the `sessionConflict` refusal at `lesson-content.service.ts:263-272` — the one written inside the caller's own context — ever lands.

**Why it matters.** §U requires structured logging of *every* grant and refusal; §R's adversarial checks ("grant flood from one learner… alert") read this table; §U's per-student grant-rate report reads it; and it is the only durable record of a refusal for a sharing investigation.

**Proposed patch — NOT applied (owned by `prisma/`, with an alternative in `src/learning/services/`).** Either of:

```sql
-- (a) an explicit audit-insert tier, plus the SELECT tier RETURNING needs
CREATE POLICY "content_access_log_audit_insert" ON "content_access_log"
  FOR INSERT
  WITH CHECK (EXISTS (SELECT 1 FROM "academies" a
                      WHERE a."id" = "content_access_log"."academy_id"));
```

`RETURNING` still needs a matching SELECT tier for a contextless row; the cleanest form is to write refusals through a `SECURITY DEFINER` function (`record_content_access_refusal(...)`) so neither the WITH CHECK nor the RETURNING is subject to the caller's context — which is also what makes the audit trail independent of the thing it audits.

Separately, and regardless of the policy: the `sessionConflict` refusal must be recorded **after** the transaction has unwound, the way `logRefusal` already records the others, rather than inside the transaction the refusal aborts.

**Regressions added (currently failing, by design):**
- `test/p64-phase2-rls-tiers.e2e-spec.ts` → *FINDING SEC-2: a refusal for an authenticated learner is recorded in content_access_log*
- `test/p64-phase2-security.e2e-spec.ts` → three cases: through the real refusal path, through the repository directly, and the rolled-back `sessionConflict` refusal.

---

## 3. Should-fix

### SEC-3 — a refused request can hold the learning lease

**Where.** `src/learning/services/lesson-content.service.ts:250-257` (lease acquired) versus `:409-414` (`processingStatus !== 'ready'` throws `ContentRefusal` from inside `buildGrant`).

The file's own header states the ordering rule: *"the lease — the only condition with a side effect — is taken LAST, so a request that was going to be refused anyway never steals another device's lease on the way out."* One refusal violates it. A learner opening a lesson whose video is still processing acquires the 60-second lease and is then refused; their real device is told "another device is already learning". `getContent`'s `catch` (`:328-338`) does not release it.

This is latent today because SEC-1 makes `lesson.videoAsset` null, so the check never runs at all.

**Proposed patch — NOT applied (owned by `src/learning/services/lesson-content.service.ts`).** `lesson.videoAsset` is already loaded by the opening query, so the readiness check can move up beside the `if (!lesson.content)` guard at `:217`:

```ts
if (!lesson.content) throw new ContentRefusal('lessonUnavailable');
// Asset readiness is a property of the LESSON, not of the request, so it
// belongs with the other row-shaped refusals — above the lease.
if (lesson.videoAsset && lesson.videoAsset.processingStatus !== 'ready') {
  throw new ContentRefusal('lessonUnavailable');
}
```

Alternatively, release the lease in the `ContentRefusal` catch. Moving the check is preferable: it keeps the documented ordering true rather than compensating for breaking it.

**Regression added:** `test/p64-phase2-security.e2e-spec.ts` → *FINDING SEC-3: a lesson whose video is still processing is refused without holding the lease*.

### SEC-4 — `revocableBeforeExpiry` from configuration presence alone *(fixed during the audit)*

At the start of this audit `BasicVideoProvider.capabilities()` returned hard-coded `boundToSession: true`, `boundToDevice: true`, `revocableBeforeExpiry: true` and `originRestricted: true`, while `deploy/video-gate-worker/src/gate.js` verified only signature, expiry and object key — it never compares `claims.s`/`claims.d` against anything the caller presents, because the delivery host is cross-site from the academy and receives no Atlas cookie. A token lifted from one browser played in another, exactly as in D-5. Nothing in `src/` wrote to the Worker's `GATE_DENYLIST`.

The owning worker has since corrected all four flags (`src/media/video/basic-video.provider.ts:97-140`) and added `VideoGateRevocationService` (`src/media/video/video-gate-revocation.service.ts`), which publishes `rev:s:<sessionId>`.

**Re-verified at the end of this audit.** Four of the five reasons `GateRevocationReason` declares now have real callers: `device_removed` and `session_taken_over` (`learner-session.service.ts:155,238`), `academy_membership_blocked` (`academy-students.service.ts:325`) and `enrollment_revoked` (`:611`). **`signed_out` has none** — a learner who signs out keeps a live Normal-tier credential for the remainder of its ten-minute life. That is defensible (sign-out is voluntary, and the credential is short by design), but the union advertises a path that does not exist, which is the same shape of claim AD-16 exists to prevent. Either wire it from `AuthService.revokeSession`/sign-out, or drop the value.

**Residual note on the flag itself:** `isEnabled` (`:51-53`) is *configuration presence*, so `revocableBeforeExpiry: true` becomes true the moment the two environment variables are set — before any evidence that the gate is reachable or that the denylist is bound. A startup reachability probe, or reporting the capability from the last successful publish, would make the flag describe enforcement rather than intent.

### SEC-5 — the webhook verifier is resolved from a process-wide default, not the registry

**Where.** `src/media/controllers/video-webhook.controller.ts:52-55` injects `VIDEO_PROVIDER`; `src/media/media.module.ts:117-130` binds that token from `config.provider` with a three-way branch.

An installation running both tiers has one default adapter. If `VIDEO_PROVIDER=r2_worker` — which §T's Normal-first rollout makes the natural setting — then `BasicVideoProvider.verifyWebhookSignature()` returns `false` unconditionally and **every Cloudflare Stream webhook is rejected**, so Premium assets never reach `ready` and Premium video never plays. The registry exists precisely to stop one process-wide provider choice deciding a per-asset question (AD-7); the webhook route is the one place still outside it.

**Proposed patch — NOT applied (owned by `src/media/`).** Route the webhook through `VideoProviderRegistry.forProvider('cloudflare_stream')` (or iterate the adapters whose `capabilities().reportsReadinessAsynchronously` is true and accept the first that verifies), rather than through the `VIDEO_PROVIDER` token.

### SEC-6 — the local adapter's webhook verification has no production guard

**Where.** `src/media/video/fake-video.provider.ts:241-264` (`verifyWebhookSignature`, with no `assertNotProduction()` unlike `createDirectUpload:122` and `issuePlaybackToken:162`) and `:309-316` (`sign`, falling back to the literal `'atlas-local-fake-video'` when `CLOUDFLARE_STREAM_WEBHOOK_SECRET` is unset).

`VIDEO_PROVIDER` defaults to `fake` and `env.validation.ts:277` does not require otherwise under `NODE_ENV=production`. The investigation §17 records that production currently sets no `VIDEO_PROVIDER` and no `CLOUDFLARE_STREAM_*`. In that state `POST /webhooks/video/stream` would verify inbound signatures against a constant published in this repository, admitting an unauthenticated caller to `VideoReconciliationService.applyEvent` — which flips `processing_status` and rewrites `duration_seconds`, the column the `videoStorageMinutes` quota is computed from.

Depth of exploitation is limited (the attacker must guess a `providerId`), and `FakeVideoProvider.isConfigured()` already returns `false` under production so the registry never selects it — but the webhook route does not go through the registry (SEC-5), which is what makes this reachable.

**Proposed patch — NOT applied (owned by `src/media/`).** Add `this.assertNotProduction()` as the first statement of `verifyWebhookSignature`, and make SEC-5's registry change so the route can never resolve to this adapter at all.

---

## 4. Notes

**SEC-7 — the tenant policies on `lesson_contents`/`lesson_resources` are `FOR ALL`.**
`migration.sql:375-389` and `:401-414`. In PostgreSQL `FOR ALL` covers SELECT, so anything running in tenant context reads every lesson body in the organization without passing `can_access_lesson()`. That is the intended staff-authoring tier and no API path reaches these tables in tenant context today (the content path is user-context only), but the two reads are worth separating so the write tier cannot widen the read tier by accident.

**SEC-8 — `contentUrl` survives on locked lessons while `content.protected` is off.**
`src/learning/services/course-content.service.ts:116-130` gates the field on the per-academy flag alone; `src/course/dto/course-lesson.contract.ts:65,74` applies `lockState` independently. §V's *"Locked lessons carry no content until unlocked"* therefore holds only once the flag is enabled. The staged rollout is deliberate (§T: "the previous image runs against the new schema"), so this is recorded rather than challenged — but S3 is not closed by default, and the completion record should say so rather than implying otherwise.

**SEC-9 — anonymous preview grants are not rate-limited.**
`lesson-content.service.ts:223` gates the limiter on `userId && !staffPreview`. An anonymous crawler can mint unbounded presigned URLs for every preview lesson on the platform. Preview content is open by design, so this is a cost and noise concern rather than a disclosure one; an IP-scoped limit on the anonymous branch would close it.

**SEC-10 — `takeover()` checks device existence but not the device cap.**
`src/learning/services/learner-session.service.ts` resolves `claimed` by `userId + academyId + cookieHash + revokedAt IS NULL` only, where the grant path additionally applies `StudentDeviceService`'s registration-order rank against `maxDevices`. After an owner lowers the cap, an over-cap device can still take the lease and force-revoke the in-cap session's refresh token. It cannot obtain content — the grant path still refuses it with `deviceLimit` — so the impact is a self-inflicted denial of service, not an access bypass. Applying the same rank check in `takeover` would make the two agree.

**SEC-11 — three sibling helpers disagree about membership status.**
`assertCanReviewCourse` (`learning-access.util.ts:212-216`) and `assertCanManageSecurityPolicy` (`:244`) require `status === 'active'`; `assertCanAuthorCourseContent` (`:167`) does not, and neither does `ProtectedMediaService.assertCanManage` (`protected-media.service.ts:504`) or `MediaService` (`media.service.ts:98`). The SQL half agrees with the TypeScript half in each case — `can_author_course_content` (P24 migration `:39-45`) also omits the status check — so guard and RLS are consistent, and `AcademyScopeGuard:122` requires an active membership before any of the media routes run. Pre-existing, defence-in-depth only, and out of Phase 2's scope; recorded so the divergence is a decision rather than an accident.

**SEC-12 — `access_policies_read` admits every authenticated user.**
`migration.sql:628-633`. The comment explains the requirement honestly (the Devices page must know the cap), but the predicate is "any user id at all", so any learner can read every academy's device policy. A self-scoping predicate (the platform row plus the academies the caller belongs to) would satisfy the same requirement.

**SEC-13 — `can_access_lesson()` does not check `users.status`.**
The service enforces suspension as condition 7 (`lesson-content.service.ts:177-183`); the SQL predicate does not. The migration's own header says RLS agrees about "the four that are row-shaped" and suspension is not among them, so this is documented rather than accidental — but it means a suspended user's rows are still visible at the database layer, and "guard decides, RLS independently agrees" is true for six conditions, not seven.

---

## 5. What was verified as correct

Recorded with the same weight as the findings, because "checked and sound" is a result.

**The seven conditions (§D.2).** All seven are enforced server-side, in the documented order, and the two branches (learner, staff preview) were exercised individually. The ordering rule holds for every refusal except SEC-3: a revoked learner is refused with no lease taken and no device registered. `notAuthenticated` is returned for a host/academy mismatch, so the host check cannot be distinguished from "no such lesson" by an unauthenticated prober. Every refusal except `deviceLimit`, `rateLimited`, `suspended`, `accessEnded` and `scheduled` is a 404, which is what stops an anonymous crawler mapping lesson ids in a paid catalogue.

**Normal versus Premium authorization (D10).** Identical, and structurally so. `grep -rn "cloudflare\|stream\|r2\|bunny\|fake" src/learning/` returns only comments and two R2 references in unrelated upload plumbing. There is no `provider ===` comparison anywhere in `src/learning/`. The only two provider reads are `content-grant.signer.ts:115` (`registry.forProvider(asset.provider)`) and `lesson-content.service.ts:323` (the access-log column). `premium` is mapped to a provider class in exactly one place, `video-provider.registry.ts:74`, one layer below the authorization layer — which is what D10 requires.

**`securityTier` versus `provider` (AD-15, D11).** Separate columns, both written once at creation (`protected-media.service.ts:251,255`) and read as facts. `VideoTierService.resolve` is called only from the upload path and from the owner's settings screen — never from the grant path. Verified end-to-end: an asset created `premium`/`cloudflare_stream` keeps both after its organization resolves to a Normal-family plan, and mixed Normal and Premium assets in one academy each route to their own adapter.

**Cross-academy isolation.** `ContentGrantSigner.signVideo:101-105` refuses before touching a provider, and the refusal cannot be reached with a mismatched binding — the binding's `academyId` comes from `course.academyId`, read from the database inside the same transaction, never from the request. The host-resolved academy is read from `request.hostname` (`learning-request.util.ts:27-34`) and `requireHostAcademy` (`learner-dashboard.controller.ts:89-99`, `learner-session.controller.ts:85-93`) accepts a fallback `?academyId=` **only when the host resolves to nothing at all**, so on a real academy host the parameter is ignored entirely. Object keys are prefixed by academy and course from verified context (`protected-media-storage.provider.ts:114-123`).

**Token TTL, refresh, replay (D-3).** `signFile` reports exactly the store's own ceiling, which is also the clamp (`protected-media-storage.provider.ts:143`); `signVideo` returns the adapter's own `expiresAt`; `buildGrant` takes the minimum across every credential in the grant. `PROTECTED_MEDIA_URL_TTL_SECONDS` and `BASIC_VIDEO_PLAYBACK_TTL_SECONDS` are both `.max(3600)` in `env.validation.ts`, so an operator cannot turn a short credential back into a durable link. The refresh endpoint re-runs the whole decision rather than a cheaper one (`lesson-content.controller.ts:94-111`), which is what makes revocation take effect within a credential's life.

**Device, session and takeover (AD-10, D4).** The device is a server-issued opaque cookie stored as a SHA-256 hash, never a fingerprint. The cap is applied to recognised devices too, by registration order, so lowering a policy takes effect on learners who already have devices. An unknown or forged cookie re-registers under the cap rather than bypassing it, and never adopts another learner's row. The lease is `SET NX EX`, one atomic round-trip, so two devices racing cannot both win. **Takeover cannot create a device** (`learner-session.service.ts`, `if (!claimed) throw`), which is the specific bypass the brief asked about, and it writes `learning.device_session_takeover` naming both sides. Removing a device revokes its sessions, drops the lease, and now publishes the revocation to the delivery gate.

**R2 protected-object access (S1).** Confirmed against the running store, not against a mock: an unsigned `GET` of a protected object returns **403**; a presigned `GET` returns **200**; swapping the key in a valid presigned URL returns an error, so the signature covers the key. The protected bucket is a separate bucket with no `publicUrlBase`, `PublicMediaController` serves only the public bucket, and `presignGet` is called from exactly two places, both inside the grant path. Protected assets are stored with `url: ''` rather than an invented durable address.

**Cloudflare Stream honesty (D-5, AD-16).** `cloudflare-stream.provider.ts:94-98` reports `boundToSession: false`, `boundToDevice: false`, `revocableBeforeExpiry: false`, `drm: false`, and the interface comment at `video-provider.interface.ts:144-157` records that an earlier version asserted the opposite and was wrong. `buildProtectionReport` copies the adapter's answer verbatim and types `drm` as the literal `false`. No adapter sets `downloadable`.

**D-1 … D-5.** Each fix is real, not cosmetic. D-1: `provider: tierProvider.storedAs` (`protected-media.service.ts:251`), and the same value is what `forProvider` routes on. D-2: both `createDirectUpload` implementations presign a real PUT. D-3: both adapters compute and report the clamped life. D-4: `reportsReadinessAsynchronously` is consulted by `createVideoUpload` (`:305`) and by `completeVideoUpload` (`:362`), which refuses to short-circuit an asynchronous provider. D-5: above. The owning worker's `src/media/video/p64-phase2-defects.regression.spec.ts` covers all five; this audit did not duplicate it.

**Quota aggregate agreement (AD-14).** `EntitlementEnforcementService:374` and `TenantUsageRecomputeService:182` both filter on the shared `HOSTED_VIDEO_PROVIDERS` constant rather than spelling out a list each, which is what stops enforcement and the Usage page telling a customer different numbers. `r2` is deliberately excluded. No price, currency or billing field appears anywhere in the video configuration.

**Guards and IDOR.** Every controller in `src/learning/` and `src/media/` carries a guard. The two without one are deliberate and documented: `PublicMediaController` serves the public bucket, and `VideoWebhookController` authenticates by HMAC instead. `LessonContentController` has no class-level guard but every method has its own, including the one `OptionalJwtAuthGuard` the preview case requires. Staff routes carry `JwtAuthGuard + ManagementSurfaceGuard + AcademyScopeGuard`. No learner endpoint accepts a user id: `request.authContext!.userId` is the only source on every one of them, and every id in a path is re-scoped to it (`{ id: lessonId, courseId }`, `{ id: deviceId, userId }`, `{ userId, academyId }`), so there is no reachable IDOR on the Phase 2 surface.

**Webhook verification.** HMAC over `time + "." + rawBody`, length-checked before `timingSafeEqual` so an attacker-controlled header cannot turn verification into a 500, and a five-minute replay window rejecting stale-but-once-genuine deliveries. The raw body is captured per-path and its absence fails closed.

**The Worker gate.** `deploy/video-gate-worker/src/gate.js` verifies the signature before decoding any attacker-supplied bytes, bounds the token at 4 KiB, rejects a token with a second dot, requires every claim to be present, uses `crypto.subtle.verify` (which cannot throw on a length mismatch), and binds the signed `k` to the requested object key. The entry point refuses every method but GET/HEAD/OPTIONS, sets `Cache-Control: private, no-store` explicitly rather than copying the object's stored headers, and never logs the token.

---

## 6. Tests added

All in files this worker owns.

| File | Tests | Pass / fail | Purpose |
|---|---|---|---|
| `test/p64-phase2-security.e2e-spec.ts` | 43 | **36 / 7** | The service half: the real object store (anonymous 403, signed 200, swapped key, TTL ceiling), the seven conditions including suspension and cross-academy, staff preview taking no lease, lease ordering, the grant's shape and expiry, `boundToDevice: false` for Premium, the signer's cross-academy and no-provider-id refusals, the device cap on unrecognised and on recognised devices, cookie forgery, takeover not creating a device, device removal, the HTTP guard stack and headers, and the host-versus-query-parameter tenancy claim. |
| `test/p64-phase2-rls-tiers.e2e-spec.ts` | 16 | **14 / 2** | The database half: `lesson_contents` with published+public fixtures (no context / foreign tenant / non-enrolled / revoked / expired / refunded / blocked / dripped), the preview short-circuit, learner write refusal, `media_assets` visibility (SEC-1), the tier/provider split and mixed-tier coexistence, registry refusal of an unknown provider, device self-scoping, refusal logging (SEC-2), retention. |
| `src/learning/services/learning-access.util.spec.ts` | 22 (5 pre-existing, 17 added) | **22 / 0** | `assertActiveEnrollment`, `assertCourseReadAccess`, `assertCanReviewCourse` and `assertCanManageSecurityPolicy` — including D8's owner-only rule and the refusal of a non-active managing membership. |
| **Total** | **81** | **72 / 9** | |

`npx tsc --noEmit -p tsconfig.json` → **0 errors**.

**Every one of the nine failures is a labelled finding regression** — SEC-1 ×4, SEC-2 ×4, SEC-3 ×1 — and there are no others. Tests named `FINDING SEC-n` assert the behaviour the master plan requires and fail today. They were written that way deliberately: the project's quality bar forbids weakening an assertion to produce green, and a failing regression is how a finding stays visible until it is fixed. When SEC-1, SEC-2 and SEC-3 are patched, all 81 should pass with no edit to any assertion.

---

## 7. Proposed patches NOT applied (file ownership)

| Finding | File(s) owned by another worker | Patch |
|---|---|---|
| SEC-1 | `prisma/migrations/**` | `can_access_media_asset()` definer + `media_assets_lesson_access_select` policy (§2, SEC-1) |
| SEC-2 | `prisma/migrations/**`, `src/learning/services/lesson-content.service.ts` | audit-insert policy, or a `SECURITY DEFINER` refusal writer (§2, SEC-2) |
| SEC-3 | `src/learning/services/lesson-content.service.ts` | move the asset-readiness check above the lease acquisition (§3, SEC-3) |
| SEC-4 | `src/media/video/basic-video.provider.ts`, `src/identity/services/auth.service.ts` | wire `signed_out` (or drop the value); report the capability from a reachability check rather than from configuration presence |
| SEC-5 | `src/media/controllers/video-webhook.controller.ts`, `src/media/media.module.ts` | resolve the webhook verifier through `VideoProviderRegistry` |
| SEC-6 | `src/media/video/fake-video.provider.ts` | `assertNotProduction()` in `verifyWebhookSignature` |
| SEC-7 | `prisma/migrations/**` | split the `FOR ALL` tenant policies into explicit write tiers |
| SEC-8 | `src/learning/services/course-content.service.ts` | drop `contentUrl` for locked lessons regardless of the flag |
| SEC-9 | `src/learning/services/lesson-content.service.ts` | rate-limit the anonymous preview branch by IP |
| SEC-10 | `src/learning/services/learner-session.service.ts` | apply the device-cap rank check in `takeover` |
| SEC-12 | `prisma/migrations/**` | self-scope `access_policies_read` |

---

## 8. Nothing in this audit claims

No control described here makes content download-proof, screen-record-proof or piracy-proof, and neither tier has DRM. A signed URL and a gate token are both bearer credentials for their lifetime. What Atlas can truthfully claim is what the plan already says it claims: entitlement checked on every request, short-lived credentials, no durable URL in any learner response, per-viewer watermark, and — for the Normal tier, once the revocation publisher is wired on every path — withdrawal of a credential before it expires.
