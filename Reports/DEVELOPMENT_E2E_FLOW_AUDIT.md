# Atlas — Development E2E Product Flow Audit

**Scope**: audit-only, local development, no fixes applied. Verified via static code analysis (both repos) AND real, live HTTP requests against the actual running local backend (`localhost:3000`, real local Postgres, real seeded + freshly-registered accounts). No production data, no real payments, no real emails. Nothing was modified.

---

## 1. Executive Summary

> Can a brand-new Client currently use Atlas locally from Sign Up → Plans → Plan Selection → Payment → Admin Approval → Client Setup → Theme Selection → Final Dashboard?

# **NO.**

Not "partially" — **the journey is structurally impossible today, for every account in the system, not just new ones.** This was verified empirically, not inferred: a freshly registered account was created and signed in through the real API, and a seeded, fully-privileged Organization Owner account (`sarah.chen@acme-academy.dev`, with an active paid subscription) was also tested. Both hit the same wall.

Three independent, compounding, root-cause defects were found, each sufficient on its own to block the entire journey:

1. **There is no way to create an Organization anywhere in the product.** No backend endpoint (`POST /organizations` returns a real `404` — confirmed live), no frontend page. `OrganizationService.ts`'s own comment admits it: *"Read-only: the backend does not yet expose an update/create/delete."* A brand-new user registers, signs in, and has `organizations: []` forever.

2. **Every frontend route/nav item gated by `requiredPermissions` is unreachable by every account in the system, including a seeded Organization Owner with an active paid subscription.** The frontend's `RouteGuard` fails closed on `organization.permissions.includes(...)` — and `OrganizationMembership.permissions` is a real database column that **no code anywhere ever populates** (hardcoded `permissions: []` even in the seed script; confirmed live via API — `sarah.chen`'s membership returns `"permissions": []` despite `"role": "owner"`). This silently hides Tenant Subscription, Tenant Billing, Academy Create, and Provisioning Start from **every user**, seeded or new.

3. **No code path anywhere creates the first `tenant_subscriptions` row for a new Organization.** `PaymentApplicationService`'s own doc comment: *"Throws... if there is no `tenant_subscriptions` row to update yet — real subscription CREATION is Phase P14 provisioning, not this phase's job."* But Phase P14's own orchestrator has a `'tenant'` step that does nothing (*"Always complete immediately... there is no 'create the tenant' work left"*) and never creates one either. Both phases documented this as "the other phase's job." Neither phase did it.

A fourth, separate defect compounds the "Theme Selection" part specifically: the provisioning orchestrator's `theme`/`branding`/`domain` steps are **hardcoded to always skip** (`return { result: 'skipped' }`, with a comment confirming this is deliberate for now). Theme selection is a real, substantial, working feature (5 themes, a registry, preview components) — but it lives inside Website Settings, reachable only after an Academy already exists, completely disconnected from onboarding.

None of this means the backend engineering from P0–P18 was wasted — the parts of the system that DO get reached (courses, learning, website builder, billing math, notifications) are real and well-tested, as the extensive prior audits already established. It means the **onboarding funnel that connects Sign Up to a working Academy was never fully wired end-to-end** — each phase (P2 Organizations, P4 Plans, P12 Billing, P14 Provisioning) correctly built its own piece and correctly documented what it deliberately left out, but the pieces left out by one phase were never picked up by the next, and a frontend-authorization assumption (real per-org permission strings) was never matched by a backend that actually produces them.

---

## 2. Actual Product Journey (as designed, reconstructed from code + master plan)

```
Sign Up (POST /auth/register)
  → Sign In (POST /auth/sign-in)
  → [MISSING] Create Organization
  → Browse Plans (GET /plans — works)
  → Select Plan → Checkout (POST /organizations/:id/checkouts)
  → Pay (POST /organizations/:id/payments, upload proof — "atlas_manual" provider)
  → [Platform Owner] Review & Approve (POST /payments/:id/approve)
  → [MISSING] First tenant_subscriptions row created
  → Provisioning Request (POST /organizations/:id/provisioning-requests)
  → Orchestrator runs: tenant (no-op) → academy (real) → theme (SKIPPED) →
    branding (SKIPPED) → subdomain (real) → domain (SKIPPED) → finalization
  → Academy exists, ready
  → [Disconnected] Theme selection — actually lives in Website Settings, not onboarding
  → Final Academy Dashboard
```

