# Atlas — Account Deletion and Data Lifecycle

**Status: living document. Started 25 September 2026.**
**Governed by `ATLAS_PRODUCT_QUALITY_MASTER_PLAN.md` — where this document and that one disagree, that one wins.**

Every claim below was verified against the schema, the migrations and the code on
backend `c85b644` / frontend `bc42ac4`. Sections are marked `IMPLEMENTED`,
`PARTIAL` or `DESIGNED — NOT BUILT` so nothing here can be mistaken for shipped
behaviour. That classification discipline is required by §6 of the Quality Master
Plan.

---

## 1. The deletion model, and why it is what it is

> **Atlas deletes the *person* and the *bytes*. It does not delete the *record*.**

Three independent facts force this, and none of them is a matter of taste.

**1. `users` cannot be hard-deleted.** The table is referenced by 53 foreign keys,
**ten of which are `ON DELETE RESTRICT`**: `organizations.owner_user_id`,
`audit_log_entries.actor_user_id`, `announcements.author_id`, `blog_posts.author_id`,
`forum_threads.author_id`, `forum_replies.author_id`, `payment_reviews.reviewed_by`,
`provisioning_requests.requested_by_user_id`, `course_order_refunds.requested_by`,
and `live_sessions.host_user_id`. Any account that has ever *done* anything has audit
rows, so `DELETE FROM users` is refused by the database for essentially every real
user. Those constraints are correct: audit, billing and moderation history must
survive a person leaving.

> The `20260916000000_p38_account_deletion` migration comment lists only nine of
> these. `live_sessions.host_user_id` arrived later with P44 and the comment is now
> stale. Corrected here rather than in place, so the migration's history stays honest.

**2. Tenant content cannot be hard-deleted either.** 65 RLS-enabled tenant tables —
including `organizations`, `academies`, `courses`, `enrollments`, `media_assets`,
`certificates`, `payments` — have **no `FOR DELETE` policy at all**. `atlas_app` holds
the SQL `GRANT`, so a `DELETE` does not error: **RLS filters every row and it silently
affects zero**. That silent-success failure mode is the single most dangerous thing in
this area, and it has already bitten Atlas once (see §9).

> One exception behaves differently and must be designed around: `student_devices` had
> `DELETE` revoked at the *privilege* level in
> `20261009000000_p64_phase2_protected_content_video_devices`, so a delete there raises
> a Postgres permission error rather than a silent no-op.

Making deletion literal would mean either a superuser escape hatch — never, see §10 —
or adding ~65 new DELETE policies, which is a large new attack surface built to
satisfy a word.

**3. It is a deliberate legal posture.** Recorded in the Phase 10.4–10.6 report against
Egypt PDPL 151/2020 (+ Executive Regulations, Decree 816/2025) and Saudi PDPL M/19.
Erasure of identity is the obligation; destruction of financial and audit history is
not, and in places is prohibited.

### What deletion therefore means

| Layer | Treatment |
|---|---|
| Identity (name, email, avatar, preferences, credentials) | **Irreversibly scrubbed.** Cannot be recovered or re-authenticated. |
| Tenant content (academy, courses, website) | **Archived and made unresolvable.** Row survives; nothing serves it. |
| External bytes (R2 objects, Stream videos) | **Genuinely destroyed**, verified absent, then tombstoned. |
| Sessions, devices, grants, leases | **Revoked immediately.** |
| Financial and audit records | **Retained, pointing at an anonymised subject.** Never rewritten. |
| Forensic video watermark records | **Retained, with the identity at issue time** (encrypted snapshot: name, email, phone). Anti-piracy evidence must outlive the account that leaked; readable only by a Platform Owner lookup; pruned only by retention (`WATERMARK_RETENTION_DAYS`, default 730 days after last shown). See `FORENSIC_WATERMARK.md`. |

"The organization ceases to exist as a live Atlas tenant" is satisfied by rows 2–4.
Row 5 is the part that must not be faked.

---

## 2. What exists today

