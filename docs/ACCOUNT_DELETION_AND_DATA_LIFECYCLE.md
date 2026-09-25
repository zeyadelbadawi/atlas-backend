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
- Archives owned academies, which reuses the academy archive path and so inherits its
  domain release and cache invalidation.
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

See §8.

---

## 3. What does not exist — the real gaps

| Gap | Severity | Detail |
|---|---|---|
| **Public R2 objects are never deleted** | **High** | `MediaStorageProvider` exposes only `putObject`/`getObject`. There is no delete capability on the public bucket *at all*. Every logo, thumbnail and marketing image stays fetchable at its public URL forever, after archive and after account deletion. |
| **Cloudflare Stream videos are never deleted** | **High** | `deleteAsset` exists and works, but its only caller is the video-retention sweep. Deleting a course or lesson leaves the video playable and still billing storage minutes. |
| **Certificate PDFs are orphaned** | Medium | Anonymisation nulls `storageKey` and re-renders, but never deletes the previous PDF — which carries the real learner's name — from the protected bucket. A live PII retention leak. |
| **No Platform Owner deletion** | High | `platform-users.controller.ts` is `@Get()` only. There is no administrative deletion path of any kind. |
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

## 12. Maintenance rules

- Any new model that holds tenant content must state, in its schema comment, what
  happens to it on deletion of its owner. Silence is how gaps are created.
- Any new external object store must ship a delete capability **with** its upload
  capability. The public R2 provider is the cautionary example.
- Any new queue processor must re-validate its target at execution time.
- Anything that cannot be deleted must be *explained* to the person who asked for its
  deletion, not silently skipped.