## 3. Current Local Journey (what actually happens today)

```
Sign Up  → WORKS (real 201, real Argon2id-hashed user row)
Sign In  → WORKS (real JWT, real session)
Dashboard → renders, but organizations: [] — almost every nav item requiring
            an organization context is either absent or leads nowhere
Plans    → NOT reachable through any navigation link (no page exists to browse
            them as a first-time action); the API itself works if called directly
Everything downstream → UNREACHABLE (no organization to attach it to, and even
            with one, permission-gated routes are unreachable for anyone)
```

This exactly matches the user's own description: "Go to Dashboard / Sign In... the dashboard is mostly empty."

---

## 4. Route Inventory (frontend — the journey-relevant subset)

| Route | Page | Guard | Reachable via nav? |
|---|---|---|---|
| `/auth/register` | `RegistrationPage` | public | YES |
| `/auth/sign-in` | `SignInPage` | public | YES |
| `/dashboard` | `DashboardOverviewPage` | `requireAuthentication` | YES |
| — (no route) | *(no "browse plans" page exists)* | — | **N/A — MISSING** |
| `/dashboard/tenant/subscription` | `TenantSubscriptionPage` | `requiredPermissions: ['tenant.subscription.view']` | **NO — permission never granted to anyone** |
| `/dashboard/tenant/billing/checkout/:targetType/:targetKey` | `CheckoutPage` | (guard not separately checked this session; only reachable via links from `TenantSubscriptionPage`/`TenantAddOnsPage`, both themselves unreachable) | **NO — no working entry point** |
| `/dashboard/tenant/billing/payments` | `PaymentHistoryPage` | requires permission (pattern consistent with the rest of `tenant.*`) | **NO** |
| `/dashboard/academy/create` | `AcademyCreatePage` | `requiredPermissions: ['academy.view']` | **NO — permission never granted to anyone** |
| `/dashboard/provisioning/new` | `ProvisioningStartPage` | `requiredPermissions: ['academy.provisioning.create']` | **NO — permission never granted to anyone** |
| `/dashboard/provisioning/:requestId` | `ProvisioningStatusPage` | same pattern | **NO** |
| `/dashboard/platform/payments` | `PlatformPaymentReviewListPage` | `requiredRoles: ['platform_owner']` | **YES for a real Platform Owner** — this one uses `requiredRoles`, not `requiredPermissions`, and `roles` (unlike `permissions`) IS correctly populated (`user.isPlatformOwner` → `roles: ['platform_owner']`) |
| `/dashboard/academy/:academyId/website/settings` (Theme tab) | `AcademySettingsPage`/`WebsiteThemeTab` | requires an existing academy + presumably a `requiredPermissions` check consistent with the rest of the academy-scoped routes | **Reachable only if you already have an Academy** (itself unreachable — see above) |

**Pattern discovered**: every route gated by `requiredRoles` (checks the real, populated `roles`/`role` field) works correctly. Every route gated by `requiredPermissions` (checks the never-populated `permissions` field) is dead. This is the single clearest, most actionable signal in this entire audit.

---

## 5. Backend Endpoint Mapping

