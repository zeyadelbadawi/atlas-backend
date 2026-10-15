# Hosted video (Normal tier): activation runbook

**Status (15 Oct 2026):** hosted-video authoring is **off in production**, by
owner decision D3: Cloudflare Workers Paid is not bought now. The
engineering is finished (B0-MED-11), so turning it on later is
configuration and infrastructure work only. This runbook is that work, in
order. It names settings, never their values.

Related:
[`deploy/video-gate-worker/README.md`](../deploy/video-gate-worker/README.md)
(the delivery Worker),
[`ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md`](ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md)
(measured behaviour, cost model),
[`FORENSIC_WATERMARK.md`](FORENSIC_WATERMARK.md) (the learner watermark),
[`ROLLBACK_AND_PIN_RUNBOOK.md`](ROLLBACK_AND_PIN_RUNBOOK.md) (release
rollback and frontend pinning).

---

## 1. What is built, and what each switch does

| Piece | Where | Switch |
|---|---|---|
| Upload ticket (quota reserved first), presigned PUT straight to the protected bucket, completion (server HEADs the object and measures the duration), Cancel | `POST academies/:id/media/video-uploads`, `…/:assetId/complete`, `…/:assetId/cancel` | `FLAG_VIDEO_NORMAL_MODE` (`off` / `allowlist` / `on`) with `FLAG_VIDEO_NORMAL_ACADEMY_IDS` |
| Lesson saved with `videoAssetId` (this academy, protected, active, this course or academy-wide, upload finished) | lesson create / update API | none (refused data stays refused) |
| Learner grant: Worker-signed URL, device rules, forensic watermark | `GET /learning/courses/:id/lessons/:id/content` | **not flag-gated**: assets that exist keep playing (D11) |
| Abandoned-upload release (unfinished for 24 h → released, bytes deleted) | Phase 2 maintenance sweep (every 10 min) | always on; acts only on Normal-tier rows |
| Deleted-video purge (archive → bytes destroyed after 30 days) | archived-media purge | `FLAG_MEDIA_ARCHIVE_PURGE_MODE` (`dry_run` by default) |
| Course builder upload / library control | frontend `FEATURE_FLAGS.hostedVideoAuthoring` | compile-time constant, `false` |
| Video tier card (Normal only) | frontend `FEATURE_FLAGS.hostedVideoPremium` | `false`: no Premium option is ever shown |
| Revocation before expiry (Workstream D): the Worker re-authorizes every token with the API, answer cached ≤ 30 s | `POST /api/v1/video-gate/authorize` (`VideoGateAuthorizationService`), Worker `src/authz.js` | exists only when `BASIC_VIDEO_GATE_AUTHZ_SECRET` is set (404 otherwise); see §8 |
| Boot check | `src/config/env.validation.ts` | in production, `FLAG_VIDEO_NORMAL_MODE` other than `off` without `BASIC_VIDEO_DELIVERY_HOST` + `BASIC_VIDEO_SIGNING_SECRET` + `BASIC_VIDEO_GATE_AUTHZ_SECRET` (≥ 32 characters, different from the signing secret) refuses to start |
| Readiness facts | `deploy/release-verify/remote.sh video` | read only; section "Normal-tier activation config (names only)" |

Roles: owners, administrators and managers upload; a course's assigned
instructor can attach a video that is already in the library to that
course's lessons but cannot upload (`errors.media.insufficientRole`).

---

## 2. Prerequisites (owner)

1. **Workers plan decision.** The evidence note (B0-MED-11 CORS and Workers
   plan, section 4) recommends: Free is acceptable for the canary and a
   small pilot; **Workers Paid before** any academy with classes of 50+
   learners, or before the tier is opened beyond the allowlist. The reason
   is the account-wide 1,000 requests per minute burst limit and the daily
   stop on requests, not cost. (Revocation no longer uses KV, so the KV
   read and write quotas no longer apply; it needs no paid feature — §8.) Buying it is an owner action.
   Check the current plan in Cloudflare → Workers & Pages → Plans.