### `IMPLEMENTED` — Self-service account deletion

`POST /api/v1/users/me/delete` → `AccountDeletionService.deleteOwnAccount`
(`src/identity/services/account-deletion.service.ts`).

- **No user-id parameter anywhere.** The account acted on is the one proved by the
  access token, so horizontal privilege escalation is absent *by construction*, not by
  a check that could be forgotten.
- Platform Owner is **refused on the server** (403), not merely hidden in the UI.
- Idempotent: deleting an already-`deleted` account is a no-op, not an error.
- Scrubs `email` → `deleted-<uuid>@account.invalid` (the column is UNIQUE so it cannot
  be blanked), `passwordHash` → a value no password can produce, `name`, `avatarUrl`,
  `preferences`; sets `status='deleted'`, `deletedAt`.
- Destroys 2FA secret, recovery codes, password-reset and email-verification tokens.
- Revokes every session in-transaction, then writes the Redis denylist **after commit**
  — a Redis failure must not roll back a completed deletion.
- Removes memberships **inside per-organization tenant context**, because a
  context-free `deleteMany` matches zero rows and reports success.
- Archives owned academies with a direct status update (`status='archived'`). This is
  NOT `AcademiesService.archive`: it does not set `archivedAt`. The archived-media
  sweep can still pick up individually archived assets of these academies as
  candidates, but `isPurgeEligible` refuses every asset of an archived academy whose
  `archivedAt` is null, so none is ever purged. It does not release custom domains or
  clear the hostname cache — the public resolver refuses archived academies, so the
  site drops once that cache expires (about a minute). No restore path exists for any
  archived academy.
- Enqueues certificate anonymisation on the certificates queue.

### `IMPLEMENTED` — Academy archive

`POST|DELETE /api/v1/academies/:id/delete` → `AcademiesService.archive`. Owner-level
only. Sets `status='archived'`, releases the plan's academy allowance, enqueues a
Cloudflare custom-hostname release through the `domain_provider_releases` ledger, and
invalidates **every** hostname form in the Redis resolution cache so the site goes
offline within the request rather than after the 60s TTL.

### `IMPLEMENTED` — Course archive

`DELETE /api/v1/academies/:id/courses/:courseId` → `status='archived'`. Never a SQL
DELETE; `courses` has no DELETE policy.

### `IMPLEMENTED` — Self-delete freeze fix (25 Sep 2026)

See §8. Frontend `2380e51`, production-verified.

### `IMPLEMENTED` — Deletion plan (25 Sep 2026)

`GET /api/v1/users/me/deletion-plan` and
`GET /api/v1/platform-user-management/:userId/deletion-plan` →
`DeletionPlanService`. Read-only. Returns per-group lines carrying one of
the five treatments plus real counts read from the rows the deletion will
act on, so a confirmation dialog can never drift from the code. Keeps the
no-`:id` shape on the self route so it cannot enumerate what others own.
Backend `5b79d9f`; the self route is production-verified (401 registered,
404 on a nonexistent sibling).

Every count states the context it needs, because a count outside the
right context does not error — RLS filters every row and returns a
confident zero. Notably `enrollments` is user-scoped, so the affected-
learner figure comes from `academy_students` instead.

### `PARTIAL` — Platform Owner administrative deletion (25 Sep 2026)

`POST /api/v1/platform-user-management/:userId/delete` →
`AccountDeletionService.deleteUserAsPlatformOwner`. One implementation,
two doors: both entry points call one private `performDeletion`, so the
resulting data state cannot depend on who pressed the button. Runs in the
TARGET's own context, which is what lets the existing self-scoped DELETE
policies apply without widening anything for operators.

Two server-side refusals: an operator may not delete themselves through
it, and may not delete another Platform Owner — nothing in the product
can grant `is_platform_owner` back, so that would be an unrecoverable
lockout. Audited as `account.deleted_by_platform_owner` with the operator
as actor.

Backend `2965719`, live in production only after the hotfix below.
Production-probed: `401` on the real route, `404` on a nonexistent sibling,
so the 401 means registered-and-guarded rather than a catch-all.