| Frontend step | Backend endpoint | Controller | Service | DB table | Required state | Status |
|---|---|---|---|---|---|---|
| Sign Up | `POST /auth/register` | `AuthController` | `AuthService.register` | `users` | none | WORKING |
| Sign In | `POST /auth/sign-in` | `AuthController` | `AuthService.signIn` | `users` | none | WORKING |
| Create Organization | *(none exists)* | — | — | `organizations` | — | **MISSING** |
| Browse Plans | `GET /plans` | `PlansController` | `PlansService` | `plans` | none | WORKING (data quality issue — see §13) |
| Create Checkout | `POST /organizations/:id/checkouts` | `CheckoutController` | `CheckoutService` | `checkouts` | org membership | WORKING (verified live) |
| Submit Payment | `POST /organizations/:id/payments` | `PaymentController` | `PaymentService` | `payments` | a checkout | IMPLEMENTED, not fully re-verified live this session (see §16) |
| Admin Review/Approve | `POST /payments/:id/approve` | `PlatformPaymentController` | `PlatformPaymentService` → `PaymentApplicationService` | `payments`, `checkouts`, `tenant_subscriptions` | `platform_owner` role, **an existing `tenant_subscriptions` row** | **IMPLEMENTED BUT BROKEN for any org's first-ever subscription** — throws (`P2025`) if the row doesn't exist yet, and nothing ever creates it |
| Create Provisioning Request | `POST /organizations/:id/provisioning-requests` | `ProvisioningRequestsController` | `ProvisioningRequestsService` | `provisioning_requests`, `provisioning_steps` | org membership only (no subscription check!) | WORKING (but decoupled from payment — see §7) |
| Orchestrator: create Academy | (internal, BullMQ worker) | — | `ProvisioningOrchestratorService.executeAcademyStep` → `AcademiesService.create` | `academies` | — | WORKING |
| Orchestrator: theme | (internal) | — | `ProvisioningOrchestratorService.executeStep('theme')` | — | — | **HARDCODED SKIP — never implemented** |
| Orchestrator: branding | (internal) | — | same | — | — | **HARDCODED SKIP** |
| Orchestrator: domain | (internal) | — | same | — | — | **HARDCODED SKIP** (separate, real `DomainService.addCustomDomain` flow exists independently) |
| Orchestrator: subdomain | (internal) | — | `executeSubdomainStep` | `subdomain_allocations` | — | WORKING |
| Theme selection (real) | `GET/PATCH /academies/:id/website` (theme field) | `WebsiteController` | `WebsiteConfigurationService` | `website_configurations` | an existing Academy | WORKING, but only reachable post-onboarding, not during it |

---

## 6. Roles & Permissions

| Flow Step | Role/Permission Required | Frontend Route | Backend Endpoint | Reachable? |
|---|---|---|---|---|
| Sign Up | Public | `/auth/register` | `POST /auth/register` | **YES** |
| Sign In | Public | `/auth/sign-in` | `POST /auth/sign-in` | **YES** |
| Create Organization | (undefined — no implementation) | *(none)* | *(none — 404)* | **NO** |
| Browse Plans | `requiredPermissions` not applied to any route (no route exists) | *(none)* | `GET /plans` (works if called directly) | **NO (no UI path)** |
| Select Plan / Checkout | Org membership (backend); frontend `requiredPermissions: ['tenant.subscription.view']` gates the only page that links here | `/dashboard/tenant/subscription` → `/dashboard/tenant/billing/checkout/...` | `POST /organizations/:id/checkouts` | **NO (page unreachable)** |
| Payment | Org membership | (same, downstream of checkout) | `POST /organizations/:id/payments` | **NO (unreachable upstream)** |
| Admin Approval | `platform_owner` role | `/dashboard/platform/payments` | `POST /payments/:id/approve` | **Page: YES. Action: FAILS for any org's first subscription** (P2025) |
| Setup / Provisioning | `requiredPermissions: ['academy.provisioning.create']` | `/dashboard/provisioning/new` | `POST /organizations/:id/provisioning-requests` | **NO (permission never granted)** |
| Theme | requires an existing Academy + academy-scoped permission | `/dashboard/academy/:id/website/settings` | `PATCH` website config | **NO (both prerequisites unreachable)** |
| Final Dashboard | Active Academy | `/dashboard/academy/...` | various | **NO (nothing upstream ever completes)** |

---

## 7. Plans & Subscription Flow

**Designed**: browse `GET /plans` → pick one → `POST /organizations/:id/checkouts` (freezes a price snapshot) → `POST /organizations/:id/payments` (manual, `atlas_manual` provider, proof-of-payment upload) → Platform Owner reviews and approves → `PaymentApplicationService.applySuccessfulPayment` marks the payment succeeded, completes the checkout, and calls `TenantSubscriptionsRepository.updateForPlanPurchase`.

**Actual, verified defect**: `updateForPlanPurchase` is a Prisma `.update()` — it throws `P2025` if no `tenant_subscriptions` row exists for that organization yet. Confirmed by the repository's own doc comment: *"real Tenant-subscription CREATION remains explicitly out of scope (Phase P14 provisioning...)... `CheckoutService`/`PaymentApplicationService` surface that as a real, honest error rather than fabricating a subscription row here."* Phase P14's provisioning orchestrator never creates one either (its `'tenant'` step is a documented no-op). **A brand-new organization's very first payment approval will fail with a 500-class database error**, not a graceful business error — this was not re-tested live this session (doing so would require successfully creating a real organization first, which is itself impossible — see §1), but is conclusively established by the code's own explicit, self-aware doc comments on both sides of the gap.

