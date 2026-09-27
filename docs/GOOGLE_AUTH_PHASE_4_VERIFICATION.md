# Google Authentication — Phase 4 verification

Date: 27 Sep 2026. Branch `claude/nifty-ride-h9nxql` in both repositories. Nothing was deployed, and the production flag stays off.

**Evidence types.** Everything below was executed locally against a fake Google provider (a local OIDC implementation), the real backend and the real SPA build. Real Google in production is **not** verified here; that is Phase 5 (§18).

## 1. Scope

Phase 4 proves that Google sign-in is production-safe across:
- every Atlas surface (management, academy subdomain, custom domain);
- every identity state;
- the second-factor and trusted-device controls (TOTP, A6);
- tenancy and origin boundaries;
- the invitation and linking paths;
- the frontend UX states.

It fixes the real defects found and adds regression tests for them.

## 2. Implementation reviewed

**Backend (`atlas-backend`)**
- `src/identity/google/*`:
  - OIDC client: RS256 only; a known `kid` required; signature checked first; then iss, aud/azp, exp/iat skew, nonce hash, sub and email; the JWKS refetch is throttled; errors carry only a status.
  - Service: authorize/callback/complete, the link/create/activate steps, settings link/unlink, setup.
  - Repository: conditional single-spend UPDATEs.
  - Controller: host-only binder cookie; the callback is served on the platform host only.
  - DTOs and rate-limit guard.
- `continueSignIn`: status → surface → TOTP → emailed code / trusted device → session.
- Config validation (`env.validation.ts`).
- Migration `20261019000000_google_identity_foundation`.
- Metrics (`google-auth-metrics.ts`) and the pino request logger (`pino-options.factory.ts`).
- Deploy plumbing: `deploy.yml` and `.github/actions/vps-deploy` (no Google keys yet; that is Phase 5).
- The production `Caddyfile` in the `atlas` repo: `handle /api/*` passes the path unchanged, and there is no `log` directive, so the access log is off.

**Frontend (`atlas`)**
- `src/features/auth/google/*`: button, start hook (bfcache reset), flow context, return flow, step panel, errors.
- Return pages on both surfaces.
- `SignInMethodsCard`.
- The canonical-redirect exemption.
- The session-service "Last used" write.

**Tests reviewed**
- `test/google-identity.e2e-spec.ts` (47 cases) and the fake provider `test/utils/fake-google-oidc.ts`.
- The auth, 2FA, email-code/A6, trusted-device, invitation and surface suites.

## 3. Test matrix (what was added in Phase 4)

| Area | New evidence |
|---|---|
| Config validation | `src/config/env.validation.spec.ts` › *Google sign-in*: 11 unit cases |
| Log redaction | `src/common/logging/sensitive-query.util.spec.ts`: 5 unit cases |
| Hardening e2e | `test/google-identity-hardening.e2e-spec.ts`: 18 cases (`GID4-*`), with a real `PLATFORM_BASE_DOMAIN` and the emailed code on both surfaces |
| Frontend | `google-auth.test.tsx`: a cancel or failure never writes "Last used"; bfcache "Back" re-enables the button |
| Browser | J5–J11: 25 checks (§14) |

## 4. Security / adversarial matrix

| Attempt | Expected | Observed | Evidence |
|---|---|---|---|
| Flow started on academy A, completed on B (correct binder) | refused, no session | 401 `googleSignInExpired`, 0 new sessions | GID4-HOST-02, J8 |
| …then completed on A with the same handoff | refused (fail closed) | 401, the handoff was spent | GID4-HOST-02, J8 |
| Flow started on A, completed on the platform host | refused | 401 | GID4-HOST-02 |
| Callback on `www.<base>` | 404, state not spent | 404, and the platform callback still succeeds | GID4-HOST-01 |
| Callback on an academy subdomain or custom domain | 404, state not spent | 404 | GID4-HOST-01, GID-CB-03 |
| Callback redirect target | the origin the flow started on, never the callback host | `303 http://<academy host>/auth/google/return#h=…` | GID4-HOST-01 |
| Foreign `Origin` header at authorize | refused | 403 `googleOriginRefused` | GID4-HOST-03, GID-AUTH-03 |
| Modified or unknown state; replayed state | dead end, no redirect | 400 plain page | GID-CB-02 |
| Nonce mismatch, forged signature, wrong iss/aud/azp, expired token, `iat` in the future, `alg` none/HS256, unknown kid | refused, nothing handed off | `#error=failed` | GID-CB-05, `google-oidc.client.spec.ts` |
| PKCE: a code bound to another flow's verifier | refused | failed | GID-CB-06 |
| Replayed handoff; no binder; wrong binder; another origin | refused | 401 | GID-DONE-01 |
| Pending-step secret presented as a handoff | refused | 401 | GID-DONE-03, GID4-LIFE-02 |
| Pending step replayed after success (link, create, activate, complete) | refused | 401 on all four; 1 identity | GID4-LIFE-02 |
| Expired state, handoff or pending step | refused | 400 / 401 / 401; nothing created | GID4-LIFE-01 |
| A captured return URL reopened after use | refused, no session | "expired or already used" | J9 |

