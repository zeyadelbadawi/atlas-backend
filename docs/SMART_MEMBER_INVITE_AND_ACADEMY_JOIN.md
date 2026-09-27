# Smart Member Invitation & Smart Academy Join

**Status:** mini-feature delivered after Launch Stabilization Plan A + A6
(closed). It builds on A2 (invited accounts), A4 (one identity, many
academies) and A6 (academy OTP) without changing any of them, any session or
token format, or the database schema (no migration).

Two identity flows, one rule: **one person, one Atlas account.** Nobody is
asked to create a second account, and nobody's existing account is renamed,
re-passworded or re-scoped by someone else.

---

## 1. Smart staff invitation (Add Manager / Add Instructor / Add Student)

### What the owner sees

As the email is typed, the dialog checks it (debounced, 400 ms):

| Lookup status | Dialog |
|---|---|
| `new` | Editable **Full name** (required). "We'll email them an invitation to set up their account." |
| `existing` + name | The account's **real name, read-only**. Callout: they'll be added as *role* and sign in with their existing credentials; name, password and other academies won't change. |
| `existing_pending_setup` + name | Real name, read-only. Callout: they were invited but never finished setup; a fresh setup link will be sent. |
| `already_member` | Warning; submit disabled. |
| `unavailable` (suspended/deleted) | Warning; submit disabled. |
| client states: `idle`, `invalid`, `checking`, `error`, `rate_limited` | `checking` disables submit; `error`/`rate_limited` fall back to the plain form (the server decides on submit). |

The success message says what actually happened (`outcome` in the response):
`invited` → "Invitation sent", `reinvited` → "fresh setup link sent",
`added` → "Added — we've emailed them".

### API

`GET /academies/:id/member-lookup?email=&role=manager|instructor|student`

- Guards: `JwtAuthGuard` + `ManagementSurfaceGuard` (an academy-website
  session is refused, A1) + `AcademyScopeGuard`, then the **same**
  `assertCanAddMember` the add itself uses: academy owner, and organization
  owner for manager/instructor. Anyone who could not perform the add is
  refused (403) and never learns anything.
- Rate limit per acting user: **30 / 10 min and 300 / day** (Redis,
  `AuthRateLimiterService`) → 429 `errors.academy.memberLookupRateLimited`.
- Response: `{status}` or `{status, name}` — never a user id, email echo,
  organizations, other academies, roles or sessions.
- **UX only.** The add routes never read it.

`POST /academies/:id/members | instructors | students` (unchanged routes;
`name` is now optional for students too) return the member/student plus
`outcome: 'invited' | 'reinvited' | 'added'`.

### Server-side behaviour (authoritative)

`AcademiesService.addStaffMember` / `createStudent` run **one transaction**:

1. `assertCanAddMember` (owner rules).
2. `resolveMemberAccount` — inside the transaction:
   - active account → reused as-is (`existing`);
   - `invited` account → reused (`pending_setup`);
   - suspended/deleted → 409 `errors.academy.accountUnavailable`;
   - no account + name → new `invited` account (A2) (`new`);
   - no account, no name → 404 `managerUserNotFound` (staff) /
     400 `nameRequiredForNewAccount` (student).
3. Existing membership → 409 (`managerAlreadyMember` /
   `studentAlreadyMember`); a blocked learner → 403 `studentBlocked`.
4. Organization membership created only if the person has none there
   (an existing one, whatever its role, is left untouched); the
   `academy_members` row (entitlement-checked) or `academy_students` row
   (`source: staff_created`); the audit row (`context.account`).
5. **After commit** — `notifyMemberAdded`: `existing` → added notice;
   `new`/`pending_setup` → setup invitation (reset token, 72 h). A mail
   failure is logged (no email address in the log) and never rolls back the
   membership.

**Atomicity & races.** Because the user row is created inside the same
transaction, a refused add leaves no orphan account. A unique-constraint
collision (`P2002`: two adds of the same new email, or of the same
membership) rolls the whole transaction back and `withAddRaceRetry` retries
once — the retry sees the committed winner and answers exactly like the
sequential case (201 reusing the account, or 409 already-member). Never a
500, never a duplicate user or membership. Counted in
`atlas_member_add_race_total{role}`.

---

## 2. Smart academy signup (existing Atlas account)

### Anti-enumeration design

There is **no** anonymous "does this email exist" endpoint.

- The sign-up form submits to `POST /auth/register` as before
  (`RegisterRateLimitGuard`, 5/h/IP). With an existing email and the right
  password, A4 already joins (unchanged). With the wrong password it answers
  409 `errors.auth.emailAlreadyRegistered` — the pre-existing, rate-limited
  disclosure every registration form has. The frontend turns that 409 into
  the join step instead of an error.