**What DOES work (verified live)**: for an organization that ALREADY has a `tenant_subscriptions` row (i.e., every seeded organization), creating a checkout for a plan works correctly — verified this session with a real `POST /organizations/:id/checkouts` call against `sarah.chen`'s real organization, which returned a real, correctly-priced snapshot.

---

## 8. Payment Flow

**Provider**: `atlas_manual` — a manual bank-transfer-style flow, not a real payment gateway (Atlas has no Stripe/PayPal/etc. integration anywhere, confirmed in prior audits and unchanged). The client uploads proof of payment (an image/PDF), and a Platform Owner manually reviews and approves or rejects it.

**Development testing path**: this IS testable locally without any real payment — that is the whole point of the manual-transfer design. The blocker is not the payment mechanism itself (which is real, honest, and appropriately simple for this stage), it's that you can never get an organization into a state where a payment can be legally submitted and successfully approved for the first time (§7).

**Verified live this session**: checkout creation succeeds for an existing organization. Payment submission itself was not completed live this session — the test run into this project's own sign-in rate limiter (10 attempts/15 minutes, the same real, correctly-functioning limiter documented in `Reports/P18_PRODUCTION_READINESS.md`) after repeated sign-ins during testing. This is a testing-session artifact, not a product defect, and is noted honestly rather than glossed over.

---

## 9. Admin Approval Flow

**Real, implemented, reachable for a Platform Owner**: `/dashboard/platform/payments` uses `requiredRoles: ['platform_owner']` (not the broken `requiredPermissions` mechanism), and `admin@atlas.dev`'s `roles` array is correctly populated (`user.isPlatformOwner` → `['platform_owner']`, confirmed real, unlike the `permissions` array). This page and its underlying `GET /payments`/`POST /payments/:id/approve`/`POST /payments/:id/reject` endpoints are real, testable today, and were exercised earlier in this project's own P17 work.

**The gap** is not in this step — it's that nothing valid ever arrives here for a genuinely new organization's first subscription (§7), and once it does approve, the underlying subscription-update call fails for that same reason.

---

## 10. Client Setup / Onboarding

`ProvisioningStartPage` (`/dashboard/provisioning/new`) is the real "setup wizard" entry point — it exists, is well-built (subdomain validation, academy naming), and its backend (`ProvisioningRequestsService.createRequest` → `ProvisioningOrchestratorService`) is real and mostly functional. It is unreachable because its route is gated by `requiredPermissions: ['academy.provisioning.create']`, which no account in the system ever has (§1, finding 2).

**Notably**: `createRequest` does NOT actually require an active subscription or completed payment as a hard precondition in the backend (`triggeringPaymentId` is optional and only checked for existence, not success) — meaning the design intent (payment gates provisioning) is not actually enforced in code. This is a second, independent gap from the permissions issue: even if the permission check were fixed, a user could provision an Academy having never paid anything.

---

## 11. Theme Selection

**Real and substantial**: 5 theme definitions (`premium-academy`, `modern-education`, `corporate-learning`, `minimal-editorial`, `bold-creative`), a theme registry, a preview card component, a `WebsiteThemeTab`. This is genuinely implemented product functionality, not a stub.

**Disconnected from onboarding**: the provisioning orchestrator's `'theme'` step is hardcoded to always return `{ result: 'skipped' }` — confirmed directly in `provisioning-orchestrator.service.ts`'s own comment: *"No theme/branding/custom-domain data exists anywhere in `CreateProvisioningRequestPayload` — always skipped in this phase, matching the frontend's own documented 'reported skipped until [a picker] exists' rule."* Theme selection lives entirely inside the post-onboarding Website Settings area of an already-existing Academy, not in the setup flow the user described.

**Persistence**: real — `website_configurations` table, `WebsiteConfigurationService`, confirmed functional in prior phases (P9).

---

## 12. Email Flow

