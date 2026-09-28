# Google Identity

**Status: Phases 1–2 (backend) implemented, behind `FLAG_AUTH_GOOGLE_MODE=off`.**
The approved plan is the investigation report of 27 Sep 2026; every open decision there was accepted as recommended.

Google is a **first factor** for the one global Atlas account. It replaces
the password step, and only that step. Everything after it is the existing
pipeline, unchanged:

- account status;
- surface and academy rules;
- TOTP;
- the A6 emailed code / trusted devices;
- `issueSession`.

Roles and access are never taken from Google.

---

## 1. Flow

The API is same-origin on every host (platform, academy subdomains, custom domains), and sessions live in per-origin storage. So the flow starts and ends on the **origin** host, and only the callback runs on the platform host: the single redirect URI registered with Google.

```
origin O  POST /auth/google/authorize {intent, returnTo?}
          → surface + academy derived from the request HOST (never the body)
          → auth_oauth_flows row: sha256(state), sha256(nonce), sha256(binder), PKCE verifier, O, surface, academy
          → Set-Cookie atlas_google_binder (host-only, HttpOnly, SameSite=Lax, Path=…/auth/google, 10 min)
          → { authorizationUrl }                      (openid email profile, S256, prompt=select_account)
Google    → GET https://<platform>/api/v1/auth/google/callback?code&state
          → state spent atomically → code exchanged (client secret + verifier) → ID token verified
          → claims stored on the row + single-use handoff (2 min)
          → 303 O/auth/google/return#h=<handoff>     (#error=cancelled|failed on failure; a dead end if no flow)
origin O  POST /auth/google/complete {handoff}        (binder cookie + same origin required)
          → identity (google, sub) → AuthService.continueSignIn(…, 'google')
          → session | emailOtpRequired | twoFactorRequired | refusal
          → or a follow-up step: link_required | create_account | activate_invited
```

`GET /auth/options` → `{ google: boolean }` for this host. It is the only thing the frontend needs; no client id ever reaches the browser bundle.

ID-token checks are done in `GoogleOidcClient`, with `node:crypto`:
- RS256 signature by the JWKS `kid` (cached; an unknown `kid` refetches at most once a minute);
- `iss` ∈ {`https://accounts.google.com`, `accounts.google.com`};
- `aud` = client id (plus `azp` when there are several audiences);
- `exp`/`iat` within 60 s;
- `nonce` = this flow's;
- `sub` and `email` present.

Google's access token is discarded, and no Google refresh token is requested.

## 2. Identity resolution (Phase 1)

