# Authentication Comprehensive Audit

Atlas — backend `atlas-backend`, frontend `atlas`. Audit date: 28 September 2026. Branch `claude/nifty-ride-h9nxql`, released through `main`.

## 1. Executive Summary

The whole authentication and identity system was audited, not only Google sign-in. The audit read the call graph from the HTTP routes down to the database, re-checked production configuration, and probed every public auth endpoint with hostile input.

The system was already strong in the places that matter most:
- **Credentials:** Argon2id hashing, generic credential errors with a dummy-hash timing equaliser, and atomic refresh rotation.
- **Revocation:** an access-token denylist makes revocation immediate.
- **Second factors and devices:**
  - emailed codes are HMAC-hashed and bound to host and challenge;
  - TOTP has replay protection;
  - remembered devices are scoped per academy.
- **Surface and tenancy:** surface separation (an academy session is refused on every management route, enforced by a route inventory test), FORCE RLS on 97 of 110 tables (the seven identity tables included, AUTH-13), and dozens of tenant-isolation suites.
- **Google:** PKCE, state, nonce, a binder cookie and a one-time handoff.

**Eighteen issues were found and fixed** (AUTH-01 to AUTH-18), with regression tests. Eleven came from the audit's own findings. Five came from the owner's decisions on the items the first pass could not change alone (account deletion, identity-table RLS, registration enumeration, CSP, and oversized uploads). Two more were caught while regression-testing those:

| Severity | Count | IDs |
|---|---|---|
| High / critical | 0 | — |
| Medium | 8 | AUTH-01, 03, 04, 06, 07, 09, 12, 15 |
| Low | 9 | AUTH-02, 05, 08, 11, 13, 14, 16, 17, 18 |
| Informational | 1 | AUTH-10 |

**What the decisions changed:**
- **Account deletion (D1):** now needs a purpose-bound code emailed to the verified address.
- **Identity tables (D2):** all seven carry FORCE RLS. Pre-authentication entry is confined to narrow, id-only resolvers.
- **Registration (D3):** no longer reveals whether an email has an account.
- **CSP (D4):** a Content-Security-Policy runs in Report-Only mode with a report pipeline. A browser assessment of 25 page loads found zero violations. Enforcement and the token-storage migration are planned and evidence-gated.
- **Oversized uploads (D5):** oversized or malformed uploads answer 413/400 everywhere instead of 500.

**Final status: AUTHENTICATION — PRODUCTION READY.** The production-readiness pass (section 19) resolved the three known limitations: enforced CSP, HttpOnly cookie sessions, and credential isolation. It fixed four further findings and verified all of it in production. See section 18.

## 2. Audit Scope

Inspected, by reading the code and tracing calls, not by filename.

**Backend `src/identity`:**
- **Controllers:**
  - `auth` (register, academy-join, sign-in, refresh, sign-out, sessions, verify-email, password reset);
  - `email-otp`, `two-factor`, `trusted-devices`, `users` (me, profile, password, deletion);
  - `google` (authorize, callback, complete, link, create-account, activate, sign-in methods, options).
- **Services:**
  - `auth`, `email-otp`, `two-factor`, `trusted-device`, `session-revocation`, `session-surface`, `session-activity`;
  - `access-token`, `account-setup`, `account-deletion`, `academy-surface`, `password-hasher`, `auth-rate-limiter`, `users`, `email-risk`;
  - `google-auth`, `google-oidc.client`.
- **Guards:** `jwt-auth`, `optional-jwt-auth`, `management-session`, `platform-owner`, and the sign-in, register and password-reset rate limits. DTOs, repositories and utils (opaque tokens, request metadata, email).

**Backend, elsewhere:**
- **Tenancy:** `management-surface`, `organization-membership` and `saas-level-caller` guards; `principal-resolver`, `access-policy`, `surface-enforcement`, `tenancy-context`, `student-device`.
- **Learning:** `academy-students` (blocking revokes academy sessions).
- **Communications:** OTP, security notifications, webhook, suppression.
- **Common:** `all-exceptions.filter`, `pino-options.factory`, `sensitive-query.util`, `cookies.util`.
- **App setup (`main.ts`):** trust proxy, CORS, helmet, validation pipe, body limits.
- **Schema and database:** Prisma schema and migrations; an RLS coverage query against a migrated database (`pg_class.relrowsecurity/relforcerowsecurity`).
- **Deployment:** `deploy.yml`, `vps-deploy`, `docker-compose.prod.yml`, Caddy (both repos).

**Frontend `src/features/auth`:**
- **Pages:** sign-in, registration, reset, verify-email, Google return.
- **Components:** challenge forms and `RegistrationForm`.
- **Google pieces:** button, option, step panel, return flow, flow storage.
- **Utilities:** `academy-surface.utils` (`isSafeReturnPath`).

**Frontend, elsewhere:**
- `public-website` sign-in, sign-up and guest route;
- `services/identity` (token, session, authentication) and `services/api/http-client` (refresh single-flight);
- route definitions, the profile security section, and localisation (EN/AR).

