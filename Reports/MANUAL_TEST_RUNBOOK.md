# ATLAS MANUAL TEST RUNBOOK

Living QA document. Currently covers: **Organization Management Completion**
(organization switcher, organization overview page, cross-tenant isolation
as experienced through the actual product), **P3 — Academy Management**
(academy creation/settings/branding/members/stats, cross-tenant isolation,
write-authorization), **P4 — Plans, Subscription & Entitlements**
(plan/add-on catalog, tenant subscription/usage/add-ons display,
entitlement/limit-gap behavior, trial policy read/write, cross-tenant
isolation), and **P5 — Course Management** (course/section/lesson
authoring, publish/unpublish, reorder, category/instructor read surfaces,
Academy isolation, write-authorization — now testable against real,
deterministic seed data via `npm run db:seed`). Update this file — don't
replace it — as later phases add
their own manual test sections.

---

## Environment

### Requirements

- Docker Desktop running (for PostgreSQL + Redis).
- Node.js ≥ 20.
- Two terminal windows/tabs (one for backend, one for frontend).

### 1. Start backend infrastructure

```bash
cd atlas-backend
docker compose up -d
```

Confirm both containers are healthy:

```bash
docker compose ps
```

Both `postgres` and `redis` should show `Up ... (healthy)`.

### 2. Backend environment file

If `atlas-backend/.env` doesn't exist yet:

```bash
cp .env.example .env
```

Then open `.env` and set a real `JWT_ACCESS_SECRET` (32+ characters — you
can generate one with `openssl rand -hex 32`).

**Check `CORS_ALLOWED_ORIGINS` in `.env` matches the port the frontend will
actually run on.** The frontend's default dev port is `5173`. If
`CORS_ALLOWED_ORIGINS` is set to anything else (e.g. `3001`), the frontend
will fail every API call with a CORS error and nothing in this runbook
will work. Set it to:

```
CORS_ALLOWED_ORIGINS=http://localhost:5173
```

(Adjust if your frontend actually starts on a different port — check the
terminal output when you start it in step 4.)

### 3. Install and migrate the backend

```bash
cd atlas-backend
npm install
npm run prisma:migrate:deploy
npm run dev
```

Confirm it's running: open `http://localhost:3000/v1/health` in a browser
or `curl` it — you should see `{"status":"ok", ...}`.

The API is served under `http://localhost:3000/api/v1`.

### 4. Frontend environment file

The frontend's compiled-in dev default (`http://localhost:3000/api`) is
**missing the `/v1` segment** the backend actually requires (a known,
previously-reported gap — not something to fix as part of this runbook).
Create `atlas frontend/.env.local`:

```
VITE_API_BASE_URL=http://localhost:3000/api/v1
```

### 5. Start the frontend

```bash
cd "atlas frontend"
npm install
npm run dev
```

Note the port Vite prints (default `http://localhost:5173`). If it differs
from what you set in `CORS_ALLOWED_ORIGINS` (step 2), go back and fix
that, then restart the backend (`npm run dev` again).

### Local URLs

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:3000/api/v1`
- Backend health: `http://localhost:3000/v1/health`
- Backend Swagger docs (non-production only): `http://localhost:3000/api/docs`

---

## Test Accounts

There is no seed script and no self-service organization-creation flow yet
(Phase P14 provisioning). Test accounts and organizations must be created
by hand, once, before running the test cases below. **These are disposable
local-only credentials you create yourself against your own local
database — never real credentials, never committed anywhere.**

### Step A — Register two users through the real UI

