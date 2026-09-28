# Google Authentication — production closeout

> **Status: RELEASE NOT YET EXECUTED.** Everything below that describes configuration, procedures and tooling is final. The sections marked *pending* are filled in only with real production evidence. Nothing in them is inferred or pre-written.

## 1. Architecture (unchanged since Phases 1–4)

- **Identity.**
  - One Atlas user is one global person.
  - A Google identity is keyed by Google's immutable `sub` (`user_auth_identities`, `UNIQUE(provider, provider_subject)`, `UNIQUE(user_id, provider)`).
  - Nothing is ever linked because an email address matches.
- **Flow.** Authorization Code + PKCE S256 + state + nonce:
  - a server-side flow row (`auth_oauth_flows`, hashed secrets, FORCE RLS);
  - a host-only `HttpOnly`/`Secure`/`Lax` binder cookie;
  - a one-time handoff in the URL fragment;
  - strict origin binding.
- **One central callback** on the platform host. The browser is returned to the origin the flow started on: the platform, an academy subdomain or a custom domain.
- **Google enters the normal pipeline:** account status → surface/host → TOTP → emailed code (A6) / trusted device (academy-scoped) → session. `refresh_tokens.auth_method` records `google` or `password`. "Last used" is written only from a session response's `authMethod`.
- **Linking.**
  - Same-email accounts: password proof in the link step.
  - A different email: only from signed-in settings, with the current password.
  - Unlinking needs a usable password.
  - Invitations use the canonical `claim_academy_invite`.
- **Tests and details:** `docs/GOOGLE_IDENTITY.md` and `docs/GOOGLE_AUTH_PHASE_4_VERIFICATION.md`.

## 2. Google Cloud configuration

| Item | Value |
|---|---|
| Project | Atlas Production (`atlas-production-509922`, number `111904368737`) |
| OAuth client | "Atlas Web Production" (Web application), the single client for every surface |
| Authorized JavaScript origins | **none** (server-side code flow; the SPA never talks to Google) |
| Authorized redirect URIs | **only** `https://atlass.dpdns.org/api/v1/auth/google/callback` |
| Scopes | `openid`, `email`, `profile` |
| Audience / status | External / Testing: only listed test users can sign in until the app is published |

The `Google verify` workflow's `probe` check asks Google itself to accept the client and redirect URI, so a mismatch is detected without a browser.

## 3. Redirect URI

`https://atlass.dpdns.org/api/v1/auth/google/callback` is the backend's `GET /auth/google/callback` under the `api` prefix and URI version `v1`. Caddy passes `/api/*` through unchanged. The route is served only when the request host equals `PLATFORM_BASE_DOMAIN`; any other host gets a 404.

## 4. Secrets and variables (names only)

| Name | Kind | Consumed by |
|---|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | GitHub secret | `configuration.ts` `googleAuth.clientId` |
| `GOOGLE_OAUTH_CLIENT_SECRET` | GitHub secret | the token exchange only (backend) |
| `GOOGLE_OAUTH_REDIRECT_URI` | GitHub secret | the authorize and token requests |
| `FLAG_AUTH_GOOGLE_MODE` | GitHub variable | `off` (default) · `allowlist` · `on` |
| `FLAG_AUTH_GOOGLE_ACADEMY_IDS` | GitHub variable | comma-separated academy UUIDs for `allowlist` |
| `FLAG_AUTH_GOOGLE_PLATFORM` | GitHub variable (optional) | `allowlist` only: `on` also offers Google on Atlas's own sign-in and sign-up (the platform host). `deploy.yml` passes `on` when the variable is unset; set it to `off` to turn the platform pages off without touching the academies. |

**Path:** GitHub secrets/variables → `deploy.yml` (both jobs) → `.github/actions/vps-deploy` → a base64 fragment over SSH stdin → `deploy.sh --sync-env` upserts `/opt/atlas/.env`, dropping empty values and never printing any → `docker-compose.prod.yml` `env_file: .env` → backend recreated.