**Earlier audits cross-checked:** `docs/ATLAS_CLOUD_SESSION_BASELINE.md` (S1–S10), `docs/ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (O1, O2), `docs/ATLAS_GLOBAL_IDENTITY_PLAN_v3.md`, and `docs/GOOGLE_AUTH_PRODUCTION_CLOSEOUT.md`.

## 3. Authentication Architecture

**One global identity.** `users` holds one row per person, and the email is unique. An academy membership (`academy_students` / `academy_members`) and an organization membership are separate facts about that person.

**First factors.**
- **Password:** Argon2id, m=19 MiB, t=2, p=1.
- **Google (OIDC):**
  - authorization code with PKCE S256, state and nonce;
  - a server-side flow row, plus a host-only HttpOnly binder cookie;
  - one central callback on the platform host, returning to the start origin with a one-time handoff in the fragment;
  - identities keyed by Google `sub` (unique), and one Google account per user (unique).

Both first factors end in **one pipeline**, `AuthService.continueSignIn`:
1. account status (deleted/invited refused as invalid credentials; suspended 403);
2. surface resolution (`resolveSurface`: management refuses learners; academy is bound to the host's academy and its registration policy);
3. TOTP if confirmed;
4. otherwise the emailed code (`FLAG_AUTH_EMAIL_OTP_MODE_*`), skipped only by a remembered device of that user, surface and academy;
5. `issueSession`, the only place a session is minted.

**Sessions.**
- **Access token:** a 15-minute HS256 JWT with claims `sub` and `sid` only.
- **Refresh token:** 256-bit opaque, stored as SHA-256, and rotated atomically in one conditional update. The session family (`session_id`) carries the surface, academy, device and `auth_method`.
- **Revocation:** revoking a session denylists its `sid` in Redis for the access-token lifetime, with a database fallback. The JWT guard checks the denylist and resolves the session's surface from its own record, never from the token or request.

**Surface separation.** Management routes carry `ManagementSurfaceGuard`, `PlatformOwnerGuard` or `ManagementSessionGuard`. Every authenticated route must be classified in `route-surface-inventory.spec.ts`. Academy routes assert that the session serves the host's academy.

**Tenancy.** Guards decide first; RLS (FORCE, on the runtime role `atlas_app`) decides independently on 97 of 110 tables, now including the identity tables (AUTH-13).

**Recovery and invitation.**
- **Password reset:** a 256-bit token, hashed and single-use, 30 minutes for a reset or 72 hours for a staff-created account's setup link. The same token type activates an `invited` account.
- **On reset or change:** every session and every remembered device is revoked, and the owner is notified.
- **Academy invitation codes:** redeemed atomically by `claim_academy_invite` against the academy and the account's email.

**Rate limits.** Redis fixed windows:
- sign-in (per IP and per email), also used for the email-code and TOTP verification routes and for academy join;
- register (per IP);
- reset request and validate (per IP and email);
- Google start;
- email-code resend;
- **new:** credential checks (section 9).

## 4. Surfaces Audited

- **Atlas marketing / platform** (`atlass.dpdns.org/auth/sign-in`, `/auth/register`, the alias `/auth/sign-up`, and pricing to `?plan=`):
  - this is the management surface;
  - organization and plan signup creates the organization, owner membership and trial in one transaction;
  - onboarding is pending after signup.
- **Management:** the same host and session type as the platform. Platform owners and organization staff are refused nothing extra and granted nothing extra by the first factor.
- **Academy websites:** subdomains `<slug>.atlass.dpdns.org` and custom domains (`domain_connections`). Sign-in and sign-up under open, invite and approval registration policies, and the smart-join path for existing accounts.
- **Custom domains:** the host resolves to the academy. Google's callback is central; binder and handoff return to the origin. The TOTP and email-code challenges are now both host-bound.
- **Learners:** refused on management, and admitted per policy on the academy.
- **Staff:** an academy session is limited to that academy; management sessions come only from the platform.

## 5. Authentication Methods Audited

- **Password.**
- **Google OIDC** (sign-in, sign-up, link, setup activation, invited activation, settings connect/disconnect).
- **Emailed one-time code** (A6).
- **TOTP** (enrolment, verification, recovery codes, disable).
- **Remembered device.**
- **Refresh token.**
- **Password-reset / setup link.**
- **Email-verification link.**
- **Academy invitation code.**
- **Smart member invitation** (staff-created account set up through the setup link or Google).

## 6. Security Areas Audited

- **Credentials:** credential storage and policy.
- **Enumeration and timing:** enumeration (status, body, timing, redirect, email) and response timing.
- **Sessions:** issuance, rotation, reuse, revocation, logout, expiry, and surface and academy binding.
- **Second factors and devices:** TOTP, the email code, and remembered devices.
- **Tenancy:** guards, RLS coverage, ID-based access (sessions, trusted devices, sign-in methods, invitations, OAuth flows).
- **OAuth/OIDC:** issuer, audience, azp, signature, expiry and nonce, plus state, PKCE, redirect URI, origin, handoff, replay and retention.
- **Recovery:** password reset and change.
- **Invitations and account activation.**
- **Account status:** suspension and deletion.
- **Input validation:** length, Unicode/Arabic, control characters, NUL, injection, prototype pollution.
- **Web attacks:** CSRF/XSS/open redirect.
- **Abuse:** rate limiting and the IP trust model.
- **Data integrity:** database constraints, transactions, races.
- **Logging and observability:** redaction, audit events, metrics and alerts.
- **Frontend:** error handling, loading and double-submit, EN/AR/RTL, mobile.
- **Production configuration:** cookies, CORS, headers, flags and secrets.

## 7. Tests Executed

All commands ran locally against real PostgreSQL 16 and Redis (plus an S3 emulator for media), with the application connecting as the restricted runtime role `atlas_app`, so RLS was in force.

| Command | Scope | Passed | Failed | Notes |
|---|---|---|---|---|
| `npx jest` (backend unit) | 140 suites | 3950 | 0 | |
| `npx jest --config ./test/jest-e2e.json` (full backend e2e) | 162 suites, 1976 tests | 158 suites, 1962 tests | 4 suites, 14 tests | shared-database pollution only; see §7a |
| the 4 failing suites on a **freshly migrated database** | 4 suites | 79 | 0 | proves §7a |
| `test/identity-rls.e2e-spec.ts` | IDRLS-01..07 | 7 | 0 | attacks the policies directly as `atlas_app` |
| `test/csp-reports.e2e-spec.ts` | CSP-01..04 | 4 | 0 | |
| `test/account-deletion-otp.e2e-spec.ts` | DELOTP-01..11 | 11 | 0 | |
| `test/registration-enumeration.e2e-spec.ts` | ENUM-01..06 | 6 | 0 | |
| `test/auth-audit-hardening.e2e-spec.ts` | AUD-01..08 | 9 | 0 | on the pre-fix source: **9 failed** |
| `pnpm exec vitest run` (frontend) | 129 files | 1170 | 0 | includes `auth-audit.test.tsx`, `delete-account-card.test.tsx`, `sign-in-registered-notice.test.tsx` |
| lint (`pnpm run lint`; backend eslint on changed files) | | clean | 0 errors | 3 pre-existing `no-console` warnings in ops scripts |
| typecheck (`tsc --noEmit` backend) | | clean | — | |
| typecheck (frontend) | | — | 34 | **pre-existing**, identical count before and after; none in touched files |
| `npm run build` / `pnpm build` | | ✓ | — | |
| `caddy adapt` (Caddy 2.10.2) on the production Caddyfile | | ✓ | — | both CSP headers emitted |
| migration on an empty database; precondition guard against a non-bypass role | | ✓ | — | the guard aborts as designed |
| CSP browser assessment (Chromium) | 25 page loads | 0 violations | — | §7b |

### 7a. Full backend e2e

Full run: **158 of 162 suites passed.** The 4 that failed all pass on a freshly migrated database (79 of 79 tests), so they are leftover-data effects in the long-lived shared test database, not defects:
- **`platform-add-ons-management` and `platform-add-ons-http`:** the database held 124 add-ons from earlier runs, and the test reads one page of 100.
- **`p63-domain-operations`:** canonical-host expectations against a platform base domain left behind by earlier runs. This was already recorded as pre-existing.
- **`p64-comm-lifecycle-sequences`:** a 60-second fake-clock test timed out under full-run load.

Earlier failures, now fixed and passing:
- `media` and `p53-support-attachments`: the data-URL stack overflow (AUTH-16).
- The RLS suites' own `createUser` fixtures, which seeded users (including platform owners) through the RLS-bound application client. They now seed through the owner connection like every other fixture (`fixtureUsers()`); what they test is unchanged.
- Specs that verified identity rows through the application client (the same change).

### 7b. CSP browser assessment

The production frontend build was served by Caddy 2.10.2 with the production snippets, with `/api` on the built backend. Chromium loaded 25 pages with a `securitypolicyviolation` listener installed before any page script:
- platform public and auth pages;
- Platform Owner dashboard pages, including charts;
- a real academy host;
- EN and AR, at desktop and mobile widths.

**Results:**
- **Zero violations**, and every page returned 200 carrying the header.
- **Positive control:** an injected inline script and an `ftp:` image were both caught.
- **Delivery:** confirmed from a real browser for both `report-uri` (`application/csp-report`) and the Reporting API (`application/reports+json`, over HTTPS).
- **Redaction:** confirmed.

Details and what was not exercised: `docs/CSP_AND_TOKEN_STORAGE.md` §1.5.

## 8. Issues Found

Severity follows impact as deployed, not worst-case theory.

### AUTH-01 — TOTP challenge not bound to the sign-in it completes

- **Severity:** MEDIUM
- **Component:** `TwoFactorService.createChallenge/completeChallenge`, `AuthService.completeTwoFactorSignIn`, `POST /auth/2fa/verify`.
- **Description:** the TOTP challenge stored only the user id and first factor. The surface and academy of the session came from the **verify request body**, and any host could complete it. The emailed-code challenge already recorded both and was host-bound; TOTP was the odd one out.
- **Root cause:** Phase 10.3 predates surfaces. When surfaces arrived, the 2FA path re-ran `resolveSurface` on the body instead of recording the resolved selection.
- **Security impact:** the account's own factors are still required, so this is not a takeover. But a first factor checked for one surface could be spent on another. Example: a Google sign-in started on an allowlisted academy could be finished as a **management** session, or on an academy where Google is not enabled. That bypasses the per-surface Google gating and the host binding the rest of the pipeline enforces.
- **User impact:** none.
- **Fix:**
  - the challenge records `userId|authMethod|surface|academyId`;
  - completion must happen on a host whose expected context matches (the email-code rule), and a mismatch is answered like a wrong code;
  - the session uses the challenge's selection, and the body is read only for challenges minted before the deploy (TTL 5 minutes).
- **Files:** `src/identity/services/two-factor.service.ts`, `src/identity/services/auth.service.ts`.
- **Tests:** AUD-01 (a challenge from academy A is refused on the platform host and on academy B; on A's host it yields A's session even when the body says management).
- **Verification:** passes; fails on the pre-fix code.

### AUTH-02 — Password-reset link confirmation not atomic

- **Severity:** LOW
- **Component:** `AuthService.confirmPasswordReset`, `PasswordResetTokensRepository`.
- **Description:** the link was checked, then the password written, then the link marked used, with no conditional write. Two concurrent confirmations of one link both succeeded. This was previously recorded as S9.
- **Root cause:** a check-then-use sequence with no conditional consume.
- **Security impact:** a link counted as "single-use" could be used twice within a race window.
- **User impact:** none.
- **Fix:** a cheap validity read (so an unknown token never costs a hash), then hash, then `claimValidByHash`, a single conditional `UPDATE … WHERE used_at IS NULL AND expires_at > now()` whose loser matches zero rows. A deleted account's link is refused.
- **Files:** `password-reset-tokens.repository.ts`, `auth.service.ts`.
- **Tests:** AUD-02 (two concurrent confirmations return one 200 and one 401; only the winner's password works).
- **Verification:** passes; fails before.

### AUTH-03 — Outstanding reset/setup links survived a reset or password change

- **Severity:** MEDIUM
- **Component:** `confirmPasswordReset`, `UsersService.changePassword`.
- **Description:** only the link used was spent. Any other outstanding link (a second reset request, a 72-hour setup email) stayed valid after the owner reset or changed the password.
- **Root cause:** the tokens were consumed by id, not per account.
- **Security impact:** an attacker holding an older link from the same mailbox or a forwarded email could set the password again after the owner had recovered the account. Every session and remembered device would then be revoked in the owner's name.
- **User impact:** none.
- **Fix:** `spendAllForUser` after a successful reset and after a password change.
- **Files:** `password-reset-tokens.repository.ts`, `auth.service.ts`, `users.service.ts`.
- **Tests:** AUD-03.
- **Verification:** passes; fails before.

### AUTH-04 — Password re-authentication not rate limited

- **Severity:** MEDIUM
- **Component:** `POST /users/me/password`, `POST /auth/2fa/disable`, `POST /auth/2fa/recovery-codes`, `DELETE /users/me/sign-in-methods/google`, `POST /auth/password-reset/confirm`.
- **Description:** each of these verifies the current password, or a reset link plus an Argon2 hash, with no rate limit. Sign-in, register and reset request were limited.
- **Root cause:** limits were applied route by route, and these routes were added later.
- **Security impact:** a stolen access token (15 minutes, or longer through a stolen refresh token) became an unthrottled online oracle for the account's password. With a correct guess it could disable 2FA or change the password. Reset confirmation was unthrottled Argon2 work for anonymous callers.
- **User impact:** none within normal use (10 attempts per 15 minutes, the sign-in budget).
- **Fix:** a new `CredentialCheckRateLimitGuard`, keyed per verified account (the token's `sub`, never the body) and per IP, on all five routes.
- **Files:** `src/identity/guards/credential-check-rate-limit.guard.ts` (new), `users.controller.ts`, `two-factor.controller.ts`, `auth.controller.ts`, `google-auth.controller.ts`, `identity.module.ts`.
- **Tests:** AUD-04 (the 11th guess is 429, and the same budget covers 2FA disable and recovery codes; sign-in is unaffected) and AUD-04b (reset confirm per IP).
- **Verification:** passes; fails before.

### AUTH-05 — Unbounded auth inputs

- **Severity:** LOW
- **Component:** `RegisterDto`, `SignInDto`, `AcademyJoinDto`, `ChangePasswordDto`, `PasswordReset*Dto`, `RefreshTokenDto`, `VerifyEmailDto`, `UpdateProfileDto`, `VerifyTwoFactorDto.academyId`, and the registration form.
- **Description:** name, email, passwords, tokens and ids had no maximum. The JSON body limit is about 30 MB (three times the media upload limit), so an anonymous `/auth/register` could store a multi-megabyte `name` and make the server Argon2-hash a multi-megabyte password. Newer DTOs (email code, TOTP, Google) were already bounded.
- **Root cause:** Phase-1 DTOs predate the bounded style.
- **Security impact:** storage and CPU abuse, rate-limited but real.
- **User impact:** a name over 100 characters is now refused. The limit matches the Google create step, and the frontend now enforces it with EN/AR messages and `maxLength`.
- **Fix:**
  - `MaxLength`: name 100, email 254, passwords 1024 (far above any real password; it only bounds Argon2 input), tokens 512, ids 64, avatar URL 2048;
  - frontend name `.max(100)` with `auth:register.errors.nameTooLong`.
- **Files:** the 11 DTOs above; `atlas` `RegistrationForm.tsx`, `auth.json` (en/ar).
- **Tests:** AUD-05 (oversized values give 400 and create nothing; 100 Arabic characters are accepted) and frontend `auth-audit.test.tsx`.
- **Verification:** passes.

### AUTH-06 — Sessions outlived an account that is no longer active

- **Severity:** LOW
- **Component:** `AuthService.refresh`.
- **Description:** refresh rotated tokens without looking at the account. A session belonging to a suspended account (or any non-`active` status) kept renewing for the refresh lifetime.
- **Root cause:** status was checked only at sign-in.
- **Security impact:** low as deployed, because no product path suspends a user (it is a database operation) and deletion already revokes everything. But it was the gap that would make suspension ineffective the day it is exposed.
- **User impact:** none.
- **Fix:** after rotation, a non-active or missing account ends that session family and denylists its access token (401).
- **Files:** `auth.service.ts`.
- **Tests:** AUD-06.
- **Verification:** passes; fails before.

### AUTH-07 — No refresh-token reuse detection

- **Severity:** MEDIUM
- **Component:** `AuthService.refresh`, `RefreshTokensRepository`.
- **Description:** presenting an already-rotated refresh token was simply a 401. `ATLAS_GLOBAL_IDENTITY_PLAN_v3.md` threat 13 describes reuse revocation as existing; it was not implemented (also S9).
- **Root cause:** rotation without family-level reuse handling.
- **Security impact:** with a stolen refresh token, whichever party refreshes first wins and the other is silently logged out. The attacker keeps the session indefinitely, and the owner's later refresh reveals nothing.
- **User impact:** none. A 60-second grace separates the benign race of two tabs refreshing the same token (the frontend single-flights per tab and always reads the latest token from storage) from a copied token replayed later.
- **Fix:** `findReusedRotation`: a retired token that was rotated into a newer row more than 60 seconds ago ends the whole family (refresh rows plus the access-token denylist). It is recorded as an `auth.sessions.revoked` audit entry (`trigger: refresh_token_reuse`) with a warning log.
- **Files:** `refresh-tokens.repository.ts`, `auth.service.ts`.
- **Tests:** AUD-07 (within the grace it only fails; after the grace the family ends and the audit is written); the existing `auth-refresh-concurrency` still passes.
- **Verification:** passes; fails before.

### AUTH-08 — Platform sign-in `?redirect=` not constrained to same-site paths

- **Severity:** LOW
- **Component:** `atlas` `SignInPage.tsx`.
- **Description:** the academy sign-in used `isSafeReturnPath`; the platform sign-in passed `?redirect=` to `navigate()` unchecked.
- **Root cause:** an inconsistency between the two pages.
- **Security impact:** low. React Router's history push cannot leave the origin, but the guard was not guaranteed and `next` also flowed into the Google flow context (where it was separately re-checked).
- **User impact:** none.
- **Fix:** `isSafeReturnPath` on both uses.
- **Files:** `SignInPage.tsx`.
- **Tests:** `auth-audit.test.tsx` (`//evil`, `https://evil`, `/\evil` and `javascript:` land on `/dashboard`; `/dashboard/profile?tab=security` is followed).
- **Verification:** passes; 4 fail before.

