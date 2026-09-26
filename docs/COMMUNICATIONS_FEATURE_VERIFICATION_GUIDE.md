# Atlas Communications — Feature Verification Guide

**Who this is for:** a competent tester who does not know this codebase and needs to check, by hand,
that the shipped communications system actually does what it claims — without guessing what Atlas is
supposed to send.

**What it is:** procedures, expected results, and a diagnosis table. Every route, variable, table and
column named below was read out of the source tree; nothing here is invented. Where something cannot
be tested today, this guide says so **in place** rather than omitting it.

**What it is not:** evidence. Nothing in this document is a test result. It tells you how to produce
evidence; it does not claim any has been produced.

**Source of truth for behaviour:** `src/communications/**`, `src/config/env.validation.ts`,
`src/config/configuration.ts`, `prisma/schema.prisma`, and the frontend route registry
`atlas-front/src/app/routes/route-paths.ts`. The design record is
`docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`.

---

## 0. The eight facts that shape every test

Read these before running anything. Several of them will otherwise look like bugs.

1. **Brevo is the only live provider.** Production runs `EMAIL_PROVIDERS=brevo`. Brevo Free is
   **300 emails/day**, 9 000/month, 5/second (`src/communications/providers/brevo-email.provider.ts`,
   `capabilities()`). Your whole day of testing shares that budget with real customers.
2. **Resend is implemented but not in the chain.** It refuses to send from anything but a
   DNS-verified sending domain, and Atlas has no such domain (blocker BL-3 in the plan). Adding
   `resend` to `EMAIL_PROVIDERS` without `RESEND_API_KEY` makes the API **refuse to boot**
   (`validateEnv` in `src/config/env.validation.ts`). Do not "just try it" against production.
3. **`EMAIL_FROM_EMAIL` is one value shared by both adapters.** Both `BrevoEmailProvider.send` and
   `ResendEmailProvider.send` read `email.fromEmail`. There is no per-provider From address.
4. **Three flags default OFF. Events behind them emit nothing at all today.**
   - `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY` — `off | new_device | always`
   - `FLAG_LIFECYCLE_SEQUENCES_MODE` — `off | dry_run | on`
   - `FLAG_VIDEO_RETENTION_MODE` — `off | warn_only | on`
5. **Production host is `https://atlass.dpdns.org`; the API prefix is `/api/v1`.**
   `main.ts` does `setGlobalPrefix('api', { exclude: ['health','metrics'] })` and
   `enableVersioning({ type: URI, defaultVersion: '1' })`.
6. **`/health` and `/metrics` are NOT reachable from outside the host.** They sit outside the `api`
   prefix and Caddy proxies only `/api/*` (`ops/alerts/README.md`). You cannot scrape
   `atlas_comm_*` metrics remotely. The platform communications console exists precisely because of
   this gap.
7. **The operator's window into the pipeline is `GET /api/v1/platform-communications/health`** —
   platform-owner only, with a UI at **Analysis › Communications**
   (`/dashboard/analytics/communications`).
8. **Two hosts, two route trees.** `/dashboard/*` is **not mounted on an academy host**. A link there
   renders the academy's own CMS "Page not found". See §C.

---

## A. Test accounts and roles

Atlas has no `@Roles()` decorator and no roles claim in the JWT. The access token payload is exactly
`{ sub, sid }` (`src/identity/services/access-token.service.ts`). Every authorization fact is
re-read from the database per request, and Postgres row-level security proves it a second time.
So "granting a role" means writing the right row, not editing a token.

### A.1 The six principals you need

| Principal | What it is, in data | What you need it for |
|---|---|---|
| **Platform Owner** | `users.is_platform_owner = true` | The communications console, the suppression list, `/metrics` (host-local only) |
| **Client Owner** (organisation owner) | `organizations.owner_user_id` + an `organization_memberships` row with `role='owner'`; usually also `academy_members` with `role='owner'` | Lifecycle/billing/retention emails, provisioning, the roster |
| **Manager** | `academy_members.role = 'manager'` (and normally `organization_memberships.role='manager'`) | Staff work items — roster approvals, review moderation |
| **Instructor** | `academy_members.role = 'instructor'` | Grading. **Note:** instructors are deliberately *excluded* from staff-addressed communications (`ACADEMY_MODERATOR_ROLES = ['owner','administrator','manager']` in `src/communications/services/academy-staff-recipients.service.ts`) |
| **Learner / student** | an `academy_students` row for that academy (`status='active'`, `blocked_at IS NULL`) | Almost every learner-audience email; the `/my/*` surface |
| **Anonymous** | no token | Sign-up, password reset request, certificate verification, webhooks |

`academy_members.role` is the Postgres enum `academy_member_role` with exactly five values:
`owner | administrator | manager | instructor | staff`. Its status enum is
`active | inactive | pending`. A student is **never** an `academy_members` row — that is a
deliberate schema split documented in `prisma/schema.prisma`.

`academy_students` columns you will actually look at: `academy_id`, `user_id`, `status`, `source`
(`self_signup | sign_in_join | staff_created | purchase | invite | backfill`), `registered_via_host`,
`blocked_at`, `blocked_reason`, `joined_at`.

### A.2 How each role is granted

**Platform Owner — direct SQL only.** No API endpoint grants it. On the superuser connection
(`DATABASE_URL`, not `APP_DATABASE_URL`):

```sql
UPDATE users SET is_platform_owner = true WHERE email = 'your.tester@example.test';
```

`PlatformOwnerGuard` re-reads the column on every request, so an existing token keeps working; sign
in again anyway so the `/users/me` payload reports `roles: ['platform_owner']` and the sidebar shows
Analysis › Communications.

**Client Owner / Manager / Instructor.** Real product paths, on the management host:
- `POST /api/v1/academies/:id/members` → adds an `organization_memberships` row (`manager`) **and**
  an `academy_members` row (`manager`).
- `POST /api/v1/academies/:id/instructors` → the same shape with `instructor`.
- Both require the caller to be an academy `owner` (`GRANTS_MANAGER_ROLES` in
  `src/academy/services/academies.service.ts`).

**Learner.** Four real paths (`src/identity/services/auth.service.ts`,
`src/academy/services/academies.service.ts`):
1. `POST /api/v1/auth/register` with `{ name, email, password, academyId }` on the academy host —
   writes the `academy_students` row under RLS policy `academy_students_self_insert`. On a real
   academy host the `Host` header must resolve to the same academy or you get
   403 `errors.auth.academyHostMismatch`.
2. `POST /api/v1/auth/sign-in` with `{ surface: 'academy', academyId }` when the academy's
   `registration_policy` is `open` — joins with `source='sign_in_join'`.
3. `POST /api/v1/academies/:id/students` (staff-created, academy owner only).
4. Test fixture `seedAcademyStudent(admin, academyId, userId)` in `test/utils/db-admin.ts`.

**Anonymous.** There is no `@Public()` decorator and no global auth guard. A route is public by
having no `@UseGuards(JwtAuthGuard)`. The public ones that matter here: `health`, `public/plans`,
`public/websites`, `public/media`, `verify/:code`, and `webhooks/email/:provider`.

### A.3 Building a complete test world

For a **local or staging** environment, `npm run db:seed` (`prisma/seed.ts`) creates a full tenant
graph. Every seeded account's password is the constant `DevPassword123!`
(`DEV_PASSWORD`, `prisma/seed.ts`). The seeded accounts:

| Email | What it is |
|---|---|
| `admin@atlas.dev` | the only `is_platform_owner = true` account |
| `sarah.chen@acme-academy.dev` | organisation owner of Org A; `academy_members` **owner** of academy `web-development-academy` |
| `nora.haddad@acme-academy.dev` | `academy_members` **manager** |
| `jane.doe@acme-academy.dev` | `academy_members` **instructor** |
| `omar.hassan@nextgen-learning.dev` | owner of a second organisation / academy |
| `alex.morgan@student.dev` | intended student account |

**Caveat, verify before relying on it:** `prisma/seed.ts` creates the `users` row and an
`enrollments` row for `alex.morgan@student.dev` but does not appear to insert an `academy_students`
row. Without that row the account resolves as `unaffiliated`, not `learner`. If you need a genuine
learner principal, register one through `POST /api/v1/auth/register` with an `academyId`, or insert
the row yourself.

For **production**, use accounts the owner has authorised. Do not seed production.

An academy also needs an **active subscription** before entitlement-gated writes succeed — the e2e
fixtures call `seedActiveSubscriptionForOrg` for exactly this reason. A trial-expired organisation
will refuse course creation and other gated writes, and you will misread that as a communications
failure.

---

## B. Provider setup

### B.1 The variables (names only — never write a value into a document, a ticket or a log)

| Variable | Meaning | Required when |
|---|---|---|
| `EMAIL_PROVIDERS` | ordered fallback chain, comma list of `stub\|brevo\|resend` | production shape is `brevo` |
| `EMAIL_PROVIDER` | legacy single-provider alias; used only when `EMAIL_PROVIDERS` is unset | — |
| `BREVO_API_KEY` | Brevo REST key | whenever `brevo` is in the chain, or boot fails |
| `RESEND_API_KEY` (legacy alias `EMAIL_API_KEY`) | Resend key | whenever `resend` is in the chain, or boot fails |
| `EMAIL_FROM_EMAIL` | the single verified sender address, **shared by both adapters** | whenever any real provider is in the chain |
| `EMAIL_FROM_NAME` | display name; defaults to `Atlas`; also used as the platform brand name in email layout | — |
| `EMAIL_REPLY_TO` | optional Reply-To | — |
| `BREVO_WEBHOOK_SECRET` | shared secret carried in the webhook URL as `?secret=`; minimum 16 characters | to accept Brevo delivery events; unset = fail closed |
| `RESEND_WEBHOOK_SECRET` | Svix `whsec_…` | to accept Resend events; unset = fail closed |
| `PLATFORM_WEB_URL` | public origin used to build every platform-branded link | required in production with a real provider, unless `PLATFORM_BASE_DOMAIN` can derive it |
| `PLATFORM_BASE_DOMAIN` | the base domain academy subdomains hang off | used to derive `PLATFORM_WEB_URL` and to build academy hosts |

The boot-time cross-checks live in `validateEnv` (`src/config/env.validation.ts`):
naming a real provider without its key **or** without `EMAIL_FROM_EMAIL` throws at startup, on
purpose — a provider that cannot send must fail loudly rather than accept password resets it will
never deliver. The chain is also exactly what the configuration names: nothing is appended as a
safety net, so there is deliberately **no stub fallback** in production
(`buildProviderChain` in `src/communications/providers/email-provider.registry.ts`).

### B.2 Confirming Brevo is actually live

The authoritative in-product check, as Platform Owner on the management host:

```
GET https://atlass.dpdns.org/api/v1/platform-communications/health?days=30
```

Look at `providers[]`. Each entry is `{ provider, position, dailyUsed, dailyLimit, monthlyUsed, monthlyLimit }`.