2. **Delivery Worker deployed** (`atlas-video-gate`, route on the delivery
   host). Already deployed: it answers a token-less request with 401
   (Release verify, 13 Oct 2026). Its configuration, by name:
   - secret `GATE_SIGNING_SECRET`, equal to the API's
     `BASIC_VIDEO_SIGNING_SECRET` (rotation slot
     `GATE_SIGNING_SECRET_PREVIOUS`);
   - secret `GATE_AUTHZ_SECRET`, equal to the API's
     `BASIC_VIDEO_GATE_AUTHZ_SECRET` (Workstream D — **new; the deployed
     Worker predates it and must be redeployed from this commit**);
   - binding `VIDEO_BUCKET`, the same bucket as the API's
     `R2_PROTECTED_BUCKET`;
   - vars `ATLAS_AUTHZ_URL` (the API's `/api/v1/video-gate/authorize`, https),
     `AUTHZ_CACHE_TTL_SECONDS` (≤ 30), `AUTHZ_TIMEOUT_MS`, `ALLOWED_ORIGINS`,
     `ENFORCE_ORIGIN`;
   - **no KV binding**: the former `GATE_DENYLIST` namespace and the
     `REVOCATION_MODE` / `DENYLIST_*` vars are gone (nothing ever wrote the
     denylist). The two namespaces may be deleted from the dashboard;
   - the route host, equal to the API's `BASIC_VIDEO_DELIVERY_HOST`.
3. **Protected bucket CORS rule.** Added by the owner on 13 Oct 2026; the
   preflight from the dashboard origin passes and a foreign origin is
   refused. The rule allows `PUT` from the dashboard origin only. Compare
   the dashboard JSON with the evidence note once, line by line (extra
   headers and `ExposeHeaders` cannot be seen from outside).
4. **Plan quotas.** The academies that will upload need a plan with
   `videoStorageMinutes` above zero (and `videoStorage`). An academy on a
   **Premium-family plan with no stored tier choice resolves to Premium**,
   which stays off: its owner must choose **Normal** on the academy settings
   card "Video protection tier" first (only Normal is offered), or uploads are refused
   `videoNotEnabled`. Pick a Normal-family academy for the canary.

---

## 3. Settings, by name

API host `.env` (`/opt/atlas/.env`; the deploy workflow does not pass these):

| Name | Required | Note |
|---|---|---|
| `BASIC_VIDEO_DELIVERY_HOST` | yes | the Worker's route host |
| `BASIC_VIDEO_SIGNING_SECRET` | yes | equal to the Worker's `GATE_SIGNING_SECRET` |
| `BASIC_VIDEO_GATE_AUTHZ_SECRET` | yes | equal to the Worker's `GATE_AUTHZ_SECRET`; ≥ 32 characters; **must differ** from the signing secret. Enables `POST /video-gate/authorize` and makes the grant report `revocableBeforeExpiry: true` (§8) |
| `BASIC_VIDEO_PLAYBACK_TTL_SECONDS` | no | default 600, capped at 3600 |
| `BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED` | no | `true` only when the Worker's `ALLOWED_ORIGINS` is set; otherwise the grant reports `originRestricted: false` |
| `BASIC_VIDEO_REVOCATION_ENDPOINT`, `BASIC_VIDEO_REVOCATION_TOKEN` | removed | the old push design (never had a receiver). No longer read; delete them from the host `.env` if present |
| `R2_PROTECTED_BUCKET`, `R2_PROTECTED_ACCESS_KEY_ID`, `R2_PROTECTED_SECRET_ACCESS_KEY` | already set | the protected bucket and its own token |
| `VIDEO_MAX_UPLOAD_BYTES`, `PROTECTED_MEDIA_URL_TTL_SECONDS` | no | defaults 5 GiB and 600 s |
| `VIDEO_PROVIDER` | no | not used to pick the Normal adapter (the tier decides); leave as is |

Repository variables (passed by the deploy workflow):
`FLAG_VIDEO_NORMAL_MODE`, `FLAG_VIDEO_NORMAL_ACADEMY_IDS`. Keep
`FLAG_VIDEO_PREMIUM_MODE` off.

Frontend (`atlas` repository, `src/config/feature-flags.config.ts`):
`hostedVideoAuthoring` (flip to `true` at step 6); `hostedVideoPremium`
stays `false`.

---

## 4. Steps

### 4.1 Provision

1. Owner: Workers plan decision (section 2.1). For a Free canary, record
   that it is a deliberate choice.
2. Confirm the Worker answers a token-less request with 401 and that
   `wrangler.toml` in the repository matches the live bindings. The live
   Worker still has the old KV denylist; it is replaced at §4.3.

### 4.2 Configure secrets and settings

1. Generate one signing secret (a long random value). Set it as the Worker
   secret `GATE_SIGNING_SECRET` and as `BASIC_VIDEO_SIGNING_SECRET` in the
   host `.env`. One value, two places; a mismatch does not fail loudly (the
   Worker answers `403 bad_signature` to every play).
2. Set `BASIC_VIDEO_DELIVERY_HOST` in the host `.env` to the Worker's route
   host.
3. Generate a SECOND, different long random value (e.g. `openssl rand -hex
   32`). Set it as the Worker secret `GATE_AUTHZ_SECRET` and as
   `BASIC_VIDEO_GATE_AUTHZ_SECRET` in the host `.env`. A mismatch fails
   closed: every play answers `503 authz_unavailable` and
   `atlas_video_gate_authz_total{decision="caller_rejected"}` rises.
4. Leave `FLAG_VIDEO_NORMAL_MODE` **off** for now and redeploy (normal
   deploy). Nothing changes for users: the authorization endpoint now
   exists but no Normal-tier token is minted while the tier is off.
5. Run Release verify, `remote.sh video`. Expect:
   - `PASS  required names set: 3 of 3 (BASIC_VIDEO_DELIVERY_HOST BASIC_VIDEO_SIGNING_SECRET BASIC_VIDEO_GATE_AUTHZ_SECRET)`;
   - `PASS  preflight PUT origin=<dashboard origin> …` and the foreign
     origin refused;
   - `PASS  delivery host answers a token-less request with 401`.
   Any `FAIL` stops here.

### 4.3 Deploy Worker configuration

**Required once for Workstream D** (the live Worker predates the
re-authorization call), and afterwards whenever something in section 2.2
changes (secret, bucket, route, `ALLOWED_ORIGINS`, `ATLAS_AUTHZ_URL`):

1. `npm test` in `deploy/video-gate-worker` (Node's built-in runner, no
   dependencies) — must be green.
2. `npx wrangler@latest secret put GATE_AUTHZ_SECRET` (the value from §4.2.3).
3. Check `ATLAS_AUTHZ_URL` in `wrangler.toml` is the API's
   `https://<platform host>/api/v1/video-gate/authorize`.
4. `npx wrangler@latest deploy`, then `npx wrangler@latest tail` while one
   token-less request is made (one `deny` line, reason `missing_token`).
5. From the API host, a signed probe is not needed: the canary play in §4.6
   proves the round trip (`atlas_video_gate_authz_total{decision="allow"}`
   increments).

### 4.4 Run the automated suites

On the release commit, in CI (SeaweedFS provides the bucket):

- backend e2e: `test/hosted-video-flow.e2e-spec.ts` (upload → ready →
  lesson with `videoAssetId` → enrolled learner granted with the watermark;
  quota refusals; Cancel; abandoned-upload release; roles and scope),
  `test/hosted-video-authoring.e2e-spec.ts`, `test/p64-phase2-api.e2e-spec.ts`,
  `test/p64-phase2-quota.e2e-spec.ts`, `test/p64-phase2-tiers.e2e-spec.ts`,
  `test/forensic-watermark.e2e-spec.ts`, `test/media-delete.e2e-spec.ts`,
  `test/archived-media-purge.e2e-spec.ts`,
  `test/video-gate-authorization.e2e-spec.ts` (revocation: sign-out,
  revoke-session, device removal, account deletion, enrollment revocation
  and block each deny on the next call; tenant and course isolation);
- backend unit: `src/config/normal-video-activation.spec.ts`,
  `src/config/release-verify-video-facts.spec.ts`,
  `src/learning/services/phase2-maintenance.service.spec.ts`,
  `src/media/video/video-gate-authorization.service.spec.ts`;
- Worker: `node --test deploy/video-gate-worker/test/*.test.js` (also a CI
  step) — valid/expired/revoked-within-30 s/cross-course/cross-academy/
  replay/Atlas-unreachable-fails-closed;
- frontend Vitest: `src/features/course/hosted-video-authoring.test.tsx`,
  `src/features/academy/academy-protection-cards.test.tsx`,
  `src/features/learner/forensic-watermark.test.tsx`;
- Playwright (local stack, `scripts/e2e-local-stack.sh` sets
  `FLAG_VIDEO_NORMAL_MODE=on`): `e2e/j49-hosted-video-playback.spec.ts`,
  plus `j44-device-limit-dialog` and `j48-forensic-watermark-lookup`.
  Locally the tier is served by the development stand-in, not the Worker.

### 4.5 Canary on the demo academy

Per-academy gating exists on the server; the frontend constant is global.

1. Repository variables: `FLAG_VIDEO_NORMAL_MODE=allowlist`,
   `FLAG_VIDEO_NORMAL_ACADEMY_IDS=<demo academy id>`; normal deploy. The
   API now refuses to start if the two required names are missing.
2. Frontend: a small PR setting `hostedVideoAuthoring: true`; merge and
   deploy through the normal release. Every academy's builder now shows
   the control; academies outside the allowlist get "Uploading videos to
   Atlas is not available for this academy yet" on upload. Keep the canary
   short for that reason.
3. Release verify `remote.sh video`: the activation row must still pass,
   `FLAG_VIDEO_NORMAL_ACADEMY_IDS entries=1`.

### 4.6 Verify on the canary

As the demo academy's owner (or manager), in the course builder:

- [ ] Video lesson → Upload a video (short MP4, under a minute): progress
      bar, then "Processing…", then "Attached: <file>". Save the lesson.
- [ ] Cancel during an upload: "Upload cancelled"; Release verify shows no
      extra in-progress video afterwards.
- [ ] Choose an uploaded video lists the upload (this course's and
      academy-wide videos only).
- [ ] A file that is not MP4, or over the size limit, is refused before
      uploading.
- [ ] Quota: on a test plan with few minutes, an upload over the remaining
      minutes is refused with the localised quota message (EN and AR).
- [ ] The tier card shows Normal only.

As a test learner enrolled in the course, on the academy website:

- [ ] The lesson plays; the forensic watermark code and the masked identity
      are drawn over the video, and the caption shows the same code.
- [ ] The network panel shows the delivery host with a `t=` token and no
      bucket URL; the token expires (10 minutes) and the player refreshes
      it without interrupting playback.
- [ ] Device rules: a third browser at a device limit of 2 is refused with
      the device dialog (J44 behaviour).
- [ ] A learner who is not enrolled gets no video.
- [ ] **Revocation (§8):** start the lesson in browser A, then from browser
      B (same learner) use "Sign out of all other sessions". Within 30 s,
      browser A's player stops (its next range request is `403`,
      `x-atlas-gate-deny: revoked`); `wrangler tail` shows a `deny` line
      with `"detail":"session_revoked"`. Repeat once with device removal
      (`device_revoked` / `session_revoked`) and once by revoking the
      enrollment from the roster (`access_ended`).