### `IMPLEMENTED` — Platform Owner deletion surface (26 Sep 2026)

Frontend `933a7d4`. The action lives on the user DETAIL page, not the
directory listing: only the detail page shows email, status, roles and
memberships together, which is what an operator needs to be sure they have
the right person. A delete button on a paginated row is how the wrong
account gets removed.

The impact list is built from the server's plan and labels each group with
the treatment it actually receives. Destructive emphasis is reserved for the
groups genuinely destroyed — painting the retained audit and payment rows
red would say they are being erased. Each row carries an icon **and** the
treatment in words, so the distinction survives greyscale and
colour-blindness. Confirmation is the target's email, typed (trimmed,
case-insensitive). The dialog cannot be dismissed mid-flight and the outcome
renders in place rather than as a toast.

Also fixed a pre-existing defect found here: `PlatformUserAccountStatus`
omitted `deleted` although the backend enum has carried it since Phase 10.6,
so an already-deleted account rendered an untranslated status label.

### `IMPLEMENTED` — Nest module-graph guard (26 Sep 2026)

`src/platform/controllers/deletion-module-graph.spec.ts`, backend `a5ce4ec`.
See §13.

---

## 3. What does not exist — the real gaps

| Gap | Severity | Detail |
|---|---|---|
| **Public R2 objects are never deleted** | **High** | `MediaStorageProvider` exposes only `putObject`/`getObject`. There is no delete capability on the public bucket *at all*. Every logo, thumbnail and marketing image stays fetchable at its public URL forever, after archive and after account deletion. |
| **Cloudflare Stream videos are never deleted** | **High** | `deleteAsset` exists and works, but its only caller is the video-retention sweep. Deleting a course or lesson leaves the video playable and still billing storage minutes. |
| ~~**Certificate PDFs are orphaned**~~ **FIXED 26 Sep 2026** (be `cce0de7`, `purge-superseded` job; see `ATLAS_CLOUD_SESSION_BASELINE.md` §8 K). Correction: anonymisation overwrites the CURRENT version in place (keys are versioned and the version is unchanged); the leak was the EARLIER versions left by re-issue/regeneration | Medium | Anonymisation nulls `storageKey` and re-renders, but never deletes the previous PDF — which carries the real learner's name — from the protected bucket. A live PII retention leak. |
| ~~No Platform Owner management UI~~ | — | **Closed** by frontend `933a7d4`. |
| **No organization teardown** | Medium | Academies are archived; the `Organization` row and its subscription state are left active. |
| **No deleted-course learner tombstone** | Medium | An archived course simply vanishes from the learner's view. |
| **Learning leases not revoked** | Medium | `LearningLeaseService.revokeAll` exists and is exactly the right primitive, but no deletion path calls it. A learner mid-playback continues until the lease TTL. |
| **Archived rows stay searchable** | Medium | `searchVector` is a generated column computed from `name`/`title`/`description`. Archiving changes none of those, so the row remains in the GIN index unless every query filters on status. |

---

## 4. Role-by-role behaviour

`IMPLEMENTED` unless marked.

| Role | On self-deletion |
|---|---|
| **Student / Learner** | Identity scrubbed; sessions revoked; memberships and enrolment grants removed; certificates anonymised (issuance facts kept, holder name replaced). Quiz attempts, submissions, progress and orders are **retained pointing at the anonymised subject** — they are academy and financial records, not personal profile data. |
| **Instructor** | Identity scrubbed; `course_instructors` rows removed. **Courses are not touched.** A course belongs to the academy, not the instructor; `courses.createdById` is `SetNull`, so authorship becomes "Not recorded". Destroying academy-owned teaching content because a staff member left would be a bug, not a feature. |
| **Manager** | As Instructor, minus the teaching assignments. |
| **Client Owner** | Identity scrubbed; **all owned academies archived** (sites offline, domains released, allowance freed). The `Organization` row is retained: it anchors billing and audit history, and other people's data hangs off it. |
| **Platform Owner** | **Refused, 403.** Self-deleting the account that administers the platform is not a user-facing operation. |