| Event | Frontend trigger | Backend trigger | Provider | Development-tested? |
|---|---|---|---|---|
| Payment approved/rejected | (n/a — server-driven) | `PlatformPaymentService.approvePayment`/`rejectPayment` → `NotificationFanoutService.notify` + `sendEmailAfterCommit` | `StubEmailProvider` in dev (no real send) | Real, wired, confirmed via source (`src/billing/services/platform-payment.service.ts`) |
| Provisioning completed/failed | (n/a) | `ProvisioningOrchestratorService` → same fanout pattern | same | Real, wired, confirmed via source |
| Course-order payment approved/rejected | (n/a) | `PlatformCourseOrderPaymentsService` → same pattern | same | Real, wired, confirmed via source |
| Registration | `RegistrationPage` → `POST /auth/register` | `AuthService.register` | **No welcome/verification email is sent — confirmed: registration does not call any notification/email service** (matches master plan's own "no email verification in this phase" decision) | N/A by design |
| Password reset | `ForgotPasswordPage` | `AuthService` password-reset flow | Real, pre-existing since P1, `StubEmailProvider` in dev | Real (established in prior phases, unchanged) |

**Development behavior**: `EMAIL_PROVIDER` env-driven; in local dev it resolves to `StubEmailProvider`, which records the attempt without sending anything real (confirmed architecture from P17/P18, unchanged this session). **No real credentials were used or requested this session.** This part of the stack is genuinely production-ready in its abstraction, independent of the onboarding-funnel defects above.

---

## 13. Required Development Seed Data

**What the seed script (`prisma/seed.ts`) DOES create**: real users (including `admin@atlas.dev` as Platform Owner, and several org-scoped users like `sarah.chen@acme-academy.dev`), real Organizations (via direct `prisma.organization.upsert`, bypassing the app layer entirely since no app-layer create exists), real Academies, real `tenant_subscriptions` rows (also via direct upsert, `permissions: []` on every membership), real Plans, one real enrollment.

**What it does NOT create, and what would be needed to actually exercise the missing journey**: nothing can currently exercise the missing journey through seed data alone, because the journey's blockers are in application CODE (missing endpoint, unpopulated permissions, missing subscription-creation path), not in missing data. Seeding more data would not unblock any of the three root causes in §1.

**Real, separate data-quality issue found**: the local dev database's `plans` table is polluted with **hundreds of leftover e2e-test-fixture plans** (`precedence-plan-...`, `lifecycle-happy-plan-...`, `worker-multi-planA-...`, etc. — confirmed via a live `GET /plans` call returning this exact data), accumulated from many previous e2e test runs against the persistent local dev database (a known, previously-documented characteristic of this project's e2e strategy — real Postgres, no per-run reset). This means even if the Plans-browsing UI existed and were reachable, a developer exploring it today would see an unusable, confusing catalog rather than a clean 3–5 tier plan list.

---

## 14. Orphaned / Unreachable Features

- **`AcademyCreatePage`, `ProvisioningStartPage`, `TenantSubscriptionPage`, `TenantAddOnsPage`, and (by the same pattern) every other `requiredPermissions`-gated tenant-scoped page** — implemented, real, backed by real working APIs, completely unreachable through normal navigation for any account.
- **Theme selection** (`WebsiteThemeTab` and the 5 real themes) — implemented, real, disconnected from onboarding (§11).
- **`POST /organizations/:id/provisioning-requests`'s `triggeringPaymentId`** — implemented as optional, never actually enforced as a gate, meaning the "payment must precede provisioning" business rule the master plan implies is not actually coded anywhere.
- **The direct `POST /academies` endpoint** — real, working, used internally by the orchestrator; not separately audited for its own frontend reachability this session, but notable as an alternate Academy-creation path that bypasses the provisioning-request flow entirely.

This directly answers the user's own framing: *"If the project has 100 implemented features but only 10 are actually reachable by a normal Client, say so."* — a large fraction of the tenant-facing onboarding/billing/setup surface is exactly this: implemented, tested in isolation (per-domain e2e suites), but not reachable end-to-end as a connected journey.

---

## 15. Frontend ↔ Backend Contract Issues

**The one, central, systemic contract mismatch**: the frontend's authorization model (`RouteGuard`, `navigation.config.ts`) was built assuming the backend returns a real, populated, per-organization list of granular permission strings (`tenant.subscription.view`, `academy.view`, `academy.provisioning.create`, etc.) in `organizationMemberships[].permissions`. The backend defines the column, defines the DTO field, and even has a real RLS-backed read path for it — but **no write path anywhere ever populates it with anything other than an empty array.** This is not a minor mismatch; it silently fails every `requiredPermissions` check in the entire application, for every account, permanently, with no error surfaced to the user (the item simply doesn't appear in navigation, and the guarded route silently redirects/denies).