- [ ] The Platform Owner watermark lookup finds the code (J48 behaviour).

Afterwards: Release verify usage shows the new videos as `ready`; the
Worker's `wrangler tail` shows no `bad_signature` and no
`authz_unavailable`/`gate_misconfigured`; `/metrics` shows
`atlas_video_gate_authz_total{decision="allow"}` rising with plays and
`caller_rejected` at zero; the Workers dashboard shows the request counts.

### 4.7 Enable

Through the established release procedure, after the canary passes and,
for anything beyond a small pilot, after Workers Paid is in place:

1. Either add academies to `FLAG_VIDEO_NORMAL_ACADEMY_IDS`, or set
   `FLAG_VIDEO_NORMAL_MODE=on`; normal deploy.
2. The frontend constant is already `true` from the canary; leave
   `hostedVideoPremium` `false`.
3. Record the production check (B0-OC-34) with the Release verify run.
4. Consider `FLAG_MEDIA_ARCHIVE_PURGE_MODE=on` (after reviewing its
   `dry_run` logs) so deleted videos are destroyed after the 30-day grace.

---

## 5. Monitoring

- Release verify `remote.sh video`: activation row, CORS preflight, Worker
  probe, `protected videos=… ready=… in-progress=… failed=…`. A growing
  `in-progress` count that never falls means uploads are not completing;
  the maintenance sweep releases each one after 24 hours.