### AUTH-09 — Brevo webhook secret written to request logs

- **Severity:** MEDIUM
- **Component:** `sensitive-query.util.ts`, via `POST /webhooks/email/:provider?secret=…`.
- **Description:** the request logger censors query parameters by name, and `secret` was not among them. Every delivery webhook wrote the shared secret into the production request log. This was previously recorded as S8, unfixed.
- **Root cause:** the name list covered OAuth parameters only.
- **Security impact:** anyone with log access could forge delivery events, for example marking addresses bounced and suppressed, or delivered.
- **User impact:** none.
- **Fix:** `secret`, `api_key`, `apikey`, `key`, `signature`, `sig` and `password` are censored in both the URL and the parsed query. `Google verify` now checks webhook lines since the backend started.
- **Files:** `sensitive-query.util.ts` (+ spec), `deploy/google-verify/remote.sh`, `verify.mjs`.
- **Tests:** unit tests for the redaction, and the production check in section 12.
- **Verification:** see section 12. Lines written before the deploy remain in the old container's log until rotation, so **rotate the Brevo webhook secret** (section 16).

### AUTH-10 — Second-factor body fields absent from the redaction list

- **Severity:** INFORMATIONAL
- **Component:** `pino-options.factory.ts`.
- **Description:** `code`, `recoveryCode`, `challengeId` and `secret` bodies, and the `encryptedSecret`/`codeHash` fields, were not on the redaction list. Request bodies are not logged by default, so nothing leaked.
- **Fix:** added as defence in depth.
- **Files:** `pino-options.factory.ts`.

