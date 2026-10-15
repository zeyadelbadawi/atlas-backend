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
| Boot check | `src/config/env.validation.ts` | in production, `FLAG_VIDEO_NORMAL_MODE` other than `off` without `BASIC_VIDEO_DELIVERY_HOST` + `BASIC_VIDEO_SIGNING_SECRET` refuses to start |
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
   stop on requests and KV reads, not cost. Buying it is an owner action.
   Check the current plan in Cloudflare → Workers & Pages → Plans.
2. **Delivery Worker deployed** (`atlas-video-gate`, route on the delivery
   host). Already deployed: it answers a token-less request with 401
   (Release verify, 13 Oct 2026). Its configuration, by name:
   - secret `GATE_SIGNING_SECRET`, equal to the API's
     `BASIC_VIDEO_SIGNING_SECRET` (rotation slot
     `GATE_SIGNING_SECRET_PREVIOUS`);
   - binding `VIDEO_BUCKET`, the same bucket as the API's
     `R2_PROTECTED_BUCKET`;
   - binding `GATE_DENYLIST` (KV);
   - vars `REVOCATION_MODE`, `DENYLIST_CACHE_TTL_SECONDS`,
     `DENYLIST_FAIL_MODE`, `ALLOWED_ORIGINS`, `ENFORCE_ORIGIN`;
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
| `BASIC_VIDEO_PLAYBACK_TTL_SECONDS` | no | default 600, capped at 3600 |
| `BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED` | no | `true` only when the Worker's `ALLOWED_ORIGINS` is set; otherwise the grant reports `originRestricted: false` |
| `BASIC_VIDEO_REVOCATION_ENDPOINT`, `BASIC_VIDEO_REVOCATION_TOKEN` | no, leave unset | the Worker has no revocation-write endpoint today (POST answers 405), so there is nothing to point these at; unset, the grant honestly reports `revocableBeforeExpiry: false` and the 10-minute token life is the revocation window. A session can still be revoked by hand with `wrangler kv key put` (Worker README) |
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
   `wrangler.toml` in the repository matches the live bindings (the KV ids
   are the only values issued by Cloudflare).

### 4.2 Configure secrets and settings

1. Generate one signing secret (a long random value). Set it as the Worker
   secret `GATE_SIGNING_SECRET` and as `BASIC_VIDEO_SIGNING_SECRET` in the
   host `.env`. One value, two places; a mismatch does not fail loudly (the
   Worker answers `403 bad_signature` to every play).
2. Set `BASIC_VIDEO_DELIVERY_HOST` in the host `.env` to the Worker's route
   host.
3. Leave `FLAG_VIDEO_NORMAL_MODE` **off** for now and redeploy (normal
   deploy). Nothing changes for users.
4. Run Release verify, `remote.sh video`. Expect:
   - `PASS  required names set: 2 of 2 (BASIC_VIDEO_DELIVERY_HOST BASIC_VIDEO_SIGNING_SECRET)`;
   - `PASS  preflight PUT origin=<dashboard origin> …` and the foreign
     origin refused;
   - `PASS  delivery host answers a token-less request with 401`.
   Any `FAIL` stops here.

### 4.3 Deploy Worker configuration

Only if something changed in section 2.2 (secret, bucket, route,
`ALLOWED_ORIGINS`): `npx wrangler@latest deploy` from
`deploy/video-gate-worker`, then `npx wrangler@latest tail` while one
token-less request is made (one `deny` line, reason `missing_token`).

### 4.4 Run the automated suites

On the release commit, in CI (SeaweedFS provides the bucket):

- backend e2e: `test/hosted-video-flow.e2e-spec.ts` (upload → ready →
  lesson with `videoAssetId` → enrolled learner granted with the watermark;
  quota refusals; Cancel; abandoned-upload release; roles and scope),
  `test/hosted-video-authoring.e2e-spec.ts`, `test/p64-phase2-api.e2e-spec.ts`,
  `test/p64-phase2-quota.e2e-spec.ts`, `test/p64-phase2-tiers.e2e-spec.ts`,
  `test/forensic-watermark.e2e-spec.ts`, `test/media-delete.e2e-spec.ts`,
  `test/archived-media-purge.e2e-spec.ts`;
- backend unit: `src/config/normal-video-activation.spec.ts`,
  `src/config/release-verify-video-facts.spec.ts`,
  `src/learning/services/phase2-maintenance.service.spec.ts`;
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
- [ ] The Platform Owner watermark lookup finds the code (J48 behaviour).

Afterwards: Release verify usage shows the new videos as `ready`; the
Worker's `wrangler tail` shows `allow` lines for the plays and no
`bad_signature`; the Workers dashboard shows the request and KV read counts.

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
  `atlas_learning_device_limit_hits_total`.
- Cloudflare Workers dashboard: requests per day and per minute against the
  plan limits (on Free: 100,000 per day account-wide and 1,000 per minute
  burst; error 1027 past them), KV reads, CPU time per request.
- Logs: `Released abandoned Normal-tier video uploads`, `Could not delete a
  discarded video upload` (the purge retries), Worker deny reasons via
  `wrangler tail`.

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
   See the Worker README.
4. The CORS rule can stay; it grants nothing without a presigned URL.

---

## 7. Still owner or infrastructure gated

- Workers Paid purchase (D3: not now).
- The canary and the production check (B0-OC-34).
- A revocation-write path for the Worker (an authenticated endpoint that
  writes the KV denylist), if early revocation is wanted; until then
  `BASIC_VIDEO_REVOCATION_*` stay unset and the grant says so.
- Premium (Cloudflare Stream): not onboarded; `FLAG_VIDEO_PREMIUM_MODE` and
  `hostedVideoPremium` stay off.
