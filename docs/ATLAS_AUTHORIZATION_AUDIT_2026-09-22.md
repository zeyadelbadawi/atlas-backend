# Atlas authorization audit — "Client Owner cannot open academy management"

**Date:** 22 September 2026
**Trigger:** an existing Client Owner can sign in, load the dashboard and see
their academy, but Academy Members, Courses, Website and Academy Overview
fail with "You do not have access" and/or "Unexpected error".
**Outcome:** root cause found and proven; fix is frontend-only; no guard, RLS
policy, role, permission or database row was changed.
**Labels:** VERIFIED = observed directly (production read-only queries, local
reproduction, test runs). NOT VERIFIED / UNKNOWN as marked.

---

## 1. Root cause (one paragraph)

The browser remembers the "active academy" in `localStorage`
(`atlas:active-academy`). Until this fix it was restored verbatim on every
page load, never tied to the signed-in account, never validated against the
academies that account can reach, never cleared on sign-out or organization
switch, and never dropped when the academy was archived. The dashboard
sidebar builds every academy-scoped link (Courses, Members, Website,
Branding, Settings, Media, Announcements) from that id, so a Client Owner
whose browser held another account's — or an archived — academy id was sent
to `/academies/<foreign id>/…`. The backend refused every one of those
requests correctly (`AcademyScopeGuard` → 403 `errors.tenancy.notAMember`;
RLS independently agrees). The frontend then rendered the refusal as
**"You do not have access"** (global toast, with the raw key
`errors.tenancy.notAMember` leaking as its description) plus **"Unexpected
error"** (the pages' `ErrorState` was not given the error kind). The
organization dashboard kept working because it is organization-scoped
(`GET /organizations/:id/dashboard`, `GET /academies?organizationId=`), and
Academy Overview self-healed only if the user happened to open it, because
it resets the active academy to the first academy of the organization.

Production evidence (VERIFIED, read-only): the backend log of the current
container carries a dashboard session from a Chrome browser requesting
`GET /api/v1/public/websites/ea3276aa-…/identity` — the sidebar's
active-academy identity fetch — where `ea3276aa` is `atlas-p2-53981`, an
**archived** smoke-test academy of organization `20b7cdac` whose owner user
is deleted. No live account is a member of that organization.

## 2. Discovery

Production data inventory (read-only `psql` as the superuser, no writes):

| Fact | Value |
| --- | --- |
| Organizations | 22 (4 are smoke-test remnants with deleted owners and archived academies) |
| Owner `organization_memberships` rows | present for all 18 live-owner orgs, role `owner`, 36 permission strings incl. `academy.view`, `academy.members.view`, `course.view`, `academy.website.view` |
| Owner `academy_members` rows | present for all 16 live academies, role `owner`, status `active` |
| `is_platform_owner` on owners | false everywhere |
| `academy_members.status` | all `active` (19 rows) |
| `users` of live owners | `active`, not deleted |
| Subscriptions | 16 `trial_expired`, 5 `trialing`, 1 `no_plan` (see §9) |
| RLS | `atlas_app`: `rolsuper=false`, `rolbypassrls=false`; FORCE RLS on academies, academy_members, organization_memberships, organizations, courses, website_*, tenant_subscriptions; `users` has no RLS (by design) |

Conclusion of discovery: **no membership, role or permission row is missing
or wrong for any live Client Owner.** The data could not explain the report.

## 3. Authorization model (as implemented)

Routes `/academies/:id/*` (academies, courses, curriculum, website,
website-content, dashboard): `JwtAuthGuard` → `ManagementSurfaceGuard`
(refuses `learner` principals; owners resolve as `staff`) →
`AcademyScopeGuard`:

1. `runInUserContext(userId)` → `academies.findUnique(id)` — visible only
   through `academies_org_member_select` (an `organization_memberships` row
   for the academy's organization) or `academies_academy_member_select`
   (`is_academy_member`, SECURITY DEFINER). No row → 403 `notAMember`
   (deliberately no enumeration oracle).
2. `runInTenantContext(organizationId)` → re-verifies the organization
   membership (or, P64 Phase 1, an active `academy_members` row).

Service layer adds role tiers: `assertCanManage` / `assertIsMember` require
an `academy_members` row with role in {`owner`, `administrator`, `manager`}
for academy reads/writes, website reads/writes, course writes, roster
management. Instructors are refused on Website (Phase 9 I1) by design.

`SubscriptionAccessInterceptor` runs after the guards and refuses only
**mutations** for `expired` / `cancelled` / `trial_expired` tenants (403
`SUBSCRIPTION_REQUIRED`); reads always pass so a lapsed tenant can still see
their data.

Frontend: `RouteGuard` (permissions from the active organization membership,
`requiresEntitlement` bounce to `/dashboard` when lifecycle `hasAccess` is
false), `filterNavigationItems` (hides entitlement-gated items), and
`PlatformProvider.activeAcademyId` feeding `getDashboardNavigation`.

## 4. Reproduction (LOCAL VERIFIED, Chrome, seeded Client Owner `omar.hassan`)

1. Sign in; dashboard loads (`/organizations/:id/dashboard` 200,
   `/academies?organizationId=` 200, "Academies 1").
2. Set `localStorage['atlas:active-academy']` to an academy of a different
   organization (exactly what an earlier sign-in as another account, or an
   archived academy, leaves behind); reload `/dashboard`.
3. Sidebar links now target the foreign academy. Members →
   `GET /academies/<foreign>` **403**, `GET …/members` **403**; UI shows the
   toast "You do not have access / errors.tenancy.notAMember" and the page
   card "Unexpected error". Courses → `…/courses` 403, `…/course-categories`
   403 → "Unexpected error". Website → `…/website/domain|configuration|pages`
   403 → "Unexpected error".
4. Academy Overview → resolves `academies[0]`, calls `setActiveAcademy`, and
   the sidebar heals — which is why the report is intermittent.

Control: with a valid id every one of those requests returns 200 for the same
account (VERIFIED locally; and by production read-only RLS simulation as
`atlas_app` for owners `e4b36c56` and `4656367b`: bootstrap read 1 row,
membership 1 row, members/courses/website reads visible).

## 5. Exact rejection layer

`AcademyScopeGuard` step 1 (`errors.tenancy.notAMember`, HTTP 403), because
the requested academy id belongs to an organization the caller is not a
member of. RLS independently returns zero rows for the same read. **The
backend is correct.** The defect is that the frontend chose the id.

## 6. Historical / migration state

- No migration touched `academy_members`, `organization_memberships` or the
  academy RLS policies since P64 Phase 1; production policies match the
  migration history (VERIFIED by `pg_policies` dump).
- `atlas:active-academy` restoration was added on 2026-09-14 (commit that
  made the sidebar survive reloads); its test file documents the intent and
  explicitly assumed "a stale id resolves to the same refusal it would
  today" — the refusal was correct, the user experience of it was not.
- The archived smoke-test academies (created 2026-09-19/20 by the Phase 2
  production smoke runs, owners since deleted) are the concrete source of a
  stale id in the owner's own browser.

## 7. Policy (unchanged, now enforced client-side as well)

The active academy is a navigation convenience. It must be one of the
academies the backend returned for the signed-in account's active
organization and must not be archived. Otherwise it is replaced by the first
reachable academy or cleared. Nothing in this rule grants access: every
route and API call stays independently authorised.

## 8. Implementation (frontend `atlas-front`, no backend change)

| File | Change |
| --- | --- |
| `src/features/academy/utils/active-academy.utils.ts` (+ test, 7 cases) | `reconcileActiveAcademy(storedId, academies)` — pure rule from §7 |
| `src/features/academy/hooks/useActiveAcademyReconciliation.ts` | applies the rule once the organization's academy list is loaded |
| `src/app/layouts/dashboard/DashboardLayout.tsx` | mounts the hook for the whole management shell |
| `src/app/providers/platform/PlatformProvider.tsx` (+ test) | organization switch clears the remembered academy (state and storage) |
| `src/services/identity/session.service.ts` | sign-out removes `atlas:active-academy` |
| `src/app/providers/query/error-toast.utils.ts` (+ test, 3 cases), `QueryProvider.tsx` | global read-error toast namespaces the backend key (`errors.x` → `errors:x`) and falls back to the per-kind copy when untranslated — no raw key on screen |
| `src/services/api/api-error.ts` (`apiErrorKind`) and the Members, Courses, Website overview and Academy dashboard pages | `ErrorState` receives the real kind: a 403 reads "You do not have access", not "Unexpected error" |
| `en/ar errors.json` | `academy.insufficientRole`, `course.insufficientRole` (backend keys that had no translation) |

## 9. Tests and validation

| Suite | Result |
| --- | --- |
| `atlas-front` vitest: active-academy utils, error-toast utils, platform provider restore/switch | 15/15 pass (VERIFIED) |
| `atlas-front` full `vitest run` | see closing summary of the session |
| `atlas-front` `tsc` on touched files | clean; pre-existing errors remain in `platform-zoom`, `platform-add-ons`, `WebsitePageEditorPage` (untouched, NOT this change) |
| `atlas-backend` guard specs (`academy-scope`, `academy-organization-scope`, `organization-membership`, `management-surface`) | 20/20 pass |
| `atlas-backend` e2e `academies-tenant-isolation` (P3-TENANT-001…010), `courses-tenant-isolation`, `p7-tenant-isolation`, `p64-surface-enforce-flag` | 31/31 pass — role matrix and cross-tenant negatives (foreign academy by id → 403/404; org member without academy row → denied; concurrent cross-org reads never cross-contaminate) |
| RLS | production read-only simulation as `atlas_app` (rolled back): foreign reads return 0 rows, own reads return the expected rows |
| Browser re-test after fix (LOCAL VERIFIED) | stale foreign id → sidebar links re-pointed to the real academy on load; deep link to a foreign academy → "You do not have access" with translated description; own academy → Members/Courses/Website 200 |

## 10. Findings that are NOT this bug (owner decisions required)

1. **Trial length is 3 days.** `trial_policy.duration_days = 3` (singleton
   row, no env override, plans carry `trial_duration_days = NULL`). As a
   result 16 of the 17 real organizations are `trial_expired`. For those
   tenants the Academy section is hidden by design (Phase 11) and a deep
   link to any academy page bounces silently to `/dashboard`; every write
   returns 403 `SUBSCRIPTION_REQUIRED`. This is the documented Phase 11
   behaviour, not an authorization defect — but if 3 days was not the
   intended trial, every one of those customers has been locked out of
   management since 15–21 Sep. Decision: keep 3 days, or change the policy
   row (an UPDATE through the platform tooling, not a deploy). Not changed.
2. **101 backend `messageKey`s have no frontend translation** (list in the
   session transcript; e.g. `errors.academy.insufficientRole` was one — now
   added — `errors.tenancy.saasLevelCallerOnly`, `errors.provisioning.*`,
   `errors.payment.*`). With this fix they degrade to the per-kind sentence
   instead of a raw key. A catalogue pass is recommended.
3. **Silent bounce on entitlement.** `RouteGuard` sends an expired tenant
   from a deep link to `/dashboard` with no message. The banner explains the
   state, but the redirect itself is unexplained. UX decision, not security.

## 11. Deployment

Not deployed. The change is committed on the frontend; pushing to `main`
triggers the production frontend deploy, which this audit was told not to do
without explicit authorization.
