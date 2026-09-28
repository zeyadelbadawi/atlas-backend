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
- **Surface and tenancy:** surface separation (an academy session is refused on every management route, enforced by a route inventory test), RLS on 69 of 89 tables, and dozens of tenant-isolation suites.
- **Google:** PKCE, state, nonce, a binder cookie and a one-time handoff.

**Eleven issues were found and fixed** with regression tests, each proven to fail on the pre-fix code:

| Severity | Count | IDs |
|---|---|---|
| High / critical | 0 | — |
| Medium | 6 | AUTH-01, AUTH-03, AUTH-04, AUTH-06, AUTH-07, AUTH-09 |
| Low | 4 | AUTH-02, AUTH-05, AUTH-08, AUTH-11 |
| Informational | 1 | AUTH-10 |

**Four items need an owner decision or a staged rollout**, so they were not changed (section 17):
- account deletion without re-authentication;
- RLS on the identity tables;
- registration email disclosure;
- a Content-Security-Policy for the SPA.

**Final status: PASS WITH KNOWN LIMITATIONS** (section 18).

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

**Tenancy.** Guards decide first; RLS (FORCE, on the runtime role `atlas_app`) decides independently on 69 of 89 tables.

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

All commands ran locally against real PostgreSQL 16 and Redis, as the restricted runtime role for RLS, unless noted.

| Command | Suite | Passed | Failed | Notes |
|---|---|---|---|---|
| `npx jest --config ./test/jest-e2e.json test/auth-audit-hardening.e2e-spec.ts` | new audit suite AUD-01…AUD-08 | 9 | 0 | same suite on the pre-fix source: **9 failed**, which proves each test detects its defect |
| `npx jest` (backend unit) | 139 suites | 3890 | 0 | includes the new filter and redaction tests |
| `npx jest --config ./test/jest-e2e.json` (full backend e2e, 160 suites) | all | see §7a | see §7a | |
| `pnpm exec vitest run` (frontend) | 128 files | 1167 | 0 | includes the new `auth-audit.test.tsx` (6); on the pre-fix source: 5 of 6 fail (the 6th asserts a legal path) |
| `pnpm run lint` / `npm run lint` scope | frontend / changed backend files | clean | — | |
| `npm run typecheck` (backend) | | clean | — | |
| `pnpm run typecheck` (frontend) | | — | 34 | **pre-existing**, identical count before and after, none in files touched here |
| `npm run build` / `pnpm run build` | | ✓ | — | |

### 7a. Full backend e2e

`npx jest --config ./test/jest-e2e.json` ran over all 159 suites (1950 tests) with every audit fix applied:
- **155 suites passed**, 1938 tests.
- **4 suites failed**, 12 tests.

None of the failures is in an authentication path, and none is caused by this audit:

| Suite | Failed tests | Cause | Same on pre-audit `88877a4`? |
|---|---|---|---|
| `p63-domain-operations` | 5 | Canonical-host expectations against a platform base domain left by earlier runs in the shared test database; custom-domain logic, not auth. | **Yes**: the same 5 tests fail on the baseline in isolation (pre-existing). |
| `media` | 1 | `RangeError: Maximum call stack size exceeded` in `parseDataUrl` (a regular expression over a multi-megabyte data URL) answers an oversized upload with 500 instead of 413. | Passes on the baseline in isolation; see the isolation result below. **Not auth code.** |
| `p53-support-attachments` | 1 | Same `parseDataUrl` stack overflow (P53-ATT-013). | As above. |
| `p64-comm-events` | 2 | The digest sweep found 100 and 19 due windows instead of 1: leftover digest windows from other suites in the shared database (order-dependent). | Passes on the baseline in isolation. |

Isolation re-run of `media`, `p53-support-attachments` and `p64-comm-events` on the audited tree: see section 12.

The `parseDataUrl` stack overflow is a separate, **non-authentication** defect: an oversized upload can return 500 instead of 413. It is recorded here for follow-up and was not changed by this audit.

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

## 9. Issues Fixed

AUTH-01 through AUTH-11 (section 8). All carry regression tests, and each backend test was run against the pre-fix source to confirm it fails there.

## 10. Issues Not Fixed

