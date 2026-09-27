# Google Identity

**Status: Phase 1 (backend foundation) implemented, behind `FLAG_AUTH_GOOGLE_MODE=off`.**
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

## 3. Data

- `user_auth_identities`:
  - `UNIQUE(provider, provider_subject)`, `UNIQUE(user_id, provider)`;
  - `email_at_link` is display-only;
  - no RLS, like `users`/`refresh_tokens`/`user_two_factor`;
  - deleted with the account (`AccountDeletionService`).
- `auth_oauth_flows`: hashed secrets, PKCE verifier and the short-lived provider claims. FORCE RLS, with server-side policies plus a 24 h retention delete (the `auth_email_challenges` pattern).
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
| `FLAG_AUTH_GOOGLE_MODE` | repository variable → `feature_flags` | `off` (default: every Google route 404, options `false`) · `allowlist` (academy websites in `FLAG_AUTH_GOOGLE_ACADEMY_IDS` only; management off) · `on` |
| `FLAG_AUTH_GOOGLE_ACADEMY_IDS` | repository variable | comma-separated academy ids |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` / `GOOGLE_OAUTH_REDIRECT_URI` | GitHub secrets → VPS `.env` | the backend refuses to start with the flag on and any of them missing. Redirect URI: `https://<platform>/api/v1/auth/google/callback`, byte-for-byte as registered |
| `GOOGLE_OIDC_ISSUER` / `_AUTHORIZATION_ENDPOINT` / `_TOKEN_ENDPOINT` / `_JWKS_URI` | local/test only | a fake provider; **refused in production** |

The deploy plumbing (the `vps-deploy` fragment keys and the `feature_flags` lines) comes in the rollout phase. Until then production cannot receive the flag, so it stays off by construction.

## 5. Observability

- `atlas_google_auth_total{stage=authorize|callback|complete, result}`. Result is one of:
  - `started`, `cancelled`, `provider_error`, `invalid_state`, `invalid_token`;
  - `unverified_email`, `existing_identity`, `link_required`, `create_account`, `activate_invited`;
  - `refused`, `rate_limited`, `disabled`.
- Logs carry the flow id, stage and failure kind only. They never contain codes, tokens, ID tokens, addresses or subjects.

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

1. **Backend foundation**: this document.
2. **Identity resolution**:
   - link with password (Platform Owner: settings only);
   - create account (academy + organization signup);
   - invited activation plus the setup page;
   - existing-identity academy sign-up join;
   - settings sign-in methods and unlink;
   - notifications `auth.identity.linked` / `unlinked`; audit.
3. **Frontend**:
   - buttons on the four surfaces, the `/auth/google/return` page and the steps;
   - "Last used" (browser-local, written only from a session response);
   - EN/AR/RTL/mobile;
   - the canonical-host redirect exemption for the return page.
4. **Verification**: full suites, local browser journeys against the fake provider.
5. **Rollout**: Google Cloud client, secrets, deploy plumbing, `allowlist` then `on`, real Google test accounts.