**Secondary, related gap**: `POST /organizations` is referenced nowhere in the frontend's `OrganizationService.ts` (whose own comment confirms this was a known, accepted gap at the time it was written) and does not exist in the backend either — both sides agree it's missing, but neither side flags it as a blocking dependency of the onboarding journey.

---

## 16. Exact Development Blockers

### P0 — Complete blockers (prevent the core product journey)

**P0-1 — No Organization-creation endpoint or UI exists anywhere.**
Confirmed live: `POST /api/v1/organizations` → real `404`. Confirmed in code: no `create` method on `OrganizationsRepository`; the only committed `organizations` controller (`src/platform/controllers/organizations.controller.ts`) is Platform-Owner-only and read-only. Confirmed in frontend: `OrganizationService.ts`'s own comment.

**P0-2 — `OrganizationMembership.permissions` is never populated anywhere, breaking every `requiredPermissions`-gated route for every account.**
Confirmed live: `sarah.chen`'s real membership returns `"permissions": []` despite `"role": "owner"` and an active paid subscription. Confirmed in code: `RouteGuard`/`navigation.utils.ts` fail closed on this field; `prisma/seed.ts` hardcodes `permissions: []`; no service anywhere writes a non-empty value; `schema.prisma`'s own `@default([])` is never overridden.

**P0-3 — No code path creates the first `tenant_subscriptions` row for a new Organization.**
Confirmed in code: `TenantSubscriptionsRepository`'s own doc comment (P4) and `PaymentApplicationService`'s own doc comment both explicitly defer this to "Phase P14 provisioning" — and P14's own orchestrator (`executeStep('tenant')`) explicitly does no such work (*"there is no 'create the tenant' work left"*). Both phases' own documentation agrees on where responsibility lies; neither phase implemented it there.

### P1 — Major blockers (prevent an important part of the journey)

**P1-1 — Provisioning's theme/branding/domain steps are hardcoded to always skip.**
File: `src/provisioning/services/provisioning-orchestrator.service.ts`, `executeStep()`, `case 'theme': case 'branding': case 'domain': return { result: 'skipped' };` — confirmed by its own comment this is a deliberate, current-phase decision, not a bug, but it does mean "Setup → Theme" as a connected onboarding step does not exist.

**P1-2 — `triggeringPaymentId` on a provisioning request is optional and unenforced.**
File: `src/provisioning/services/provisioning-requests.service.ts`, `createRequest()` — only checks the referenced payment exists, never that it succeeded, never that an active subscription exists. The "pay before you provision" rule implied by the master plan's own phase dependency graph (`P12 --> P14`) is not actually coded as a guard anywhere.

**P1-3 — Local dev `plans` catalog is polluted with hundreds of leftover e2e-test fixtures.**
Confirmed live via `GET /plans`. Makes any future Plans-browsing UI unusable for manual exploration without a data cleanup pass.

### P2 — Minor issues (do not prevent the main journey but need fixing)

**P2-1 — `TenantSubscriptionPage` has no graceful "you have no subscription yet — pick one" empty state**, only a generic `ErrorState` on any `error` including the expected 404-no-subscription case. Even with P0-2/P0-3 fixed, this page would still need this empty-state handling to be useful as a first-plan-selection entry point.

**P2-2 — No dedicated "browse all plans" page/route exists at all** — the only UI path into the plan catalog is through `TenantSubscriptionPage`'s comparison dialog (an "upgrade my existing plan" UI, not a "pick my first plan" UI) and `TenantAddOnsPage`.

### P3 — Nice-to-have

**P3-1 — This audit's own live-testing was interrupted by the (correctly functioning) sign-in rate limiter** after repeated manual sign-ins — worth a documented "how to reset your local rate-limit state" note for developers doing manual exploration (the mechanism — flushing Redis `ratelimit:*` keys — already exists and is used by the e2e suite's own test harness, just not documented for manual/exploratory use).

---

## 17. Exact Fix Plan (NOT implemented — audit only)

