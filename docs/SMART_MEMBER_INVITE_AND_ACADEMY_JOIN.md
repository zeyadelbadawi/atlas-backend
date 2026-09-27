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

The person's question is "why are you telling me I already have an account —
I'm signing up here for the first time?". The page answers it in two steps,
each disclosing only what the visitor has proven they may know.

1. **Before any proof** — the sign-up was answered "email already registered"
   (the same, rate-limited disclosure every registration form makes):
   - **You already have an Atlas account.** *[This academy] runs on Atlas,
     and this email is already registered on Atlas — most likely because you
     joined another academy that also uses Atlas.* You don't need a new
     account: continue with your Atlas account and we'll add *[this academy]*
     to it; courses, progress and certificates stay separate per academy.
   - The email is **locked** (read-only, lock icon) with a **Change email**
     action that returns to the form with the name and email kept.
   - The new-account *Password / Confirm password* fields are replaced by one
     **Your Atlas password** field, *Use the password you already use for
     Atlas*, and **Forgot your password? Reset it**.
   - CTA: **Continue with my Atlas account**.
   - Only the CURRENT academy (public) is named. No other academy is named
     here: that would tell anyone who knows an email where its owner studies.
2. **After full proof** — password (join) + this academy's A6 emailed code
   (sign-in): **You're all set — [this academy] has been added to your Atlas
   account.** *You already use this Atlas account with [Al-Nogoom Academy]…*
   → **Go to my learning** (`/my`). With no other academy, straight to `/my`.

Proactive entry: "Already have an Atlas account? **Join with it**" under the
sign-up form (email editable, "Back to sign up").

- `pending` (approval academy) → "Your request to join … has been sent"; no
  sign-in attempt.
- Already a learner here (409 after password proof) → continues to sign in.
- If the continuation cannot complete (network, cancelled code step, …) →
  success/fallback state: the academy was added; "Go to sign in".

### Naming the other academies (`GET /auth/academy-join/summary`)

Naming another tenant is a cross-academy disclosure, so it is gated at the
sign-in bar (password **and** emailed code), not at the password alone — a
stuffed password must not reveal where someone studies, and A5 keeps an
academy session to its own academy:

- `JwtAuthGuard`; an academy-website session on **its own** academy's host
  (A1 — on another academy's host it is refused 403 `academyHostMismatch`);
- non-empty only if the learner row at this academy was created in the last
  **30 minutes** (i.e. as part of this join) — afterwards `[]`;
- only other academies where the account is an **active, unblocked learner**
  (staff roles and blocked/pending memberships are never named);
- a management session, or no host academy → `[]`.

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

- Added with the 27 Sep fixes: `academy-member-emails.spec.ts`; e2e
  SMI-JOIN-07 (other academies named only to a signed-in session on the
  academy just joined; 403 on another host; `[]` for management sessions and
  after 30 min), SMI-JOIN-08 (staff account joins as a learner; staff and
  blocked academies never named; memberships unchanged), SMI-JOIN-09
  (suspended/deleted: generic 401 before the password, nothing joined);
  outbox `academyName` assertions for every add outcome; frontend locked
  email, *Change email*, welcome step and Arabic existing-account step.

## 6. Production fixes — 27 September 2026

### "You've been added to  on Atlas" (academy name missing)

**Root cause.** After an add committed, the academy's name was read with
`TenancyContextService.runWithoutContext` — a transaction with no tenant or
user context. `academies` is FORCE RLS and every SELECT policy needs one
(`app.current_organization_id`, the user's membership, or the platform
owner), so the row was invisible, `findUnique` returned `null`, and
`academy?.name ?? ''` turned that into an empty string. `str()` printed the
empty string verbatim, so the template's own fallback never applied. The
same read fed **every** setup invitation since C8 (`inviteNewMember`) and the
new "added" notice.

**Fix.** `assertCanAddMember` reads the name inside the add's own
`runInTenantAndUserContext` transaction (where the tenant policy admits it),
fails if the academy is not visible there, and returns it; the name travels
with the transaction result into `sendInvite` / `sendAddedNotice` (the
context-free read is gone). `str()` now treats a blank string as missing, so
no template can render a hole where a value belongs. Covered by
`academy-member-emails.spec.ts` (every template × role × locale; blank /
whitespace / missing names) and by e2e assertions on the outbox values and
on the email actually sent (`p64-c8`: subject "You've been added to
<academy> on Atlas"). Against the old code the same tests fail with exactly
the production subject.

### Gmail placed the invitation in Spam

**Authoritative evidence: the received message** (Gmail *Show original*,
27 Sep 12:52 UTC, the "added" notice with the empty academy name).

| Header | Value | Meaning |
|---|---|---|
| `Authentication-Results` | `dkim=pass header.i=@atlass.dpdns.org header.s=brevo2` | Signed by our own domain (Brevo selector 2) |
| | `spf=pass … smtp.mailfrom=bounces-…@gz.d.sender-sib.com` (77.32.148.26) | SPF passes for **Brevo's** bounce domain (not aligned with From — expected) |
| | `dmarc=pass (p=NONE sp=NONE dis=NONE) header.from=atlass.dpdns.org` | DMARC passes through the **aligned DKIM** signature |
| `Received` | from `gz.d.sender-sib.com [77.32.148.26]`, TLS 1.3 | Brevo relay IP |
| `Feedback-ID` | `77.32.148.26:12256708_-1:12256708:Sendinblue` | Brevo account/IP feedback loop id |
| `X-CSA-Complaints` | `csa-complaints@eco.de` | Brevo relay participates in the CSA certification complaint loop |
| `List-Unsubscribe` + `List-Unsubscribe-Post: One-Click` | Brevo URL on `…r.bh.d.sendibt3.com` | Added by **Brevo**, not by our dispatcher |
| `From` | `"Atlas" <no-reply@atlass.dpdns.org>` | — |
| `Reply-To` | absent | see below |
| `Subject` / body | `You've been added to  on Atlas`; `You now have access to  as Manager.` | the empty academy name (fixed in this change) |
| Links in the HTML | the "Open Academy" button and "Manage email settings" both rewritten to `https://bccfghai.r.bh.d.sendibt3.com/tr/cl/…`; a hidden open-tracking pixel on the same host | Brevo transactional click/open tracking; the plain-text part keeps the direct `atlass.dpdns.org` URLs |
| `Delivered-To` | a Google Workspace mailbox on the recipient organization's own domain | Gmail filtering, plus any Workspace-admin spam settings of that organization |

**What this proves and what it does not**

- **Authentication is not the cause.** SPF, DKIM and DMARC all passed, and
  DMARC aligned on our own domain through DKIM. Nothing to fix in DNS for
  this message.
- **Gmail does not state its reason.** The message carries no spam-verdict
  header; the only reason given is the UI's "similar to messages that were
  identified as spam in the past", which is Gmail's content/reputation
  similarity classification. Any cause below is a contributing factor
  supported by the evidence, not a proven verdict.

**Contributing factors, by who can act on them**

1. **Application — fixed here.** The message was visibly broken: a subject
   and body with the academy name missing ("added to  on Atlas", "access to
    as Manager"), leaving a very short, generic, templated-looking message
   that names nothing specific except "Atlas". That is a content-quality
   signal we control.
2. **Brevo configuration — owner review.** Every HTML link and the open
   pixel are rewritten to Brevo's shared tracking host (`sendibt3.com`), so
   the message's links do not point at the sending domain, and they share
   that host's reputation with Brevo's other senders. Brevo documents
   tracking settings at the account level (*Settings → Automations →
   Transactional emails → Tracking*); we found no documented per-message API
   switch, so this is an account decision, not an application change.
   Brevo also injects the `List-Unsubscribe` pair on this transactional
   notice; that is standard and not harmful by itself.
3. **Domain / reputation — owner decision.** `dpdns.org` is on the Public
   Suffix List, so `atlass.dpdns.org` is its own organizational domain with
   almost no sending history, sending from Brevo's shared Free-plan pool.
   Gmail weighs domain and IP reputation heavily for new senders. Brevo's
   7-day numbers (112 requests, 29 soft bounces, 3 hard bounces) point the
   same way: fix bounce sources, build volume gradually, and monitor the
   domain in Google Postmaster Tools. A long-lived owned domain is the
   durable remedy. DMARC `p=none` passed and does not lower placement.
4. **Outside our control.** Gmail's per-recipient model, the recipient
   organization's Workspace policies, and Brevo's shared-IP reputation.
   Inbox placement cannot be guaranteed.

**Reply-To.** Absent, and the sending domain has no MX, so a reply to
`no-reply@atlass.dpdns.org` cannot be received. There is no evidence in this
message that its absence contributed to the Spam placement, and Gmail does
not require one — it is a product/support concern (replies go nowhere), not
a demonstrated spam cause. Setting `EMAIL_REPLY_TO` to a monitored mailbox is
still recommended.

**Diagnostics.** `Launch verify` with `scope=deliverability` (read-only)
re-checks the domain's SPF / DKIM / DMARC, the Public Suffix List status, the
Brevo domain, sender and plan, and 7-day Brevo aggregates at any time.

## 7. Deliberately unchanged

Plan A / A6 behaviour, JWT/session/token formats, sign-in and OTP flows,
registration of new accounts, the members page's button visibility for
non-owners (server still refuses), and the known out-of-scope items
(media data-URL 413, domain e2e leakage, "Leave without saving?" on the
add dialogs, password-change notice, legacy staff accounts).