- Metrics (`/metrics`): `atlas_video_upload_completions_total`,
  `atlas_video_duration_provenance_total` (a rise in `declared` means
  durations are not being parsed), `atlas_content_grants_total`,
  `atlas_learning_device_limit_hits_total`, and — revocation —
  `atlas_video_gate_authz_total{decision}`: `allow` should track plays;
  any `caller_rejected` means a secret mismatch or an impersonation
  attempt (alert); **a drop to zero while learners are playing means the
  Worker has stopped asking, i.e. revocation is not enforced** (alert);
  deny reasons (`session_revoked`, `device_revoked`, `account_inactive`,
  `access_ended`, …) show revocations taking effect.
- API logs: `video_gate.authz.denied` (reason, truncated user id), HTTP 429
  on `POST /video-gate/authorize` (the route's per-IP ceiling, 6,000/min —
  if it appears, see §8 capacity), 5xx on the same route (each one is a
  refused play).
- Cloudflare Workers dashboard: requests per day and per minute against the
  plan limits (on Free: 100,000 per day account-wide and 1,000 per minute
  burst; error 1027 past them), CPU time per request, subrequest errors.
- Logs: `Released abandoned Normal-tier video uploads`, `Could not delete a
  discarded video upload` (the purge retries), Worker deny reasons via
  `wrangler tail` (`revoked` with Atlas's `detail`, `authz_unavailable`,
  `gate_misconfigured`).