- **Healthy production:** exactly one entry, `provider: "brevo"`, `position: 0`, `dailyLimit: 300`,
  `monthlyLimit: 9000`.
- **`stub` appearing here means nothing is really being sent.** That is the misconfiguration this
  endpoint exists to make visible. The registry also logs an error at boot in that case.
- `deliveries.byProvider` tells you which provider actually accepted messages in the window — that is
  the field that proves the chain in the field rather than on paper.

The same numbers render in the UI at **Analysis › Communications**
(`/dashboard/analytics/communications`, `?range=7d|30d|90d`).

### B.3 Where the sender identity is verified

> **Superseded 26 Sep 2026 (OTP delivery incident, see `NEW_CUSTOMER_ONBOARDING.md` §10).** A
> free-mail single sender (a `@gmail.com` address) is NOT deliverable to strict receivers: Brevo
> cannot send as a Gmail address it is not authorised for, rewrites From to its shared
> `…@<account>.brevosend.com` domain, and receivers such as Hostinger reject the message as spam
> (`554 5.7.1 Spam message rejected`, provider event `softBounces`). The platform's own domain
> `atlass.dpdns.org` is now registered in Brevo with DKIM (`brevo1/brevo2._domainkey` CNAMEs), the
> Brevo ownership code, SPF (`include:spf.brevo.com`) and DMARC (`p=none`) in the platform's
> Cloudflare zone, added by the `Email domain setup` workflow. `EMAIL_FROM_EMAIL` must be an address
> on that authenticated domain.

Historical arrangement (before 26 Sep 2026): Brevo **single-sender verification**, not domain DNS.
The From address (`EMAIL_FROM_EMAIL`) was a single mailbox verified inside the Brevo account
(Senders → the address shows `active`), with no verified sending *domain*.

Consequences you must not misread as defects:
- Free-tier Brevo appends a **"Sent with Brevo" footer** to outbound mail. That is the provider, not
  Atlas's template.
- Everything arrives from one address regardless of which academy the email is branded for. Academy
  branding lives in the body, the logo and the link host — never in the envelope sender.
- Because `EMAIL_FROM_EMAIL` is shared, changing it to a future Resend-verified domain would change
  what **Brevo** sends as too, and that new address must be verified at Brevo in the same change
  window or the live provider breaks.

### B.4 The daily budget, and why it constrains testing

Brevo Free: **300/day**, 9 000/month, 5/second. The quota service
(`src/communications/services/email-quota.service.ts`) reserves against a *line* of that budget per
category class:

| Category | Line |
|---|---|
| `security`, `transactional` | 100 % (may use the whole budget) |
| `lifecycle` | 85 % |
| `engagement`, `operational` | 70 % |

Counters are Redis keys `comm:quota:brevo:d:YYYYMMDD` and `comm:quota:brevo:m:YYYYMM` (UTC), bumped
only on an **accepted** send. The per-second limiter is `comm:rate:brevo:<epochSecond>`.
Redis being unreachable fails **open** for the reservation (the send goes out and the provider
enforces its own cap) and is logged.

Practical rules for a tester:
- Budget your session. Fifty test emails is one sixth of the platform's day.
- The counters reset at **UTC midnight**, not local midnight.
- An engagement email skipped at 210/300 is the 70 % line doing its job, not a failure. You will see
  `Email provider skipped: quota line exhausted.` in the logs and a
  `atlas_comm_email_sends_total{result="quota_skipped"}` increment.
- There are also **per-recipient daily caps** independent of the provider budget:
  **5/day for a learner, 10/day for staff**, applied to everything outside `security` and
  `transactional` (`DAILY_EMAIL_CAP_LEARNER` / `DAILY_EMAIL_CAP_STAFF` in
  `src/communications/queue/communications.types.ts`). Past the cap the row goes into the recipient's
  digest instead of being dropped. Testing eight engagement events against one learner in one day
  will *not* produce eight emails, and that is correct.

---

## C. Surfaces and routes

Atlas serves two entirely different route trees from one bundle. `AppRouter` decides with a single
early return: if the hostname resolves to an academy, it renders `PublicWebsiteRouter`
**instead of** — never alongside — the dashboard/auth/marketing tree.

Host detection (`atlas-front/src/features/public-website/utils/hostname-resolution.utils.ts`):
the base domain comes from `VITE_PLATFORM_BASE_DOMAIN` (bootstrap default; the authoritative value is
the backend `PlatformDomainConfiguration`, editable at `/dashboard/platform/domain`).
`base` and `www.base` → management host. `<label>.base` → academy host by subdomain. Anything else
that is not localhost/an IP → academy host by custom domain.

### C.1 Management host — `https://atlass.dpdns.org`

| Surface | Path |
|---|---|
| Sign in / register | `/auth/sign-in`, `/auth/register` |
| Forgot / reset password | `/auth/forgot-password`, `/auth/reset-password` |
| Verify email | `/auth/verify-email` |
| Academy chooser | `/academy-chooser` |
| Dashboard root | `/dashboard` |
| Profile (incl. communication preferences) | `/dashboard/profile` |
| Notification centre | `/dashboard/notifications` |
| **Communications console** | `/dashboard/analytics/communications` |
| Delivery analytics | `/dashboard/analytics/delivery` |
| Subscription | `/dashboard/tenant/subscription` |
| Billing | `/dashboard/tenant/billing` |
| Retention (Data & retention) | `/dashboard/tenant/retention` |
| Academy roster | `/dashboard/academy/:academyId/members` |
| Course reviews (moderation) | `/dashboard/academy/:academyId/courses/:courseId/reviews` |
| Live-session recordings / connection | `/dashboard/add-ons/live-sessions/recordings`, `/dashboard/add-ons/live-sessions/connection` |
| Support case | `/dashboard/support/:caseId` |
| Certificate verification | `/verify/:code` |
| Unknown path | `*` → `NotFoundPage` |

### C.2 Academy host — `https://<slug>.<base domain>` or a connected custom domain

| Surface | Path (Arabic twin is the same path under `/ar`) |
|---|---|
| Sign in / sign up | `/sign-in`, `/sign-up` |
| Forgot / reset password | `/forgot-password`, `/reset-password` |
| Verify email | `/verify-email` |
| Learner home | `/my` |
| My courses / a course | `/my/courses`, `/my/courses/:courseId` |
| An activity (quiz/assignment) | `/my/courses/:courseId/activities/:itemId` |
| Assessments | `/my/assessments` |
| Certificates | `/my/certificates` |
| Purchases | `/my/purchases` |
| Checkout | `/my/courses/:courseId/checkout` |
| Devices | `/my/devices` |
| Notifications | `/my/notifications` |
| Profile (incl. communication preferences) | `/my/profile` |
| Security | `/my/security` |
| Certificate verification | `/verify/:code` |
| Course catalogue / details | `/courses`, `/courses/:courseId` |
| Unknown path | CMS catch-all |

### C.3 The trap that produces the most false bug reports

**`/dashboard/*` does not exist on an academy host.** `AppRouter` returns `PublicWebsiteRouter`
before any `/dashboard` route is declared, so `/dashboard/anything` falls into the CMS catch-all,
`resolvePathToPage` finds no page, and `PublicWebsitePage` renders the academy's own
**"Page not found — This page doesn't exist or is no longer available."** — not Atlas's
`NotFoundPage`.

The mirror image is also true: **`/my/*` only exists on an academy host.**

This is why the catalogue splits `branding` per event. `branding: 'platform'` builds links on
`PLATFORM_WEB_URL`; `branding: 'academy'` builds them on the academy's canonical host (a connected,
HTTPS-reachable custom domain wins; otherwise `<subdomain>.<PLATFORM_BASE_DOMAIN>`), with an `/ar`
prefix for Arabic — the prefix exists **only** on the academy host
(`src/communications/services/link-builder.service.ts`).

So when you check a link, check **both halves**: the host and the path. A `/dashboard/...` path on an
academy host, or a `/my/...` path on the management host, is a defect even though the page "looks
like a 404".

Two more behaviours worth knowing so you do not mis-triage:
- An unknown `/my/...` path redirects to `/my` rather than showing a 404.
- A pure learner who reaches `/dashboard/*` on the management host is redirected to
  `/academy-chooser` by `RouteGuard`, not 403'd in the browser.

### C.4 Where preferences live

The same communication-preferences panel renders on **both** profile pages — `/dashboard/profile`
for staff and platform recipients, `/my/profile` for learners — and both call
`GET`/`PATCH /api/v1/users/me/communication-preferences`. The email footer's
"Manage email settings" link points at whichever of those matches the recipient's audience.

---

## D. Per-scenario procedures

Each scenario gives: the actions, the **email** expected, the **in-app notification** expected, the
**destination** of the link, and how to tell success from failure.

**Timing.** After the emitting transaction commits, a dispatch job is enqueued. If that hint is
lost, a **sweep every 60 s** re-enqueues anything `pending`/`deferred` whose `available_at` has
passed. So: an email inside ~10 seconds is normal, inside ~70 seconds is still normal, and beyond a
couple of minutes means something in §I.

**Common failure signature.** If nothing arrives at all, do not guess — go straight to §I and start
at the console's `outbox.byState`.

---

### D.1 Sign-up and email verification

**Actions.** On an academy host, open `/sign-up` and register. (API: `POST /api/v1/auth/register`
with `{ name, email, password, academyId }`.) To re-send:
`POST /api/v1/auth/verify-email/resend` while signed in.

**When it is sent (26 Sep 2026).** Only when the OTP policy of the surface the account registers on
is `off` (the academy surface for learners, the management surface otherwise). Under `new_device` /
`always` a new account's first sign-in must pass an emailed code, whose success sets
`emailVerifiedAt`, so registration sends **no** link (and writes no link token). Production runs
`new_device` on both surfaces, so production sign-ups receive the code only. The resend endpoint
and the link page are unchanged.

**Email.** Key `auth.email.verification`, category `security`, email policy `always` (preferences
cannot suppress it).
Subject **"Verify your email address"** / **"تأكيد عنوان بريدك الإلكتروني"**.
CTA **"Verify email"**.

**In-app.** None — `inApp: 'never'` for this key. That is correct: the person is not signed in yet.

**Destination.** `https://atlass.dpdns.org/auth/verify-email?token=<opaque>` — the **management
host**, because the entry is `branding: 'platform'`. This is true even for a learner who registered
on an academy host. The token travels only inside the href; no template prints it.

**Success.** The email arrives; clicking the button lands on the verify-email page and the account
becomes verified. The body contains **no raw token text** — an earlier build pasted
`Verification token: <opaque>` into the body and that was removed deliberately
(commit `000e964`, "stop emailing raw credentials").

**Failure.** A body containing a bare token string; a link with no `?token=`; a link on an academy
host (that would render the CMS not-found).

**If the academy's registration policy is `approval`**, the same registration *also* emits
`roster.student.awaiting_approval` to every owner/administrator/manager — see D.10.

---

### D.2 Password reset