### `DESIGNED — NOT BUILT` — open business decision

When a Client Owner deletes their account, learners in their academies lose access
**immediately**, consistent with academy archive today. The alternative — honouring paid
enrolments to period end — needs new grace-state machinery and contradicts the existing
archive behaviour. **Recorded as an assumption, not an owner decision.** It must be
confirmed before the teardown work ships.

---

## 5. `DESIGNED — NOT BUILT` — Storage and external teardown

Atlas already has the right pattern twice over: `VideoRetentionDeletionService` and
`DomainProviderReleaseService`. Deletion will extend that house style, not invent a
framework.

**Non-negotiable properties, all inherited from the retention pipeline:**

1. One queue, **exactly one `@Processor`**. BullMQ hands a job to whichever worker
   claims it first, not the one whose switch recognises the name, so a second processor
   silently eats jobs.
2. Deterministic job ids that **never contain `:`** — BullMQ treats a colon as a key
   separator.
3. **Re-validate the entire decision at execution time.** Never trust the enqueue-time
   decision; a tenant that reactivated between enqueue and execution must be skipped,
   and the race resolves in the customer's favour.
4. **delete → verify absent → tombstone**, strictly in that order. A tombstone is
   written only from positive evidence of absence.
5. A provider 404 counts as **success** — idempotent on the provider's own terms.
6. A zero-rows-changed tombstone write is an **error**, never a no-op: "bytes gone, row
   does not say so" is the worst reachable state.
7. Terminal failures are kept (`removeOnFail: false`) for a human.

**Required new capability:** `deleteObject` must be added to the public
`MediaStorageProvider`. It does not exist, and no amount of orchestration substitutes
for it.

### Known provider limitation, documented not engineered around

**Cloudflare Stream has no per-session or per-token revocation.** Its only kill switches
are deleting the asset or rotating the account signing key, which would invalidate every
token for every tenant. So for Premium-tier video there is a window of up to the token
lifetime (~2h) where an already-issued playback URL keeps working after deletion.
Deleting the asset closes it; nothing else does. This is a provider capability gap, and
the product must not claim otherwise.

---

## 6. `DESIGNED — NOT BUILT` — Failure and retry

Database state and external object state are not one transaction, so the design assumes
partial failure rather than hoping against it:

- The database transaction commits first and is authoritative.
- External cleanup is a **queued, retryable job per object**, never inline in the
  request.
- Each job re-validates, acts, verifies, then records outcome on the row
  (`deletedAt` / `deletionFailedAt` / `bytesFreed`, the shape `MediaAsset` already uses).
- Redis and gate-revocation failures are **best-effort and logged**, never fatal —
  credentials self-expire, and a delivery-layer outage must not undo a committed
  deletion.
- Replay is safe: deterministic job ids dedupe at the queue, and provider-404-is-success
  dedupes at the provider.

**No job cancellation.** Atlas has no generic BullMQ cancel-by-entity utility and will
not grow one; the house convention is execution-time revalidation in every processor.
One gap to close: `quiz-deadlines` has no visible existence guard at the processor
layer.

---

## 7. `DESIGNED — NOT BUILT` — Deleted-course learner experience

An archived course must stay gone — no access through old URLs, API ids, cached pages,
media URLs, search, recommendations or website sections — while the learner's *history*
must remain legible. The direction is the tombstone pattern already used by
`MediaAsset`: keep the enrolment and order rows, resolve the course reference to a
minimal snapshot (title, academy, archived date), and render "This course has been
deleted by the Academy." Content endpoints continue to refuse as they do today: **404,
not 403**, because unreachable and nonexistent must be indistinguishable in a paid
catalogue.

---

## 8. `IMPLEMENTED` — The self-deletion freeze (25 Sep 2026)

**Symptom.** Deleting your own account froze the application immediately, and it stayed
frozen after a reload.