---

## 6. Rollback

1. `FLAG_VIDEO_NORMAL_MODE=off` and a normal deploy (seconds of work). New
   uploads are refused `videoNotEnabled`. Nothing else changes: **assets
   that exist stay valid and keep playing** (playback is not flag-gated),
   lessons keep their `videoAssetId`, and unfinished uploads are released
   by the sweep within 24 hours.
2. Frontend: revert the `hostedVideoAuthoring` PR, or
   `bash deploy.sh --pin-frontend <commit>` for an immediate frontend-only
   rollback (`ROLLBACK_AND_PIN_RUNBOOK.md`). Lessons with a hosted video
   keep it; the builder simply stops offering uploads.
3. If playback itself must stop (a suspected signing-secret leak): rotate
   `GATE_SIGNING_SECRET` without the previous slot (every URL in flight
   dies at once), then update `BASIC_VIDEO_SIGNING_SECRET` and redeploy.
   See the Worker README. For ONE learner or session, no rotation is
   needed: revoke the session, remove the device, block the learner or
   revoke the enrollment in Atlas; the gate refuses within 30 s (§8).
4. If the authorization endpoint itself misbehaves (e.g. a bug refusing
   entitled learners): there is deliberately **no fail-open switch**. Fix
   forward, or turn the tier off (step 1) — playback of existing assets
   then also stops, because the Worker refuses what Atlas cannot
   authorize. Removing `BASIC_VIDEO_GATE_AUTHZ_SECRET` is not a rollback:
   with the flag on the API refuses to start, and with it off the Worker
   fails closed.
5. The CORS rule can stay; it grants nothing without a presigned URL.

---

## 7. Still owner or infrastructure gated

- Workers Paid purchase (D3: not now).
- The canary and the production check (B0-OC-34).
- Deploying the Worker from this commit (§4.3) and setting the two
  `GATE_AUTHZ_SECRET` / `BASIC_VIDEO_GATE_AUTHZ_SECRET` values. Until then
  production is unchanged (flag off, endpoint 404, grant reports
  `revocableBeforeExpiry: false`).
- Premium (Cloudflare Stream): not onboarded; `FLAG_VIDEO_PREMIUM_MODE` and
  `hostedVideoPremium` stay off.