**Actions.** Request a reset: academy host `/forgot-password`, management host
`/auth/forgot-password` (API `POST /api/v1/auth/password-reset/request`). Then follow the link and
set a new password (`POST /api/v1/auth/password-reset/confirm`).

**Email.** Key `auth.password.reset`, category `security`, policy `always`.
Subject **"Reset your password"** / **"إعادة تعيين كلمة المرور"**. CTA **"Reset password"**.

**In-app.** None (`inApp: 'never'`).

**Destination.** `https://atlass.dpdns.org/auth/reset-password?token=<opaque>` — management host,
`branding: 'platform'`, for learners as well as staff.

**Then, on confirmation**, a second email: key `auth.password.reset_confirmed`, subject
**"Your password was reset"**, in-app **yes** this time, CTA **"Reset your password"** pointing at
`https://atlass.dpdns.org/auth/forgot-password`. That destination is deliberate: it is reachable
while signed out, which is the state someone is in when this is the email that matters.

**Success.** Two distinct emails; the reset link works once; a second use is refused (§H.2).

**Failure.** No second email; a "reset your password now" instruction with nothing to click (that
was fixed in commit `e04f620` — if you see it again, it regressed).

---

### D.3 Password changed (while signed in)

**Actions.** Sign in, change the password from the profile/security surface —
`POST /api/v1/users/me/password` with `{ currentPassword, newPassword }`
(service: `UsersService.changePassword`).

**Email.** Key `auth.password.changed`, category `security`, policy `always`.
Subject **"Your password was changed"** / **"تم تغيير كلمة المرور"**. CTA **"Reset your password"**.

**In-app.** Yes — `inApp: 'always'`, never deduped (a security alert must fire every time).

**Destination.** `https://atlass.dpdns.org/auth/forgot-password`.

**Also verify the side effects**, because they are part of this feature: every refresh token is
revoked and **every trusted device is revoked** (`TrustedDeviceService.revokeAllForUser(userId,
'password_change')`). Other sessions should be signed out.

---

### D.4 Email OTP at sign-in — **currently untestable in production**

`FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` and `FLAG_AUTH_EMAIL_OTP_MODE_ACADEMY` both default to
**`off`**, and production has not enabled them. With `off`, `EmailOtpService.isRequired` returns
`false` before anything is written: **no challenge row, no code, no email**. There is nothing to
observe. Do not record "OTP does not work" — record "OTP is disabled".

There is also **no frontend route constant for an OTP page**; sign-in returns an
`EmailOtpChallengeContract` in place of an access token and the challenge is handled inline.

**To exercise it in a non-production environment**, set the relevant flag to `always` (or
`new_device`) and sign in.

- **Email.** Key `auth.email.otp`, category `security`, policy `always`.
  Subject is the code itself: **"`<code>` is your sign-in code"** /
  **"`<code>` هو رمز تسجيل الدخول"**.
- **It carries a CODE and deliberately NO LINK.** There is no CTA and no `actionUrl` in the
  catalogue. An email that both demands a code and offers a button is the exact shape every phishing
  lookalike copies. **A link appearing here is a defect.**
- **In-app.** None (`inApp: 'never'`).
- Bounds to check: code TTL 600 s, 5 verification attempts, 3 codes per challenge, 60 s resend
  cooldown, 5 challenges per account per hour (`AUTH_EMAIL_OTP_*` defaults in
  `src/config/configuration.ts`). Endpoints: `POST /api/v1/auth/otp/verify`,
  `POST /api/v1/auth/otp/resend`.
- **A suppressed address refuses the challenge before writing anything** — the person is sent to
  password reset or support rather than to a code field that can never be satisfied.
- `new_device` depends on the `atlas_trust` HttpOnly cookie; trust lasts 90 days on management,
  180 on academy.

---

### D.5 A purchase, and its payment approval

Two different money flows exist. Test both; they are separate catalogue families.

#### D.5a Course purchase (learner buys a course from an academy)

**Actions.** As a learner on the academy host: `/courses/:courseId` → **Buy this course** →
`/my/courses/:courseId/checkout` → pick a manual payment method → upload proof. Then approve or
reject it — **as the Platform Owner**, because that controller carries
`JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard`:
`POST /api/v1/platform-course-order-payments/:id/approve` or `.../reject`.

Prerequisites, or the checkout page will honestly say *"Not available for purchase yet"*: the
organisation's payment collection mode set to Atlas Payments, a platform commission configured, and
at least one enabled manual payment method.

| Step | Key | Email subject (EN) | In-app | Destination |
|---|---|---|---|---|
| Order created | `course.order.created` | "Your order for `<course>`" | yes | `/my/purchases` on the academy host — **but `email: 'never'`, so no email is sent** |
| Proof uploaded | `course.order.proof_submitted` | "We received your payment proof" | yes | `/my/purchases` |
| Approved | `course.order.paid` | "Purchase confirmed" | yes | `/my/purchases` |
| Rejected | `course.order.payment_failed` | "Payment failed" | yes | `/my/purchases` |
| Refunded | `course.order.refunded` | "Refund processed" | yes | `/my/purchases` |
| Expired | `course.order.expired` | "Your order for `<course>` expired" | yes | `/courses/:courseId` — **`email: 'never'`** |

All six are `audience: 'learner'`, `branding: 'academy'`, so every link is built on the **academy
host** with an `/ar` prefix in Arabic. All are category `transactional`, which means the recipient
**cannot** switch them off and they are exempt from the per-recipient daily cap.

**Known data residue (BL-4).** Course orders never actually expired before a recent fix — the lazy
expiry wrote `status='expired'` and then threw a 409 from the same transaction, rolling the write
back. Rows that lapsed before the fix are still `draft`/`pending_payment` with a past `expires_at`.
Do not expect `course.order.expired` to fire for them, and note that nothing should ever backfill
those events.

#### D.5b Platform subscription payment (organisation pays Atlas)

**Actions.** As Client Owner, submit a payment for a plan
(`POST /api/v1/organizations/:id/payments`, upload the proof). Then as Platform Owner, from
`/dashboard/platform/payments`: `POST /api/v1/payments/:id/approve` or `.../reject` — that controller
is `JwtAuthGuard, ManagementSurfaceGuard, PlatformOwnerGuard`.

| Step | Key | Subject (EN) | Destination |
|---|---|---|---|
| Proof submitted | `lifecycle.subscription.payment_submitted` | "We received your payment proof" | `/dashboard/tenant/billing` |
| Approved | `platform.payment.approved` | "Payment approved" | `/dashboard/tenant/billing` |
| Rejected | `platform.payment.rejected` | "Payment rejected" | `/dashboard/tenant/billing` |
| Subscription activated | `lifecycle.subscription.activated` | "Your `<plan>` subscription is active" | `/dashboard/tenant/subscription` |

All are `audience: 'staff'`, `branding: 'platform'` → **management host**, no locale prefix.
Recipient is `organizations.owner_user_id`.

**Note on `lifecycle.subscription.activated`:** it is emitted from the payment approval path
(`PlatformPaymentService`), *not* from the flagged lifecycle sweep, so it fires with
`FLAG_LIFECYCLE_SEQUENCES_MODE=off`.

**Check specifically that the link is `/dashboard/tenant/billing` and not `/dashboard/billing`.**
The latter is not a route on any host and used to be what three entries carried; it now lives in the
catalogue as the constant `TENANT_BILLING_PATH`.

---

### D.6 Enrollment

**Actions (staff).** On the management host, roster → grant a course:
`POST /api/v1/academies/:id/students/:userId/enrollments`. Revoke:
`POST /api/v1/academies/:id/enrollments/:enrollmentId/revoke`. Change expiry:
`PATCH /api/v1/academies/:id/enrollments/:enrollmentId/expiry`.

**Actions (learner).** Self-enroll in a free course from the academy host.

| Key | Subject (EN) | Email | In-app | Destination (academy host) |
|---|---|---|---|---|
| `enrollment.granted` | "You have been enrolled in `<course>`" | always | yes | `/my/courses/:courseId` |
| `enrollment.self_enrolled` | "You are enrolled in `<course>`" | always | yes | `/my/courses/:courseId` |
| `enrollment.revoked` | "Your access to `<course>` has ended" | always | yes | `/my/courses` |
| `enrollment.expiry_changed` | "Your access to `<course>` now ends on `<date>`" (or the no-expiry variant) | always | yes | `/my/courses/:courseId` |

All four are `locale: 'academy'` — meaning if the recipient has not chosen a language, the
**academy's** language decides. That is the cheapest way to produce a real Arabic email (§F).

**Success.** Link opens the learner's course page on the academy host and the enrollment state
matches. **Failure.** A `/dashboard/learning/...` path anywhere — that learner surface was retired
and those paths exist only as a forwarding table on the *platform* host.

---

### D.7 A graded assessment

**Actions.** As instructor, grade a quiz attempt or an assignment submission from
`/dashboard/instructor/courses/:courseId/...`. For the auto-submit case, let a timed quiz attempt
run out.

| Key | Subject (EN) | Email | Destination (academy host) |
|---|---|---|---|
| `assessment.quiz.graded` | "Your quiz has been graded" | `preference` | `/my/courses/:courseId/activities/:quizId` |
| `assessment.assignment.graded` | "Your assignment has been graded" | `preference` | `/my/courses/:courseId/activities/:assignmentId` |
| `assessment.quiz.auto_submitted` | "`<quiz>` was submitted automatically" | `preference` | `/my/courses/:courseId/activities/:quizId` |
| `assessment.attempt.invalidated` | "Your attempt at `<quiz>` no longer counts" | `preference` | `/my/courses/:courseId/activities/:quizId` |

All four are category `engagement`. **`preference` means they are genuinely suppressible**, and this
is where most "the email never came" reports actually resolve:

1. If the learner's engagement email is **off**, the outbox row settles as `dispatched` with
   `last_error = 'preference_off'` and a delivery row with status `suppressed`. The **in-app
   notification still appears** — that is not a bug, that is `outcome: 'in_app_only'`.
2. If engagement digest is **`daily`**, the row is attached to the learner's open digest and sent in
   one batched email at local hour **08:00** in the academy's timezone.
3. If the learner has already received **5** non-security/non-transactional emails today, the row
   also goes to the digest — unless the learner set digest to `off`, in which case it settles as
   in-app only with `last_error = 'daily_cap'`.

So before calling this broken, open `GET /api/v1/users/me/communication-preferences` as that learner.

**`exam` is a MODE of a quiz, not a separate thing.** There is no
`assessment.exam.graded` to look for. An exam-mode quiz emits
`assessment.quiz.graded` exactly as a practice quiz does, and the wording says "quiz"
on purpose: the learner-facing product uses that one noun everywhere, and introducing
"Exam" only in the notification would make it the single place a learner meets a word
the rest of the product never shows them.

**The isolation check — do this one, it is the one that matters.** A grade is the most
private fact Atlas holds about a person, so "the right learner was told" is a weaker
claim than "only the right learner was told". Enrol **two** learners in the same course,
have both submit, then grade **one**:

| Who | Should receive |
|---|---|
| The learner whose work was graded | Email **and** in-app notification |
| The other learner in the same course | **Nothing** — no email, no feed entry |
| A learner in a different academy | **Nothing** |
| The instructor who did the grading | **Nothing** — they just typed it |

If any of the bottom three receives anything, stop and escalate: that is a privacy
incident, not a notification bug. Neither grading request carries a learner id at all —
the recipient is read back from the row being graded — so a leak here would mean
something structural is wrong. `test/p64-c9-graded-work-isolation.e2e-spec.ts` holds
this contract; misdirecting either emit fails it.

---

### D.8 A certificate

**Actions.** Complete a course so a certificate issues, or issue one from
`/dashboard/academy/:academyId/certificates`. To test revocation, revoke it.

| Key | Subject (EN) | Email | In-app | Destination |
|---|---|---|---|---|
| `certificate.issued` | "Your certificate is ready" | always | yes | `/my/certificates` on the academy host |
| `certificate.revoked` | "A certificate was revoked" | always | yes | `/my/certificates` |

**`certificate.issued` carries BOTH a code and a link.** The body prints
`Verification code: <verificationCode>.` as literal text — that is correct, because a third party
types it into the public verification page — and the CTA button goes to the holder's certificate
list.

**Documented gap, not a defect to file:** the plan (§22) also asks the certificate email to link to
the public verification sheet (`/verify/:code`). It does not, because the layout supports one CTA.
This was recorded rather than bodged (commit `e04f620`). Verify the code by pasting it into
`/verify/:code` yourself on either host.

**Also check `course.completed`** (subject "You finished `<course>`", `engagement`/`preference`,
destination `/my/courses/:courseId`), which usually fires just before the certificate.

---

### D.9 A review submitted, and moderated

**Actions.** As an enrolled learner on the academy host, write a review on a course details page
(`POST /api/v1/courses/:id/reviews`). As owner/administrator/manager, approve or reject it at
`/dashboard/academy/:academyId/courses/:courseId/reviews`
(`POST /api/v1/courses/:id/reviews/:reviewId/approve|reject`).

**Staff side — `review.submitted`.**
- Subject **"A review is waiting for moderation at `<academy>`"**.
- `audience: 'staff'`, category `operational`, **`email: 'digest'`** — this is **batched, not
  immediate**. It attaches to the recipient's open digest window and is sent by the hourly digest job
  when the window closes at local hour 08:00. An immediate email here is the wrong expectation.
- In-app: immediate.
- Recipients: **owner / administrator / manager only**. Instructors are deliberately excluded.
- `branding: 'platform'` → destination
  `https://atlass.dpdns.org/dashboard/academy/:academyId/courses/:courseId/reviews`.
- The email deliberately **does not quote the learner's review text** — user-written content in
  outbound mail is an injection and abuse surface. Absence of the quote is correct.

**Learner side — `review.moderated`.**
- Subject switches on `values.status`: **"Your review of `<course>` is now published"** when
  approved, **"Your review of `<course>` was not published"** otherwise.
- Category `engagement`, **`email: 'never'`** — **in-app only, no email is ever sent.** Destination
  `/my/courses/:courseId` on the academy host.

---

### D.10 A roster approval

**Setup.** Set the academy's registration policy to `approval`:
`PATCH /api/v1/academies/:id/registration-policy` with `{ "registrationPolicy": "approval" }`
(values: `open | invite | approval`).

**Actions.** Register a new learner on that academy host → the `academy_students` row lands
`pending`. Then approve / reject / block / unblock from the roster
(`POST /api/v1/academies/:id/students/:userId/approve|reject|block|unblock`).

| Key | Audience | Subject (EN) | Email | Destination |
|---|---|---|---|---|
| `roster.student.awaiting_approval` | staff | "Someone is waiting to join `<academy>`" | **digest** | `https://atlass.dpdns.org/dashboard/academy/:academyId/members` |
| `roster.student.approved` | learner | "Your registration at `<academy>` has been approved" | always | `/my/courses` (academy host) |
| `roster.student.rejected` | learner | "Your registration at `<academy>` was not approved" | always | **no link** — no `actionUrl`, no CTA |
| `roster.student.blocked` | learner | "Your access to `<academy>` has been suspended" | always | **no link** |
| `roster.student.unblocked` | learner | "Your access to `<academy>` has been restored" | always | `/my/courses` (academy host) |

The two "no link" entries are intentional: there is nowhere useful to send someone who has just been
refused or suspended. A CTA appearing on them is a defect.

The staff work item reaches its recipients through the SECURITY DEFINER function
`academy_notification_recipients(academy_id, roles[])`, because the learner's own transaction cannot
read `academy_members`. If nobody is told, check that the academy actually has an
owner/administrator/manager with an active membership.

---

### D.11 Trial and subscription lifecycle — **currently emits nothing**

`FLAG_LIFECYCLE_SEQUENCES_MODE` defaults to **`off`** and production has not enabled it.
`TenantLifecycleService.run` returns immediately when the mode is `off`: no evaluation, no outbox
rows, no email. **Seventeen steps are therefore unobservable today.**

The sequence is not scheduled anywhere — it is re-derived from live subscription state on every
`subscription-sweep` tick (every 15 minutes). There is no table of future emails to inspect.

| Key | Subject (EN) | Email policy |
|---|---|---|
| `lifecycle.trial.started` | "Your `<plan>` trial has started" | always |
| `lifecycle.trial.ending_soon` | "Your trial ends tomorrow" | always |
| `lifecycle.trial.expired` | "Your trial has ended and your site is offline" | always |
| `lifecycle.trial.followup_3d` | "Your Atlas work is still here" | preference (in-app: never) |
| `lifecycle.trial.followup_14d` | "Your courses are still waiting" | preference (in-app: never) |
| `lifecycle.trial.reactivation_45d` | "Last note about your Atlas academy" | preference (in-app: never) |
| `lifecycle.subscription.activated` | "Your `<plan>` subscription is active" | always |
| `lifecycle.subscription.payment_submitted` | "We received your payment proof" | always |
| `lifecycle.subscription.renewal_due` | "Your subscription renews in 7 days" | always |
| `lifecycle.subscription.renewal_tomorrow` | "Your subscription period ends tomorrow" | always |
| `lifecycle.subscription.grace_started` | "Your site stays online for 7 more days" | always |
| `lifecycle.subscription.grace_ending` | "Your grace period ends tomorrow" | always |
| `lifecycle.subscription.expired` | "Your subscription has expired and your site is offline" | always |
| `lifecycle.subscription.cancel_scheduled` | "Your subscription is set to end" | always |
| `lifecycle.subscription.cancelled` | "Your subscription has ended" | always |
| `lifecycle.subscription.followup_7d` | "Your academy is still stored" | preference (in-app: never) |
| `lifecycle.subscription.followup_30d` | "Last note about your Atlas subscription" | preference (in-app: never) |

All are `audience: 'staff'`, `branding: 'platform'`, destination
`https://atlass.dpdns.org/dashboard/tenant/subscription` (except `payment_submitted`, which goes to
`/dashboard/tenant/billing`). Recipient is the organisation owner.

**If someone enables it for you**, the honest first move is `dry_run`, which evaluates every
condition and **logs** the steps it would have emitted without sending. Then test:

1. **The lateness horizon.** A step is due inside a window `[dueAt, dueAt + horizon]` — two days,
   and six hours for the three "tomorrow" reminders. Anything older is skipped, permanently.
   Without this, switching the flag on would have emailed "your site is now offline" to every
   organisation that ever lapsed. Sixteen of seventeen production organisations are `trial_expired`,
   so this is not hypothetical. **An organisation that lapsed last month must receive nothing.**
2. **Silence on repeat.** The dedupe key is `lifecycle_<step>:<organizationId>:<anchor>`, where the
   anchor is the immutable instant the timing derives from. Ninety-six sweep ticks a day re-derive
   the same string and the unique index rejects every one after the first. **Leave it running for a
   day and confirm exactly one email per step.**
3. **Activation ends the sequence instantly.** Pay mid-sequence; the next tick should simply no
   longer return the step. There is nothing to cancel.
4. **The `reminders` toggle.** Turning off `lifecycle.reminders` in preferences must silence only
   the four follow-ups (`trial.followup_3d/14d`, `reactivation_45d`, `subscription.followup_7d/30d`)
   and must **not** silence "your site is now offline", which declares `email: 'always'` and never
   reaches that branch.

---

### D.12 Video retention warnings — **currently emits nothing; deletion is untestable**

`FLAG_VIDEO_RETENTION_MODE` defaults to **`off`**. Production has not enabled it.

| Mode | Behaviour |
|---|---|
| `off` (current) | nothing is evaluated, no warnings, no deletions |
| `warn_only` | the full W1–W4 warning sequence is sent — **these are real emails to real customers** — and **no** deletion job is ever enqueued |
| `on` | warnings plus deletion |

| Key | Subject (EN) | Destination |
|---|---|---|
| `retention.video.warning_30d` | "Your hosted videos will be deleted on `<date>`" | `/dashboard/tenant/retention` |
| `retention.video.warning_14d` | "14 days left: your hosted videos are deleted on `<date>`" | `/dashboard/tenant/retention` |
| `retention.video.warning_7d` | "Final warning: your hosted videos are deleted on `<date>`" | `/dashboard/tenant/retention` |
| `retention.video.warning_24h` | "Last call: your hosted videos are deleted tomorrow" | `/dashboard/tenant/retention` |
| `retention.video.deleted` | "Your hosted videos have been deleted" | `/dashboard/tenant/retention` |
| `retention.video.deletion_failed` | "Video retention: deletion failed for asset `<id>`" | `/dashboard/analytics/delivery` (audience: platform) |

All `branding: 'platform'` → management host. `/dashboard/tenant/retention` is a real page
(it answers `GET /api/v1/organizations/:id/retention`), owner-only — stricter than the ordinary
lifecycle read, because it names courses and a destruction date. Confirm that a **Manager** of the
same organisation is refused.

**What is untestable, and why:**
- **Real deletion cannot be verified.** The video infrastructure it would call is not configured
  (blocker BL-2). Deletion has only ever been exercised against a fake provider. `retention.video.deleted`
  and `retention.video.deletion_failed` are therefore not reachable in a real environment today.
- **Switching straight to `on` cannot delete anything either.** A deletion requires all four
  warnings to already exist in the outbox *at the current anchor*. A platform that has only ever run
  `warn_only` cannot delete on the day it flips to `on`; the earliest possible deletion is 30 days
  after the first W1 actually went out.
- **No backfill.** Tenants already past the horizon are permanently skipped by design.
- **A hold opened by someone else is invisible to the tenant.** `support_cases` has no tenant-scoped
  SELECT policy, so the retention page can only ever **over**-warn — it can never claim a frozen
  clock for an organisation that is actually counting down.