**Root cause — a re-entrant deadlock, not a spinner bug.** The 401 interceptor in
`atlas-front/src/services/api/http-client.ts` refreshes and retries. `performRefresh`
sends `POST /auth/refresh` through the *same* axios instance, so its response re-enters
the *same* interceptor. Account deletion revokes every session synchronously, so the
follow-up `POST /auth/sign-out` answered 401, which started a refresh; the refresh token
was also revoked, so `/auth/refresh` answered 401 too, re-entered the branch, found
`refreshPromise` already set and awaited it — but that promise could only settle once
this very request settled. A true circular await: no rejection, and no timeout, because
what was stuck was the interceptor's promise rather than a socket.

Consequences followed exactly: `authenticationService.signOut()` never returned, so
`tokenService.clear()` never ran and the dead tokens stayed in `localStorage`;
`isDeleting` stayed true so the dialog could not be closed; and on reload
`restore()` hit the same deadlock via `/auth/validate`, so `isRestoring` never went
false and `RouteGuard` rendered its pending fallback forever — deterministically, on
every reload, because the poisoned tokens were never purged.

**Fix.** Auth-lifecycle routes (`/auth/refresh`, `/auth/sign-out`, `/auth/sign-in`,
`/auth/validate`) are exempt from the refresh-and-retry branch. A 401 from any of them
is a final answer and is returned as one. Refreshing a session is meaningless for the
four routes that establish, check or end one.

No other change was needed: `authenticationService.signOut()` already swallowed errors
and `restore()` already cleared tokens on validation failure. Both were simply never
reached.

**Regression test.** `src/services/api/auth-lifecycle-401.test.ts` reproduces the real
topology — the mocked `sessionService.refresh` re-enters the live interceptor with a 401,
as the real one does over the wire — and fails by timeout if the re-entrancy returns.
**Proven to bite:** removing the guard fails all five tests with "interceptor never
settled". An earlier version of this test passed without the fix and was rewritten;
a test that cannot fail is worse than no test.

---

## 9. Precedents worth not relearning

- **Silent RLS no-ops.** The first version of account deletion anonymised the user but
  left every membership row, because `deleteMany` outside a tenant context matched zero
  rows and reported success. Fixed by `20260916010000_p38b_self_membership_delete` plus
  explicit context wrapping. Test `P106-DEL-004` exists only so it cannot regress.
- **`p44` dropped the `search_vector` columns** as schema drift and broke `/search` in
  production for about eight days. Deletion work touching generated columns or search
  filters inherits that lesson.
- **`platform-users` is read-only by product spec**, with doc comments cautioning against
  inventing user-management mutations. Adding administrative deletion is a deliberate
  reversal of a prior decision and must be recorded in the decision log, not slipped in.

---

## 10. Security rules this work may not bend

Deletion is the most destructive capability in the product, so the standing rules apply
with no exceptions:

- **Guard decides, RLS independently agrees.** Both, always.
- `atlas_app` stays `NOSUPERUSER` / `NOBYPASSRLS`. **No superuser connection to "make
  deletion easier"** — RLS is inert for a superuser, which would silently remove the
  second barrier from the single most dangerous operation.
- No broad or permissive DELETE policy. Any new one is narrow, scoped to a context
  variable, and justified in its migration.
- Self-deletion keeps its no-id-parameter shape.
- Administrative deletion is `PlatformOwnerGuard`-gated, re-reading
  `users.is_platform_owner` per request, and runs **the same canonical service** as
  self-deletion — no duplicated deletion logic in a controller.
- Never log passwords, OTPs, tokens, reset links or provider credentials.

---

## 11. Known limitations

1. Public R2 objects, Stream videos and superseded certificate PDFs are **not deleted
   today** (§3). This is the largest outstanding correctness and privacy gap.
2. Cloudflare Stream cannot revoke an issued playback token (§5).
3. The `Organization` row survives owner deletion by design; only academies are archived.
4. Archived content remains in the search index unless queries filter on status (§3).
5. Learner access on Client Owner deletion is an **assumption, not an owner decision** (§4).
6. `quiz-deadlines` has no confirmed execution-time existence guard (§6).