**Never set in production:** `GOOGLE_OIDC_*`. The backend refuses to start with any of them set.

**Guard:** with the mode other than `off` and any of the three `GOOGLE_OAUTH_*` missing, the backend refuses to start.

## 5. Feature-flag rollout

1. Release with `FLAG_AUTH_GOOGLE_MODE` unset/`off`. Every Google route is 404, `/auth/options` answers `google: false`, and no button is shown.
2. Baseline production verification (password, OTP, A6, invitations, sessions).
3. Set `FLAG_AUTH_GOOGLE_ACADEMY_IDS=b794e760-eb63-4b17-85a3-7a4f6a0c9418` (ellzoz, after fresh verification) and `FLAG_AUTH_GOOGLE_MODE=allowlist`, then redeploy. **Management stays off in allowlist mode by design.**
4. Real-Google verification on ellzoz.
5. The final state stays **allowlist**. Moving to `on` is a separate, explicit product decision (§20).
6. **Atlas's own sign-in and sign-up pages** (the platform host) get Google through their own switch, `FLAG_AUTH_GOOGLE_PLATFORM=on`, which the deploy workflow sets unless the variable says `off`. The switch doesn't change the academy allowlist, and unlisted academies stay off.

   In Atlas, "platform" and "management" are **one surface**: `atlass.dpdns.org/auth/sign-in` is the management sign-in, and it mints management sessions for organization owners, staff and platform admins. A Google sign-in there runs the same pipeline as a password sign-in: account status, surface rules, TOTP, the management emailed code and trusted devices.

   A new person on `/auth/register` (alias `/auth/sign-up`) gets the Google create step, which carries the same organization-name and plan fields as the password form. Both are validated by the same canonical signup (`registerInternal` → `prepareSignupOrganization`), which creates the organization (onboarding pending), the owner membership and the trial atomically.

## 6. Migration

`20261019000000_google_identity_foundation` is additive; see Phase 4 §12. It ships **only** through the gated `Deploy` → `workflow_dispatch` with `apply_migrations=true`, which requires approval of the `production-migrations` environment. It must ship in the same release as the code, because every sign-in writes `refresh_tokens.auth_method`.

A push to `main` whose image carries it stops before rolling: "Nothing was migrated and nothing was rolled".

## 7. Deployment commits and runs

| What | Value |
|---|---|
| Backend `main` | `598e134` (merge of `claude/nifty-ride-h9nxql` at `bc79fc7`) |
| Frontend `main` | `fa429ac` (merge at `d71a83b`) |
| Pre-release snapshot | Google verify #1, run `36386447738` (28 Sep 06:26 UTC): healthy; latest backup `atlas-20260928T030852Z.sql.gz` gzip-OK with the users table; Google migration absent; ellzoz facts fresh |
| Push deploy | Deploy #216, run `36386437154`: stopped at the migration gate by design ("nothing migrated, nothing rolled") |
| Gated migration + deploy | Deploy #217, run `36386543938` (`apply_migrations=true`, `production-migrations` approved by the owner), completed 06:43 UTC; backend started 06:43:19 UTC; backup `atlas-20260928T064244Z.sql.gz` taken at release |
| Frontend deploy | atlas Deploy #124, run `36386503555` |
| Allowlist deploy | Deploy #218, run `36392199721` (`apply_migrations=false`), after `FLAG_AUTH_GOOGLE_MODE=allowlist` and `FLAG_AUTH_GOOGLE_ACADEMY_IDS=<ellzoz>,<hfghgf>` |

## 8. Production verification with Google OFF (28 Sep 2026, 07:03–07:06 UTC)

**Google verify #2, run `36389539352`** (secrets and release).

The running backend received:
- mode `off`;
- the exact redirect URI `https://atlass.dpdns.org/api/v1/auth/google/callback`;
- a client id shaped like a Google web client id;
- a client secret (presence only, 35 characters);
- no `GOOGLE_OIDC_*` override.