---

## 8. Revocation before expiry (Workstream D)

**The problem it closes.** A playback token lives up to
`BASIC_VIDEO_PLAYBACK_TTL_SECONDS` (600 s). The Worker used to check only
signature, object key and expiry, so a learner whose session was revoked,
device removed, account deleted, enrollment revoked or membership blocked
kept streaming until the token expired. The earlier fix (Atlas POSTing
revoked session ids to a "revocation endpoint" that would fill a KV
denylist) had no receiver — the Worker answers `405` to every POST — so the
endpoint stayed unset and the grant honestly reported
`revocableBeforeExpiry: false`.

**The mechanism.** After `gate.js` verifies a token, the Worker
(`src/authz.js`) asks the API — `POST /api/v1/video-gate/authorize` with
`{ token, objectKey }`, HMAC-SHA256 over `timestamp.body` with
`GATE_AUTHZ_SECRET`, ±60 s freshness — whether the token is still honoured.
`VideoGateAuthorizationService` verifies the token with Atlas's own signing
secret, then re-checks, **in the token user's own RLS context**, the
grant conditions that can change after a grant: account `active`; the
session has a live `refresh_tokens` row (every session-ending path —
sign-out, revoke-session, sign-out-others, credential change, takeover,
device removal, block, account deletion — revokes those rows); the device
row is unrevoked and belongs to that user and academy; enrollment and
academy membership are current; course and lesson are published and the
lesson still points at these bytes. Tokens now carry a signed scope
(`a` academy, `c` course, `l` lesson); the API cross-checks it against the
object key and the database, so a token can never be re-scoped to another
academy or course. Staff-preview tokens are honoured while the user is
still staff; open-preview tokens while the lesson is still an open preview.

**The bound: ≤ 30 s.** Each Worker isolate caches an answer per token for
at most `AUTHZ_CACHE_TTL_SECONDS` (clamped to 30 in code; the API also caps
its `ttlSeconds` at 30, and never past the token's expiry), counted from
when the question was sent. A revocation committed at T is refused for
every NEW request, at every edge location, by T + 30 s. There is no
propagation delay on top: the API reads its primary database directly.
Setting `AUTHZ_CACHE_TTL_SECONDS=0` makes revocation immediate at the cost
of one API call per range request.

**What the bound does not cover (stated honestly).** A response body that
began streaming before T is not cut off — a single `GET` without `Range`
(a download tool, not a browser player) can finish the whole object.
Browser players issue many range requests, so they stop within the bound.
Bytes already downloaded are not recalled; nothing here is DRM.

**Failure policy: fail closed.** If the API cannot be asked (network
error, timeout `AUTHZ_TIMEOUT_MS`, any non-200, unparseable answer) the
Worker answers `503 authz_unavailable`, caches nothing, and asks again on
the next request. Missing or non-https Worker settings answer
`503 gate_misconfigured`. The **only** requests served without a fresh
answer are those inside a positive answer's ≤ 30 s window — that is the
bound itself, not an exception. There is no stale-while-revalidate, no
grace period and no fail-open setting; the documented exception policy is
that there is none (an operator who needs playback during an API outage
has no lever short of a code change, by design).

**Why no purchase is needed.** No KV, no Durable Object, no paid feature:
one subrequest from the Worker to the API per (token, isolate, 30 s).
Subrequests to the origin do not count as Worker requests. Workers KV was
rejected: it needs a writer holding a Cloudflare credential, is eventually
consistent "60 seconds or more" (no upper bound), and on the free plan
allows 100,000 reads and 1,000 writes a day — a quota a fail-closed gate
would turn into an outage. Durable Objects were rejected as unnecessary
state at the edge (and a second source of truth).

**Capacity.** API load is about two authorization calls per playing
learner per minute per Worker isolate — each a handful of indexed
primary-key / unique-index reads in one RLS transaction. The route has
its own per-IP ceiling (6,000/min) because Cloudflare egress addresses are
shared by many viewers; the global 120/min/IP throttle would otherwise
turn a busy edge location into a refused-playback outage. Watch for 429s
on the route (§5).