---

## 12b. Production identity migration — `IMPLEMENTED` (25-26 Sep 2026)

No secrets are recorded here: no password was ever revealed to anyone, and
the provisioning password was generated inside the remote command, hashed by
`PasswordHasherService` and discarded.

**Outcome.** `zeyadelbadawi.ze@gmail.com` is the Platform Owner, id
`c9a8267c-d352-4280-bb67-d446a6b5f2e5`, `status: active`, `is_platform_owner:
true`, owning no organization, holding no membership, academy role or
studentship.

**Sequence, in the safe order.** The previous Client Owner row for that
address (`ab5660db-…`) was deleted first — by the owner, through the product
— which anonymised its email to `deleted-<uuid>@account.invalid` and freed
the UNIQUE constraint. Its organization row is retained by design, pointing
at the anonymised subject. Only then was the address provisioned through
`src/scripts/provision-platform-owner.ts`, which refuses to touch an email
that exists and is not already a platform owner, so it could not have
hijacked a live account.

**Verified, with evidence rather than assertion:**

| Check | Evidence |
|---|---|
| Exists exactly once | `SELECT count(*) … WHERE email = '…'` → 1 |
| Email stored exactly | `zeyadelbadawi.ze@gmail.com`, no case or dot drift |
| Platform Owner | `is_platform_owner = t` |
| No Client Owner left on that address | non-platform-owner rows with that email → 0 |
| No tenant attachment | owns_orgs 0, memberships 0, academy roles 0, studentships 0 |
| Canonical email actually sent | `communication_deliveries` → `email / delivered / brevo` |
| **Authenticated through the real OTP/new-device flow** | `auth_email_challenges` row **consumed**; live `refresh_tokens` row on the **`management`** surface; **1 `trusted_devices`** row; `last_sign_in_at` set |
| OTP policy in force | `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT=new_device` read from the running container |
| Platform routes registered and guarded | `platform-users`, `platform-user-management/:id/deletion-plan`, `platform-metrics` → 401; a nonexistent sibling → 404 |

**Deliberately NOT done.** `ziadelbadawi@gmail.com` (`511d05bf-…`) is
untouched: it is a Platform Owner that has actually signed in and owns an
organization, and the request never unambiguously identified it (the
addresses originally named, `ziad.elbadawi@gmail.com` and
`ziad.elbadawi.ZD@gmail.com`, matched no row — Gmail ignores dots, so the
stored row is the undotted one). Deleting the wrong privileged account is
irreversible and nothing in the product can grant `is_platform_owner` back.

**Open item.** `ziad.elbadawi.zd@gmail.com` (`51808bca-…`) was provisioned
under the earlier, since-superseded instruction and has never been used. It
is a surplus privileged account and should be removed — but
`AccountDeletionService` deliberately refuses to delete a Platform Owner, so
removing it requires an explicit, separately authorised step rather than the
ordinary path. Recorded rather than quietly left behind.

---

## 13. The outage this work caused, and the guard that now prevents it

`IMPLEMENTED`

On 25 September 2026, backend `2965719` added
`PlatformUserManagementController` to `PlatformModule` injecting
`AccountDeletionService`, which `IdentityModule` provided but never
exported. **Nest resolves dependency injection at bootstrap, not at compile
time.** `tsc` passed. `nest build` passed. The image built and pushed. Then
`atlas-backend-1` came up unhealthy, `docker compose up --wait` failed the
deploy, and every `/api/v1` route answered **502 for roughly two and a half
hours** — while Caddy went on serving the frontend perfectly, which is why
the site looked alive.

Two deploys burned before the cause was visible, because the docs-only
commit stacked on top failed identically: the break was in the module graph,
not in anything that commit touched.

Fixed by `131ad8d` (one `exports` entry). Guarded by
`deletion-module-graph.spec.ts`, which reads the same decorator metadata
Nest reads — the controller's `design:paramtypes` and the module's
`exports` — and fails when an injected dependency is not exported. Proven to
bite: removing the export fails it and names the service.