| Situation | Answer |
|---|---|
| `email_verified` not true | 403 `errors.auth.googleEmailUnverified` |
| `(google, sub)` linked | the pipeline as for a password, with `authMethod: 'google'` |
| not linked, no account with the address | `create_account` step (Google name prefilled); **nothing created** |
| not linked, an `invited` account and Google is authoritative (`@gmail.com`, or `hd` = the address's domain) | `activate_invited` step |
| not linked, any other account with the address | `link_required` step; **never linked** by an email match |

A step returns a single-use `pending` secret (prefix `p.`, 10 min). It is bound to the same binder and origin, and `complete` refuses it. The step endpoints (link with the account's password, create, activate, settings linking) are **Phase 2**.

Stale, replayed or foreign completions all get the same 401 `errors.auth.googleSignInExpired`: an unknown/used/expired handoff, a missing or wrong binder, or another origin.

## 2a. Binding the identity (Phase 2)

| Endpoint | Guard | What it does |
|---|---|---|
| `POST /auth/google/link` `{pending, password}` | sign-in IP budget + the account's own sign-in budget | `link_required` step. The existing account's own password proves it (wrong password: generic 401 `invalidCredentials`, and the step stays open for another try). Then Google is connected and the sign-in continues (TOTP / A6 code). Suspended: 403 after the password. **A Platform Owner is refused** (403 `googleLinkFromSettings`) and links only from signed-in settings. Account already holding another Google account: 409 `googleAlreadyLinked`. An academy **sign-up** also joins this academy (Case 4). |
| `POST /auth/google/create-account` `{pending, name, organizationName?, planId?, inviteToken?}` | register IP budget | `create_account` step. ONE account through the same single registration transaction as a password signup: user (password = the `nopassword:` sentinel), identity, and the learner row under the registration policy (or the organization bundle on the management surface). The address is verified only if Google is authoritative. A fixable input (organization fields on an academy, missing/bad invite) keeps the step open. The address being taken meanwhile gives 409 `emailAlreadyRegistered`; the same Google account racing gives 409 `googleIdentityInUse`. |
| `POST /auth/google/activate` `{pending}` | Google IP budget | `activate_invited` step (authoritative address only). The invited account becomes active and verified with Google as its sign-in. There is no password, and outstanding setup links are spent. |
| `POST /auth/google/authorize {intent: 'link', currentPassword}` | optional JWT (**required** for `link`) + the account's sign-in budget | Account settings. The account is the session's, fixed at start. **Re-authentication:** the current password is required (401 `invalidCurrentPassword`), because a new sign-in method is persistent access and a stolen short-lived session must not be able to attach one. An account without a usable password already has Google, so it gets 409 `googleAlreadyLinked`. `complete` answers `{linked: true, email}` with no new session. Any Google address may be connected; a Google account owned by another Atlas account gives 409 `googleIdentityInUse` (never named). Platform Owners link here. |
| `POST /auth/google/authorize {intent: 'setup', setupToken}` | public | The invitation/setup page. The live setup token proves the mailbox, so any verified Google account becomes the sign-in, and the account is activated like the setup link would. Bad or used token: 401 `invalidResetToken`. |
| `GET /users/me/sign-in-methods` | JWT (either surface) | `{password: boolean, google: {email, linkedAt} \| null}` |
| `DELETE /users/me/sign-in-methods/google` `{currentPassword}` | JWT + sign-in budget | Disconnect. Requires a usable password (otherwise 409 `setPasswordFirst`; the fix is Forgot password) and its re-entry (401 `invalidCurrentPassword`). |

An **existing identity** starting an academy **sign-up** joins that academy through the same write as the password-proven join (`admitExistingAccount`: policy, invite binding, blocked/already checks, audit, `account.academy.joined`). Already a learner there means the sign-in simply continues (Case 3).

### Invite-only academies and an existing Google identity (Phase 2 hardening, 27 Sep 2026)

**Classification: a real Phase 2 gap, not an intended rule.**

The password path has always supported this. `POST /auth/academy-join` (an existing account proven by its password) accepts `inviteToken` and passes it to `admitExistingAccount`, which redeems it through the canonical `claim_academy_invite`.

On the Google path the code was lost:
- `finishSignIn` called the same join write, `joinAcademyAsExistingAccount`, without a code, because no Google endpoint except `create-account` accepted one. The global validation pipe even rejected the extra field.
- So an existing Google-linked account (or a password account linking Google in the same step) could never redeem a valid invitation at an `invite`-policy academy.

**Supported behavior now.** `POST /auth/google/complete`, `POST /auth/google/link` and `POST /auth/google/activate` accept an optional `inviteToken`. It is used only for an academy **sign-up** by an account that already exists, and it goes to the SAME join write as the password path.

- The academy is the flow's, fixed from the request host when the flow started. A code can never choose the academy.
- The code is redeemed only by `claim_academy_invite`: one atomic conditional `UPDATE` that matches this academy, not revoked, not expired, `used_count < max_uses`, and an addressed invite only for the **Atlas account's** email. This is the same binding the password join uses; the Google address is irrelevant.
- The registration policy stays authoritative:
  - no code → 403 `inviteRequired`;
  - a wrong, foreign-academy, expired, revoked, used-up or other-address code → 400 `inviteInvalid` (existing EN/AR copy), nothing written, nothing spent.
- An account that is already a learner there spends nothing and signs in; that check runs before the claim.
- The same user, the same memberships and roles elsewhere, no second account.
- A6: the newly joined academy's own emailed code still applies.
- Disclosure: the answers are the existing invite answers, and they are reachable only after Google proof plus the single-use handoff (or pending secret), the browser binder and the origin.

**Security model.** The invite code is authorization context, never identity. Google proves who the person is; Atlas decides admission from its own invitation row. The code travels in the body of the request that performs the join, and is not stored on the flow. It is a bearer credential the person already holds from their invite link, validated and spent server-side only; the academy and account it applies to come from server-side state.

**Races.** Two concurrent redemptions of a single-use code by the same account give exactly one membership and one use:
- the claim is one atomic `UPDATE`;
- the `(academy, user)` unique index decides the membership;
- the loser either finds the account already a learner (and signs in) or finds the code spent (`inviteInvalid`).

With a multi-use code a concurrent loser can spend one extra use. That is the existing semantics of the password join, which claims before inserting, and it is unchanged here.

**Tests** (`GID-INVITE-01..07`):
- a valid code joins B as the same user, with A/A2 memberships and roles unchanged, `source: invite`, one use, B's own code (A6), and an `authMethod: google` session on B;
- no code and a wrong code are refused, with EN + AR copy checked;
- foreign academy, expired, revoked, used up and other address are all refused, nothing spent;
- already a learner: nothing spent, the sign-in continues;
- a concurrent redemption gives one membership and one use;
- Case 4 via the link step (a password account links Google and redeems the code);
- a code bound to the Atlas email works when the Google address differs, and one bound to the Google address is refused.

Against the pre-fix code, `GID-INVITE-01` and `-06` fail (400: the field is rejected). A Google account owned by another Atlas account stays refused without naming anyone (`GID-SET-02`).

**Remaining, deliberate:** an invitation binds to the Atlas account's email, not to the Google address. This is the existing invitation semantics, unchanged.

Password reset and password change are unchanged. They still revoke sessions and trusted devices, and they **do not** remove the Google link. A Google-only account sets a password through "Forgot password" (email-based), after which it may disconnect Google.

**Notifications** (catalogue, EN/AR, email + in-app, security, never deduped, CTA = Forgot password):
- `auth.identity.linked`: sent on password link, settings link, invitation activation and setup;
- `auth.identity.unlinked`.

**Audit:** `auth.identity.linked` (context `via`: `password | settings | setup | invitation | new_account`) and `auth.identity.unlinked`.

## 2b. Frontend (Phase 3)

The SPA lives in the `atlas` repository, `src/features/auth/google/`.

- **Button**: "Continue with Google" on the management sign-in and sign-up, the academy website sign-in and sign-up (`?invite=` carried), and the setup link (`?setup=1`, intent `setup`). It is shown only when `GET /auth/options` answers `google: true`; otherwise nothing renders.
- **Starting a flow** (`useGoogleStart`):
  - stores a small context in `sessionStorage` (intent, surface, academy, where it started, where a session goes, invitation code, website locale); it holds no secret;
  - calls `authorize` (which sets the binder cookie), then leaves for Google;
  - a second click is ignored, and "Back" from Google (a bfcache restore) re-enables the button.
- **Return page** `/auth/google/return` (management `AuthLayout`; academy chrome in `PublicWebsiteRouter`, in the starting page's language):
  - reads the fragment once and removes it from the address bar, then presents the handoff exactly once (StrictMode-safe);
  - a session → the destination; a 2FA / email-code challenge → the existing challenge forms;
  - `link_required` / `create_account` / `activate_invited` → the step panel. Create uses the same fields and terms as the password sign-up of that surface (organization + trial plan on management); nothing is created before the person confirms;
  - `linked` (settings) → back to settings with a confirmation; a management refusal of a learner → the academy chooser; anything else → the reason and "Back".
- **Canonical-host redirect**: skips `/auth/google/return`, so a returning flow is never moved off its origin.
- **Account settings → Sign-in methods** (management profile and the academy learner security page):
  - connect and disconnect both ask for the current password;
  - no disconnect while Google is the only way in.
- **"Last used"**: `localStorage["atlas:last-auth-method"]`, written only where a session is established, from the response's `authMethod`. It is kept across sign-out, since that is when it is shown.
- **API client**: the Google completion and step endpoints are auth-lifecycle paths, where a 401 is final and never a refresh. `authorize` is not, because the settings `link` intent is a signed-in call.
- **Local verification** (the SPA build served same-origin behind a proxy, with an interactive fake Google): management create (organization, terms, email code), link with a wrong then right password, disconnect and reconnect from settings, and cancel. On an academy website in Arabic on a 390 px viewport: sign-up create, RTL with no overflow, an academy-only session, the Google-only settings state, and a returning identity signing straight in.

## 3. Data

- `user_auth_identities`:
  - `UNIQUE(provider, provider_subject)`, `UNIQUE(user_id, provider)`;
  - `email_at_link` is display-only;
  - no RLS, like `users`/`refresh_tokens`/`user_two_factor`;
  - deleted with the account (`AccountDeletionService`).
- `auth_oauth_flows`: hashed secrets, PKCE verifier and the short-lived provider claims. FORCE RLS, with server-side policies plus a 24 h retention delete (the `auth_email_challenges` pattern). The retention is enforced: every new flow deletes a bounded batch of flows whose lifetime ended more than 24 h ago (`pruneExpired`, Phase 4 fix D-2).
- `refresh_tokens.auth_method`, `auth_email_challenges.auth_method` (`password` | `google`):
  - the first factor of a session, carried through the TOTP (Redis payload) and the emailed-code challenge;
  - copied forward on rotation;
  - NULL on sessions minted before the column existed.
  - Every session response now carries `authMethod`. It is the source for the browser's "Last used" hint (Phase 3).

Migration `20261019000000_google_identity_foundation` is additive. It has no backfill.

**Deployment order is mandatory.** Every sign-in (password included) now writes `refresh_tokens.auth_method`. The migration must be applied through the gated `apply_migrations` deploy run in the same release as this code, **never after it**; otherwise every sign-in would fail on the missing column.

## 4. Configuration

| Variable | Where | Notes |
|---|---|---|
| `FLAG_AUTH_GOOGLE_MODE` | repository variable → `feature_flags` | `off` (default: every Google route 404, options `false`) · `allowlist` (academy websites in `FLAG_AUTH_GOOGLE_ACADEMY_IDS`; the platform/management host only with `FLAG_AUTH_GOOGLE_PLATFORM=on`) · `on` |
| `FLAG_AUTH_GOOGLE_PLATFORM` | repository variable → `feature_flags` | `allowlist` only: `on` offers Google on Atlas's own sign-in/sign-up (the management surface); `off` (backend default). `deploy.yml` passes `on` unless the variable says `off`. |
| `FLAG_AUTH_GOOGLE_ACADEMY_IDS` | repository variable | comma-separated academy ids |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | GitHub secrets → VPS `.env` | the backend refuses to start with the flag on and any of them missing. Redirect URI: `https://<platform>/api/v1/auth/google/callback`, byte-for-byte as registered |
| `GOOGLE_OIDC_ISSUER` / `_AUTHORIZATION_ENDPOINT` / `_TOKEN_ENDPOINT` / `_JWKS_URI` | local/test only | a fake provider; **refused in production** |

The deploy plumbing (the `vps-deploy` fragment keys and the `feature_flags` lines) comes in the rollout phase. Until then production cannot receive the flag, so it stays off by construction.

## 5. Observability

- `atlas_google_auth_total{stage=authorize|callback|complete|link|create|activate|unlink, result}`. Result is one of:
  - `started`, `cancelled`, `provider_error`, `invalid_state`, `invalid_token`;
  - `unverified_email`, `existing_identity`, `link_required`, `create_account`, `activate_invited`;
  - `refused`, `rate_limited`, `disabled`;
  - `linked`, `created`, `activated`, `unlinked`, `conflict`, `invalid_credentials`.
- Logs carry the flow id, stage and failure kind only. They never contain codes, tokens, ID tokens, addresses or subjects.
- The HTTP request logger censors the callback's `code` and `state` (and any `token`-like query parameter) in both the URL and the parsed query (`sensitive-query.util.ts`, Phase 4 fix D-1).

## 6. Tests

- `src/identity/google/*.spec.ts`:
  - the verifier (valid token; forged signature, wrong issuer/audience/azp, expired, future `iat`, nonce mismatch or missing, missing sub/email, `alg` none/HS256, unknown kid);
  - JWKS refetch throttling; a provider outage vs a bad token;
  - the authorization URL;
  - PKCE (RFC 7636 vector), secret hashing, return-path sanitizing, the Google-authority rule.
- `test/google-identity.e2e-spec.ts` runs the real backend flow against a local fake of Google's token endpoint and JWKS (`test/utils/fake-google-oidc.ts`), covering:
  - authorize: URL, cookie, host-derived context, host mismatch, unknown host, foreign Origin, relative-only return path, options;
  - callback: origin-only redirect with the fragment handoff, replay/unknown/missing state dead ends, platform-host only, cancel/fail, every token defect, a PKCE mismatch;
  - complete: binder, origin and replay refusals, unverified email, the three steps (nothing created or linked), the pending secret refused as a handoff;
  - linked sign-in: `authMethod` on the session, the row and through refresh; the A6 code still required on an academy site; a learner refused on management; suspended refused, with no session;
  - `returnPath`, deletion removing the identity, and flag off/allowlist.

## 7. Phases

1. **Backend foundation**: done.
2. **Identity resolution**: done (§2a):
   - link with password (Platform Owner: settings only);
   - create account (academy + organization signup);
   - invited activation plus the setup page;
   - existing-identity academy sign-up join;
   - settings sign-in methods and unlink;
   - notifications `auth.identity.linked` / `unlinked`; audit.
3. **Frontend**: done (§2b):
   - buttons on the four surfaces, the `/auth/google/return` page and the steps;
   - "Last used" (browser-local, written only from a session response);
   - EN/AR/RTL/mobile;
   - the canonical-host redirect exemption for the return page.
4. **Verification**: done. See `docs/GOOGLE_AUTH_PHASE_4_VERIFICATION.md`.
5. **Rollout**: Google Cloud client, secrets, deploy plumbing, `allowlist` then `on`, real Google test accounts.