## 5. Identity matrix

| Case | Result | Evidence |
|---|---|---|
| A. Existing password account, same email, not linked | link step. A wrong password is a generic 401 and the step stays open; the right one links and signs in; audit and notification are written | GID-LINK-01, GID4-LIFE-02, J2 |
| B. Existing account, different Google email | never matched by address. Linking only from signed-in settings with the current password; same user afterwards | GID-SET-01, GID4-RACE-03, J2/J11 |
| C. Already linked | signs in the same user. Membership resolution and A6 apply | GID-DONE-06/07, GID4-A6-01, J5 (P3) |
| D. New person | nothing is created before the confirmation step; the registration policy applies; no password (`nopassword:`); verified only if Google is authoritative; a password can be set later via reset, then Google may be disconnected | GID-NEW-01…07, GID4-PWD-01, J1/J4 |
| E. Invited account | activation only where Google is authoritative. The setup page works through the emailed token; the token is spent | GID-DONE-05, GID-INV-01/02, J6 |
| F. Existing Google user joins another academy | same user; new membership only; other roles unchanged; per-academy A6 | GID-NEW-06, GID-LINK-04, J7 |
| G. Suspended | refused before any challenge or session; revealed only after proof (password or the linked Google) | GID-DONE-08, GID4-PIPE-02, GID4-PRIV-03 |
| G. Deleted | the identity is removed with the account | GID-DEL-01 |
| G. Invited + wrong password at the link step | generic `invalidCredentials` | GID-LINK-*, code review |

## 6. Invitation matrix

- Correct code: joins once, spent exactly once (GID-INVITE-01, J5).
- No code: `inviteRequired`. Wrong code: `inviteInvalid`, shown inline (GID-INVITE-02, J5).
- Another academy's code, expired, revoked, used up, or addressed to someone else: refused (GID-INVITE-03).
- Already a learner: nothing spent (GID-INVITE-04).
- Concurrent redemption: one membership, one use (GID-INVITE-05).
- The code binds to the **Atlas account email**, never the Google address (GID-INVITE-07).
- Linking and redeeming in one step (GID-INVITE-06).

## 7. A6 matrix

- **Google does not skip TOTP.** Challenge first, no session row, then a session with `authMethod=google` (GID4-PIPE-01). TOTP and the emailed code are alternatives, never stacked, exactly as for a password (§12, `continueSignIn`).
- **The emailed code applies** on academy and management for a new device (GID-DONE-07, GID4-A6-01, J1/J2/J4/J7).
- **A device remembered on academy A:**
  - A skips the code (GID4-A6-01, J7).
  - B still asks (GID4-A6-01, J7).
  - Management still asks (GID4-A6-01).
- **A device remembered on management** does not trust A (GID4-A6-01).
- **A code challenged on A** cannot be completed on B (GID4-A6-01).
- **Forgetting the device** on A brings the code back (GID4-A6-01).
- The existing A6 suites pass unchanged (§13).

## 8. Frontend matrix

**Management**
- sign-in and sign-up (J1);
- return page, link step with a wrong then right password (J2);
- create step with organization, trial plan and terms (J1);
- email-code step (J1/J2);
- settings connect, disconnect and reconnect (J2);
- "Last used" (J10);
- setup page (J6); no Google on a plain reset (J6).

**Academy**
- sign-in (J5 P3, J9);
- sign-up (J4, J7);
- invitation sign-up (J5);
- learner security page: Google-only state (J4) and connect (J11);
- Arabic RTL at 390 px with no overflow (J4, J7, J11).

**States**
- "Back" from Google (J9, plus a bfcache unit test);
- double click (unit);
- cancel (J3, J10);
- replay/expired return (J9);
- retry (J9);
- messages come from the i18n bundle; unknown keys fall back to a generic message; there are no raw keys;
- an off-site `?redirect=`/`next` is dropped (unit);
- the fragment is removed from the address bar (J1, J9).

## 9. "Last used"