### For P0-1 (no Organization creation)
- **File(s)**: new controller method needed, e.g. `src/tenancy/controllers/organizations.controller.ts` (recreate) or a method on the existing `platform/controllers/organizations.controller.ts` split appropriately; `OrganizationsRepository` needs a real `create()` method; `OrganizationMembershipsRepository` needs a matching membership-creation call (owner role) in the same transaction.
- **Route**: `POST /organizations` (or `POST /organizations` nested appropriately per this codebase's established `resource` pattern).
- **Required state**: authenticated user, no other precondition.
- **Reason it fails**: literal absence of the endpoint.
- **Recommended fix**: implement organization creation (name, slug generation/validation) + owner-membership creation, in one transaction, matching this codebase's established idempotency-key convention for other creation endpoints.

### For P0-2 (permissions never populated)
- **File(s)**: wherever `OrganizationMembership` rows are created (once P0-1 exists) and any existing membership-creation code path; likely also needs a role→permissions mapping table/constant shared between frontend (`navigation.config.ts`'s `requiredPermissions` strings) and backend.
- **Reason it fails**: `permissions: []` is hardcoded everywhere a membership is ever written; nothing derives it from `role`.
- **Recommended fix**: either (a) populate `OrganizationMembership.permissions` from a real role→permissions mapping at membership-creation/role-change time, or (b) switch the frontend's `requiredPermissions` checks to `requiredRoles` for the routes currently blocked, matching the pattern that already correctly works for Platform Owner routes. Option (a) is more faithful to the apparent original design intent (fine-grained permissions); option (b) is a much smaller, faster fix. This is a product/architecture decision, not made here.

### For P0-3 (no first-subscription creation)
- **File(s)**: `src/provisioning/services/provisioning-orchestrator.service.ts` (`executeStep('tenant')`) or `src/billing/services/payment-application.service.ts` (`applySuccessfulPayment`) — one of these needs to become the real creation point, matching the codebase's own "one place a Payment's effect is applied" rule (`PaymentApplicationService`'s own doc comment) — arguably `applySuccessfulPayment` should `upsert` rather than `update` when handling a checkout whose target is a brand-new subscription.
- **Reason it fails**: `TenantSubscriptionsRepository.updateForPlanPurchase` is a bare `.update()`, and no `.create()` counterpart exists.
- **Recommended fix**: add a `createForPlanPurchase` (or extend the existing method to upsert) and call it from `applySuccessfulPayment` when no existing row is found — this is the natural, minimal fix consistent with the codebase's own stated architecture ("the one and only server-side trigger that turns a successful Payment into a real subscription change").

### For P1-1 (theme/branding/domain always skipped)
- **File(s)**: `src/provisioning/services/provisioning-orchestrator.service.ts`, `CreateProvisioningRequestDto`/`CreateProvisioningRequestPayload` (frontend) need theme/branding fields added; a real theme-picker step needs to be added to `ProvisioningStartPage`.
- **Recommended fix**: this is a genuine product-scope decision (does onboarding need its own theme picker, or is "create with a default theme, customize later in Website Settings" acceptable?) — **PRODUCT DECISION REQUIRED**, not purely a bug fix.

### For P1-2 (payment-gate not enforced)
- **File(s)**: `src/provisioning/services/provisioning-requests.service.ts`, `createRequest()`.
- **Recommended fix**: require and validate `triggeringPaymentId` references a `succeeded` payment tied to a `plan_subscription` checkout for this organization, once P0-3 makes that state reachable at all.

### For P1-3 (polluted dev plans data)
- **File(s)**: none — a data cleanup operation, not a code fix (e.g., a one-time local `DELETE FROM plans WHERE key LIKE '%-%-%'`-style cleanup script, or simply resetting the local dev database from the seed script). Explicitly not performed by this audit (no destructive operations permitted).

### For P2-1/P2-2 (missing empty state / no plans-browsing page)
- **File(s)**: `atlas-front/src/features/tenant/pages/TenantSubscriptionPage.tsx` (add an explicit "no subscription" branch distinct from the generic error branch); a new page/route for first-time plan browsing, or repurpose the existing `PlanComparisonDialog` to be reachable standalone.

---

**STOP. No fixes were applied. No files were modified. No commits, no pushes. This is the complete, evidence-based map requested.**