- `POST /auth/academy-join` `{email, password, academyId, inviteToken?}` is
  **join-only** (never creates an account) and is answered like a sign-in:
  `SignInRateLimitGuard` (same per-IP and per-account budget as
  `/auth/sign-in`), dummy-hash verification for unknown emails, and the same
  401 `errors.auth.invalidCredentials` for unknown email, wrong password,
  invited and deleted accounts. Suspended (403), blocked (403) and
  already-a-learner (409) are revealed only after the password is proven.
- The display name is returned only after the password is proven:
  `{account: 'existing', status: 'active'|'pending', name}`.

### What the visitor sees

- Proactive: "Already have an Atlas account? **Join with it**" under the
  sign-up form.
- After a 409 from sign-up: "**This email already has an Atlas account.** You
  don't need to create another account. Enter your Atlas password to
  continue."
- On success: "Welcome back, *name*." → the page signs in on this academy
  (`surface: 'academy'`) with the password just typed → A6 emailed code (new
  device) → `/my`.
- `pending` (approval academy) → "Your request to join … has been sent"; no
  sign-in attempt.
- Already a learner here (409 after password proof) → continues to sign in.
- If the continuation cannot complete (network, cancelled code step, …) →
  success/fallback state: the academy was added; "Go to sign in".

`POST /auth/register` now also returns `status` for the A4 existing-account
branch, so the same continuation applies when the right password was typed
on the sign-up form itself.

---

## 3. Communications

| Key | When | Host (branding) | CTA |
|---|---|---|---|
| `academy.member.invited` (v2 copy) | new or pending-setup Manager/Instructor | platform | Set up your account → `/auth/reset-password?token=…&setup=1` |
| `academy.learner.invited` | new or pending-setup Student | academy | Set up your account → `/reset-password?token=…&setup=1` |
| `academy.member.added` (new) | existing account added as Manager/Instructor | platform | Open Academy → `/auth/sign-in` |
| `academy.learner.added` (new) | existing account added as Student | academy | Open Academy → `/sign-in` |

EN + AR (RTL) templates; role wording from the shared `roleLabel`.
`*.added` dedupe per membership row (`academy_member_added:<id>` /
`academy_learner_added:<id>`); emitted through the outbox after commit.
Catalogue: 77 events (see `COMMUNICATIONS_EMAIL_NOTIFICATION_CATALOG.md`).

---

## 4. Observability

| Series | Labels |
|---|---|
| `atlas_member_lookup_total` | `result`: new, existing, pending_setup, already_member, unavailable, denied, rate_limited |
| `atlas_member_add_total` | `role` × `account` (new, existing, pending_setup) |
| `atlas_member_add_race_total` | `role` |
| `atlas_academy_join_total` | `result`: joined, already_learner, invalid_credentials, refused |
| `atlas_signup_total{outcome="existing_account_joined"}` | (existing, still counted for every existing-account join) |

Labels are closed vocabularies. Nothing logs passwords, codes, tokens or raw
email addresses.

---

## 5. Tests

- Backend e2e `test/smart-member-invite.e2e-spec.ts` (19): lookup shape and
  field minimisation, pending/already/unavailable, authorization (no session,
  other academy's owner, manager, academy-surface session, bad input), rate
  limit; new/existing/pending adds, student source, name/password untouched,
  no orphans, concurrent same-email adds (one user, one membership, no 500),
  two academies at once, blocked learner; join generic 401 for
  unknown/wrong/invited, join → OTP → session, approval → pending, host
  mismatch, shared sign-in budget, register unchanged.
- Updated: `p64-c8-member-onboarding` (existing user now gets the added
  notice, not a setup link), `launch-stabilization` (A4 response carries
  `status`).
- Frontend: `smart-member-invite.test.tsx` (debounce, read-only name,
  payload never sends a name for an existing account, required name for new,
  blocked states, rate-limit fallback, outcomes, Arabic RTL) and
  `smart-academy-signup.test.tsx` (409 → join step, proactive entry, generic
  wrong password, join → academy sign-in → code step, direct `/my`,
  already-learner, pending, fallback, back, Arabic RTL).

- Production: the `Launch verify` workflow (`deploy/launch-verify`) has two
  more jobs, `smi` and `smi-browser` (each on its own runner, because the
  emailed-code step shares the per-IP sign-in budget with the Plan A jobs).
  They check, against the real hosts, the join's identical 401 for an unknown
  email and a wrong password, a real join → Academy B emailed code →
  session, `alreadyLearnerHere`, the lookup refusing anonymous, academy-
  website and non-owner management callers, the `atlas_academy_join_total`
  series, and (browser mode) the "Join with it" journey to `/my` in EN
  desktop and AR mobile. The owner-only add/lookup success paths need an
  organization owner's credentials and are not automated in production;
  they are covered by the e2e suite and the local browser run.

## 6. Deliberately unchanged

Plan A / A6 behaviour, JWT/session/token formats, sign-in and OTP flows,
registration of new accounts, the members page's button visibility for
non-owners (server still refuses), and the known out-of-scope items
(media data-URL 413, domain e2e leakage, "Leave without saving?" on the
add dialogs, password-change notice, legacy staff accounts).