- It is written only in `SessionService.establishSession`, from the response's `authMethod`.
- A password session gives `password`; a Google session gives `google` (J10).
- Cancelled (J10, unit) and failed (unit) flows leave it unchanged.
- It survives sign-out (J1, J10).
- A forged value shows no badge (J10). It is a display hint only and never sent to the server.

## 10. Observability

- **Metric:** `atlas_google_auth_total{stage,result}`. Labels are closed vocabularies (asserted in GID4-OBS-02) and cover:
  - started, cancelled, provider_error, invalid_state, invalid_token;
  - link_required, create_account, activate_invited, existing_identity;
  - linked, created, activated, unlinked, conflict, refused, rate_limited, disabled.
- **Audit:** `auth.identity.linked` (with `via`) and `auth.identity.unlinked`.
- **Notifications:** `auth.identity.linked` / `unlinked`.
- **Session method:** `refresh_tokens.auth_method`.
- **Logs:**
  - A failed callback logs only the flow id, the failure kind and the reason (GID4-OBS-01).
  - No code, token, client secret, handoff or address appears in the service logs (GID4-OBS-01).
  - The request logger is covered by fix D-1 (§16).

## 11. Configuration

Unit cases in `env.validation.spec.ts`:
- `FLAG_AUTH_GOOGLE_MODE` defaults to `off`; an unknown value is rejected.
- In `allowlist` or `on`, startup is refused with each of `GOOGLE_OAUTH_CLIENT_ID`, `_SECRET` or `_REDIRECT_URI` missing, and the message names the missing one.
- A redirect URI that is not a URL is rejected.
- Each `GOOGLE_OIDC_*` override is refused in production **even with the flag off**, and accepted outside production.
- With the flag off, every route is 404 and the options answer `false` (GID-FLAG-01).
- `allowlist` enables only the listed academies; management stays off (GID-FLAG-02).

## 12. Migration

`20261019000000_google_identity_foundation` is additive only:
- 2 enums;
- 2 nullable `auth_method` columns;
- `user_auth_identities` with `UNIQUE(provider, provider_subject)` and `UNIQUE(user_id, provider)`, cascading on user delete;
- `auth_oauth_flows` with FORCE RLS and a 24 h retention-delete policy.

There is no DROP, TRUNCATE, DELETE or type change; the only such keyword is in the rollback comment. The unique indexes decide every race: GID-NEW-05, GID4-RACE-01/02 and GID-INVITE-05.

**Release order is unchanged.** Every sign-in writes `refresh_tokens.auth_method`, so the migration must ship through the gated `apply_migrations` run in the same release as the code, never after it.

**Rollback:** dropping the tables, columns and types loses only Google links and flow rows. Password accounts are untouched.

## 13. Test counts (final code)

| Suite | Result |
|---|---|
| Backend unit (`jest`, all) | **139 suites, 3887/3887 pass** |
| Backend Google e2e (flow 47 + hardening 18) | **65/65 pass** |
| Backend auth/identity/A6/2FA/invitation/surface e2e (20 suites, including both Google suites) | **20/20 suites, 278/278 pass** |
| Frontend Vitest (all) | **126 files, 1152/1152 pass** |
| Frontend ESLint | clean |
| Frontend typecheck | 34 errors, all pre-existing (platform-zoom, platform-add-ons, website); unchanged by this branch |
| Frontend production build | succeeds |
| Backend ESLint | clean in every file this branch touched; 33 pre-existing errors in 6 untouched files |

## 13a. Auth e2e batch

The batch was run on the final code: 20 suites, including both Google suites, the auth suites, 2FA, email code/A6, OTP RLS, member onboarding, identity surfaces, the surface-enforce flag, signup email security, smart member invite and metrics scrape auth. Result: **20/20 suites, 278/278 tests pass**. Before fixes D-1 and D-2 the same batch was 277/277; the new test is GID4-RET-01.

## 14. Browser journeys (local: fake Google, real backend, real SPA build, same-origin proxy)

**Phase 3 set, rerun on the final backend: 24/24 checks.**
- J1: management sign-up.
- J2: link, then settings disconnect and reconnect.
- J3: cancel.
- J4: Arabic mobile academy sign-up and settings.
- J5: returning Google user.

**Phase 4 set: 25/25 checks.**
- **J5, invitation Google sign-up:**
  - a valid code joins the invite-only academy and is spent once;
  - a wrong code shows the invitation message inline, and nothing is created.
- **J6, setup page via Google:**
  - the account is active and linked, and the setup link is spent;
  - a plain reset shows no Google button.
- **J7, A6 in the browser (Arabic, mobile):**
  - remembered on A → A signs in with no code;
  - B asks for the code;
  - the same user joins B.