Also confirmed:
- migration `20261019000000_google_identity_foundation` applied;
- both tables present, FORCE RLS on flows, `refresh_tokens.auth_method` present;
- health 200 (database and Redis up) and zero error lines;
- the three Google alerts loaded in Prometheus;
- the release backup is gzip-OK.

**Google verify #4, run `36389770660`** (after the tooling fixes).
- `/auth/options` answers `google:false` on the platform and on eight academy hosts, including ellzoz and hfghgf.
- Management authorize is 404, authorize on ellzoz is 404, and the callback is a dead end (400).
- No identities or flows; no duplicate user or email.
- New sessions carry `auth_method` (`password/academy` 10, `password/management` 2).
- The one callback log line carrying a `code` shows `code=[REDACTED]`, the Phase 4 D-1 fix live in production.
- No secret-, JWT- or token-shaped values in 24 h of logs.

**Launch verify #10, run `36389556432`** (password baseline on the new backend): all five jobs pass.
- **API:**
  - A4: new learner; existing-account join with one user row.
  - A6:
    - Academy A's code is refused on B and on management;
    - the trust row is scoped to A, and a remembered browser skips only A's code;
    - a revoked device is asked again.
  - A5: academy-scoped `/users/me`.
  - A1: surface refusals.
  - A3: a password change revokes every session and every trusted device.
  - Metrics.
- **Browser:** management and academy sign-in with the emailed code.
- **Smart join:** API, plus browser in English (desktop) and Arabic (mobile).
- **Deliverability.**