---

### D.13 The platform communications console

**Actions.** As Platform Owner on the management host, open **Analysis › Communications**
(`/dashboard/analytics/communications`). Change the range selector (`?range=7d|30d|90d`) and watch
the numbers change. The page refetches every 60 seconds.

Direct API:
```
GET    /api/v1/platform-communications/health?days=30
GET    /api/v1/platform-communications/suppressions?limit=50[&cursor=<id>]
DELETE /api/v1/platform-communications/suppressions/<url-encoded-email>
```
Guards, in order: `JwtAuthGuard`, `ManagementSurfaceGuard`, `PlatformOwnerGuard`. `days` is bounded
1–90; `limit` 1–200.

**What `health` returns** (`src/communications/dto/platform-communications-health.contract.ts`):

| Field | Meaning |
|---|---|
| `outbox.byState` | count per `pending / dispatched / deferred / suppressed / failed`, zeros included |
| `outbox.oldestPendingSeconds` | **the number that matters.** Age of the oldest row that is already due. `null` = nothing waiting = healthy |
| `outbox.overdue` | due rows waiting longer than **15 minutes** |
| `outbox.failed` | rows that exhausted their retries — each one is an email nobody got |
| `deliveries.byStatus` | `queued / sent / delivered / bounced / complained / failed / suppressed / deferred` |
| `deliveries.byProvider` | which provider actually accepted each message |
| `deliveries.failureRatio` | (bounced + complained + failed) / all terminal |
| `suppressions.total`, `suppressions.byReason` | counts only — never a list of addresses |
| `digests` | count per digest state |
| `providers[]` | the live chain in fallback order with real quota usage |

**Why `oldestPendingSeconds` is the one to watch:** a dispatcher that has stopped claiming rows looks
**exactly** like a quiet week — both are silence. The age of the oldest due row is the only thing
that separates them.

**Tests to run here:**
1. Emit something (a password reset to your own address), then reload. `outbox.byState.dispatched`
   and `deliveries.byStatus.sent` should both increase by one.
2. Confirm `providers[0].provider === "brevo"` and `dailyLimit === 300`.
3. Confirm suppression rows show **truncated hashes**, never addresses. The server stores
   `email_hash` (SHA-256 of the canonicalised address) and `email_domain`, and returns only those.
4. Lift a suppression and confirm the row disappears. **Verify this end to end rather than assuming
   it works:** the frontend service builds the path as
   `resourcePath('suppressions/' + encodeURIComponent(email))` and `resourcePath` runs
   `encodeURIComponent` over the whole segment again
   (`atlas-front/src/services/api/request.utils.ts`), which would double-encode the `/` and the `@`.
   Check the network tab for what URL is actually sent, and compare with a direct
   `DELETE /api/v1/platform-communications/suppressions/<encoded>` from the API.
   Note that the API answers `{ "lifted": false }` rather than 404 when nothing matched — that is
   deliberate, so the endpoint cannot be used to probe whether an address is on the list.
5. A non-platform-owner must get **403**, and an anonymous caller **401**. See §H.

---

### D.14 Other events worth a pass

| Key | Surface / trigger | Email | Destination |
|---|---|---|---|
| `provisioning.completed` / `.failed` | academy provisioning finishes | always | `/dashboard` (platform host) |
| `support.case.reply` | a reply on a support case | `preference` | `/dashboard/support/:caseId` |
| `support.case.status_changed` | status change | **never** (in-app only) | `/dashboard/support/:caseId` |
| `device.registered` | a learner signs in from a new browser | **never** (in-app only) | `/my/devices` |
| `device.removed` | a device is removed | always | `/my/devices` |
| `device.limit_reached` / `session.taken_over` | device policy | **never** (in-app only) | `/my/devices` |
| `announcement.published` | an announcement is published | **never** (in-app only) | `/my/courses/:courseId` or `/my` |
| `live_session.scheduled / rescheduled / cancelled / starting_soon` | live sessions | **never** (in-app only) | `/my/courses/:courseId` |
| `live_session.recording_available` | recording ready (staff) | `preference` | `/dashboard/add-ons/live-sessions/recordings` |
| `live_provider.deauthorized` | provider disconnected (staff) | **never** (in-app only) | `/dashboard/add-ons/live-sessions/connection` |

**`announcement.published` is in-app only on purpose, and the email half is not shipped.** On
Brevo free (300/day), an announcement blast to an academy of any real size would exhaust the
engagement line within a few hundred recipients and the rest would be skipped. The per-recipient cap
does not help — a fan-out is each person's *first* email of the day. The template already carries the
copy the email half would use. Do not file "announcements do not send email".

**`digest.daily`** is not an event you trigger; it is the envelope the hourly digest job sends,
listing the deferred items as `{ subject, url }` rows already rendered in the recipient's locale.

---


### D.15 An account somebody else created for you

**Actions.** As a Client Owner or Manager, add a member from the academy dashboard —
a **Student** (`/academies/:id/students`), an **Instructor** (`/academies/:id/instructors`)
or a **Manager** (`/academies/:id/members`). Use an address you can actually read.

| Key | Subject (EN) | Email | Destination |
|---|---|---|---|
| `academy.learner.invited` | "You've been added to `<academy>` on Atlas" | `always` | ACADEMY `/reset-password?token=…&setup=1` |
| `academy.member.invited` | "You've been added to `<academy>` on Atlas" | `always` | PLATFORM `/auth/reset-password?token=…&setup=1` |

**Both are email-only and `always`.** There is no in-app notification, because the
recipient cannot sign in yet — that is the entire problem the message solves.

**What to check, in order:**

1. The email arrives, and names the academy, the role, and **which address signs in**.
2. It contains **no password and no visible token**. The only place the token appears is
   inside the button's href. If you can read a long opaque string in the body, stop — that
   is the defect this whole family was rebuilt to remove.
3. The button says **"Set your password"**, not "Reset". The page it opens says the same.
   Someone who never had a password should not be told to reset one.
4. Following it, choosing a password, and signing in **works**. A link that arrives and
   does not work is the same failure as no link at all.
5. **The surface matters.** A Student must sign in on the **academy** host; a Manager or
   Instructor on the **management** host. This is why there are two keys. If a student's
   link sends them to the management host they will set a password successfully and then
   be refused with a **403** — which looks like a broken account and is not.
6. The link expires after **72 hours**. Afterwards "forgot password" issues a fresh one,
   because by then the account genuinely exists.
7. **Open a stale or tampered setup link** — `?token=nonsense&setup=1`. It must say the
   **setup** link expired and offer *Get a new link*. If it says your *reset link* expired,
   that is the defect found in production on 25 September: the page had two voices on its
   success branch and only one on its failure branch. Expiry is a normal way to arrive
   here — the link lasts 72 hours and goes to somebody who did not ask for it.

**The negative case.** Add someone who **already has an Atlas account** to a second
academy. They must receive **nothing** — they already have a password, and a "set your
password" email would be confusing at best.

---

### D.16 A learner exception (extra time, extra attempts, a private window)

**Actions.** As a reviewer, open a quiz's overrides
(`PUT /review/courses/:courseId/quizzes/:quizId/overrides`) and grant one student extra
time, extra attempts, or a window. Then edit it, then delete it.

| Key | Subject (EN) | Email | Destination (academy host) |
|---|---|---|---|
| `assessment.exception.granted` | "You have an exception for `<quiz>`" | `preference` | `/my/courses/:courseId/activities/:quizId` |
| `assessment.exception.activated` | "Your exception for `<quiz>` is now active" | `preference` | `/my/courses/:courseId/activities/:quizId` |
| `assessment.exception.revoked` | "Your exception for `<quiz>` was removed" | `preference` | `/my/courses/:courseId/activities/:quizId` |

**Immediate vs scheduled is the thing to test.** Grant one with **no** start date and one
starting **tomorrow**:

- No start date, or a start date already passed → the message says the accommodation is
  **usable now**.
- A start date in the future → the message says **when it becomes active**, and does *not*
  tell the learner to use it yet.

Both are the same key. The in-app feed picks between two copies from a `scheduled` flag the
producer decided once, so the email and the feed entry can never disagree with each other.

**The activation message.** When a scheduled window actually opens, a **sweep** running
every five minutes emits `assessment.exception.activated`. To see it without waiting, set
the start date a couple of minutes ahead and leave it. It fires **once** — the sweep is
keyed on the instant that transitioned, not on the instant of the tick — so a window that
has been open for hours does not produce a fresh message on every tick. A reviewer who
**moves** the window does produce a genuinely new one.

**No expiry message exists, on purpose.** When `availableUntil` passes, nothing is sent.
The closing date was already printed in every message above, the window shutting carries
nothing the learner can act on, and it would be the one message in this family that fires
for every learner every term. See the catalogue's *Deliberate silences*.

**The privacy check.** Grant an exception with a `reason` such as *"student is undergoing
chemotherapy this term"*. The learner must **never** see it — not in the email, not in the
feed, not in the notification's stored values. The reason is a note between staff and may
record a disability or an illness. If it appears anywhere learner-facing, escalate.

**The isolation check.** As with grading: a classmate, a learner in another academy, and
the reviewer who granted it must all receive **nothing**.

---

## E. "What should I receive?"

Subject lines are copied from `src/communications/templates/keys/*.ts`. Destinations are the
catalogue's `actionUrl` resolved through `LinkBuilderService`:
**PLATFORM** = `https://atlass.dpdns.org<path>` · **ACADEMY** = `https://<academy host>[/ar]<path>`.