1. Open `http://localhost:5173/register` (or whatever the sign-up route
   resolves to from the sign-in page's "Sign up" link).
2. Register **User A**:
   - Name: `Test Owner A`
   - Email: `org-manual-a@atlas.test`
   - Password: `TestPassword123!`
3. Register **User B**:
   - Name: `Test Owner B`
   - Email: `org-manual-b@atlas.test`
   - Password: `TestPassword123!`

(Registration does not sign you in automatically — this is intentional
product behavior, not a bug. Sign in separately for each test case below.)

### Step B — Seed organizations (SQL, one-time)

Organization creation has no UI/API yet in this phase, so seed directly
against your local dev database via Docker:

```bash
docker exec -i atlas-backend-postgres-1 psql -U atlas -d atlas_dev
```

Then, inside the `psql` prompt, find each user's id:

```sql
SELECT id, email FROM users WHERE email IN ('org-manual-a@atlas.test', 'org-manual-b@atlas.test');
```

Copy the two `id` values, then (replacing `<USER_A_ID>` / `<USER_B_ID>`
with what you just copied):

```sql
-- Organization A, owned by User A
INSERT INTO organizations (id, name, slug, owner_user_id, updated_at)
VALUES (gen_random_uuid(), 'Atlas Test Organization A', 'atlas-test-org-a', '<USER_A_ID>', now())
RETURNING id;
-- copy the returned id as <ORG_A_ID>

INSERT INTO organization_memberships (id, organization_id, user_id, role, is_primary)
VALUES (gen_random_uuid(), '<ORG_A_ID>', '<USER_A_ID>', 'owner', true);

-- Organization B, owned by User B
INSERT INTO organizations (id, name, slug, owner_user_id, updated_at)
VALUES (gen_random_uuid(), 'Atlas Test Organization B', 'atlas-test-org-b', '<USER_B_ID>', now())
RETURNING id;
-- copy the returned id as <ORG_B_ID>

INSERT INTO organization_memberships (id, organization_id, user_id, role, is_primary)
VALUES (gen_random_uuid(), '<ORG_B_ID>', '<USER_B_ID>', 'owner', true);

-- User A also joins Organization B as a regular member (for the switching test)
INSERT INTO organization_memberships (id, organization_id, user_id, role, is_primary)
VALUES (gen_random_uuid(), '<ORG_B_ID>', '<USER_A_ID>', 'member', false);
```

Type `\q` to exit `psql`.

### Accounts summary

| Name | Email | Password | Organization(s) | Purpose |
|---|---|---|---|---|
| Test Owner A | `org-manual-a@atlas.test` | `TestPassword123!` | Owner of Org A; member of Org B | Primary test account — switching, isolation |
| Test Owner B | `org-manual-b@atlas.test` | `TestPassword123!` | Owner of Org B only | Cross-tenant isolation target |
| (unseeded) | Register any third address, skip Step B | — | none | Zero-organization empty-state testing |

### Step C — P3 addendum: grant Academy permission strings

The frontend gates every Academy route behind `RouteGuard`'s
`requiredPermissions` — `academy.view`, `academy.configure`,
`academy.branding.update`, `academy.members.view`,
`academy.provisioning.view`, `academy.provisioning.create` (confirmed by
direct inspection of `AppRouter.tsx`). These are **frontend route guards
only** — the backend's own authorization (organization membership for
read, `academy_members` owner/administrator role for write — see
`Reports/ARCHITECTURE.md`'s P3 entry) is independent and enforced
regardless of what this array contains. Without these strings, however,
the UI itself will redirect away before any backend call is even made, so
the test accounts need them to reach the pages at all:

```sql
UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create'
]
WHERE organization_id = '<ORG_A_ID>' AND user_id = '<USER_A_ID>';

UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create'
]
WHERE organization_id = '<ORG_B_ID>' AND user_id = '<USER_B_ID>';
```

No academy needs to be pre-seeded — `P3-MANUAL-001` creates one through
the real UI, which is the point of testing it.

### Step D — P4 addendum: grant Tenant/Plan permission strings and seed a Plan + Subscription

The frontend gates every Tenant/Plan route: `tenant.dashboard.view`,
`tenant.subscription.view`, `tenant.usage.view`, `tenant.addon.view`
(confirmed by direct inspection of `AppRouter.tsx`) — same "frontend route
guard, independent of backend authorization" caveat as Step C.
`platform-trial` additionally requires the `platform_owner` **role**, not
a permission string (see Step E below).

```sql
UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create',
  'tenant.dashboard.view', 'tenant.subscription.view', 'tenant.usage.view', 'tenant.addon.view'
]
WHERE organization_id = '<ORG_A_ID>' AND user_id = '<USER_A_ID>';

UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create',
  'tenant.dashboard.view', 'tenant.subscription.view', 'tenant.usage.view', 'tenant.addon.view'
]
WHERE organization_id = '<ORG_B_ID>' AND user_id = '<USER_B_ID>';
```

There is no Plan-creation UI/endpoint (P4 ships zero catalog-write
capability) — seed a Plan and a Subscription for Organization A directly:

```sql
INSERT INTO plans (id, key, name, status, display_order, limits, features, pricing, updated_at)
VALUES (
  gen_random_uuid(), 'atlas-manual-starter', 'Starter', 'active', 1,
  '{"academies":2,"students":50,"instructors":5,"staff":5,"courses":20,"generalStorage":10,"videoStorage":10}',
  '{"cms":true,"seo":true,"seoAdvanced":false,"marketing":false,"marketingAdvanced":false,"analytics":false,"analyticsAdvanced":false,"customDomain":false,"themes":true,"multipleThemes":false,"backup":false}',
  '{"amount":29,"currency":"USD","billingCycle":"monthly"}', now()
)
RETURNING id;
-- copy the returned id as <PLAN_A_ID>

INSERT INTO tenant_subscriptions (organization_id, plan_id, status, trial_ends_at, updated_at)
VALUES ('<ORG_A_ID>', '<PLAN_A_ID>', 'trialing', now() + interval '7 days', now());
```

Optionally, an Add-on that raises the `academies` limit by 1, compatible
with the seeded plan (used by `P4-MANUAL-007`):

```sql
INSERT INTO add_ons (id, key, name, effect, compatible_plan_keys, updated_at)
VALUES (
  gen_random_uuid(), 'atlas-manual-extra-academy', 'Extra Academy',
  '{"type":"limit","limitKey":"academies","amount":1}',
  ARRAY['atlas-manual-starter'], now()
)
RETURNING id;
-- copy the returned id as <ADDON_A_ID>

INSERT INTO tenant_add_ons (id, organization_id, add_on_id)
VALUES (gen_random_uuid(), '<ORG_A_ID>', '<ADDON_A_ID>');
```

**`tenant_usage` is deliberately NOT seeded here** — `P4-MANUAL-005`
exists specifically to test the real "not yet computed" empty state, then
the real recompute trigger. Do not pre-populate it.

### Step E — P4 addendum: grant Platform Owner (for Trial Policy tests only)

```sql
UPDATE users SET is_platform_owner = true WHERE id = '<USER_A_ID>';
```

Only grant this on a throwaway/dedicated test account, or remember to
revert it afterward — `is_platform_owner` is global and affects every
Platform-Owner-gated surface, not just Trial Policy.

### Step F — P5 addendum: use the real seed script instead of manual SQL

As of P5, Steps A–E's manual psql seeding is no longer the only option.
From `atlas-backend`, run:

```bash
npm run db:seed
```

This creates real, deterministic P0–P5 fixture data in one command —
6 users (all password `DevPassword123!`), 2 organizations, 3 academies, 3
plans + 2 add-ons + 2 subscriptions, 3 course categories, 4 courses (2
published, 2 draft, one fully Arabic-content), 5 sections, 9 lessons — and
prints the account list at the end. Safe to re-run (idempotent — updates
the same rows, never duplicates). See `Reports/PROGRESS.md`'s P5 entry for
the full fixture graph and `prisma/seed.ts`'s own header comment for
details.

Grant the Course permission strings to the seeded accounts you'll test
with (same "frontend route guard, independent of backend authorization"
caveat as Steps C/D):

```sql
UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create',
  'tenant.dashboard.view', 'tenant.subscription.view', 'tenant.usage.view', 'tenant.addon.view',
  'course.view', 'course.create', 'course.update', 'course.manage', 'course.configure'
]
WHERE user_id = (SELECT id FROM users WHERE email = 'sarah.chen@acme-academy.dev');

UPDATE organization_memberships
SET permissions = ARRAY[
  'academy.view', 'academy.configure', 'academy.branding.update',
  'academy.members.view', 'academy.provisioning.view', 'academy.provisioning.create',
  'tenant.dashboard.view', 'tenant.subscription.view', 'tenant.usage.view', 'tenant.addon.view',
  'course.view', 'course.create', 'course.update', 'course.manage', 'course.configure'
]
WHERE user_id = (SELECT id FROM users WHERE email = 'omar.hassan@nextgen-learning.dev');
```

If you'd rather keep using Steps A–E's manually-seeded `org-manual-*`
accounts for the P5 cases below instead of the new seeded accounts, that
also works — the P5 cases don't depend on the specific seeded names, only
on having an Academy with at least one published and one draft course.

---

## Manual Test Cases

### ORG-MANUAL-001

**Feature:** Authenticated entry into the Organization environment

**Preconditions:** Backend and frontend both running (see Environment). User A and B registered and seeded (Steps A/B above).

**Test Account:** Test Owner A

**Exact Steps:**
1. Open `http://localhost:5173/login`
2. Enter email: `org-manual-a@atlas.test`
3. Enter password: `TestPassword123!`
4. Click **Sign In**.
5. Wait for the dashboard to load.

**Expected Result:** You land on the dashboard. The topbar (top-right area) shows an organization control reading **"Atlas Test Organization A"** with a building icon and a chevron, to the left of the language and theme switcher icons.

**Security Verification:** N/A for this test.

**Result:** [x] **PASS** [ ] FAIL [ ] RETEST REQUIRED

**Tester Notes:** Confirmed 2026-08-24 (Attempt 2, see retest history) — sign-in redirected correctly to `/dashboard`, "No Organization" state displayed correctly for this membership-less test user, `/dashboard/organization` correctly showed the same empty state. See "Findings observed during exploratory navigation" below for unrelated issues noticed while retesting — not part of this test, not blocking this PASS.

#### Retest history

**Attempt 2 — PASS (confirmed 2026-08-24)**

- Sign-in redirected correctly from `/auth/sign-in` to `/dashboard`.
- Dashboard correctly showed the "No Organization" state (this test user has no membership — expected, not a bug).
- `/dashboard/organization` correctly showed the same empty state.
- Root-cause fix (`useSignIn` delegating to `useAuth().signIn`) confirmed working end-to-end in the real browser, not just via automated verification.
- **ORG-MANUAL-001 is now CLOSED — PASS.**

**Attempt 1 — FAIL (reported 2026-08-24)**

- **Observed:** Registration and sign-in both worked at the network level
  (`POST /api/v1/auth/sign-in` → `200`, response contained `accessToken`,
  `refreshToken`, `user`), but the browser never left `/auth/sign-in` — no
  redirect to the dashboard occurred, and no auth token appeared in
  `localStorage`. A separate, repeated `/api/config` proxy error was also
  observed and reported alongside it.
- **Test user actually used:** a real account the tester registered
  directly (not the runbook's documented fixture) — `Zoz40500` /
  `zoz40500@gmail.com`, user id `40e8b831-02e7-457a-a601-0c75318fa094`,
  `is_platform_owner: false`. **Organization: none. Membership: none. Role:
  none.** This is expected, not a bug — no organization-creation flow
  exists yet (Phase P14), so a freshly self-registered user genuinely has
  zero organizations; the empty-state UI (`OrganizationSwitcher`/
  `OrganizationOverviewPage`) is what should have appeared *after* reaching
  the dashboard, which the tester never reached.
- **Root cause:** `src/shared/hooks/useSignIn.ts` called
  `authenticationService.signIn()` directly — the raw service that only
  talks to the backend and returns tokens, never persists them
  (`tokenService.store`) and never updates `IdentityContext`'s session
  state (`setSession`). Only `IdentityProvider`'s own `signIn` (exposed via
  `useAuth()`) does the complete `sessionService.signIn` → store tokens →
  `setSession` sequence that `isAuthenticated` and every redirect
  (`RouteGuard`, `SignInPage`'s own effect) depend on. The backend call
  succeeding was therefore never in question — nothing downstream of it
  ever ran. This bug pre-dates the Organization Management Completion pass
  entirely; manual browser testing is what surfaced it, since no automated
  test (backend e2e or otherwise) exercises this frontend hook.
- **`/api/config` relationship: INDEPENDENT.** Traced to `src/lib/config.ts`
  — a legacy, unrelated "runtime config" loader from the original template
  scaffold (a Lambda-style pattern: fetch a config endpoint at boot, fall
  back to compiled defaults on failure). Its only consumer is
  `main.tsx`'s one-time `await loadRuntimeConfig()` before the React tree
  mounts; the failure is caught internally and never propagates. The real
  Atlas API client (`httpClient`) is constructed from `ENV.apiBaseUrl`
  (`src/config/env.config.ts`) and never reads anything from
  `lib/config.ts` — confirmed by grep: no other file imports from it. Not
  touched — Vite's proxy target (`BACKEND_PORT` env var, defaulting to
  `8000`, unrelated to the real backend's port 3000) is legacy/dead
  infrastructure, noisy but harmless, out of this fix's scope per explicit
  instruction not to touch unrelated modules.
- **Fix:** `useSignIn` now delegates to `useAuth().signIn(credentials)`
  instead of calling `authenticationService.signIn()` directly — reuses the
  existing, already-correct `IdentityProvider` implementation rather than
  duplicating/rebuilding it. One file changed:
  `src/shared/hooks/useSignIn.ts`.
- **Unrelated issue found and fixed during regression verification:** the
  backend e2e suite failed intermittently (`waitFor` timeout on the
  password-reset tests) while re-verifying this fix. Root cause: a
  separately running `npm run dev` backend instance (the tester's own
  manual-testing server) and the automated e2e test process both point at
  the same local Redis, and their BullMQ workers raced to consume the same
  `password-reset-email` job — whichever process's worker won determined
  whether the *other* process's in-memory `StubEmailProvider` ever saw the
  result. Fixed by giving the BullMQ connection an environment-scoped
  Redis key prefix (`bull-test` under `NODE_ENV=test`, `bull` otherwise) in
  `src/app.module.ts`, so test and dev instances never share a queue
  namespace again, regardless of what else happens to be running locally.
  Confirmed fixed: e2e suite runtime dropped from 136s (colliding) to
  ~17s (isolated), 14/14 suites green, twice consecutively.
- **Automated verification after fix:** frontend typecheck/lint/build all
  PASS (0 new errors); backend typecheck/lint/build/unit (51/51)/e2e
  (54/54, twice) all PASS.
- **Exact manual test to repeat:** the same 5 steps above, unchanged.

---

### ORG-MANUAL-002

**Feature:** Organization overview page

**Preconditions:** Signed in as Test Owner A (continue from ORG-MANUAL-001, or repeat sign-in).

**Test Account:** Test Owner A

**Exact Steps:**
1. In the left sidebar, find the **Organization** section (near the top, just below "Overview"/"Dashboard").
2. Click **Organization**.
3. Wait for the page to load.

**Expected Result:** The page shows:
   - Title "Organization"
   - A card with a building icon, the name "Atlas Test Organization A"
   - Slug: `atlas-test-org-a-<random suffix>`
   - A status badge reading "Active"
   - "Your relationship: Owner"
   - A "Created" date (today's date)

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-003

**Feature:** Organization switching

**Preconditions:** Signed in as Test Owner A. User A must be seeded as a member of both Organization A and Organization B (Step B above).

**Test Account:** Test Owner A

**Exact Steps:**
1. Click the organization control in the topbar (showing "Atlas Test Organization A").
2. A dropdown opens listing organizations. Confirm both **"Atlas Test Organization A"** and **"Atlas Test Organization B"** appear, with a checkmark next to Organization A (the currently active one).
3. Click **"Atlas Test Organization B"**.
4. Observe the topbar control updates to show "Atlas Test Organization B".
5. Navigate to **Organization** in the sidebar again.

**Expected Result:**
   - The topbar immediately reflects "Atlas Test Organization B" after step 3, with no page reload.
   - The Organization overview page (step 5) shows Organization B's data: name "Atlas Test Organization B", "Your relationship: Member" (not Owner — User A is a regular member of Org B, not its owner).
   - No data from Organization A appears anywhere on this page.

**Security Verification:** Confirm the slug/status/created-date shown are Organization B's real values, not stale/cached Organization A values.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-004

**Feature:** Organization switching persists across a page refresh

**Preconditions:** Continue from ORG-MANUAL-003 — currently switched to Organization B.

**Test Account:** Test Owner A

**Exact Steps:**
1. With Organization B active (from ORG-MANUAL-003), press your browser's refresh button (or `Cmd+R` / `F5`).
2. Wait for the app to reload and reach the dashboard.
3. Look at the topbar organization control.

**Expected Result:** The topbar still shows "Atlas Test Organization B" — the active organization survived the full page reload (session restoration re-validates and re-applies it from `localStorage`).

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-005 — SECURITY

**Feature:** Cross-tenant isolation (User A cannot reach Organization B's data they don't belong to, and User B cannot reach Organization A)

**Preconditions:** Sign out of Test Owner A first (Account menu / sign-out control, if present, or clear the browser's local storage for the site and reload).

**Test Account:** Test Owner B (`org-manual-b@atlas.test`)

**Exact Steps:**
1. Sign out of Test Owner A's session completely.
2. Sign in as Test Owner B (`org-manual-b@atlas.test` / `TestPassword123!`).
3. Click the organization switcher in the topbar.
4. Observe the list of organizations offered.
5. Navigate to **Organization** in the sidebar.
6. Note the exact URL shown in the browser's address bar.
7. Open a new browser tab. Manually construct a URL by taking the URL from step 6 and, if it contains any identifiable organization reference, attempt to substitute Organization A's id (found via the `psql` query in Step B of the Test Accounts setup) in place of anything resembling one. If the URL contains no such reference at all (expected — the overview page has no id in its own URL), instead: in the same tab, open browser DevTools → Application/Storage → Local Storage, and manually edit the `atlas:active-organization` key to Organization A's id, then refresh the page.

**Expected Result:**
   - Step 4: only **"Atlas Test Organization B"** appears in the switcher — Organization A is never listed, because User B has no membership in it.
   - Step 7: after forcing `localStorage`'s active-organization key to Organization A's id and refreshing, the app must **not** display Organization A's data. Session restoration validates the stored id against the signed-in user's real memberships (`identity.types.ts`'s `OrganizationMembership[]`) and discards it if invalid — the app should fall back to Organization B (User B's real, only organization) or an unauthenticated/no-organization state, never silently show Organization A's name/slug/status.

**Security Verification:** At no point should any Organization A data (name "Atlas Test Organization A", its slug, its status) become visible while signed in as User B, through any UI path attempted above.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-006 — SECURITY

**Feature:** Backend independently rejects cross-tenant access even if the frontend were bypassed

**Preconditions:** Signed in as Test Owner B. Browser DevTools open (Network tab) or a terminal with `curl`.

**Test Account:** Test Owner B

**Exact Steps:**
1. While signed in as User B, open DevTools → Application/Storage → Local Storage, and copy the value of the auth token storage key (`atlas:auth-tokens`) — specifically the `accessToken` field inside the stored JSON.
2. In a terminal, run (replacing `<ACCESS_TOKEN>` and `<ORG_A_ID>` with the values you have):
   ```bash
   curl -i http://localhost:3000/api/v1/organizations/<ORG_A_ID> \
     -H "Authorization: Bearer <ACCESS_TOKEN>"
   ```

**Expected Result:** HTTP response status is `403` (or `404`) — never `200`, and the response body never contains `"Atlas Test Organization A"` or its slug. This proves the backend enforces the boundary itself (guard + Row-Level Security), independent of anything the frontend UI does or doesn't prevent.

**Security Verification:** This is the security verification — a direct backend request with a real, valid access token for a user with no membership in the target organization must fail.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-007

**Feature:** Zero-organization empty state

**Preconditions:** A third, freshly registered user with **no** organizations seeded (do not run Step B for this account).

**Test Account:** Register a new account, e.g. `org-manual-empty@atlas.test` / `TestPassword123!` — do not seed any organization/membership for it.

**Exact Steps:**
1. Register the new account via `http://localhost:5173/register`.
2. Sign in with it.
3. Look at the topbar organization control.
4. Navigate to **Organization** in the sidebar.

**Expected Result:**
   - Step 3: the topbar shows a non-interactive (greyed out / disabled-looking) control reading "No organization" — not a broken/empty dropdown, not an error.
   - Step 4: the Organization page shows an empty-state panel: an icon, the heading "No organization yet", and explanatory text — not a loading spinner stuck forever, not a raw error message, not a blank page.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-008

**Feature:** Loading and error states

**Preconditions:** Signed in as Test Owner A, on the Organization overview page.

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to **Organization** in the sidebar.
2. Immediately (within ~1 second) observe the page before data arrives.
3. Once loaded, stop the backend: in the backend terminal, press `Ctrl+C`.
4. Refresh the Organization page in the browser.
5. Wait for the request to fail.
6. Restart the backend (`npm run dev` in `atlas-backend`).
7. Click the retry control on the error state.

**Expected Result:**
   - Step 2: a skeleton/placeholder loading state is visible briefly (grey animated blocks), not a blank white page.
   - Step 5: an error state appears — an icon/message indicating the data couldn't be loaded, with a retry button. No raw stack trace, no unstyled browser error page.
   - Step 7: after the backend is back up, clicking retry successfully loads the real organization data again.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-009

**Feature:** Localization — Arabic / RTL

**Preconditions:** Signed in as Test Owner A, on the Organization overview page (or with the switcher visible).

**Test Account:** Test Owner A

**Exact Steps:**
1. Use the language switcher (globe/languages icon in the topbar) to switch to Arabic.
2. Observe the page direction changes to right-to-left.
3. Open the organization switcher dropdown.
4. Navigate to the Organization overview page.

**Expected Result:**
   - The whole layout mirrors to RTL (sidebar moves to the right, text aligns right).
   - The organization switcher's dropdown items, the "Organization" sidebar label, and the overview page's title/labels/status badge all display in Arabic, not English, and not showing any raw translation keys (e.g. never literally `organization:overview.title` on screen).
   - Switching organizations still works correctly in RTL mode.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-010

**Feature:** Responsive behavior (mobile viewport)

**Preconditions:** Signed in as Test Owner A.

**Test Account:** Test Owner A

**Exact Steps:**
1. Open browser DevTools, toggle device toolbar / responsive mode, set viewport to a phone width (e.g. 375px).
2. Observe the topbar and organization control.
3. Tap the hamburger/menu icon to open the mobile navigation drawer.
4. Find and tap **Organization** in the drawer.

**Expected Result:**
   - Step 2: the organization control remains visible and usable at narrow width (its label may truncate with an ellipsis, but the building icon and chevron stay visible and tappable).
   - Step 4: the drawer closes after navigating, and the Organization overview page renders correctly at mobile width (card stacks vertically, no horizontal overflow/scrolling).

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### ORG-MANUAL-011

**Feature:** Keyboard accessibility

**Preconditions:** Signed in as Test Owner A, desktop viewport.

**Test Account:** Test Owner A

**Exact Steps:**
1. Click into the page body, then press `Tab` repeatedly until focus reaches the organization switcher control.
2. Press `Enter` or `Space` to open the dropdown.
3. Press the `Down Arrow` key to move between organization options.
4. Press `Enter` to select an organization.

**Expected Result:** The switcher trigger receives a visible focus ring when tabbed to; the dropdown opens via keyboard; arrow keys move between items; `Enter` selects the highlighted one and the active organization updates, matching the mouse-driven flow in ORG-MANUAL-003.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

## P3 — Academy Management Test Cases

Preconditions common to all of the below: Step A/B/C completed (Test Owner
A/B registered, seeded with organizations, and granted the Academy
permission strings). Backend and frontend both running.

### P3-MANUAL-001

**Feature:** Academy creation (real UI form, real backend call)

**Test Account:** Test Owner A

**Exact Steps:**
1. Sign in as Test Owner A.
2. Navigate to `/dashboard/academy/create`.
3. Fill in Name: `Atlas Test Academy A`, Slug: `atlas-test-academy-a` (leave other fields default).
4. Submit.

**Expected Result:** The form submits successfully (no validation error), you're taken to the new academy's page/dashboard, and its name/slug match what you entered. Status shows as `draft`.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-002

**Feature:** Academy switcher / list reflects real data

**Test Account:** Test Owner A

**Exact Steps:**
1. After completing P3-MANUAL-001, look for an academy switcher/list control (sidebar or topbar, depending on where `AcademySwitcher` is mounted).
2. Open it.

**Expected Result:** `Atlas Test Academy A` appears in the list — not a stale cached name, not empty.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-003

**Feature:** Academy settings page loads real data

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to the academy's settings/configure page (`academy.configure`-gated route).
2. Observe the pre-filled form values.

**Expected Result:** Name, slug, timezone (`UTC`), language (`en`), currency (`USD`) are pre-filled with the real values from creation — not blank, not placeholder text.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-004

**Feature:** Update academy settings

**Test Account:** Test Owner A

**Exact Steps:**
1. On the settings page, change Name to `Atlas Test Academy A (Renamed)`.
2. Change Status to `active`.
3. Save.
4. Refresh the page.

**Expected Result:** The save succeeds, and after refresh the new name and `active` status persist — proving the change reached the backend, not just local form state.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-005

**Feature:** Update academy branding

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to the branding page (`academy.branding.update`-gated route).
2. Enter a logo URL, e.g. `https://example.com/logo.png`.
3. Save.
4. Refresh the page.

**Expected Result:** The logo URL persists after refresh; if the page renders a preview, it attempts to load that URL.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-006

**Feature:** Academy members list — creator auto-added as owner

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to the academy members page (`academy.members.view`-gated route).

**Expected Result:** Exactly one member is listed: Test Owner A, role `owner`, status `active` — the automatic owner-membership created alongside the academy, not an empty list.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-007

**Feature:** Academy stats reflect real data

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to the academy dashboard/stats view.

**Expected Result:** Total Members shows `1`. Active Staff and Active Instructors show `0`. Published Courses shows `0` (honestly — no Course Management exists yet in this phase; this is not a bug).

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-008 — SECURITY

**Feature:** Cross-tenant isolation — Academy never visible across organizations (UI)

**Test Account:** Test Owner B

**Exact Steps:**
1. Sign in as Test Owner B (owner of Organization B only — has no membership in Organization A).
2. Look at every academy list/switcher control reachable from the dashboard.

**Expected Result:** `Atlas Test Academy A` (created under Organization A) never appears anywhere in Test Owner B's session — no list, no switcher, no search result.

**Security Verification:** This is the primary check — confirm the academy created under a DIFFERENT organization is completely absent from this user's UI, not merely unclickable.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-009 — SECURITY

**Feature:** Cross-tenant isolation — direct URL access denied (API-level)

**Test Account:** Test Owner B

**Exact Steps:**
1. While signed in as Test Owner B, copy Test Owner A's academy id from `P3-MANUAL-001` (from the URL bar while signed in as A, or from the database).
2. Manually navigate to that academy's detail/settings URL while signed in as B.
3. Open browser DevTools → Network tab and inspect the API response.

**Expected Result:** The page shows an error/forbidden state, never the real academy data. The underlying `GET /api/v1/academies/<id>` call returns `403` or `404` — never `200`.

**Security Verification:** This is the primary check — direct-object-reference access across tenants must be refused at the API level, not merely hidden by the UI.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-010

**Feature:** Organization membership alone does not grant Academy write access

**Preconditions:** A third user, seeded as a regular (`member`) — not `owner` — of Organization A, with the Step C permission strings granted, but with **no** `academy_members` row for `Atlas Test Academy A` (do not add one).

**Test Account:** the third seeded user

**Exact Steps:**
1. Sign in as the third user.
2. Navigate to `Atlas Test Academy A`'s detail page.
3. Attempt to change its name and save.

**Expected Result:** Step 2 succeeds (read is organization-membership-scoped). Step 3 fails with a permission/forbidden error — the backend's `PATCH /academies/:id` call returns `403`, and the name is unchanged after a refresh. This proves organization membership alone never implies Academy write access (see `Reports/ARCHITECTURE.md`'s P3 entry).

**Security Verification:** Confirm via DevTools Network tab that the PATCH call itself returns `403`, not merely that a button was disabled client-side.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-011

**Feature:** Archive (soft-delete) an academy

**Test Account:** Test Owner A

**Exact Steps:**
1. On `Atlas Test Academy A`'s settings page, find and use the delete/archive action.
2. Confirm the action if prompted.
3. Refresh the page or navigate back to it.

**Expected Result:** The academy's status shows `archived`. It is NOT removed from the database (soft-delete only) — it may disappear from an "active academies" list view but its detail page (if still reachable) still loads with real data and `status: archived`.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-012

**Feature:** Duplicate slug validation

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/academy/create`.
2. Enter Name: `Duplicate Test`, Slug: `atlas-test-academy-a` (the same slug used in `P3-MANUAL-001`).
3. Submit.

**Expected Result:** A clear validation/conflict error is shown (not a generic "Unexpected error", not a silent failure) — the backend's `409` is surfaced meaningfully to the user.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-013

**Feature:** Zero-academy empty state

**Preconditions:** Test Owner B's Organization B has no academies (do not create one for it).

**Test Account:** Test Owner B

**Exact Steps:**
1. Sign in as Test Owner B.
2. Navigate to the academy list/switcher.

**Expected Result:** A clear empty state ("No academies yet" or similar) — not a blank page, not a stuck loading spinner, not a raw error.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-014

**Feature:** Loading and error states

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `Atlas Test Academy A`'s detail page and observe it within ~1 second of navigation (before data arrives).
2. Once loaded, stop the backend (`Ctrl+C` in its terminal).
3. Refresh the page.
4. Restart the backend (`npm run dev`).
5. Use the retry control, if present.

**Expected Result:** Step 1: a skeleton/placeholder loading state, not a blank page. Step 3: a styled error state with retry, not a raw stack trace. Step 5: retry succeeds once the backend is back.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-015

**Feature:** Academy activity feed — honest empty state

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `Atlas Test Academy A`'s activity view, if one exists in the UI.

**Expected Result:** An empty state is shown ("No recent activity" or similar) — not an error, not a loading spinner stuck forever. This is expected: no activity/event-log data source exists yet in this phase (see `Reports/PROGRESS.md`'s P3 entry) — an empty list is the correct, honest result, not a bug.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-016

**Feature:** i18n / RTL rendering

**Test Account:** Test Owner A

**Exact Steps:**
1. Switch the app language to Arabic (language switcher, topbar).
2. Navigate through the academy create/settings/branding/members pages.

**Expected Result:** All Academy-related labels are translated (not showing raw translation keys like `academy.create.title`), and the layout correctly mirrors to right-to-left.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-017

**Feature:** Responsive layout

**Test Account:** Test Owner A

**Exact Steps:**
1. Open DevTools, switch to a mobile viewport (e.g. 375×667).
2. Navigate through the academy create/settings/members pages.

**Expected Result:** No horizontal scroll, no overlapping/clipped controls, forms remain usable.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P3-MANUAL-018

**Feature:** Keyboard accessibility

**Test Account:** Test Owner A

**Exact Steps:**
1. On the academy create page, navigate the entire form using only Tab/Shift+Tab/Enter — no mouse.
2. Submit using only the keyboard.

**Expected Result:** Every field and the submit button are reachable and usable via keyboard alone, with a visible focus indicator at each step.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

## P4 — Plans, Subscription & Entitlements Test Cases

Preconditions common to all of the below: Step A/B/C/D completed (Test
Owner A/B registered, seeded with organizations, granted the Academy AND
Tenant/Plan permission strings, and Organization A has a seeded Plan +
Subscription). Backend and frontend both running.

### P4-MANUAL-001

**Feature:** Plan catalog display

**Test Account:** Test Owner A

**Exact Steps:**
1. Sign in as Test Owner A.
2. Navigate to `/dashboard/tenant/subscription` (or wherever the plan comparison / upgrade dialog is reachable from).
3. Open the plan comparison view, if present.

**Expected Result:** The seeded "Starter" plan appears with its real limits (2 academies, 50 students, etc.) and features — not placeholder/hardcoded data.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-002

**Feature:** Add-on catalog display

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/tenant/add-ons`.
2. Look for a catalog/available-add-ons section, if the page shows one alongside active add-ons.

**Expected Result:** The seeded "Extra Academy" add-on (if seeded per Step D) appears with its real effect described (raises the academies limit by 1) — not a generic placeholder.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-003

**Feature:** Current subscription display

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/tenant/subscription`.

**Expected Result:** Shows status `trialing`, the "Starter" plan name, and a trial end date roughly 7 days out — all real, matching the seeded row, not a hardcoded default.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-004

**Feature:** Trial countdown display

**Test Account:** Test Owner A

**Exact Steps:**
1. On the subscription page, look for a trial countdown ("X days remaining" or similar).

**Expected Result:** The countdown reflects the subscription's own `trialEndsAt` (~7 days), not `DEFAULT_TRIAL_POLICY`'s constant or the platform Trial Policy's `durationDays` re-derived client-side.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-005

**Feature:** Usage — honest "not yet computed" empty state

**Preconditions:** `tenant_usage` has NOT been seeded/recomputed for Organization A yet (per Step D's explicit instruction).

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/tenant/usage`.

**Expected Result:** A clear empty/not-yet-available state — not a blank page, not a raw error, not fabricated zero values presented as real data. This is expected: the `tenant-usage-recompute` worker has never run for this organization yet.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-006

**Feature:** Usage — real data after recompute

**Test Account:** Test Owner A (plus terminal access to run the CLI script)

**Exact Steps:**
1. In a terminal, from `atlas-backend`, run: `npm run worker:recompute-usage -- <ORG_A_ID>`.
2. Confirm the script prints a success message.
3. Refresh `/dashboard/tenant/usage` in the browser.

**Expected Result:** The page now shows real usage: `academies` used count matches how many academies actually exist under Organization A (0 unless `P3-MANUAL-001` was also run for this account), against a limit of 2 (or 3, if the Extra Academy add-on was seeded per Step D). `students`/`courses`/storage show `0` — honestly, not as an error (no source data exists yet for those in this phase).

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-007

**Feature:** Entitlement limit combination (base plan + add-on)

**Preconditions:** The Extra Academy add-on was seeded and activated per Step D; `P4-MANUAL-006` has been completed (a recompute has run).

**Test Account:** Test Owner A

**Exact Steps:**
1. On `/dashboard/tenant/usage`, find the "academies" row.

**Expected Result:** The limit shown is 3 (base plan's 2 + the add-on's +1), not 2 — proving the UI reads the combined effective entitlement, not the bare plan limit.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-008

**Feature:** Active add-ons list

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/tenant/add-ons`.
2. Look at the "active"/"currently on your subscription" section.

**Expected Result:** The seeded "Extra Academy" add-on appears (if seeded per Step D) with a real activation date — an empty list if none was seeded, not an error.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-009 — SECURITY

**Feature:** Cross-tenant isolation — subscription/usage/add-ons never visible across organizations (UI)

**Test Account:** Test Owner B

**Exact Steps:**
1. Sign in as Test Owner B (owner of Organization B only).
2. Navigate to `/dashboard/tenant/subscription`, `/dashboard/tenant/usage`, `/dashboard/tenant/add-ons`.

**Expected Result:** Every page shows Organization B's own state (likely "no subscription" — Organization B has no seeded subscription per Step D) — never Organization A's Starter plan, trial countdown, usage numbers, or add-ons.

**Security Verification:** This is the primary check — confirm Organization A's data never leaks into Organization B's session under any of these three pages.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-010 — SECURITY

**Feature:** Cross-tenant isolation — direct API access denied

**Test Account:** Test Owner B

**Exact Steps:**
1. While signed in as Test Owner B, open browser DevTools → Network (or use `curl` with Test Owner B's access token).
2. Attempt `GET /api/v1/organizations/<ORG_A_ID>/subscription`, `.../usage`, `.../add-ons`.

**Expected Result:** Every call returns `403` — never `200`, never Organization A's real data.

**Security Verification:** This is the primary check — direct-object-reference access across tenants must be refused at the API level.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-011

**Feature:** No-subscription empty state

**Preconditions:** An organization with no seeded `tenant_subscriptions` row (Organization B, per Step D, has none).

**Test Account:** Test Owner B

**Exact Steps:**
1. Navigate to `/dashboard/tenant/subscription`.

**Expected Result:** A clear "no subscription" / "not yet subscribed" empty state — not a blank page, not a stuck spinner, not a raw 404 dumped to the screen.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-012

**Feature:** Trial Policy read (Platform Owner)

**Preconditions:** Test Owner A granted `is_platform_owner = true` per Step E.

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/platform/trial`.

**Expected Result:** The page loads and shows the real current trial policy (`enabled`, `durationDays`) — defaults to `enabled: true, durationDays: 7` if never changed before, matching `DEFAULT_TRIAL_POLICY`.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-013

**Feature:** Trial Policy authorized update

**Preconditions:** Same as `P4-MANUAL-012`.

**Test Account:** Test Owner A (platform owner)

**Exact Steps:**
1. On `/dashboard/platform/trial`, change "Duration (days)" to `14`.
2. Save.
3. Refresh the page.

**Expected Result:** The save succeeds, and after refresh `durationDays: 14` persists — proving the change reached the backend.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-014 — SECURITY

**Feature:** Trial Policy unauthorized access denied

**Preconditions:** Test Owner B is NOT a platform owner (do not grant it).

**Test Account:** Test Owner B

**Exact Steps:**
1. Sign in as Test Owner B.
2. Attempt to navigate directly to `/dashboard/platform/trial` by typing the URL.
3. If the page renders at all, open DevTools → Network and inspect any `PATCH /api/v1/trial-policy` attempt.

**Expected Result:** Step 2: the frontend's own `RouteGuard requiredRoles={['platform_owner']}` redirects away or shows an access-denied state. Step 3 (if reachable by any means, e.g. a raw `curl` PATCH with Test Owner B's token): the backend independently returns `403` — the write is refused at the API level regardless of what the frontend route guard does.

**Security Verification:** This is the primary check — confirm the backend re-verifies `is_platform_owner` from the database rather than trusting anything client-supplied.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-015

**Feature:** Trial Policy invalid payload validation

**Preconditions:** Same as `P4-MANUAL-012`.

**Test Account:** Test Owner A (platform owner)

**Exact Steps:**
1. On `/dashboard/platform/trial`, attempt to enter a negative number (e.g. `-5`) for "Duration (days)".
2. Attempt to save.

**Expected Result:** A clear validation error is shown (client-side and/or a surfaced backend `400`) — not a silent failure, not a value that gets saved anyway.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P4-MANUAL-016

**Feature:** Loading and error states

**Test Account:** Test Owner A

**Exact Steps:**
1. Navigate to `/dashboard/tenant/subscription` and observe it within ~1 second of navigation (before data arrives).
2. Once loaded, stop the backend (`Ctrl+C` in its terminal).
3. Refresh the page.
4. Restart the backend (`npm run dev`).
5. Use the retry control, if present.

**Expected Result:** Step 1: a skeleton/placeholder loading state, not a blank page. Step 3: a styled error state with retry, not a raw stack trace. Step 5: retry succeeds once the backend is back.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

## P5 — Course Management Test Cases

Preconditions common to all of the below: `npm run db:seed` has been run
(Step F), and `sarah.chen@acme-academy.dev` has been granted the Course
permission strings. Academy A1 (`web-development-academy`) has two real
seeded courses: "React Fundamentals" (published, paid $49.99, 2
sections/4 lessons, instructor Jane Doe) and "Node.js Backend Development"
(draft, free, 1 section/2 lessons).

### P5-MANUAL-001

**Feature:** Course list

**Test Account:** Sarah Chen (`sarah.chen@acme-academy.dev` / `DevPassword123!`)

**Exact Steps:**
1. Sign in and navigate to `/dashboard/academy/<ACADEMY_A1_ID>/courses`.

**Expected Result:** Both seeded courses appear — "React Fundamentals" (published) and "Node.js Backend Development" (draft) — with real titles, statuses, and thumbnails/pricing, not placeholder data.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-002

**Feature:** Course details

**Test Account:** Sarah Chen

**Exact Steps:**
1. Open "React Fundamentals" from the course list.

**Expected Result:** Shows real title/description, status `published`, price `$49.99`, category "Web Development", and instructor "Jane Doe" — all matching the seeded data exactly.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-003

**Feature:** Category display (read-only)

**Test Account:** Sarah Chen

**Exact Steps:**
1. Look for a category selector/filter on the course list or course create/edit form.

**Expected Result:** "Web Development" and "Programming" (the seeded categories) appear as real, selectable options. There is no "create new category" control anywhere — this is confirmed, deliberate P5 scope (categories are read-only; see `Reports/PROGRESS.md`'s P5 entry), not a missing feature.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-004

**Feature:** Course creation

**Test Account:** Sarah Chen

**Exact Steps:**
1. Navigate to `/dashboard/academy/<ACADEMY_A1_ID>/courses/create`.
2. Fill in Title: `Manual Test Course`, Slug: `manual-test-course`, Visibility: private, Pricing: free.
3. Submit.

**Expected Result:** The course is created and you're taken to its detail/builder page. It now appears in the course list from P5-MANUAL-001.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-005

**Feature:** Course editing

**Test Account:** Sarah Chen

**Exact Steps:**
1. On the course created in P5-MANUAL-004, change the title to `Manual Test Course (Edited)`.
2. Save.
3. Refresh the page.

**Expected Result:** The new title persists after refresh — proving the change reached the backend.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-006

**Feature:** Instructor assignment — confirmed not available

**Test Account:** Sarah Chen

**Exact Steps:**
1. Look for an "assign instructor" control anywhere on the course detail/builder/settings pages.

**Expected Result:** No such control exists anywhere in the product — confirmed, deliberate scope decision (no `CourseService` method, no form, no UI defines this capability anywhere in the frontend). "React Fundamentals" still correctly shows Jane Doe as its instructor (seeded directly), proving the READ side works even though there's no write UI.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-007

**Feature:** Section creation

**Test Account:** Sarah Chen

**Exact Steps:**
1. Open the course builder for the course created in P5-MANUAL-004.
2. Add a new section titled `Getting Started`.

**Expected Result:** The section appears in the curriculum immediately, persists after refresh.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-008

**Feature:** Lesson creation

**Test Account:** Sarah Chen

**Exact Steps:**
1. Within the section from P5-MANUAL-007, add a lesson titled `Welcome`, content type Text.

**Expected Result:** The lesson appears nested under its section, persists after refresh.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-009

**Feature:** Section reorder

**Test Account:** Sarah Chen

**Exact Steps:**
1. On "React Fundamentals" (2 seeded sections: "Introduction", "React Basics"), use the move-down/move-up control to reverse their order.
2. Refresh the page.

**Expected Result:** The new order persists after refresh — proving it reached the backend, not just local UI state.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-010

**Feature:** Lesson reorder

**Test Account:** Sarah Chen

**Exact Steps:**
1. Within "Introduction" (2 seeded lessons: "Welcome", "Environment Setup"), reverse their order using move-down/move-up.
2. Refresh the page.

**Expected Result:** The new order persists after refresh.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-011

**Feature:** Publish

**Test Account:** Sarah Chen

**Exact Steps:**
1. On "Node.js Backend Development" (seeded as draft), use the Publish action.

**Expected Result:** Status changes to `published` immediately in the UI, persists after refresh.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-012

**Feature:** Unpublish

**Test Account:** Sarah Chen

**Exact Steps:**
1. On the course just published in P5-MANUAL-011, use the Unpublish action.

**Expected Result:** Status reverts to `draft`, persists after refresh.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-013

**Feature:** Validation / error states

**Test Account:** Sarah Chen

**Exact Steps:**
1. On the course create form, attempt to submit with the slug `react-fundamentals` (already taken in this academy).
2. Attempt to submit with an invalid slug like `Not A Valid Slug!`.

**Expected Result:** Both attempts show a clear validation/conflict error, not a generic "Unexpected error" and not a silent failure.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-014 — SECURITY

**Feature:** Academy isolation

**Test Account:** Omar Hassan (`omar.hassan@nextgen-learning.dev`)

**Exact Steps:**
1. Sign in as Omar Hassan (owner of Academy B1 only).
2. Attempt to navigate directly to `/dashboard/academy/<ACADEMY_A1_ID>/courses` (Academy A1's real id, copied while signed in as Sarah).

**Expected Result:** Access is denied — an error/forbidden state, never Academy A1's real course data. Confirm via DevTools Network tab that the underlying API call returns `403`.

**Security Verification:** This is the primary check — confirm no cross-academy course data leaks into a user with no relationship to that academy's organization.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-015 — SECURITY

**Feature:** Unauthorized mutation

**Test Account:** Lisa Park (`lisa.park@acme-academy.dev` — Org A member, no Academy A1 role)

**Exact Steps:**
1. Sign in as Lisa Park and grant her the Course permission strings (Step F) if not already done.
2. Navigate to "React Fundamentals"'s detail page — should load (read is org-membership-scoped).
3. Attempt to edit the title and save.

**Expected Result:** Step 2 succeeds. Step 3 fails with a permission error — confirm via DevTools that the underlying `PATCH` call returns `403`, and the title is unchanged after a refresh.

**Security Verification:** Confirms organization membership alone never implies Course write access (matches the equivalent Academy-level finding from P3).

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-016

**Feature:** Empty state

**Test Account:** Omar Hassan

**Exact Steps:**
1. Sign in as Omar Hassan and navigate to Academy B1's course list (Academy B1 has 2 seeded courses — "Spanish for Beginners" and the Arabic course, so this will show real data; to see a genuine empty state, use a freshly-created Academy with zero courses instead, e.g. create one first).

**Expected Result:** A course-free academy shows a clear "No courses yet" empty state — not a blank page, not a stuck spinner.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-017

**Feature:** Loading and error states

**Test Account:** Sarah Chen

**Exact Steps:**
1. Navigate to the course list and observe it within ~1 second (before data arrives).
2. Once loaded, stop the backend (`Ctrl+C`).
3. Refresh the page.
4. Restart the backend and use the retry control.

**Expected Result:** Step 1: a skeleton/loading state, not a blank page. Step 3: a styled error state with retry, not a raw stack trace. Step 4: retry succeeds once the backend is back.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-018

**Feature:** Arabic content / RTL rendering

**Test Account:** Omar Hassan

**Exact Steps:**
1. Sign in as Omar Hassan and open the seeded Arabic course ("أساسيات اللغة العربية") under Academy B1.
2. Switch the app's UI language to Arabic, if not already.

**Expected Result:** The course's own Arabic title/description render correctly (proving the plain-string DB columns round-trip non-Latin UTF-8 content, not just that the UI chrome translates) — this is different from and in addition to the UI chrome's own i18n, which prior phases' test cases (e.g. `ORG-MANUAL-009`) already cover. The page layout mirrors correctly to right-to-left.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

### P5-MANUAL-019

**Feature:** Responsive layout

**Test Account:** Sarah Chen

**Exact Steps:**
1. Open DevTools, switch to a mobile viewport (e.g. 375×667).
2. Navigate through the course list, course detail, and course builder (sections/lessons) pages.

**Expected Result:** No horizontal scroll, no overlapping/clipped controls, the curriculum editor (sections/lessons/reorder controls) remains usable at mobile width.

**Security Verification:** N/A for this test.

**Result:** [ ] PASS [ ] FAIL [ ] BLOCKED

**Tester Notes:**
________________________________

---

## Known Findings — Observed, Not Yet Investigated (logged, not fixed)

Reported by the human tester during exploratory navigation *after*
completing `ORG-MANUAL-001`'s required steps — not part of that test, not
a regression of the login/session fix, and explicitly **not fixed as part
of this fix pass**, per instruction to preserve scope. Recorded here so
they aren't lost, pending a dedicated investigation later.

1. **`GET /api/config` → HTTP 500.** Already root-caused as part of the
   `ORG-MANUAL-001` investigation above (see that entry's retest history)
   — a legacy, unrelated runtime-config loader (`src/lib/config.ts`) whose
   failure is caught internally and never reaches the real API client or
   auth flow. Confirmed independent, not touched. Restated here only
   because the tester re-observed the same symptom during this session.

2. **`/dashboard/profile` — `"useBlock must be used within a data router"`,
   originating from `useUnsavedChanges` / `ProfilePersonalSection`.** Not
   investigated. Not an Organization Management concern — pre-existing
   profile feature code, untouched by this or the prior pass.

3. **`/dashboard/notifications` — generic "Unexpected error" state.** Not
   investigated. Not an Organization Management concern — pre-existing
   notifications feature code, untouched by this or the prior pass.

None of these three affect `ORG-MANUAL-001`'s PASS result, the
Organization switcher/overview pages, or any backend authorization/RLS/
tenant-isolation guarantee. They belong to unrelated, pre-existing
features and should be picked up as their own investigation when in scope.

---

## Manual Test Coverage Summary

| Test ID | Feature | Covers |
|---|---|---|
| ORG-MANUAL-001 | Auth entry into org environment | Sign-in shows active organization |
| ORG-MANUAL-002 | Organization overview | Read-only org identity display |
| ORG-MANUAL-003 | Organization switching | Multi-org membership, cache correctness |
| ORG-MANUAL-004 | Switch persistence | localStorage restore on reload |
| ORG-MANUAL-005 | Cross-tenant isolation (UI) | No other tenant's org ever listed/shown |
| ORG-MANUAL-006 | Cross-tenant isolation (API) | Backend rejects direct-object access |
| ORG-MANUAL-007 | Empty state | Zero-organization UX |
| ORG-MANUAL-008 | Loading/error/retry | Network failure handling |
| ORG-MANUAL-009 | i18n / RTL | Arabic, right-to-left rendering |
| ORG-MANUAL-010 | Responsive | Mobile viewport |
| ORG-MANUAL-011 | Accessibility | Keyboard navigation |
| P3-MANUAL-001 | Academy creation | Real UI form → real backend call |
| P3-MANUAL-002 | Academy switcher/list | Reflects real data |
| P3-MANUAL-003 | Academy settings load | Pre-filled with real values |
| P3-MANUAL-004 | Academy settings update | Persists after refresh |
| P3-MANUAL-005 | Academy branding update | Persists after refresh |
| P3-MANUAL-006 | Academy members list | Auto-owner-membership on creation |
| P3-MANUAL-007 | Academy stats | Real counts, honest `publishedCourses: 0` |
| P3-MANUAL-008 | Cross-tenant isolation (UI) | Academy never listed across orgs |
| P3-MANUAL-009 | Cross-tenant isolation (API) | Direct URL access denied at API level |
| P3-MANUAL-010 | Write authorization | Org membership alone ≠ Academy write access |
| P3-MANUAL-011 | Archive academy | Soft-delete via status transition |
| P3-MANUAL-012 | Duplicate slug | Validation/conflict surfaced to user |
| P3-MANUAL-013 | Empty state | Zero-academy UX |
| P3-MANUAL-014 | Loading/error/retry | Network failure handling |
| P3-MANUAL-015 | Activity feed | Honest empty state (no event source yet) |
| P3-MANUAL-016 | i18n / RTL | Arabic, right-to-left rendering |
| P3-MANUAL-017 | Responsive | Mobile viewport |
| P3-MANUAL-018 | Accessibility | Keyboard navigation |
| P4-MANUAL-001 | Plan catalog | Real plan data displayed |
| P4-MANUAL-002 | Add-on catalog | Real add-on data displayed |
| P4-MANUAL-003 | Current subscription | Real status/plan/trial data |
| P4-MANUAL-004 | Trial countdown | Reads subscription's own `trialEndsAt` |
| P4-MANUAL-005 | Usage empty state | Honest "not yet computed" before recompute |
| P4-MANUAL-006 | Usage real data | Real counts after CLI-triggered recompute |
| P4-MANUAL-007 | Entitlement combination | Base plan + add-on limit combined correctly |
| P4-MANUAL-008 | Active add-ons list | Real activation data |
| P4-MANUAL-009 | Cross-tenant isolation (UI) | Subscription/usage/add-ons never leak across orgs |
| P4-MANUAL-010 | Cross-tenant isolation (API) | Direct URL access denied at API level |
| P4-MANUAL-011 | No-subscription empty state | Honest empty state, not a raw 404 |
| P4-MANUAL-012 | Trial Policy read | Platform Owner sees real policy |
| P4-MANUAL-013 | Trial Policy authorized update | Persists after refresh |
| P4-MANUAL-014 | Trial Policy unauthorized access | Frontend + backend both deny non-owner |
| P4-MANUAL-015 | Trial Policy invalid payload | Validation error surfaced |
| P4-MANUAL-016 | Loading/error/retry | Network failure handling |
| P5-MANUAL-001 | Course list | Real seeded courses displayed |
| P5-MANUAL-002 | Course details | Real title/price/category/instructor |
| P5-MANUAL-003 | Category display | Read-only, confirmed no create UI |
| P5-MANUAL-004 | Course creation | Real UI form → real backend call |
| P5-MANUAL-005 | Course editing | Persists after refresh |
| P5-MANUAL-006 | Instructor assignment | Confirmed not available; read side works |
| P5-MANUAL-007 | Section creation | Persists after refresh |
| P5-MANUAL-008 | Lesson creation | Nested under section, persists |
| P5-MANUAL-009 | Section reorder | Persists after refresh |
| P5-MANUAL-010 | Lesson reorder | Persists after refresh |
| P5-MANUAL-011 | Publish | Real status transition |
| P5-MANUAL-012 | Unpublish | Real status transition |
| P5-MANUAL-013 | Validation/error states | Duplicate/invalid slug surfaced |
| P5-MANUAL-014 | Academy isolation | Cross-academy access denied |
| P5-MANUAL-015 | Unauthorized mutation | Org membership alone ≠ Course write access |
| P5-MANUAL-016 | Empty state | Zero-course academy UX |
| P5-MANUAL-017 | Loading/error/retry | Network failure handling |
| P5-MANUAL-018 | Arabic content rendering | Non-Latin UTF-8 round-trips correctly |
| P5-MANUAL-019 | Responsive | Mobile viewport, incl. curriculum editor |

**Not covered (features not implemented this phase — see
`atlas-backend/Reports/PROGRESS.md`'s Organization Management Completion,
P3, P4, and P5 entries for why):** organization settings/rename,
membership invite/remove, role assignment (P2, still
`SPECIFICATION-UNDEFINED`); Academy member invite/remove/role-change,
Academy activity's real event sourcing (P3 scope); checkout, payment, plan
upgrade/downgrade mutation, add-on purchase, platform-wide scheduled usage
recomputation (P4 scope); course category create/update/delete, course
instructor assignment/removal (P5 scope — both confirmed, deliberate: no
frontend contract defines either), enrollments, student progress, quizzes,
assignments, grading (all explicitly out of P5 scope).

---

## Human Feedback Log

Record results here as they come back. Format: `TEST-ID  RESULT  DATE  NOTES`.

```
ORG-MANUAL-001   PASS (Attempt 2, after fix)   2026-08-24   Attempt 1 FAIL: useSignIn bypassed IdentityProvider's session update. Fixed and confirmed. See retest history above. 3 unrelated findings logged separately ("Known Findings" section) — not fixed, out of scope.
ORG-MANUAL-002   [ ]   ____________   ________________________________
ORG-MANUAL-003   [ ]   ____________   ________________________________
ORG-MANUAL-004   [ ]   ____________   ________________________________
ORG-MANUAL-005   [ ]   ____________   ________________________________
ORG-MANUAL-006   [ ]   ____________   ________________________________
ORG-MANUAL-007   [ ]   ____________   ________________________________
ORG-MANUAL-008   [ ]   ____________   ________________________________
ORG-MANUAL-009   [ ]   ____________   ________________________________
ORG-MANUAL-010   [ ]   ____________   ________________________________
ORG-MANUAL-011   [ ]   ____________   ________________________________
P3-MANUAL-001    [ ]   ____________   ________________________________
P3-MANUAL-002    [ ]   ____________   ________________________________
P3-MANUAL-003    [ ]   ____________   ________________________________
P3-MANUAL-004    [ ]   ____________   ________________________________
P3-MANUAL-005    [ ]   ____________   ________________________________
P3-MANUAL-006    [ ]   ____________   ________________________________
P3-MANUAL-007    [ ]   ____________   ________________________________
P3-MANUAL-008    [ ]   ____________   ________________________________
P3-MANUAL-009    [ ]   ____________   ________________________________
P3-MANUAL-010    [ ]   ____________   ________________________________
P3-MANUAL-011    [ ]   ____________   ________________________________
P3-MANUAL-012    [ ]   ____________   ________________________________
P3-MANUAL-013    [ ]   ____________   ________________________________
P3-MANUAL-014    [ ]   ____________   ________________________________
P3-MANUAL-015    [ ]   ____________   ________________________________
P3-MANUAL-016    [ ]   ____________   ________________________________
P3-MANUAL-017    [ ]   ____________   ________________________________
P3-MANUAL-018    [ ]   ____________   ________________________________
P4-MANUAL-001    [ ]   ____________   ________________________________
P4-MANUAL-002    [ ]   ____________   ________________________________
P4-MANUAL-003    [ ]   ____________   ________________________________
P4-MANUAL-004    [ ]   ____________   ________________________________
P4-MANUAL-005    [ ]   ____________   ________________________________
P4-MANUAL-006    [ ]   ____________   ________________________________
P4-MANUAL-007    [ ]   ____________   ________________________________
P4-MANUAL-008    [ ]   ____________   ________________________________
P4-MANUAL-009    [ ]   ____________   ________________________________
P4-MANUAL-010    [ ]   ____________   ________________________________
P4-MANUAL-011    [ ]   ____________   ________________________________
P4-MANUAL-012    [ ]   ____________   ________________________________
P4-MANUAL-013    [ ]   ____________   ________________________________
P4-MANUAL-014    [ ]   ____________   ________________________________
P4-MANUAL-015    [ ]   ____________   ________________________________
P4-MANUAL-016    [ ]   ____________   ________________________________
P5-MANUAL-001    [ ]   ____________   ________________________________
P5-MANUAL-002    [ ]   ____________   ________________________________
P5-MANUAL-003    [ ]   ____________   ________________________________
P5-MANUAL-004    [ ]   ____________   ________________________________
P5-MANUAL-005    [ ]   ____________   ________________________________
P5-MANUAL-006    [ ]   ____________   ________________________________
P5-MANUAL-007    [ ]   ____________   ________________________________
P5-MANUAL-008    [ ]   ____________   ________________________________
P5-MANUAL-009    [ ]   ____________   ________________________________
P5-MANUAL-010    [ ]   ____________   ________________________________
P5-MANUAL-011    [ ]   ____________   ________________________________
P5-MANUAL-012    [ ]   ____________   ________________________________
P5-MANUAL-013    [ ]   ____________   ________________________________
P5-MANUAL-014    [ ]   ____________   ________________________________
P5-MANUAL-015    [ ]   ____________   ________________________________
P5-MANUAL-016    [ ]   ____________   ________________________________
P5-MANUAL-017    [ ]   ____________   ________________________________
P5-MANUAL-018    [ ]   ____________   ________________________________
P5-MANUAL-019    [ ]   ____________   ________________________________
```

If any test FAILS: report it back with the exact Test ID and what you
observed instead of the expected result. It will be diagnosed, fixed, the
relevant automated tests re-run, this file updated, and the specific test
marked `RETEST REQUIRED` for you to try again — never silently marked
passed.