### AUTH-11 — Input the database cannot represent returned 500

- **Severity:** LOW
- **Component:** `AllExceptionsFilter` (app-wide).
- **Description:** a NUL byte in any string reaching PostgreSQL (SQLSTATE 22021) was answered as an unexpected 500, logged at error level and reported to Sentry. For example `DELETE /auth/sessions/%00` and `/auth/trusted-devices/%00`. Invalid text representations (22P02) and malformed ids (Prisma P2023) behaved the same.
- **Root cause:** no mapping for client-caused database errors.
- **Security impact:** noisy 500s and Sentry quota on demand; an alerting/DoS nuisance.
- **User impact:** none.
- **Fix:** those three classes answer 400 `errors.validation.failed` with no detail; every other database error stays a 500.
- **Files:** `all-exceptions.filter.ts` (+ spec).
- **Tests:** unit (22021 and P2023 give 400; connection loss stays 500) and AUD-08 (a sweep of 8 hostile values across 13 public endpoints plus the id routes: no 5xx).
- **Verification:** passes; fails before (two 500s).

### AUTH-12 — Account deletion had no confirmation beyond the session (Decision 1)

- **Severity:** MEDIUM
- **Component:** `POST /users/me/delete`, `AccountDeletionChallengeService` (new), `DeleteAccountCard` (frontend).
- **Description:** a valid management session alone could delete the account and archive every academy it owned.
- **Decision:** confirm by a code emailed to the account's verified address (option D).
- **Fix:**
  - `POST /users/me/delete/request` issues a purpose-bound challenge (`account_deletion_challenges`, FORCE RLS, self-scoped). It is bound to the account and to the requesting session (`sid`). The code is 6 CSPRNG digits; only HMAC(serverKey, id‖salt‖code) is stored.
  - Lifetime and limits: 10 minutes; 5 wrong attempts burn the challenge; a 60-second resend cooldown; at most 5 requests an hour. A new request retires every open challenge. Both routes sit behind the credential-check limiter.
  - Consumption is one conditional `UPDATE`, so a replay or a second concurrent confirmation fails, and deletion itself is idempotent.
  - Every failure gives the caller one uniform answer. The code is never logged or audited; the audit trail records requested, code failed, locked out and confirmed.
  - Refused before any mail is sent: an unverified address (409), a platform owner (403), an inactive account.
  - **Deletion now also:**
    - revokes trusted devices;
    - consumes open sign-in codes;
    - closes pending Google link flows;
    - removes deletion challenges.

    It still:
    - revokes every refresh-token family and denylists every `sid`;
    - deletes the TOTP secret, recovery codes, Google identity, and reset and verification tokens;
    - anonymises the account;
    - removes memberships and archives owned academies.
  - **Frontend:** a two-step dialog (email → code), with a masked address, resend with a cooldown and in-place errors, in EN/AR (RTL, digits LTR) and on mobile.
  - **Platform Owner administrative deletion** (`/platform-user-management/:id/delete`) deletes *someone else*, so it cannot be confirmed by that person's mailbox. It keeps its own guard, confirmation and audit (`DeleteAccountBaseDto`).
- **Tests:** `test/account-deletion-otp.e2e-spec.ts` DELOTP-01..11, the adapted `phase10-6`, `google-identity` and `p64-phase3` deletion tests, and `delete-account-card.test.tsx` (3).

### AUTH-13 — Identity tables had no row-level security (Decision 2)

- **Severity:** LOW (defence in depth). No exploit path exists without first reaching the database as `atlas_app`, but the tables that hold every credential relied on one gate.
- **Decision:** designed and implemented here (the owner delegated the architecture).
- **Fix:** migration `20261021000000_identity_tables_rls`:
  - **Credential tables** (`refresh_tokens`, `password_reset_tokens`, `email_verification_tokens`, `user_two_factor`, `two_factor_recovery_codes`, `user_auth_identities`):
    - ENABLE + FORCE RLS;
    - SELECT/INSERT/UPDATE/DELETE admitted only when `user_id = app.current_user_id`, with `WITH CHECK` on writes;
    - no platform-owner policy and no `USING (true)`.
  - **`users`** is the identity *directory*: rosters, reviews, certificates, audit actors and search legitimately join to other people's names.
    - SELECT requires an established user or tenant context (a context-less query sees nothing).
    - UPDATE is self-only, or the Platform Owner.
    - DELETE is Platform Owner only.
    - INSERT is only in the new id's own context, or as an `invited` account inside a tenant context (staff member-add).
    - No insert can create a platform owner. Column privileges keep `is_platform_owner`, `id` and `created_at` out of the application role's reach, so promotion is an operator action on the owner connection (`provision-platform-owner`).
  - **Pre-authentication entry** (sign-in by email, refresh, reset and verification by token hash, Google by subject, background jobs needing a platform-owner id):
    - goes through six narrow `SECURITY DEFINER` resolvers that return an **owner id and nothing else**;
    - they are `STABLE`, pin `search_path`, and are executable only by `atlas_app`;
    - all are called from one class, `IdentityResolver`;
    - every read and write that follows runs in the owner's own context.
  - **Staff:** the one staff-facing read of another account's sessions (the roster's active-session count) is a count-only definer function gated by the existing `can_view_academy_student()`.
- **Why the application role cannot bypass it:**
  - `atlas_app` is NOSUPERUSER NOBYPASSRLS and owns none of the tables;
  - FORCE applies policies to the owner too;
  - referential-integrity checks and cascades are outside RLS, so `ON DELETE CASCADE` still works.
- **Code:**
  - every access site was moved into the right context: repositories, two-factor, Google, deletion, the platform console, analytics, search, communications and scripts;
  - unique-conflict handling no longer depends on the P2002 target, which PostgreSQL hides under RLS.
- **Tests:**
  - `test/identity-rls.e2e-spec.ts` IDRLS-01..07, which attack the policies directly as `atlas_app`: role attributes; FORCE on all seven tables; no permissive policy; zero rows without context; cross-user read, update, delete, insert and re-parenting refused on every credential table; the users write rules and column privileges; the resolvers' shape and grants.
  - All auth, Google, 2FA, deletion, invitation, onboarding and RLS suites pass (section 7).