| Event | Subject (EN) | Carries | Link goes to |
|---|---|---|---|
| `auth.email.verification` | Verify your email address | **LINK** | PLATFORM `/auth/verify-email?token=…` |
| `auth.password.reset` | Reset your password | **LINK** | PLATFORM `/auth/reset-password?token=…` |
| `auth.password.reset_confirmed` | Your password was reset | LINK | PLATFORM `/auth/forgot-password` |
| `auth.password.changed` | Your password was changed | LINK | PLATFORM `/auth/forgot-password` |
| `auth.email.otp` | `<code>` is your sign-in code | **CODE, no link** | — |
| `academy.learner.invited` | You've been added to `<academy>` on Atlas | **LINK** | ACADEMY `/reset-password?token=…&setup=1` |
| `academy.member.invited` | You've been added to `<academy>` on Atlas | **LINK** | PLATFORM `/auth/reset-password?token=…&setup=1` |
| `certificate.issued` | Your certificate is ready | **CODE *and* LINK** | ACADEMY `/my/certificates` |
| `certificate.revoked` | A certificate was revoked | LINK | ACADEMY `/my/certificates` |
| `course.order.paid` | Purchase confirmed | LINK | ACADEMY `/my/purchases` |
| `course.order.payment_failed` | Payment failed | LINK | ACADEMY `/my/purchases` |
| `course.order.refunded` | Refund processed | LINK | ACADEMY `/my/purchases` |
| `course.order.proof_submitted` | We received your payment proof | LINK | ACADEMY `/my/purchases` |
| `course.order.created` | Your order for `<course>` | LINK (in-app only) | ACADEMY `/my/purchases` |
| `course.order.expired` | Your order for `<course>` expired | LINK (in-app only) | ACADEMY `/courses/:courseId` |
| `enrollment.granted` | You have been enrolled in `<course>` | LINK | ACADEMY `/my/courses/:courseId` |
| `enrollment.self_enrolled` | You are enrolled in `<course>` | LINK | ACADEMY `/my/courses/:courseId` |
| `enrollment.revoked` | Your access to `<course>` has ended | LINK | ACADEMY `/my/courses` |
| `enrollment.expiry_changed` | "Your access to `<course>` now ends on `<date>`" — or, when the date was removed, "Your access to `<course>` no longer expires" | LINK | ACADEMY `/my/courses/:courseId` |
| `course.completed` | You finished `<course>` | LINK | ACADEMY `/my/courses/:courseId` |
| `assessment.quiz.graded` | Your quiz has been graded | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `assessment.assignment.graded` | Your assignment has been graded | LINK | ACADEMY `/my/courses/:courseId/activities/:assignmentId` |
| `assessment.quiz.auto_submitted` | `<quiz>` was submitted automatically | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `assessment.attempt.invalidated` | Your attempt at `<quiz>` no longer counts | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `assessment.exception.granted` | You have an exception for `<quiz>` | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `assessment.exception.activated` | Your exception for `<quiz>` is now active | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `assessment.exception.revoked` | Your exception for `<quiz>` was removed | LINK | ACADEMY `/my/courses/:courseId/activities/:quizId` |
| `review.submitted` | A review is waiting for moderation at `<academy>` | LINK (digest) | PLATFORM `/dashboard/academy/:academyId/courses/:courseId/reviews` |
| `review.moderated` | "Your review of `<course>` is now published" / "… was not published" (branches on `values.status === 'approved'`) | LINK (in-app only) | ACADEMY `/my/courses/:courseId` |
| `roster.student.awaiting_approval` | Someone is waiting to join `<academy>` | LINK (digest) | PLATFORM `/dashboard/academy/:academyId/members` |
| `roster.student.approved` | Your registration at `<academy>` has been approved | LINK | ACADEMY `/my/courses` |
| `roster.student.rejected` | Your registration at `<academy>` was not approved | **neither** | — |
| `roster.student.blocked` | Your access to `<academy>` has been suspended | **neither** | — |
| `roster.student.unblocked` | Your access to `<academy>` has been restored | LINK | ACADEMY `/my/courses` |
| `platform.payment.approved` | Payment approved | LINK | PLATFORM `/dashboard/tenant/billing` |
| `platform.payment.rejected` | Payment rejected | LINK | PLATFORM `/dashboard/tenant/billing` |
| `provisioning.completed` | Your academy is ready | LINK | PLATFORM `/dashboard` |
| `provisioning.failed` | We could not finish setting up your academy | LINK | PLATFORM `/dashboard` |
| `lifecycle.trial.*`, `lifecycle.subscription.*` | see §D.11 | LINK | PLATFORM `/dashboard/tenant/subscription` (billing for `payment_submitted`) |
| `retention.video.warning_*`, `.deleted` | see §D.12 | LINK | PLATFORM `/dashboard/tenant/retention` |
| `retention.video.deletion_failed` | Video retention: deletion failed for asset `<id>` | LINK | PLATFORM `/dashboard/analytics/delivery` |
| `support.case.reply` | New reply on "`<subject>`" | LINK | PLATFORM `/dashboard/support/:caseId` |
| `device.registered` / `.removed` / `.limit_reached` | see §D.14 | LINK | ACADEMY `/my/devices` |
| `live_session.*` (learner) | see §D.14 | LINK (in-app only) | ACADEMY `/my/courses/:courseId` |
| `live_session.recording_available` | Your session recording is ready | LINK | PLATFORM `/dashboard/add-ons/live-sessions/recordings` |
| `live_provider.deauthorized` | Your live-session provider was disconnected | LINK (in-app only) | PLATFORM `/dashboard/add-ons/live-sessions/connection` |
| `announcement.published` | New announcement: `<title>` | LINK (in-app only) | ACADEMY `/my/courses/:courseId` or `/my` |

### E.1 What every email carries regardless of key

Rendered by `src/communications/templates/layout.ts`:
- The brand name (academy name when the entry is `branding: 'academy'` and an academy is attached,
  otherwise `EMAIL_FROM_NAME`), and the academy logo when one exists.
- A single-column table, inline styles only, `text-align: start` so the same markup reads correctly
  under `dir="rtl"`.
- At most **one** CTA button, followed by the same URL printed as plain text (so it survives a client
  that strips links).
- A footer: *"You received this email because you have an account with `<brand>`."* plus a
  **"Manage email settings"** link and *"Sent by `<platform>`"*.
- **No tracking pixel** and no remote images beyond the academy logo.
- **Every dynamic value is HTML-escaped once, in the layout.** Put `<script>alert(1)</script>` in a
  course title and confirm it renders as literal text.

The "Manage email settings" destination depends on the audience:
learner → `https://<academy host>[/ar]/my/profile`; staff or platform →
`https://atlass.dpdns.org/dashboard/profile`. **Both must be live pages.** A `/settings/notifications`
target is the old, dead value and would be a regression.

---

## F. English and Arabic

### F.1 How the locale is chosen

`CommunicationService.resolveLocale` decides at emit time and
`CommunicationDispatchService.resolveLocale` re-resolves it at send time with full visibility. The
rule is the same in both:

1. **The recipient's own `preferences.language`** — if it is `'ar'` or `'en'`, that wins. Full stop.
2. Otherwise, if the catalogue entry declares `locale: 'academy'` **and** an academy is attached,
   the **academy's `language`** decides (`'ar'` → Arabic).
3. Otherwise the stored value on the outbox row, defaulting to English.

So there are exactly two levers.

**Setting the recipient's language.** Two endpoints write to the same JSON blob
(`users.preferences`):
- `PATCH /api/v1/users/me/preferences` with `{ "preferences": { "language": "ar" } }` — the profile
  page's Language select plus **Save**.
- `PATCH /api/v1/users/me/communication-preferences` with `{ "language": "ar" }` — the email-language
  select inside the communication-preferences panel, which saves on change with no Save button.

Confirm with `GET /api/v1/users/me/communication-preferences`, which echoes the resolved `language`.

**Setting the academy's language.** The academy's `language` column, edited from the academy settings
surface. This only affects entries declared `locale: 'academy'` — which is most learner events
(enrollment, assessments, certificates, roster, reviews, announcements, devices, live sessions), but
**not** the `auth.*` family, which is `locale: 'user'`.

Note the consequence: a learner who has never chosen a language, in an Arabic academy, gets
**Arabic** enrollment mail but **English** password-reset mail. That is the design, not a bug.

### F.2 What to check in Arabic

For each of at least four emails — one `auth.*`, one enrollment, one assessment, one certificate:

1. **Subject is Arabic**, not an English string with Arabic body.
2. **`<html lang="ar" dir="rtl">`.** View source of the message. `renderHtmlLayout` sets both from
   the locale.
3. **Layout mirrors.** Paragraphs and the CTA sit on the right. The layout uses logical properties
   (`text-align: start`, `padding-inline-start`) rather than left/right, so a rendering that is
   left-aligned in Arabic means the locale never reached the renderer.
4. **The footer is Arabic**: *"وصلتك هذه الرسالة لأن لديك حسابًا لدى …"*, *"إدارة إعدادات البريد"*,
   *"أُرسلت بواسطة …"*.
5. **The link carries `/ar`** — but **only on the academy host**. `https://<academy>/ar/my/courses/<id>`
   is correct; `https://atlass.dpdns.org/ar/dashboard/...` is **wrong** — the management host mounts
   no `/ar` subtree at all. Platform-branded Arabic emails must link to the unprefixed path.
6. **Six-digit codes must not be reordered.** This is the highest-value Arabic check. Both the OTP
   code (`auth.email.otp`, when the flag is enabled) and the certificate verification code
   (`certificate.issued`) are digit runs inside an RTL paragraph. Type what you see into the app,
   in order, and confirm it is accepted. The Unicode bidi algorithm renders a digit run
   left-to-right inside an RTL paragraph, which is why the frontend marks its OTP slot group
   `dir="ltr"` — the email and the screen must agree. **A code that must be read backwards to work
   is a defect.**
7. **Interpolated values survive.** Arabic copy that quietly drops `{{courseTitle}}` still renders
   and still loses the only useful detail. Confirm the course title, academy name and dates actually
   appear in the Arabic body.
8. **In-app rows are translated too.** Open `/ar/my/notifications` (learner) or switch the dashboard
   language and open `/dashboard/notifications`. A raw key like
   `notifications:events.enrollmentGranted.title` on screen means a missing translation in
   `atlas-front/src/localization/resources/{en,ar}/notifications.json`. This has regressed twice
   before, so check it explicitly.

---

## G. Desktop and mobile

### G.1 Email at 375 px

Open each email in a phone mail client, or at a 375 px viewport in a desktop client that supports it.

- Nothing scrolls sideways. The layout is a single-column table with inline styles for exactly this
  reason.
- The CTA button is tappable and not clipped.
- The plain-text copy of the URL under the button wraps rather than overflowing (the layout sets
  `word-break: break-all` on it).
- The academy logo is capped at 40 px high and does not push the header off-screen.
- **Check the plain-text part as well as the HTML.** Every template renders both; some clients show
  only text. The text version must still contain the URL, because there is no button to click.

### G.2 Application pages at 375 px

Check each destination the emails actually link to, in both locales:

| Surface | Path |
|---|---|
| Learner notifications | academy host `/my/notifications` and `/ar/my/notifications` |
| Learner profile (preferences panel) | academy host `/my/profile` |
| Learner courses / activity | `/my/courses`, `/my/courses/:id/activities/:id` |
| Purchases, certificates, devices | `/my/purchases`, `/my/certificates`, `/my/devices` |
| Management notifications | `/dashboard/notifications` |
| Management profile | `/dashboard/profile` |
| Subscription / billing / retention | `/dashboard/tenant/subscription`, `/dashboard/tenant/billing`, `/dashboard/tenant/retention` |
| Communications console | `/dashboard/analytics/communications` |

For each: no horizontal scroll; the communication-preferences matrix remains usable (the toggles and
the digest/language selects are reachable, not clipped); the console's counter tiles stack rather
than overflow; the retention timeline still prints its status **in words** beside the icon, so it
reads without colour.

Also check the two notification entry points, which differ by surface: the management bell is a
popover previewing five items in `DashboardLayout`; the learner bell is a plain **link** to
`/my/notifications`, not a popover.

---

## H. Negative and security tests

### H.1 A suppressed address is never mailed