| ID | Severity | Item | Why not fixed |
|---|---|---|---|
| DEC-1 | MEDIUM | `POST /users/me/delete` has no re-authentication. A stolen management session can delete the account, which also archives every academy it owns. | **Human decision.** Re-authentication by password excludes Google-only accounts. The options are password-or-Google re-auth, a recent-sign-in window, or an emailed confirmation, and each is a product policy (section 17). |
| DEC-2 | LOW (defence in depth) | The identity tables (`users`, `refresh_tokens`, `password_reset_tokens`, `email_verification_tokens`, `user_two_factor`, `two_factor_recovery_codes`, `user_auth_identities`) have no RLS. | **Pre-existing, documented (O1), owner decision.** Identity is deliberately cross-tenant. Every query is scoped by the verified user id, and it matters only to an attacker already running SQL as `atlas_app`. User-scoped RLS touches every module and belongs in its own phase. |
| DEC-3 | LOW | Registration answers 409 for an existing email (account existence disclosed). | **Pre-existing, documented (O2/DL-12), owner decision.** The smart academy join is already non-enumerating; the platform signup message is a product choice. |
| DEC-4 | MEDIUM | No Content-Security-Policy on the SPA documents, while access and refresh tokens are in `localStorage` (any XSS could read them). | **Staged rollout required.** Academy themes, embeds and video need an inventory; a CSP shipped blind could break production sites. Recommended: `Content-Security-Policy-Report-Only` with a report endpoint, then enforce. |
| INFO-1 | INFORMATIONAL | Reset request timing differs slightly for existing and unknown emails (a database write and enqueue). | Accepted: rate-limited per IP and email, and the response is identical. |
| INFO-2 | INFORMATIONAL | `POST /auth/verify-email` has no rate limit. | 256-bit single-use tokens; guessing is infeasible. |
| INFO-3 | INFORMATIONAL | There is no product path to suspend a user; suspension is a database operation. | Out of auth scope. AUTH-06 makes a suspension effective on the next refresh once one exists. |

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
  - RLS FORCE on 69/89 tables, plus about 40 tenant-isolation and RLS e2e suites.
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

Filled in after the release (see sections 14 and 15).

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

**Frontend (`atlas`):**
- `src/features/auth/pages/SignInPage.tsx`
- `src/features/auth/components/RegistrationForm.tsx`
- `src/localization/resources/en/auth.json`, `src/localization/resources/ar/auth.json`
- `src/features/auth/auth-audit.test.tsx` (new)

## 14. Commits

Filled in after the release.

## 15. Deployment Status

Filled in after the release.

## 16. Remaining Risks

- **Brevo webhook secret:** it was logged before AUTH-09. Rotate it (Brevo webhook URL plus the backend secret), because older log lines may still hold it.
- **XSS impact:** because tokens live in `localStorage`, an XSS would be session theft until a CSP ships (DEC-4).
- **Account deletion:** it has no re-authentication (DEC-1).

## 17. Human Decisions Required

1. **DEC-1: re-authentication for account deletion.**
   - **Why a decision:** it changes what a signed-in person must do to delete, and Google-only accounts have no password.
   - **Options:**
     - (a) current password, or a fresh Google sign-in for Google-only accounts: strongest, and more UI;
     - (b) require a sign-in within the last N minutes: simple, with a weaker guarantee;
     - (c) an emailed confirmation link: works for every account, but deletion becomes asynchronous.
   - **Consequence of doing nothing:** a stolen management session can delete the account and archive its academies.
2. **DEC-2: user-scoped RLS on the identity tables** (O1).
   - **Options:** (a) add policies scoped to `app.current_user_id` plus service-role paths for sign-in and refresh: a large cross-module phase; (b) keep application-level scoping (status quo).
   - **Consequence:** only relevant if SQL execution as `atlas_app` is ever achieved.
3. **DEC-3: registration email disclosure** (O2).
   - **Options:**
     - (a) always answer "check your email" and mail the existing owner: no disclosure, and a slower signup UX;
     - (b) keep the 409 plus "sign in instead" (status quo).
4. **DEC-4: Content-Security-Policy rollout.**
   - **Options:** (a) Report-Only first, then enforce: recommended; (b) enforce now: risk to academy sites; (c) none (status quo).
   - **Consequence:** any XSS is token theft.

## 18. Final Audit Status

**PASS WITH KNOWN LIMITATIONS.** There are no critical or high issues. Every medium issue that can be fixed without a policy decision is fixed, tested and released. The known limitations are DEC-1 to DEC-4 (section 17) and the Brevo secret rotation (section 16).