- **J8, cross-academy:** a handoff captured on A and opened on B is refused; the same handoff back on A is already spent.
- **J9:**
  - Back from Google re-enables the button;
  - the replayed return URL is refused, with no fragment left;
  - retry succeeds.
- **J10, "Last used":**
  - password session → no badge;
  - cancelled Google → unchanged;
  - forged hint → ignored;
  - Google session → badge.
- **J11:** an academy learner connects Google from the Arabic security page and returns there.

## 15. Bugs found

| # | Severity | Defect |
|---|---|---|
| D-1 | Security (credential in logs) | The pino request logger recorded Google's callback query at info level, in both `url` and `query` and in the message line: `GET /auth/google/callback?code=…&state=…`. The code is single-use and bound to PKCE and the client secret, but it is a credential. |
| D-2 | Privacy / data retention | `auth_oauth_flows` had a 24 h retention *policy* but nothing deleted rows, so every flow's Google address, name, subject and PKCE verifier were kept indefinitely. |

A test-harness finding, not a product defect: my first TOTP e2e assertion expected the emailed code after TOTP. The pipeline correctly treats them as alternatives (§7).

## 16. Bugs fixed

- **D-1:**
  - `src/common/logging/sensitive-query.util.ts` censors `code`, `state`, `token`, `id_token`, `access_token` and `refresh_token` by name.
  - It is applied in `pino-options.factory.ts` through a request serializer (`url`, `query`) and in the success/error message lines.
  - The body redact paths now include `handoff`, `pending`, `setupToken` and `inviteToken`.
  - Regression: 5 unit cases. End to end, a rerun of both Google e2e suites produced 111 callback log lines and **0** raw codes; each shows `code=[REDACTED]&state=[REDACTED]`.
- **D-2:**
  - `GoogleIdentityRepository.pruneExpired` deletes a bounded batch (500) of flows whose lifetime ended more than 24 h ago.
  - `GoogleAuthService.authorize` calls it best-effort on every new flow. The RLS policy independently refuses anything younger than 24 h.
  - Regression: GID4-RET-01 (a 3-day-old flow is deleted; a 2-hour-old flow is kept).

## 17. Known pre-existing failures

- Frontend typecheck: 34 errors outside this feature, unchanged.
- Vitest: one `[vitest-worker] Timeout calling "onTaskUpdate"` under load. It also occurs without this branch's changes, and every test passes.
- Backend ESLint: 33 errors in `src/learning/dto/quiz.contract.ts`, `src/learning/services/learner-dashboard.service.ts` and four e2e files, none touched here.
- From earlier phases (not in the batches above): `p63-domain-operations` and `archived-media-purge` (intermittent, also red on main), and `media` / `p53-support-attachments` 500-vs-413 under load (pass alone).

## 18. Remaining Phase 5-only items (need real Google or production)

- Real Google consent, token exchange and signature checks against Google's real JWKS and issuer.
- Production reverse-proxy facts:
  - the backend sees `https` (`X-Forwarded-Proto` + `trust proxy`), which the production-only `https://` origin check requires;
  - `PLATFORM_BASE_DOMAIN=atlass.dpdns.org`, so the callback host is accepted.
- The deploy plumbing for `GOOGLE_OAUTH_*` and `FLAG_AUTH_GOOGLE_*`, which doesn't exist yet by design, and its read-only verification on the VPS.
- A real test-user sign-in on the allowlisted academy (`ellzoz`, `b794e760-eb63-4b17-85a3-7a4f6a0c9418`), including its A6 code.
- Management stays off in `allowlist`.
- The production metrics and logs, checked for `[REDACTED]`.

## 19. Production readiness blockers (for Phase 5, not for Phase 4)

1. Merge this branch and deploy through the gated `apply_migrations` run: the Phase 1 migration together with its code.
2. Add the Google keys to `vps-deploy` and `deploy.yml` (Phase 5 code).
3. The GitHub secrets `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET` and `GOOGLE_OAUTH_REDIRECT_URI`, and the variables `FLAG_AUTH_GOOGLE_MODE` and `FLAG_AUTH_GOOGLE_ACADEMY_IDS`.
4. The Google Cloud client with the one redirect URI, `https://atlass.dpdns.org/api/v1/auth/google/callback`.

There are no code-level security blockers.

## 20. Verdict

**PHASE 4 COMPLETE — READY FOR PHASE 5.** The two real defects found (D-1, D-2) are fixed, with regression tests and end-to-end evidence. No known security defect remains in the Google implementation. Real-Google verification is Phase 5.