**Setup.** Add a suppression. The honest way is to let a real bounce do it (send to a known-invalid
mailbox on a domain you control and let Brevo's webhook report `hard_bounce`). Otherwise insert one
directly — the table stores a **SHA-256 hex digest of the canonicalised (trimmed, lower-cased)
address**, never the address:

```sql
INSERT INTO communication_suppressions
  (id, email_hash, email_domain, reason, source, created_at)
VALUES (gen_random_uuid()::text,
        '<sha256 hex of lower(trim(address))>',
        -- printf '%s' 'target@example.test' | shasum -a 256   (no trailing newline!)
        'example.test', 'manual', 'console', now());
```

Compute the digest outside the database unless the `pgcrypto` extension is installed; the
application computes it in Node (`hashEmail` in `src/communications/services/suppression.service.ts`),
not in SQL.

**Test.** Trigger any email to that address — a password reset is the strongest case, because it is
category `security` and bypasses every preference.

**Expected.** No email. The outbox row settles `state = 'suppressed'` with
`last_error = 'address_suppressed'`, and the **in-app notification still appears** if the key has one.
A `security` email going out to a suppressed address is a defect.

**Then lift it** via `DELETE /api/v1/platform-communications/suppressions/<address>` and confirm the
next send succeeds. Note that canonicalisation means `"User@X.com "` matches `user@x.com`.

Reasons and their default lifetimes (`SuppressionService`): `hard_bounce`, `complaint`, `invalid`,
`manual` → permanent (`expires_at IS NULL`); `soft_bounce` → **30 days**. A soft bounce alone does
**not** suppress; it marks the delivery `deferred`.

### H.2 An expired or reused token is refused

- **Reused password-reset token.** Complete a reset, then submit the same token again to
  `POST /api/v1/auth/password-reset/confirm`. It must be refused. Requesting a *second* reset must
  invalidate the first link.
- **Reused verification token.** Same shape: only the most recent token works. Requesting
  verification twice must not leave two live tokens.
- **Expired token.** Wait past the TTL (`identity.emailVerificationTokenTtlMinutes`) or expire the
  row directly, then use the link.
- **OTP code** (only when the flag is enabled): single-use under concurrency —
  `UPDATE … WHERE consumed_at IS NULL` means only one of two simultaneous correct submissions wins.
  Past `AUTH_EMAIL_OTP_MAX_ATTEMPTS` (5) the challenge is destroyed, not merely refused.
- In every case the refusal must be a clean 4xx with the error envelope
  `{ "error": { "kind": …, "messageKey": …, "status": …, "requestId": …, "retryable": false } }`,
  never a 5xx and never a stack trace.

### H.3 A wrong-tenant user gets nothing from the console

Sign in as each of these and call
`GET /api/v1/platform-communications/health`:

| Caller | Expected |
|---|---|
| Client Owner of organisation A | **403** (`PlatformOwnerGuard`) |
| Manager | **403** |
| Instructor | **403** |
| Learner | **403** — from `ManagementSurfaceGuard`, which runs first |
| Platform Owner | **200** |

Repeat for `GET /platform-communications/suppressions` and
`DELETE /platform-communications/suppressions/:email`.

Then prove the second gate: the service runs its reads under the **caller's own** user context, so
RLS refuses independently of the guard.
`communication_suppressions` allows SELECT/UPDATE/DELETE only to a platform owner
(`communication_suppressions_platform_all`); INSERT is open (`_system_insert`).

Also check tenant isolation on the retention read, which is owner-only and stricter:
`GET /api/v1/organizations/:id/retention` must refuse a **Manager of the same organisation** and a
member of a **different** organisation.

**Configuration caveat that can make a learner test pass for the wrong reason:**
`SURFACE_ENFORCE_MODE` (`off | allowlist | on`, default `on`) decides whether
`ManagementSurfaceGuard` actually refuses a learner or merely logs a bypass. With `off`, a learner is
**not** 403'd by that guard — RLS still applies, but your expected status changes. Check the
environment before recording a failure.

### H.4 An unauthenticated caller is refused

```
GET /api/v1/platform-communications/health          → 401
GET /api/v1/users/me/communication-preferences      → 401
GET /api/v1/notifications                           → 401
GET /api/v1/platform-communications/nonexistent     → 404   (the control)
```

The 401-versus-404 pair is the control that proves the route exists and is guarded rather than simply
absent. `JwtAuthGuard` collapses missing header, wrong scheme, empty token, bad signature, expired
token and revoked session into the same undifferentiated **401** — deliberately.

### H.5 The webhook fails closed without its secret

Brevo carries **no signature**; authentication is a shared secret in the URL.

```
POST /api/v1/webhooks/email/brevo                       → 401   (no secret)
POST /api/v1/webhooks/email/brevo?secret=wrong          → 401
POST /api/v1/webhooks/email/brevo?secret=<correct>      → 202 {"received":true,"events":N}
POST /api/v1/webhooks/email/resend                      → 404   (not in the chain, so not registered)
```

Things to confirm:
- **Nothing is written before verification succeeds.** A 401 must leave no delivery row and no
  suppression row.
- **An unset `BREVO_WEBHOOK_SECRET` refuses everything** — `verifyWebhook` returns `false`
  immediately. Fail closed is the required behaviour.
- **The comparison is constant-time over hashes**, so a wrong secret of a different length behaves
  identically to one of the same length.
- **The raw body is required.** Verification runs against `request.rawBody`, captured only for
  `/api/v1/webhooks/email` and `/api/v1/webhooks/video` in `main.ts`. A missing raw body fails closed
  with 401.
- **Nothing sensitive is logged** — no secret, no signature, no address, no payload. Check the logs
  after a failed attempt; a signature failure should appear only as
  `atlas_comm_webhook_signature_failures_total{provider="brevo"}` and a bare warning naming the
  provider.
- **Replays are absorbed.** Idempotency is `(providerMessageId, event)` behind a Redis marker
  `comm:webhook:seen:<sha256>` with a 7-day TTL; the status write is a plain set, so a replay past
  the TTL is harmless too. Send the same event twice and confirm the delivery row does not
  double-count.

### H.6 Other things a reviewer should try

- **The console never leaks an address.** `GET /platform-communications/suppressions` returns
  `emailHash`, `reason`, `source`, `note`, `createdAt` — and `health` returns only counts per reason.
- **Preferences cannot unlock a locked category.** `PATCH /users/me/communication-preferences` with
  `{"security":{"email":false}}` must be **400**, not a silent no-op — the DTO uses
  `forbidNonWhitelisted`. The same for `transactional`, and for the locked half of `lifecycle`.
- **A learner cannot persist operational settings.** `operational` exists only for staff; a
  learner's PATCH of it is accepted by the DTO and deliberately not persisted.
- **No caller can supply a recipient address.** `emit` resolves recipients by user id only. There is
  no API surface that lets a caller name an arbitrary address to mail.
- **Template escaping.** Put HTML in a course title, an academy name or a support case subject and
  confirm it appears as literal text in the email.

---

## I. Diagnosis

Work top to bottom. Each row says exactly where to look.

**Your four instruments:**

1. **The console** — `GET /api/v1/platform-communications/health` (or Analysis › Communications).
2. **`communication_outbox`** — `state`, `last_error`, `attempts`, `available_at`, `dispatched_at`,
   `dedupe_key`, `locale`, `branding`, `channels`, `values`.
3. **`communication_deliveries`** — `status`, `provider`, `provider_message_id`, `error_code`,
   `attempts`, `template_version`, `sent_at`.
4. **Brevo's own event log** and its suppression list, in the Brevo dashboard.

A useful starting query (superuser connection):

```sql
SELECT id, key, state, last_error, attempts, locale, branding,
       created_at, available_at, dispatched_at
FROM communication_outbox
WHERE recipient_user_id = '<user id>'
ORDER BY created_at DESC
LIMIT 20;

SELECT d.status, d.provider, d.provider_message_id, d.error_code, d.attempts,
       d.template_version, d.sent_at
FROM communication_deliveries d
WHERE d.outbox_id = '<outbox id>'
ORDER BY d.created_at DESC;
```

### I.1 The decision table

| Diagnosis | How you know | Where to look |
|---|---|---|
| **The event was never emitted** | **No `communication_outbox` row at all** for that recipient and key | Query the outbox by `recipient_user_id` and `key`. If empty: was the business transaction committed? Is the key behind a flag that is off (`lifecycle.*`, `retention.*`, `auth.email.otp`)? Does the key declare `inApp: 'always'` and a duplicate in-app row already existed — `emit` returns `{created:false, outboxId:null}` and opens no delivery intent |
| **Emitted but deduped** | No new row, and an **older** row exists with the same `dedupe_key` | `SELECT dedupe_key` — a repeat of the same event by design. Lifecycle keys embed an anchor: same anchor = same key = silent |
| **The outbox row exists but was not dispatched** | `state = 'pending'` with `available_at` in the past, and `attempts` not increasing | Console: `outbox.oldestPendingSeconds` climbing and `outbox.overdue > 0`. This is a **stalled dispatcher**: the Redis/BullMQ `communications` worker is not draining. The sweep runs every 60 s; a claimed row holds a **10-minute lease**. Check that exactly one processor is registered on the `communications` queue — two workers on that queue silently drop half the jobs |
| **Deliberately not sent: preference off** | `state = 'dispatched'`, `last_error = 'preference_off'`, delivery row `status = 'suppressed'`, in-app row present | `GET /users/me/communication-preferences` as that recipient. Only `engagement`, `operational` and the `lifecycle.reminders` follow-ups can be switched off |
| **Deliberately not sent: daily cap** | `state = 'dispatched'`, `last_error = 'daily_cap'`, delivery `suppressed` | Learner cap 5/day, staff 10/day, outside `security`/`transactional`. Normally the row is digested instead; it only settles like this when the learner set digest to `off` |
| **Batched into a digest** | `state = 'deferred'` with a non-null `digest_id` | `communication_digests` — `state`, `window_start`, `window_end`, `item_count`. Windows close at local hour **08:00** in the academy timezone; the digest job runs hourly. `review.submitted` and `roster.student.awaiting_approval` are always digested |
| **Waiting on a cooldown** | `state = 'deferred'`, `digest_id IS NULL`, `available_at` in the future | The catalogue's `cooldownSeconds` for that key; Redis `comm:cooldown:<userId>:<key>`. The sweep brings it back when the window elapses. **Every catalogue entry currently declares `cooldownSeconds: 0`, so this state cannot arise today** — if you see it, a key gained a cooldown |
| **The address is suppressed** | `state = 'suppressed'`, `last_error = 'address_suppressed'` | `communication_suppressions` by `email_hash = sha256(lower(trim(address)))`; console `suppressions.byReason`; Brevo's own suppression list. Check `expires_at` — a soft bounce lapses after 30 days |
| **The recipient is gone or anonymised** | `state = 'suppressed'`, `last_error = 'recipient_unavailable'` or `'no_recipient'` | The account was deleted or anonymised (its address was rewritten to `@account.invalid`) |
| **The catalogue key is unknown** | `state = 'failed'`, `last_error = 'unknown_key:<key>'` | A deploy skew: a row written by a newer build being dispatched by an older one |
| **The provider rejected it** | A `communication_deliveries` row with `status = 'failed'` and a populated `error_code`; outbox `state='pending'` (will retry) or `'failed'` (retries exhausted) | `error_code` carries the provider's message (first 200 chars). Console: `deliveries.byStatus.failed` and `outbox.failed`. Retry policy: **6 attempts**, exponential from 30 s. A **permanent** (4xx) error stops the chain immediately — no other provider will take a malformed request; a **transient** (429/5xx/network) error moves to the next provider, of which there is currently none |
| **Quota exhausted** | No delivery row for that attempt; the log says `Email provider skipped: quota line exhausted.` | Console `providers[0].dailyUsed` vs `dailyLimit` (300). Remember the class lines: engagement/operational stop at 70 %, lifecycle at 85 % |
| **Accepted by Brevo but bounced** | Delivery `status = 'bounced'` (or `'complained'` / `'deferred'` for a soft bounce) | The webhook did its job. Cross-check the message in Brevo's event log by `provider_message_id`. A hard bounce or complaint also writes a permanent suppression |
| **Accepted but never reported** | Delivery stuck at `status = 'sent'` long after `sent_at` | The webhook is not arriving. Test `POST /api/v1/webhooks/email/brevo?secret=…` directly (§H.5). Check the webhook is still registered at Brevo and that `atlas_comm_webhook_signature_failures_total` is not climbing |
| **Delivered but the person says they didn't get it** | Delivery `status = 'delivered'` and Brevo's log agrees | The mailbox. Spam folder, a provider-side filter, an alias. Brevo free also appends its own footer, which some filters weight. Ask for the exact address and compare it to `users.email` |
| **The template rendered wrongly** | The email arrived but the copy, a value or the layout is wrong | `communication_deliveries.template_version` tells you which template version was used. `communication_outbox.values` is the exact interpolation payload — a missing `{{courseTitle}}` is usually an absent key in `values`, not a template bug. Read the template at `src/communications/templates/keys/<key>.ts` |
| **The wrong recipient** | The right content reached the wrong person | `communication_outbox.recipient_user_id`. For staff-addressed events, `academy_notification_recipients(academyId, roles)` decides — owner/administrator/manager with an **active** membership. An instructor receiving a moderation work item is a defect; an instructor *not* receiving one is correct |
| **The wrong locale** | English when Arabic was expected, or vice versa | `communication_outbox.locale` is the emit-time snapshot; the dispatcher re-resolves. Order: recipient `preferences.language` → academy `language` (only when the entry is `locale:'academy'`) → stored. Check the recipient's preferences first — a user-level `en` overrides an Arabic academy |
| **The link goes nowhere** | The email arrived, the button 404s | Compare the **host** against the entry's `branding`. `branding:'platform'` must be `atlass.dpdns.org`; `branding:'academy'` must be the academy's canonical host. `/dashboard/*` on an academy host renders the CMS "Page not found"; `/my/*` on the management host does not exist. Arabic `/ar` prefix belongs only on the academy host |
| **A frontend bug** | The backend is demonstrably right — an outbox row `dispatched`, a delivery `delivered`, a notification row present — but the UI does not show it | Open the page with devtools. Check `GET /api/v1/notifications` and `/notifications/summary` return the row. A raw i18n key on screen (`notifications:events.*`) is a missing frontend translation in `atlas-front/src/localization/resources/{en,ar}/notifications.json`, not a backend failure. For the console specifically, check the network tab for the actual request URL (see the suppression-lift encoding note in §D.13) |

### I.2 If you are on the host

`/metrics` is reachable only from inside the host, with a platform-owner bearer token. The series
that answer most of the above:

| Series | Tells you |
|---|---|
| `atlas_comm_outbox_oldest_pending_seconds` | dispatcher stalled (alert threshold: > 900) |
| `atlas_comm_outbox_total{category,state}` | flow by state |
| `atlas_comm_email_sends_total{provider,category,result}` | `result` is `sent \| quota_skipped \| transient_error \| permanent_error` |
| `atlas_comm_email_delivery_events_total{provider,event}` | inbound webhook events applied |
| `atlas_comm_quota_used_ratio{provider,window}` | budget burn (alerts at 0.8 / 0.95) |
| `atlas_comm_dead_letter_total{category}` | retries exhausted — emails nobody got |
| `atlas_comm_retry_attempts_total{category}` | transient failures being retried |
| `atlas_comm_webhook_signature_failures_total{provider}` | someone posting to the webhook without the secret |
| `atlas_comm_dispatch_latency_seconds` | end-to-end dispatch time |

---

## J. Testing against the real provider, safely

Real delivery is the only thing that proves the system works. It is also the one part that spends a
shared, capped budget and can put a real address on a suppression list. Follow this.

### J.1 Rules

1. **Use your own inbox.** Never a customer's address, never a made-up one. A bad address produces a
   hard bounce, which writes a **permanent** suppression keyed on that address's hash.
2. **Stay inside the budget.** 300/day, shared, UTC reset. Check
   `providers[0].dailyUsed` before and after your session and record both numbers. If `dailyUsed` is
   already past ~200, postpone non-essential tests: the engagement line cuts off at 70 % (210) and
   the lifecycle line at 85 % (255).
3. **An API 200 is not delivery.** Brevo accepting a request means it has queued it. The only
   evidence of delivery is Brevo's event log showing `delivered` for that `provider_message_id`, plus
   the message in the inbox. Never write "verified delivery" on the strength of a 2xx.
4. **Never test against a real customer's tenant.** Use an academy you created for testing.
5. **Do not enable a flag to "see what happens".** `FLAG_LIFECYCLE_SEQUENCES_MODE=on` would email
   every organisation whose state currently satisfies a step, and `FLAG_VIDEO_RETENTION_MODE=warn_only`
   sends real deletion warnings to real customers. Flag changes are an owner decision; `dry_run` on a
   canary is the honest first move for lifecycle.
6. **Never paste a secret anywhere.** Refer to `BREVO_API_KEY`, `BREVO_WEBHOOK_SECRET`,
   `EMAIL_FROM_EMAIL` by name. A secret in a ticket is a rotation.
7. **Stop at the first suppression you cause.** Lift it deliberately (§H.1) before continuing, or the
   rest of your session will silently produce nothing.

### J.2 The evidence chain — record all seven for each scenario

For every scenario you claim to have verified, capture, in order:

| # | Evidence | Where it comes from |
|---|---|---|
| 1 | **Event emitted** | a `communication_outbox` row: its `id`, `key`, `dedupe_key`, `locale`, `branding`, `created_at` |
| 2 | **Outbox dispatched** | the same row reaching `state = 'dispatched'` with a `dispatched_at`, and `last_error IS NULL` |
| 3 | **Dispatch result** | a `communication_deliveries` row: `channel='email'`, `status`, `attempts`, `template_version` |
| 4 | **Provider message id** | `communication_deliveries.provider_message_id` — for Brevo this looks like `…@smtp-relay.mailin.fr` |
| 5 | **Provider evidence** | Brevo's event log for that message id: `requests` then `delivered`, with timestamps. Open/click tracking is deliberately **not** subscribed for transactional mail, so do not expect `opened` |
| 6 | **The actual inbox** | a screenshot of the received message: subject line, brand, CTA, footer, and — for Arabic — the RTL rendering |
| 7 | **The frontend result** | clicking the CTA lands on the intended page on the intended host, signed in or signed out as appropriate; and the matching in-app notification appears in `/my/notifications` or `/dashboard/notifications` |

Any scenario missing steps 5 and 6 is "accepted by the provider", **not** "delivered". Say so.

### J.3 A safe first session (about 8 emails)

1. As Platform Owner, record `providers[0].dailyUsed` and `outbox.oldestPendingSeconds`.
2. Register a new account with your own address on a test academy → **verification email** (1).
3. Request a password reset → **reset email** (2); complete it → **reset confirmed** (3).
4. Change the password while signed in → **password changed** (4).
5. Grant yourself an enrollment from staff → **enrollment granted** (5).
6. Set your `preferences.language` to `ar`, grant a second enrollment → **Arabic enrollment** (6).
7. Grade something → **assessment graded** (7). Then turn engagement email off and grade again →
   **no email**, in-app only, outbox `last_error='preference_off'` (0 emails, 1 proof).
8. Issue a certificate → **certificate issued** (8), and verify its code at `/verify/:code`.
9. Post a Brevo webhook with the wrong secret (401) and with the right one (202).
10. Re-record `dailyUsed` and confirm the delta matches the number of emails you actually caused.

---

## Appendix — what cannot be verified today, and why

| Thing | Status | Reason |
|---|---|---|
| **Email OTP at sign-in** | untestable in production | `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `_ACADEMY` default `off`; with `off` nothing is written and nothing is sent |
| **All 17 tenant lifecycle steps** | untestable in production | `FLAG_LIFECYCLE_SEQUENCES_MODE` defaults `off`; the service returns before evaluating |
| **Video retention warnings W1–W4** | untestable in production | `FLAG_VIDEO_RETENTION_MODE` defaults `off` |
| **Real video deletion** (`retention.video.deleted`, `.deletion_failed`) | untestable anywhere | needs video infrastructure that is not configured (BL-2). Only ever exercised against a fake provider. Also, guard (2) means a platform that has only run `warn_only` cannot delete for at least 30 days after the first W1 |
| **Resend as a provider** | untestable | no DNS-verified sending domain (BL-3). Resend has no single-sender path. Adding `resend` to `EMAIL_PROVIDERS` without credentials makes the API refuse to boot |
| **`/metrics` and `/health` from outside** | not reachable | outside the `api` prefix; Caddy proxies only `/api/*`. Use the console instead, or run on the host |
| **Announcement emails** | not shipped | in-app only. §21's "size the audience before enqueue" has no mechanism, and 300/day cannot serve an academy-wide blast. The template exists for when it can |
| **Platform-wide announcement fan-out** | not shipped | the audience is every account; needs the same design decision as a platform-wide digest |
| **Invite-recipient emails** | not shipped | `communication_outbox.recipient_invite_id` exists, but `emit` resolves recipients by user id only |
| **`course.order.expired` for historical orders** | will not fire | BL-4 residue: those rows never transitioned. Nothing should backfill the event — telling people their months-old order just expired would be worse than the residue |
| **Certificate email linking to the public verification sheet** | not implemented | the layout supports one CTA; recorded rather than bodged. The code is printed as text for a third party to type |
| **A tenant seeing a retention hold opened by someone else** | not visible | `support_cases` has no tenant-scoped SELECT policy. The page can only over-warn, never under-warn |
| **Digest delivery for staff at scale** | partially shipped | two entries use `email: 'digest'` (`review.submitted`, `roster.student.awaiting_approval`). Other staff/platform digests were escalated rather than improvised |