### AUTH-14 — Registration disclosed whether an email has an account (Decision 3)

- **Severity:** LOW
- **Decision:** "If an account exists, we'll help you continue."
- **Fix:**
  - Platform, organization and academy sign-up answer an existing address exactly like a new one: `201 {account:'new'}`, nothing created.
  - The existing owner receives `auth.account.signup_attempt` (EN/AR, at most once an hour, no link).
  - An academy sign-up with the existing account's *correct* password still joins it as before.
  - Rule failures (organization name, invitation code) are identical for both.
  - An unproven existing address never spends an invitation code.
  - The per-address budget meters every address alike.
  - A lost race for a new address answers the same.
  - Frontend copy on all three surfaces is generic (EN/AR).
  - Google keeps its 409, because that address was proven by Google.
- **Tests:** `registration-enumeration.e2e-spec.ts` ENUM-01..06, plus updated `auth-register`, `new-customer-onboarding`, `launch-stabilization` and `smart-member-invite`.

### AUTH-15 — No Content-Security-Policy on the SPA; tokens in `localStorage` (Decision 4)

- **Severity:** MEDIUM (impact multiplier for any XSS)
- **Decision:** staged: Report-Only first, enforce on evidence; the token-storage migration is a scoped follow-up.
- **Fix:**
  - `Content-Security-Policy-Report-Only` plus `Reporting-Endpoints` on every document, on both Caddy site blocks.
  - `POST /api/v1/security/csp-reports`: public and throttled. It normalises reports so no URL query or fragment survives, logs them, and counts them in `atlas_csp_violations_total` with closed-vocabulary labels.
  - The policy, the browser compatibility assessment, the enforcement criteria and the cookie/BFF migration plan (risk, target, phases, compatibility, rollout and rollback) are in `docs/CSP_AND_TOKEN_STORAGE.md`.
- **Tests:** `csp-report.util.spec.ts` (4) and `csp-reports.e2e-spec.ts` CSP-01..04; `caddy adapt` with Caddy 2.10.2; the browser assessment (section 7b).
- **Remaining:** enforcement (evidence-gated) and the token-storage migration (section 16).

### AUTH-16 — Oversized or malformed data URLs answered 500 (Decision 5)

- **Severity:** LOW
- **Description:** `parseDataUrl` ran a regular expression over the whole data URL. A multi-megabyte upload overflowed the stack (`RangeError`), answering 500 instead of 413 (the media and p53 failures in the first full run). Body-parser refusals were also 500.
- **Fix:**
  - a linear, regex-free parser with a 256-byte header cap;
  - the size is estimated **before** decoding (413 `errors.media.fileTooLarge`), then checked exactly;
  - malformed input is 400;
  - the size limit is passed at every caller: media, support attachments, both payment-proof paths, and protected media (whose decoder was replaced);
  - `mimeType` is bounded on the upload DTOs;
  - body-parser `entity.too.large` is 413, other `entity.*` 400.

  The remaining regular expressions in the codebase run on bounded inputs (swept).
- **Tests:** unit (a 60 MB body gives 413 in under 1 second; boundaries; malformed input); media e2e hostile bodies (31 MB gives 413, malformed JSON 400, bad data URLs 400, valid 201); `P53-ATT-013b`.

### AUTH-17 — Found during regression: Decision 1 had also gated the Platform Owner's deletion of *another* user

- **Severity:** LOW (functional regression, never released)
- **Description:** `POST /platform-user-management/:id/delete` shares the deletion DTO, which now required the self-service `challengeId`/`code`, so every administrative deletion would have been refused 400. `platform-user-deletion.e2e-spec` caught it.
- **Fix:** `DeleteAccountBaseDto` (confirmation, reason, feedback) for the administrative route; `DeleteAccountDto` extends it with the code for self-service only.

### AUTH-18 — Roster "active sessions" counted a learner's sessions everywhere (cross-organization detail)

- **Severity:** LOW
- **Description:** the academy roster's `activeSessionCount` counted every live session of the learner, including management sessions at other organizations, so staff could observe activity outside their academy.
- **Fix:** counted by `academy_student_session_count()`: this academy's academy-surface sessions only, and only for a viewer `can_view_academy_student()` admits (AUTH-13).
- **Tests:** `p64-roster-lifecycle`, IDRLS-07.

## 9. Issues Fixed

AUTH-01 to AUTH-18 (section 8). Each carries regression tests. The audit-found backend fixes (AUTH-01 to AUTH-11) were each shown to fail on the pre-fix source. The decision items (AUTH-12 to AUTH-16) are new behaviour, proven by dedicated suites. AUTH-17 and AUTH-18 were caught by the existing suites during regression and fixed before any release.

## 10. Issues Not Fixed

| ID | Severity | Item | Status |
|---|---|---|---|
| CSP-ENF | MEDIUM | ~~The CSP is Report-Only.~~ **Resolved (AUTH-21):** enforced. | By decision (D4): enforce only on production evidence. Criteria are in `docs/CSP_AND_TOKEN_STORAGE.md` §1.4. `script-src 'self'` can be enforced first. |
| TOK-1 | MEDIUM | ~~Tokens in `localStorage`.~~ **Resolved (AUTH-20):** HttpOnly cookie plus an in-memory access token. | By decision (D4): a scoped follow-up (an HttpOnly `__Host-` refresh cookie and an in-memory access token), phased and flag-gated. Plan: `docs/CSP_AND_TOKEN_STORAGE.md` §2. Mitigated meanwhile by the CSP, refresh-reuse detection (AUTH-07), surface binding and the `sid` denylist. |
| INFO-1 | INFORMATIONAL | Reset-request timing differs slightly for existing and unknown emails. | Accepted: rate-limited per IP and email, identical response. |
| INFO-2 | INFORMATIONAL | `POST /auth/verify-email` has no rate limit. | 256-bit single-use tokens; guessing is infeasible. |
| INFO-3 | INFORMATIONAL | There is no product path to suspend a user. | Out of scope. AUTH-06 makes a suspension effective on the next refresh. |
| TEST-1 | INFORMATIONAL | Four e2e suites depend on a clean database (§7a). | Test hygiene, not product. They pass on a fresh database. |

## 11. Positive Findings

These controls were verified and hold:
- **Passwords:** Argon2id (OWASP profile); a malformed hash is treated as a mismatch; an unknown email is verified against a dummy hash (timing); the credential error is generic; invited and deleted accounts answer exactly like a wrong password; suspension is revealed only after the correct password.
- **Tokens:**
  - access tokens are minimal (`sub`, `sid`), 15 minutes, verified with the configured secret;
  - refresh tokens are 256-bit, SHA-256 at rest, and rotated in one conditional update (`auth-refresh-concurrency`: exactly one of N concurrent refreshes wins);
  - the session family is immutable across rotation (surface, academy, device, `auth_method`).
- **Revocation:**
  - sign-out and session revoke hit the family plus a `sid` denylist on the very next request;
  - password reset and change revoke all sessions and all remembered devices, write an audit entry and notify the owner;
  - blocking a learner revokes that academy's sessions only;
  - deletion revokes and anonymises, and deletes identities and tokens.
- **Emailed code:**
  - CSPRNG 6 digits, stored as HMAC(secret, salt‖code);
  - attempt cap with a lockout audit, resend cooldown and caps;
  - bound to the host's surface and academy;
  - the session surface comes from the challenge;
  - success verifies the email.
- **TOTP:** encrypted secret; accepted-time-step replay protection; per-challenge attempt budget that burns the challenge; recovery codes; disable and regenerate need the password; TOTP replaces the emailed code (never stacked). **Now host-bound (AUTH-01).**
- **Remembered devices:** a hashed cookie, scoped per user, surface and academy; revoke is scoped by user (a foreign id gives not-found); revoked on reset, change and deletion.
- **Surfaces and tenancy:**
  - an academy session is refused on management routes;
  - the route inventory test fails if any authenticated route is unclassified;
  - academy routes assert the host;
  - RLS FORCE on 97/110 tables (identity tables included), plus about 40 tenant-isolation and RLS e2e suites.