**The rule that follows.** Nothing in the build pipeline models the
injector. A cross-module provider that is not exported is invisible to every
check Atlas runs until the container refuses to start. Any new controller or
service that crosses a module boundary must either be covered by that spec
or added to it.

---

## 12. Maintenance rules

- Any new model that holds tenant content must state, in its schema comment, what
  happens to it on deletion of its owner. Silence is how gaps are created.
- Any new external object store must ship a delete capability **with** its upload
  capability. The public R2 provider is the cautionary example.
- Any new queue processor must re-validate its target at execution time.
- Anything that cannot be deleted must be *explained* to the person who asked for its
  deletion, not silently skipped.

---

## 14. `IMPLEMENTED` — Media lifecycle: archive now, destroy after 30 days (26 Sep 2026)

This section follows the owner's decision of 26 September 2026. It **supersedes the
"DESIGNED — NOT BUILT" media rows in §3 and §5** for media assets. Certificate PDFs are
handled separately: superseded versions are purged by the `purge-superseded` job, and
the current version is never deleted.

**Policy.** Archiving never destroys bytes on the spot. That covers a staff "Delete" in
the Media Library or Media Picker, and an academy archive, which is what account
deletion and academy deletion do. Bytes are destroyed only when **all** of these hold,
re-checked at execution time:

- **Age:** the academy was archived ≥ 30 days ago, **or** the asset itself was archived
  ≥ 30 days ago and nothing references it any more;
- **No hold:** the organization has no legal hold and no open support case. This reuses
  the retention pipeline's §31 hold, so the stronger rule wins;
- **Purge mode:** `FLAG_MEDIA_ARCHIVE_PURGE_MODE` is `on`.

**Mechanism.** `ArchivedMediaPurgeService` (`src/retention/services/`) reuses the
existing retention machinery rather than adding a second deletion pipeline:

- **Queue:** it runs on the existing `video-retention` queue and its single processor,
  with job names `archive-purge-sweep` (every 6 h) and `archive-purge-asset`
  (job id `media-purge-<assetId>`).
- **Hosted video** (Stream / Normal tier) goes through
  `VideoRetentionDeletionService.destroyAndVerify`, where a provider 404 counts as
  success and absence must be proven.
- **R2 objects**, public and protected, are deleted through
  `MediaStorageProvider.deleteObject` / `ProtectedMediaStorage.deleteObject`, each
  followed by an absence probe.
- **Then** the row becomes a `deleted` tombstone with reason `archive_grace_elapsed`, and
  an audit entry `media.asset.purged` is written in the same transaction.
- **Idempotent:** a repeated or concurrent purge returns `already_deleted`.

**Mode.** `off`, `dry_run` or `on`. The default is **`dry_run`**: the sweep logs what
*would* be destroyed and destroys nothing. Switching to `on` is a single GitHub repo
variable, synced to the VPS `.env`. Review the dry-run log lines first.

**Delete from the UI.** A staff "Delete" only archives
(`POST /academies/:id/media/:assetId/archive`, or bulk `…/media/archive-batch`).
It is refused with `409 errors.media.inUse`, naming each usage, while anything still
points at the asset:

- lesson video, lesson content or lesson resource;
- course intro video;
- a learner's submission attachment;
- a live-session recording;
- the academy logo, a course thumbnail or a certificate-template logo;
- website pages, website configuration or blog content.

| | Delete (single) | Delete (bulk) |
|---|---|---|
| Client Owner (academy owner) | yes | yes |
| Manager of that academy | yes | yes |
| Manager of another academy, same organization | no (403) | no (403) |
| Instructor / Learner / Platform Owner / other organization | no (403) | no (403) |
| Anonymous | no (401) | no (401) |

Enforcement: `MediaService.assertCanManage` checks the academy membership role. Tenant
RLS bounds every read and write. The frontend only hides controls.