**Test academies re-verified from live data** (Google verify #2/#3):
- ellzoz `b794e760-eb63-4b17-85a3-7a4f6a0c9418`: `ellzoz.atlass.dpdns.org`, website published, open registration, subscription trialing, 29 learners.
- hfghgf `9efcaacf-10e1-49e9-b82c-fefb198bd942`: `hfghgf.atlass.dpdns.org`, website published, open registration, subscription trialing, 10 learners.

## 9. Production verification in allowlist mode (28 Sep 2026, 07:34–07:36 UTC)

**Google verify #5, run `36392401888`** (`expect_mode=allowlist`), after Deploy #218. Every check passed.

**Allowlist:**
- ellzoz and hfghgf report `google:true`.
- The platform (management) reports `google:false`, and management authorize is 404.
- The six other academy hosts report `google:false`, including `sure-education` (invite policy).

**Flow start on ellzoz:**
- A foreign `Origin` is refused with 403.
- Authorize answers 200 with `https://accounts.google.com/o/oauth2/v2/auth`:
  - the exact redirect URI;
  - `response_type=code` and `scope=openid email profile`;
  - PKCE `S256`, with state and nonce present;
  - `prompt=select_account`;
  - a client id shaped like a Google web client id.
- The binder cookie is HttpOnly, Secure, SameSite=Lax, host-only, with path `/api/v1/auth/google`.

**Google accepted the configured client and redirect URI.** The authorize URL answered 302 to `accounts.google.com/v3/signin/identifier`, with no `redirect_uri_mismatch` and no `invalid_client`.

**Negative probes:**
- A callback on an academy host is 404.
- An unknown state is 400.
- An unknown handoff is 401 `googleSignInExpired`.

**Data, logs and metrics:**
- One flow row (the probe's own flow), with no identities and no duplicate users.
- All three callback lines carrying a code are redacted.
- No secret-, JWT- or token-shaped values in the logs.
- The Google alerts are loaded.

## 9b. Google on Atlas's own sign-in and sign-up (28 Sep 2026, 10:18–10:42 UTC)

**Finding from the real academy testing.** The platform pages (`/auth/sign-in`, `/auth/register`) showed no Google button. Allowlist mode only ever enabled listed academies. The platform host is the management surface, so `/auth/options` answered `google:false` there, and `GoogleSignInOption` renders nothing in that case.

The button, the Google create step (organization name + plan) and the canonical signup behind it already existed. A second gap: the sign-up page consumes the pricing-page plan intent on load, so after the Google round trip the create step started with no plan and no organization name.

**Fix:**
- **Backend:** `FLAG_AUTH_GOOGLE_PLATFORM`. In allowlist mode it enables the platform on its own switch; unlisted academies stay off.
- **Frontend:**
  - the sign-up page hands its draft (organization name, chosen plan, intended plan key) to Continue with Google;
  - the draft is saved in the tab's flow context (sessionStorage, never in a URL) and restored on the create step;
  - the same required-field rules apply there, and the server re-validates;
  - `/auth/sign-up` now redirects to `/auth/register`, keeping the query.

**Commits:**

| Repo | Branch commit | Merge to `main` |
|---|---|---|
| Backend | `216012f` | `162bf6f` |
| Frontend | `cef314a` | `479190e` |

Verify tooling: `91e0280` and `9ca79ad` (branch).

**Deploys:** backend Deploy #219 (`36408888135`, push, no migration; backend started 10:27:19 UTC) and frontend Deploy #125 (`36408893134`).

**Tests:**
- New backend e2e `google-platform-signup` passes 8/8.
- Google, onboarding and auth e2e regression: 164/164 across 10 suites.
- Backend unit tests: 3888/3888.
- Frontend: 1161/1161, including the new `google-platform-signup.test.tsx`.
- Lint, backend typecheck and both builds are clean.

**Google verify #7, run `36410491321`** (`allowlist`, `expect_platform=on`, from `main`): all checks passed.
- **Running config:** the platform switch is `on`.
- **Platform:** `/auth/options` answers `google:true`.
- **Academies:** ellzoz and hfghgf answer `true`; the six others answer `false`.
- **Platform flow:**
  - platform authorize returns 200 with the exact redirect URI, PKCE S256, state and nonce;
  - a foreign Origin gets 403 on the platform and on the academy;
  - Google accepts the client.
- **Data, logs and alerts:**
  - no duplicate identities or users;
  - 3/3 callback code lines are redacted;
  - no secrets or tokens in the logs;
  - the alerts are loaded.

**Google verify #9, run `36411155358`** (browser job, a real Chromium against production): all checks passed.
- **Pages:** in EN desktop and AR mobile, the platform sign-in and sign-up show Continue with Google beside the password form.
- **Fields:** sign-up shows the organization fields.
- **Layout:** Arabic is RTL, with no horizontal overflow.
- **Alias:** `/auth/sign-up?plan=starter` lands on `/auth/register?plan=starter`.
- **Round trip:** after typing an organization name and clicking Continue with Google, the browser reaches `accounts.google.com`. The name appears in **no** URL, and the tab's flow context carries it (`intent=sign_up`, `surface=management`).
- **Academy:** the ellzoz sign-in still shows Google.

## 10–13. Real-Google verification — *pending*

## 14. Known limitations

- **Testing publishing status:** only Google test users can complete Google sign-in until the app is published in Google Cloud (§20).
- **`allowlist` never enables management;** only `on` does.
- **Approval-policy academies:** a Google sign-up there is signed in with a *pending* membership, whereas the password sign-up stops at a "request pending" screen (Phase 2 behavior, noted in Phase 3).
- **Env keys are never deleted by deploys:** `deploy.sh` only upserts. To disable, set the variable to `off` (§17). Don't delete it.

## 15. Rollback

- **Fastest, no code change:** disable Google (§17). Password sign-in is unaffected and existing Google-linked accounts keep their links.
- **Code rollback:** `deploy.sh --rollback` on the VPS (the recorded last-good digests), or redeploy the previous `main` commit.
  - The Google migration is additive, so the old code runs on the new schema. There's no need to roll the schema back.
  - Never drop `refresh_tokens.auth_method` while new code is running.
- **Schema rollback** (only after a code rollback, and only if required): drop `user_auth_identities`, `auth_oauth_flows`, both `auth_method` columns and the two enums. This loses Google links and flow rows only; password accounts are untouched. Take a backup first.

## 16. Operational troubleshooting

| Symptom | Where to look | Likely cause |
|---|---|---|
| Google button missing everywhere | `Google verify` `config`: `mode` | flag off, or credentials missing (the backend would refuse to start) |
| Button missing on one academy | `config`: `academy_ids`; `probe` per host | academy not in the allowlist |
| `#error=failed` after Google | logs "Google sign-in callback failed." (`reason` only); alert `AtlasGoogleSignInProviderErrors` / `AtlasGoogleInvalidIdTokens` | secret rotated in Google but not in GitHub; client id mismatch; Google outage |
| Google shows `redirect_uri_mismatch` | `probe`: "Google accepts the client and the redirect URI" | the Cloud client's redirect URI differs byte-for-byte from `GOOGLE_OAUTH_REDIRECT_URI` |
| "This Google sign-in has expired…" | metrics `result="invalid_state"`, alert `AtlasGoogleInvalidFlowSurge` | the flow completed in another browser or origin, the handoff was replayed, or a proxy/host change |
| `googleOriginRefused` at start | `config`: `platform_base_domain`; proxy headers | the backend doesn't see `https` (`X-Forwarded-Proto`/`trust proxy`) |

## 17. Disable Google safely

1. Set the repository variable `FLAG_AUTH_GOOGLE_MODE=off`.
2. Run `Deploy` by `workflow_dispatch` with `apply_migrations=false`. The env sync recreates the backend.
3. Run `Google verify` with `expect_mode=off`.

Everything Google returns 404 and the button disappears. Linked accounts keep their identities, and those without a password recover with "Forgot password".

**Only Atlas's own pages:**
1. Set the repository variable `FLAG_AUTH_GOOGLE_PLATFORM=off` (an explicit `off`: an empty value is dropped by the env sync and would keep the last value).
2. Deploy as above.
3. Run `Google verify` with `expect_mode=allowlist` and `expect_platform=off`.

The academies are unaffected.

## 18. Rotate the Google client secret safely

1. In Google Cloud, **add** a new secret to the client. Google allows two active secrets.
2. Update the GitHub secret `GOOGLE_OAUTH_CLIENT_SECRET`, never in chat, docs or logs.
3. Run `Deploy` (`workflow_dispatch`, `apply_migrations=false`), then `Google verify` (`config,probe`) plus one real sign-in.
4. Only then **disable and delete** the old secret in Google Cloud.

If `AtlasGoogleSignInProviderErrors` fires after a rotation, step 2 or 3 didn't take effect.

## 19. Add another academy to the allowlist

1. Get the academy's UUID from fresh production data: `Google verify` `academy` with that UUID, or `hosts`.
2. Append it to `FLAG_AUTH_GOOGLE_ACADEMY_IDS` (comma-separated, no spaces).
3. `Deploy` (`workflow_dispatch`, `apply_migrations=false`).
4. `Google verify` with `expect_mode=allowlist`. Its probe expects Google on the first listed academy only; check others with `/auth/options` on their host.

## 20. From allowlist to global

This is a product decision, not an automatic step. Before switching:
- publish the Google app (Testing → In production) and complete any Google branding/verification it asks for;
- rerun the full real-Google matrix on at least two academies, including one custom domain.

Then:
1. Set `FLAG_AUTH_GOOGLE_MODE=on`. This enables every academy, and the platform whatever `FLAG_AUTH_GOOGLE_PLATFORM` says.
2. Deploy.
3. Run `Google verify` with `expect_mode=on`.

## 21. Test data cleanup — *pending*

## 22. Final production evidence — *pending*