- **ID-based access:** `/auth/sessions/:id`, `/auth/trusted-devices/:id` and sign-in methods have no user id in the path and are scoped by the verified user, so a foreign id gives not-found.
- **IP trust:** forwarded headers are believed only from private peers (Caddy); Caddy believes only Cloudflare ranges; per-IP limits cannot be evaded by forging headers.
- **Cookies:** device, trust and Google binder cookies are HttpOnly and SameSite=Lax, Secure over HTTPS; the binder is host-only on its own path.
- **CORS:** an explicit allowlist plus platform origins.
- **Validation:** global `whitelist` and `forbidNonWhitelisted` (prototype-pollution and extra fields refused).
- **Headers:** helmet on the API; Caddy headers on documents; HSTS.
- **Google:** PKCE S256, state, nonce, issuer/audience/azp/signature/expiry checks, binder, one-time handoff, origin check, central callback, `sub`-keyed identity, no auto-link on email, and flow retention (see `GOOGLE_AUTH_PRODUCTION_CLOSEOUT.md`).
- **Invitations:** `claim_academy_invite` is atomic and bound to academy and email; setup links reuse the hardened reset token.
- **Observability:** redaction of authorization, cookies, passwords, tokens and the OAuth code/state; audit entries for sessions revoked, devices, OTP failure and lockout, and identities linked; Prometheus auth metrics and alerts.

## 12. Production Verification

All checks ran from GitHub-hosted runners against `atlass.dpdns.org` on 28 September 2026, after the release in section 15. No production data was modified beyond each verifier's own tagged test accounts and one synthetic CSP report.