**Restore within the grace period.** No UI exists. The bytes are intact for 30 days, so
an operator can restore by setting the asset's status back to `active`. A restore UI is
future work.

**Tests.** Both suites run against real Postgres, S3 and the fake video provider:

- `test/archived-media-purge.e2e-spec.ts` (7): immediate deletion refused, grace
  respected, eligible public/protected/hosted assets destroyed with proof and audit,
  referenced assets kept, cross-tenant payload refused, legal hold wins, `dry_run` inert,
  queue path works.
- `test/media-delete.e2e-spec.ts` (5): the matrix above, the usage guard, mixed bulk
  outcomes, and a just-deleted asset is not purgeable.

## 15. `IMPLEMENTED` — Durable customer-identity ledgers (W8, Nov 2026)

Two append-only, platform-owned ledgers decide one-time benefits, and both
outlive account deletion (FKs `ON DELETE SET NULL`, no UPDATE/DELETE for
`atlas_app`, untouched by the anonymisation scrub):

| Ledger | Benefit | Identity |
|---|---|---|
| `trial_redemptions` | one Free Trial per customer | canonical email (alias-collapsed) |
| `paid_gift_redemptions` | one set of gifted setup days, on the first-ever paid subscription | the organization OWNER's canonical email |

- **Hash v2.** New rows store `HMAC-SHA256(key, canonical email)` with
  `hash_version = 2`. The key is `CUSTOMER_IDENTITY_HMAC_KEY` when set, else an
  HKDF derivation of `PAYMENT_CREDENTIALS_ENCRYPTION_KEY`. It must never
  change once rows exist (a new key re-grants every trial and gift); pin
  the derived value as `CUSTOMER_IDENTITY_HMAC_KEY` before rotating the payment
  key. Pre-W8 trial rows hold the v1 constant-salt SHA-256, are frozen, and are
  still checked on every claim and display read (v1 rows of deleted users
  can never be upgraded — accepted residual).
- **Re-signup.** Deleting the account and registering again with the same
  mailbox (or a Gmail dot / `+tag` variant) gets no trial and no gift.
- **Retention.** `ip_address` / `user_agent` on `trial_redemptions` are cleared
  after 180 days by the `trial-forensics-scrub` job on the `video-retention`
  queue (SECURITY DEFINER `scrub_trial_redemption_forensics`). Hashes and
  dates are kept for as long as the one-trial rule exists.
- **Key pinning.** `deploy/deploy.sh` pins the key: when `.env` has no
  `CUSTOMER_IDENTITY_HMAC_KEY`, it computes the CURRENTLY DERIVED value on the
  host with the backend image's own util (`customerIdentityKeyFromEnv()`, the
  backend's `.env`), appends it once and recreates the backend. Pinning changes
  no hash; a present key is never overwritten; a failed computation writes
  nothing and the deploy continues. Never a new random key (it would re-grant
  every trial and gift). Release verify reports set yes/no and match/mismatch
  with the derivation (a mismatch fails).
- **Backfill — APPROVED by the product owner on 4 Oct 2026 for production**,
  with `--gifts` and WITHOUT `--include-auto-trial-era` (inferred, not
  evidence). `src/scripts/backfill-customer-ledgers.ts`, shipped in the image
  as `dist/scripts/backfill-customer-ledgers.js` (dry run by default, counts
  only, refuses a production environment without `--allow-production`, key
  check, idempotent; `--verify` prints the read-only post-state) records trials
  evidenced before the ledger existed and, with `--gifts`, prior paying
  customers as `source = 'backfill'` rows (gift rows carry no gifted days).
  Production runs go only through the `Customer ledger backfill` workflow
  (`deploy/ledger-backfill/remote.sh`: dry-run / verify / apply, apply needs
  `confirm = APPLY-LEDGER-BACKFILL`, a pinned and loaded key, and takes a
  verified data-only dump of both ledgers first). Recovery: `DELETE ... WHERE
  source = 'backfill'` as the migration superuser, or restore that dump (both
  in the remote.sh header).