**Deploy evidence (Deploy #221, `migrate-and-deploy`):**
- a pre-migration backup, `atlas-20260928T202049Z.sql.gz`, was uploaded to S3 before anything ran;
- `20261020000000_account_deletion_challenges` and `20261021000000_identity_tables_rls` applied, and the RLS precondition guard passed;
- backend healthy, then Caddy healthy (TLS and SPA), and the last-good digests recorded for rollback.

**Google verify #11** (`expect_mode=allowlist`, `expect_platform=on`, all checks): **all checks passed.**

| Area | Result |
|---|---|
| **config** | Google configured |
| **academy** | `ellzoz` (b794e760…) assigned and published |
| **probe: Google offered** | on the platform, `ellzoz` and `hfghgf` |
| **probe: Google not offered** | on the six non-allowlisted academies |
| **probe: authorize flow** | the platform and academy authorize use the exact central redirect URI, PKCE S256, state and nonce; a foreign Origin gets 403 |
| **probe: Google side** | Google accepts the client and the redirect URI |
| **probe: callback edges** | the callback 404s on academy hosts; an unknown state is a 400 dead end; an unknown handoff gets 401 |
| **data** | no flow kept past retention; no duplicate subject; no user with two identities; no orphaned identity; no identity on a deleted account; no duplicate email |
| **logs** | every callback code line redacted (3/3); no client secret, JWT or handoff token |
| **logs: Brevo webhook secret (AUTH-09)** | `webhook_secret_raw_since_start = 0`: 23 of 25 webhook lines carry it redacted (the other 2 carry no secret) |
| **metrics** | the Google alert rules are loaded |
| **backup** | the release backup: 0 h old, gzip OK, contains `users` |
| **security** (new): identity RLS | FORCE RLS on all **7** identity tables; **0** permissive `true` policies |
| **security**: definer functions | **7** definer functions, callable by `atlas_app` only |
| **security**: the application role | `atlas_app` has no SUPERUSER or BYPASSRLS; no UPDATE on `users.is_platform_owner` |
| **security**: deletion challenges and migrations | `account_deletion_challenges` has FORCE RLS; both migrations applied |
| **security**: sessions | **18 real sessions minted since the RLS migration** (sign-in, emailed code and refresh working through the resolvers) |
| **security**: CSP | the platform and `ellzoz` documents carry `Content-Security-Policy-Report-Only` and `Reporting-Endpoints`; no enforcing CSP yet; the report endpoint answers 204 |
| **browser** | Google on Atlas's own pages, EN/AR, desktop and mobile |

**Launch verify #13** (`mailbox=zeyadelbadawi.ze`, all jobs): **passed.**
- **api:** A1–A6 and observability, including real sign-in with the emailed code, surface binding and session revocation.
- **smi:** the smart academy join and member lookup, over the API.
- **browser:** management and academy sign-in with the emailed code.
- **deliverability:** passed.
- **smi-browser:** the academy join journey, now under Decision 3:
  1. an address that already has an account signs up at academy B with another password, and gets the generic answer: no join step, academy A not named, no learner row created;
  2. it then uses "Join with it" with its own password and B's emailed code;
  3. "You're all set" names A, and it lands on `/my`.

  EN desktop and AR mobile.

**Launch verify #12**, the first run, which predates the frontend deploy: its `smi-browser` job failed, because the verifier still asserted the pre-Decision-3 automatic "You already have an Atlas account" step. That step is the account disclosure Decision 3 removed. The verifier was updated (`0d9d7a5`), and #13 passes. Its `api`, `smi`, `browser` and `deliverability` jobs had already passed against the new backend.

**Brevo webhook secret rotation** (owner-performed; verified on 28 September 2026):
1. The owner updated `BREVO_WEBHOOK_SECRET` in GitHub and the webhook URL in Brevo.
2. Deploy #222 (21:04 UTC) wrote the new value: the log shows `Env changed — force-recreating backend`.
3. Launch verify #14 then sent real transactional mail, which produced delivery events.
4. Google verify #13 (logs) found, since the new backend started:
   - **19 delivery webhooks accepted, 0 refused (401/403)**, so the new secret matches on both sides;
   - 19 of the 21 webhook lines carry the secret redacted; the other 2 are the route-registration lines at startup;
   - **0 raw secret values.**

## 13. Files Changed

**Backend (`atlas-backend`):**
- `src/identity/services/two-factor.service.ts`
- `src/identity/services/auth.service.ts`
- `src/identity/services/users.service.ts`
- `src/identity/repositories/password-reset-tokens.repository.ts`
- `src/identity/repositories/refresh-tokens.repository.ts`
- `src/identity/guards/credential-check-rate-limit.guard.ts` (new)
- `src/identity/controllers/auth.controller.ts`
- `src/identity/controllers/two-factor.controller.ts`
- `src/identity/controllers/users.controller.ts`
- `src/identity/google/google-auth.controller.ts`
- `src/identity/identity.module.ts`
- `src/identity/dto/`: `academy-join`, `change-password`, `password-reset-confirm`, `password-reset-request`, `password-reset-validate`, `refresh-token`, `register`, `sign-in`, `two-factor`, `update-profile`, `verify-email`
- `src/common/filters/all-exceptions.filter.ts` (+ spec)
- `src/common/logging/sensitive-query.util.ts` (+ spec)
- `src/common/logging/pino-options.factory.ts`
- `test/auth-audit-hardening.e2e-spec.ts` (new)
- `deploy/google-verify/remote.sh`, `deploy/google-verify/verify.mjs`
- `docs/AUTHENTICATION_COMPREHENSIVE_AUDIT.md` (new)

**Backend, decisions D1–D5 and the regression fixes:**
- **Migrations:**
  - `prisma/migrations/20261020000000_account_deletion_challenges/`;
  - `prisma/migrations/20261021000000_identity_tables_rls/`;
  - `prisma/schema.prisma`.
- **Account deletion (D1):**
  - `src/identity/services/account-deletion-challenge.service.ts` (new), `account-deletion.service.ts`, `deletion-plan.service.ts`;
  - `src/identity/dto/delete-account.dto.ts`, `src/identity/controllers/users.controller.ts`, `src/platform/controllers/platform-user-management.controller.ts`;
  - `src/communications/templates/keys/auth.account.deletion_code.ts` and `auth.account.signup_attempt.ts` (new), plus the catalogue and registry.
- **Registration and sign-in paths:**
  - `src/identity/services/auth.service.ts`, `academy-surface.service.ts`, `two-factor.service.ts`, `session-*.service.ts`;
  - `src/identity/guards/jwt-auth.guard.ts`;
  - `src/identity/google/google-auth.service.ts`, `google-identity.repository.ts`.
- **Identity data access (D2):**
  - `src/identity/repositories/identity-resolver.ts` (new), `users.repository.ts`, `refresh-tokens.repository.ts`, `password-reset-tokens.repository.ts`, `email-verification-tokens.repository.ts`;
  - `src/database/user-context.ts` (new), `src/database/prisma.module.ts`, `src/tenancy/services/tenancy-context.service.ts`;
  - `src/platform/` (users repository, service, controller, organizations-access guard), `src/analytics/`, `src/search/`, `src/communications/services/{suppression,delivery-event}.service.ts`, `src/learning/` (roster count);
  - `src/scripts/{provision-platform-owner,delete-user}.ts`.
- **Uploads (D5):** `src/media/utils/file-validation.util.ts` and its callers (media, support, billing, course-order payments, protected media).
- **CSP (D4):** `src/security-reports/` (new), `src/observability/metrics/csp-metrics.ts` (new), `src/main.ts`, `src/app.module.ts`.
- **Tests:**
  - new: `identity-rls`, `account-deletion-otp`, `registration-enumeration`, `csp-reports`;
  - adapted: the RLS suites' fixtures, several auth suites' verification client, and `test/utils/{db-admin,test-app,account-deletion}.ts`.
- **Docs:** `docs/CSP_AND_TOKEN_STORAGE.md` (new).

**Frontend (`atlas`):**
- `src/features/auth/pages/SignInPage.tsx`
- `src/features/auth/components/RegistrationForm.tsx`
- `src/localization/resources/en/auth.json`, `src/localization/resources/ar/auth.json`
- `src/features/auth/auth-audit.test.tsx` (new)
- `src/features/profile/components/DeleteAccountCard.tsx`, `src/services/identity/current-user.service.ts`, `delete-account-card.test.tsx` (new), deletion and notification copy (EN/AR)
- `src/features/auth/…` and `public-website` post-sign-up copy (EN/AR), `sign-in-registered-notice.test.tsx`
- `Caddyfile` (`csp_report_only`)

## 14. Commits

**Backend, on `main` through merge `cf977d0`:**
- `b754dd2` AUTH-01..11
- `5541f2c` report draft
- `c5fac49` uploads (D5)
- `6bb78ed` account deletion (D1)
- `10b5650` registration (D3)
- `396c304` identity RLS (D2) and AUTH-17/18
- `ef60292` CSP endpoint and plan (D4)
- `75bb6cc` report, and the fail-closed migration precondition

**Verification tooling, on the branch** (merged with this report):
- `b2de77b` the Google verify `security` check
- `0d9d7a5` the Launch verify journey for Decision 3

**Frontend, on `main` through merge `f907bb0`:**
- `56ca87e` redirect guard and name bound
- `53aac34` delete-account dialog (D1)
- `44a90f2` generic post-sign-up copy (D3)
- `a9c08fe` CSP Report-Only (D4)

## 15. Deployment Status

**Released to production on 28 September 2026.**

**Backend:**
1. Deploy #220 (push of `cf977d0`):
   - its first image build crashed in GitHub's arm64 emulation (QEMU `Illegal instruction` during `npm ci`), an infrastructure fault; unchanged dependencies built on the re-run;
   - the deploy then stopped at the migration gate as designed: nothing migrated, the stack untouched.
2. Deploy #221 (`apply_migrations=true`) was approved by the owner through the `production-migrations` environment:
   - backup taken;
   - two migrations applied;
   - backend and Caddy healthy at 20:21 UTC.

**Frontend:** Deploy #126 (`f907bb0`) succeeded at 20:47 UTC.

**Rollback:**
- `vps-deploy --rollback` restores the recorded last-good digests.
- The migrations are additive (a new table, plus policies and functions) and have no down-migration. Reverting D2 would be a new migration that drops the policies and functions.
- The release backup is `atlas-20260928T202049Z.sql.gz`.

## 16. Remaining Risks

- **Brevo webhook secret:** it was written to request logs before AUTH-09. It has been **rotated** (section 12), so any value in older log lines is now invalid.
- **XSS:** ~~session theft through XSS~~ resolved. `script-src 'self'` is enforced, and no refresh token is readable by script (AUTH-20, AUTH-21). An injected script, were one ever to run, could act only within the page's own lifetime, with a 15-minute access token.
- **`users` SELECT scope:** row visibility on `users` stays context-gated (directory data: name, email, status). It no longer holds any credential. The password hash lives in `user_credentials` with self-only RLS (AUTH-19).
- **Operator actions:** promoting a platform owner now requires the owner database connection (`provision-platform-owner` uses `DATABASE_URL`). This is intentional.

## 17. Human Decisions Required

**Decided, and implemented in this release:**
- **D1: account deletion.** An emailed code (AUTH-12).
- **D2: identity-table RLS.** The architecture was delegated and has been implemented (AUTH-13).
- **D3: registration.** "If an account exists, we'll help you continue" (AUTH-14).
- **D4: CSP.** Report-Only first, with token storage as a follow-up (AUTH-15; plan document).
- **D5: uploads.** Fixed everywhere (AUTH-16).

**Still needed from a human:**
1. ~~Approve the `production-migrations` environment~~: **done** (Deploy #221).
2. ~~Rotate the Brevo webhook secret~~: **done**, and verified (section 12).
3. ~~Approve the CSP enforcement and schedule the token-storage follow-up~~: **done** in the production-readiness pass (section 19).

## 18. Final Audit Status

**AUTHENTICATION — PRODUCTION READY** (production-readiness pass, 29 September 2026; section 19).

The three known limitations of the first pass are resolved and verified in production:
- **CSP enforcement (CSP-ENF):** **done.** The CSP is enforced (AUTH-21).
- **Token storage (TOK-1):** **done.** HttpOnly `__Host-` cookie refresh token; in-memory access token (AUTH-20).
- **`users` rows and `password_hash`:** **done.** The credential is in its own self-only RLS table; the directory carries none (AUTH-19).

The pass also fixed AUTH-22 to AUTH-25. Across both passes: 25 issues found and 25 fixed, 0 high or critical.

*First-pass status (28 September 2026), superseded:* PASS WITH KNOWN LIMITATIONS.

## 19. Production-Readiness Pass (29 September 2026)

A second, independent pass took the three known limitations as its starting point, then re-opened the rest of the system rather than trusting sections 1–18.

### 19.1 Findings and fixes

| ID | Severity | Finding | Fix |
|---|---|---|---|
| AUTH-19 | MEDIUM | **Password hashes lived in the `users` directory.** `users` rows are visible to any established context (§16), so `password_hash` was database-readable alongside ordinary directory data. It never left the API: every response is an explicit projection, and the hashes were redacted in logs. | The hash moved to a new `user_credentials` table: FORCE RLS with **self-only** policies, an Argon2-only `CHECK`, and a cascade FK; no row means no password. `PasswordCredentialsService` is the single path that reads or writes it: verify with a dummy-hash timing equaliser, set, remove, has. The `no-password:`/`deleted:` sentinels are gone. Staged migration: stage 1 copies, verifies the counts (raising on mismatch), NULLs the old column, and captures any legacy write with triggers, so the previous container keeps working during the migration window. Stage 2 drops the column. |
| AUTH-20 | MEDIUM | **Tokens in `localStorage`** (TOK-1). | Refresh token only in `__Host-atlas_session` (HttpOnly, Secure, SameSite=Strict, host-only). The access token lives in memory. A global interceptor is the one place a refresh token leaves the server. A strict same-origin gate protects the two cookie routes. Legacy tokens are converted once. Cross-tab refresh uses Web Locks. `docs/CSP_AND_TOKEN_STORAGE.md` §2. |
| AUTH-21 | MEDIUM | **CSP Report-Only** (CSP-ENF). The enforcement sweep found one real break: the certificate PDF preview is a `blob:` frame that `frame-src` did not allow. | `frame-src` gains `blob:`. The CSP is **enforced** with reporting kept on, backed by bundle analysis, dynamic-source probes, a 24-page enforced browser sweep and production reports. `docs/CSP_AND_TOKEN_STORAGE.md` §1. |
| AUTH-22 | LOW | **Log redaction missed root-level keys.** `*.accessToken` matches one level down only, so a service logging `{ accessToken }` itself would have leaked it. OAuth `codeVerifier`/`nonce` and TOTP enrolment material had no paths. No current call site did this. | Root-level and nested paths were added for every secret class. Pinned through real pino (`pino-redaction.spec.ts`, 19 cases). |
| AUTH-23 | LOW | **Missing security telemetry.** Brute force, TOTP/emailed-code guessing, reset-link abuse, cross-origin session use and refresh-token replay had no metric or alert. | `atlas_auth_refusals_total{key}` is recorded once in the global exception filter for every `errors.auth.*` refusal (bounded labels). `atlas_auth_sessions_revoked_total{trigger="refresh_token_reuse"}` covers replay. Five alerts: `AtlasAuthBruteForce`, `AtlasAuthRefreshTokenReuse`, `AtlasAuthCrossOriginSession`, `AtlasAuthSecondFactorGuessing`, `AtlasAuthResetLinkAbuse`. |
| AUTH-24 | LOW | **`EMAIL_DELIVERABILITY_CHECK_ENABLED=false` never disabled the check.** `configuration.ts` coalesced the raw string, and `'false'` is truthy. It fails safe (the check stays on). | The string is compared. Unit-tested. |
| AUTH-25 | INFO | Found during the pass, before release: the session-cookie Origin gate first compared against the raw `Host` header, while every tenancy decision uses `request.hostname`. That is behind-proxy-inconsistent and false-refused proxied dev/e2e. | The gate now uses scheme + `request.hostname`, parses Origin strictly, and is unit-tested (sibling academies, look-alike suffixes, scheme downgrade, `null`/malformed). |

### 19.2 Re-verified (not changed)

- **Identity:** one identity per person. Google linking and unlinking keep a usable sign-in method (unlink is refused without a password credential).
- **Registration:** enumeration-safe (D3).
- **Refresh:** atomic rotation, 60 s reuse grace, family revocation.
- **Revocation:** the `sid` denylist makes it immediate.
- **Surface binding:** route inventory test.
- **Second factors:** OTP host/challenge binding; per-academy trusted devices.
- **Rate limiting:** a Redis-backed per-IP global throttle (120/min) plus dedicated guards on every credential-accepting route. Refresh and verify-email tokens are 256-bit single-use.
- **CORS:** allows credentials only for platform origins. The cookie routes additionally require the exact origin, so a sibling academy's page cannot use another host's session even though CORS would let it read a response.
- **Google OAuth:** state, nonce, PKCE, binder cookie, one-time handoff to the original host (unchanged). Its completion now sets the cookie on that host through the same interceptor.
- **RLS:** eight identity tables (the seven, plus `user_credentials`) carry FORCE RLS. `account_deletion_challenges` is included.

### 19.3 Performance

Measured locally against real Postgres and Redis:
- **Password sign-in:** p50 70 ms, p90 84 ms, dominated by Argon2id by design.
- **Cookie refresh:** p50 16 ms, p90 38 ms.

The credential lookup is a primary-key read under the caller's own RLS context. Refresh uses the unique `token_hash` index. No N+1 was introduced.

### 19.4 Tests

| Suite | Result |
|---|---|
| Backend unit | 3989 / 3989 |
| Backend e2e, fresh database (all 129 migrations from zero + seed) | 164 / 164 suites, 1987 / 1987 tests |
| Backend e2e, identity/auth suites on the stage-2 schema (representative 52,727-user database) | 48 / 48 suites, 533 / 533 tests |
| Frontend unit | 1178 / 1178 |
| Lint + typecheck + build | clean (backend and frontend) |
| Real browser, cookie session (Chromium over HTTPS through Caddy) | 20 / 20 |
| Real browser, enforced CSP sweep (24 pages: public, signed-in, custom-domain academy; EN/AR; desktop/mobile) | 24 / 24, 0 violations |

**Migrations:**
- **Fresh database:** stage 1 applied from zero. The seeded passwords land only in `user_credentials`.
- **Representative database:** stage 1 moved 35,245 Argon2 hashes (the count guard passed), left 0 non-NULL values in the old column and 0 non-Argon credentials. Stage 2 then dropped the column.
- **Drift:** `prisma migrate diff` against the schema is empty.

### 19.5 Production

- **Stage 1 release** (backend `e53dc97`, frontend `4a3f5f6`): Deploy #225 with the `production-migrations` approval.
  - A pre-migration backup was taken (`atlas-20260929T005543Z.sql.gz`, gzip-verified, contains `users`).
  - Migration applied; backend healthy.
  - The frontend deployed afterwards (#127).
- **Google verify #15–#17 (production):**
  - **Credentials:** `directory_rows_with_credential = 0`; 145 accounts hold a password credential.
  - **RLS:** all 8 identity tables have ENABLE + FORCE RLS. No permissive policy. 7 resolvers, `atlas_app`-only. `atlas_app` has no BYPASSRLS.
  - **CSP:** the platform host and the allowlisted academy host **enforce** the CSP, still report, and load exactly 1 same-origin script with 0 inline or foreign. The report endpoint returns 204. 0 violation reports since the new backend started.
  - **Logs:** no JWT, Google token, client secret, handoff or setup token, raw OAuth code/state or raw webhook secret.
  - **Webhooks:** 2 accepted, 0 refused.
  - **Google:** the flow probes, data integrity and browser checks (EN desktop and AR mobile) all pass.
- **Launch verify #15 (production, all 5 jobs pass):**
  - **Cookie session:**
    - the sign-in body carries no refresh token;
    - `__Host-atlas_session` is HttpOnly, Secure, SameSite=Strict, `Path=/`, host-only;
    - refresh from another academy's origin → 403, and nothing rotates;
    - refresh with no Origin → 403;
    - same-origin refresh rotates;
    - a replayed rotated cookie → 401 and cleared.
  - **Existing checks (A1–A6, all pass):** surface and tenancy refusals, per-academy OTP and trusted devices, password change ending every session, Smart Member Invite and academy join (password verification now through `user_credentials`), and the browser journeys in EN, AR/RTL, desktop and mobile.
- **Stage 2 release** (`20261023000000_drop_users_password_hash`, backend `9ed8892`): drops the now always-NULL `users.password_hash` column and the stage-1 capture triggers, with a fail-closed guard.
  - Deploy #227 with the `production-migrations` approval, after a fresh pre-migration backup (`atlas-20260929T013837Z.sql.gz`, gzip-verified). Migration applied; backend healthy.
  - **Launch verify #16, all 5 jobs pass:** sign-in, cookie session, A1–A6, Smart Member Invite, and the browser journeys, all verifying passwords through `user_credentials` only.
  - **Google verify #18:** every check passes except one tooling fault. The security query referenced the dropped column inside a `CASE`, and Postgres rejects that at plan time.
  - The query was fixed to test the column's existence first. It now reports `column_dropped` (verified on the stage-2 database), and the re-run is recorded below.
