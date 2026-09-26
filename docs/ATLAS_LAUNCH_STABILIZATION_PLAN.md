# Atlas Launch Stabilization Plan (Plan A)

**Status:** PLAN ONLY. Not approved and not implemented. Nothing in this document has been built, migrated or deployed.
**Date:** 2026-09-26
**Predecessor:** `docs/ATLAS_GLOBAL_IDENTITY_PLAN_v3.md` (Plan v3). Plan v3 was re-scoped: its larger architecture is **deferred** to `docs/ATLAS_FUTURE_ORGANIZATION_HOST_IDENTITY_PLAN.md` (Plan B).
**Evidence:** `atlas-backend` c18793f, `atlas` 8a8dd56, the live local RLS catalogue (124 migrations, 421 policies), and a local cross-academy probe (§2.1). Every "current behaviour" statement below cites the code it was read from.

---

## 0. Why the scope was reduced

Plan v3 was architecturally sound but far too broad for the immediate goal: **secure → stable → tested → launchable**.

- This milestone keeps the existing routes, dashboard, RBAC, RLS, Academy model, Platform Owner model and OTP behaviour exactly as they are.
- It contains only:
  - the three verified security defects (D1, D2, D3);
  - cross-Academy learner identity (one global user, many learner relationships);
  - one verified privacy defect that the cross-Academy feature makes worse (A5).
- Everything else from Plan v3 is classified in §9. Most of it is deferred to Plan B.

**Principle:** REUSE > ADAPT > EXTEND > REFACTOR ONLY IF REQUIRED > REBUILD ONLY IF ABSOLUTELY NECESSARY.

## 1. Scope at a glance

| # | Item | Kind | Schema change | Frontend change |
|---|---|---|---|---|
| A1 | **D1:** academy-website sessions must not work as management credentials | Security fix | None | None |
| A2 | **D2:** staff-created accounts must never carry a password chosen by someone else | Security fix | None (uses the existing `invited` enum value) | Remove the password fields from 3 staff dialogs |
| A3 | **D3:** password reset and password change must revoke live access tokens immediately | Security fix | None | None |
| A4 | **Cross-Academy learner identity:** an existing global account can sign up as a learner at another Academy | Feature | None | Academy signup success copy for the existing-account case |
| A5 | **Academy-scoped `/users/me` projection:** an academy session must not receive the user's other Academies and Organizations | Privacy fix | None | None (the academy frontend already reads only its own entry) |

**No migrations are required for this milestone** (§8).

---

## 2. A1 — D1: Academy session used as a management credential

### 2.1 Current behaviour (verified)

- The access token carries only `{sub, sid}` (`src/identity/services/access-token.service.ts`, `AccessTokenClaims`).
- Sessions *record* their surface in `refresh_tokens.surface` (`management|academy`) and `academy_id` (`prisma/schema.prisma` `RefreshToken`). **After minting, nothing reads them.**
- `ManagementSurfaceGuard` (`src/tenancy/guards/management-surface.guard.ts`) refuses only a *principal* of kind `learner`. That kind is derived from database facts; it says nothing about the session.
- **Local probe (2026-09-26):** user Z owns Academy A's organization and is a learner of Academy B. Z signs in on **Academy B's website** (`surface:'academy'`). With that academy-surface token, `GET /api/v1/academies/<A>` returned **200**, which is Z's management API. `GET /academies/<B>` correctly returned 403.
- The same applies to Platform Owners: an academy-site session of a Platform Owner passes `PlatformOwnerGuard` today.
- **Controllers outside `ManagementSurfaceGuard` (verified):**
  - `src/community/controllers/announcements.controller.ts` has only `JwtAuthGuard`, yet it carries **management write routes** (`POST/PATCH courses/:courseId/announcements…`, `academies/:academyId/announcements…`, authorized by in-service staff checks) and **Platform Owner routes** (`platform/announcements`, `@UseGuards(PlatformOwnerGuard)` only).
  - `src/observability/metrics/metrics.controller.ts` uses its own `MetricsAccessGuard` (a bearer metrics token, not a user session). It is not affected.

### 2.2 Root cause

The surface is decided at sign-in (`AuthService.resolveSurface`) and stored, but never enforced per request. Academy websites are tenant-operated origins: tenant content, custom domains whose DNS the tenant controls, and no CSP. A token issued there must not carry management power.

### 2.3 Exact fix (minimal: no token-format change)

1. **Server-side session-surface lookup, cached.**
   - Add `SessionSurfaceService.surfaceOf(sessionId)` in `src/identity/services/`.
   - It reads `surface, academy_id` from any row of the session's `refresh_tokens` family, using the existing index on `session_id`. Every rotation copies these values forward, so they are immutable for the session.
   - Cache the result in Redis as `session:surface:<sid>` with a TTL equal to the refresh TTL. The value is immutable, so there is no invalidation problem. A revoked session is already refused earlier by `JwtAuthGuard`.
   - Memoise per request on `request`, like `PrincipalResolverService.forRequest`.
2. **`ManagementSurfaceGuard`:** if the session surface is `academy`, return 403 `errors.auth.managementSurfaceOnly`. This check runs **before** the existing principal-kind check, which is kept unchanged.
   - **`PlatformOwnerGuard` gets the same session-surface check.** 24 of its 26 users also carry `ManagementSurfaceGuard`. `announcements.controller.ts` does not. The metrics controller does not use a user session. Putting the check inside `PlatformOwnerGuard` covers every present and future Platform Owner route.
   - **`announcements.controller.ts`:** add `ManagementSurfaceGuard` to the course and academy authoring routes (create, update, publish, archive). The read routes that learners use stay as they are.
3. **Learner endpoints — the other direction.** An academy session may act only for **its own academy**:
   - `requireHostAcademy` in `LearnerDashboardController` and `LearnerSessionController`, and the content grant path in `LessonContentController`, gain one comparison: if the session surface is `academy`, the session's `academy_id` must equal the host academy. Otherwise 403.
   - Management sessions keep their current behaviour on these endpoints. Staff preview relies on it, and enrollment, membership and RLS checks still decide access.
4. **Implementation inventory task:** enumerate every controller guarded only by `JwtAuthGuard` and classify each route as self/account (either surface allowed), learner (academy surface) or management (needs `ManagementSurfaceGuard`). The known management controllers already carry it. The inventory must show no management capability reachable without it. Deliver it as a reflection test (§2.8).

Why a lookup instead of a JWT claim:
- A claim would need changes to the token format, `issue`, `refresh`, the claim parsing in `JwtAuthGuard`, and a legacy-token window.
- A lookup is one guard plus one small service, covers **already-issued tokens immediately**, and costs one cached Redis read per management request.
- Context tokens are part of the deferred Plan B.

### 2.4 Impact

| Area | Impact |
|---|---|
| Data model | None |
| API | Academy-surface tokens now receive 403 on management controllers. Cross-academy learner calls return 403. No contract shapes change. |
| Frontend | None. `AppRouter` never mounts management routes on academy hosts, so no legitimate UI call breaks. The log-mode rollout (below) proves this. |
| AuthN | None. Sign-in and session issuance are unchanged. |
| AuthZ | Strictly narrower |
| RLS | Unchanged |
| Migration | None |
| Backward compatibility | Existing sessions keep working for legitimate use |

**Rollout:**
- A VPS `.env` setting `SURFACE_SESSION_ENFORCE=log|on` (not a product flag):
  - `log` records `atlas_auth_surface_denied_total{reason}` plus a warning for 48 hours without refusing.
  - Then set `on`.
- The setting is **removed in the next release**, so no switch remains that could reopen D1. The setting is a rollout mechanism, not the security boundary.

### 2.5 Tests

- **Unit:**
  - `SessionSurfaceService`: cache hit and miss, unknown sid, rotation family.
  - Guard truth table: surface {management, academy} × principal {learner, staff, platform_owner, unaffiliated}.
- **e2e:**
  - The probe scenario: an academy-B token on `/academies/<A>` returns 403.
  - The same token on a Platform Owner route returns 403, including `POST /platform/announcements`.
  - An academy-surface staff token on `POST /academies/:id/announcements` returns 403.
  - A management token on management routes returns 200 (regression).
  - An academy-A token on Academy B's host learner routes returns 403.
  - An academy-A token on its own learner routes returns 200.
  - A management token on a learner route for an Academy the user has no relationship with returns 403/404 (J11).
- **Reflection test:** every route is either `ManagementSurfaceGuard`-protected, learner-bound, or on the self/account allow-list. A new controller that fits none fails CI.
- **Playwright:** sign in on an academy host, then call a management endpoint from the page context → 403.

### 2.6 Production verification

- Extend the read-only `deploy/onboarding-verify.sh` with a probe that mints nothing. It checks that `ManagementSurfaceGuard` refuses a synthetic academy-surface session:
  - The production check reuses a controlled test account's academy session, obtained by the browser-verify workflow.
- Monitor `atlas_auth_surface_denied_total` during log mode.

### 2.7 Rollback, observability, risks, do-not-change

- **Rollback:** set `SURFACE_SESSION_ENFORCE=log`, or redeploy the previous image. Not recommended after launch.
- **Observability:**
  - Metric `atlas_auth_surface_denied_total{reason: academy_session_on_management|academy_mismatch}`.
  - Warn log with `userId`, `sid`, route.
  - Alert if it is non-zero after `on` from a staff principal (possible stolen tenant-origin token).
- **Risk:** an unknown legitimate academy-host call to a management route. Mitigated by the 48-hour log mode.
- **Must not change:**
  - `issueSession`, token format and refresh rotation.
  - Principal resolution, tenant guards, RLS, and frontend routing.

---

## 3. A2 — D2: Staff-chosen passwords on other people's accounts

### 3.1 Current behaviour (verified)

- `AcademiesService.findOrCreateUserByEmail` (`src/academy/services/academies.service.ts:237`) creates a user with `passwordHash = hash(password supplied by the manager/owner)` when adding a Manager or Instructor with a new email.
- `createStudent` (`:1016`) does the same, and the password is required (`create-academy-student.dto.ts:30`).
- The account is `status='active'` (the column default) and **usable immediately with the creator's password**.
- `AccountSetupService` then emails a set-password link. Until the person uses it, the creator knows a working password.
- `UserAccountStatus.invited` exists in the schema but is never written (`grep "'invited'"` → no writers).
- Frontend dialogs that collect the password:
  - `AddAcademyManagerDialog.tsx`
  - `AddAcademyInstructorDialog.tsx`
  - `CreateAcademyStudentDialog.tsx`
  - the schemas in `academy.schemas.ts`

### 3.2 Why it is a launch blocker

Atlas identity is global. A staff member who created an account knows its password and can sign in as that person **anywhere**, for as long as the person has not set their own password. That includes any organization the person later owns, and any academy they later join (A4 makes this more likely).

### 3.3 Exact fix

1. **Backend:**
   - A new person is created with `status='invited'` and an **unusable** password hash: a random 64-byte secret, argon2-hashed, then discarded. Nobody knows it.
   - The `password` DTO fields become **optional and ignored**; a supplied value is logged at `warn` as deprecated. `create-academy-student.dto.ts` makes `password` optional. The fields are removed in a later release.
2. **Sign-in and 2FA/OTP completion:** `invited` behaves like an unknown account. That means `invalidCredentials` after the dummy-hash verify, and no status disclosure (`AuthService.signIn`, next to the existing `deleted` check).
3. **Password reset confirm:** if the account is `invited`, set `status='active'` and `email_verified_at = now()` if null (the emailed link proves the mailbox). The existing `AccountSetupService` link already uses the reset-token flow, so setting a password there activates the account. `requestPasswordReset` works for `invited` accounts too, so a lost setup link is recovered with "forgot password" (existing behaviour).
4. **Existing email** (Manager/Instructor add): unchanged. The existing account is attached and **its password is never touched**. `createStudent` with an existing email keeps returning its current 409. The existing person can self-join through A4.
5. **Frontend:**
   - Remove the password fields from the three dialogs and their schemas.
   - Add copy: "We'll email them a link to set their own password."

### 3.4 Impact

| Area | Impact |
|---|---|
| Data model | None. The enum value exists. |
| API | `password` is ignored. The request shape stays compatible. |
| Frontend | 3 dialogs + schemas |
| AuthN | `invited` cannot sign in until the person sets a password |
| AuthZ, RLS | Unchanged |
| Migration | None. **Existing staff-created test accounts** are removed by the controlled reset (§10). If the reset is not approved, a one-off script converts accounts created through these paths that have never signed in (`last_sign_in_at IS NULL`; identified from the `academy.student.created` / `academy.*.added` audit rows written in the same transaction) to `invited` and re-sends their setup links. |
| Compatibility | Callers that still send `password` keep working, and the value is ignored |

### 3.5 Tests

- **e2e:**
  - A staff-created account signed in with the creator's password gets 401 `invalidCredentials`.
  - The setup link sets the password, the account becomes `active` and verified, and it can sign in.
  - An expired setup link: "forgot password" issues a new one.
  - Adding an existing email as Manager leaves the password hash byte-identical.
  - `createStudent` without a password returns 201.
- **Frontend:** the dialogs render with no password field, and the submit payload has no `password`.
- **Adversarial:** the creator tries sign-in, OTP and a 2FA challenge on an `invited` account → all refused, with no difference from an unknown email.

### 3.6 Production verification, rollback, observability, risks, do-not-change

- **Production verification:** the browser journey "Owner invites Manager" confirms the invitee cannot sign in until the setup link is used, then can.
- **Rollback:** redeploy the previous image. `invited` accounts stay invited and recover through "forgot password".
- **Observability:**
  - `atlas_staff_account_created_total{role, kind=invited|existing}`.
  - Audit `account.invited.created`.
  - Warn on the deprecated `password` field.
- **Risk:** invite email delivery (KI-EMAIL-1). Mitigated by "forgot password" recovery and the resend (re-invite) that already exists.
- **Must not change:**
  - The staff permission model and the membership writes.
  - `AccountSetupService` token mechanics.
  - Email templates beyond copy.

---

## 4. A3 — D3: Password reset/change leaves live access tokens valid

### 4.1 Current behaviour (verified)

- `AuthService.confirmPasswordReset` (`auth.service.ts` ~1174) and `UsersService.changePassword` (`users.service.ts:121-126`) revoke all refresh rows (`RefreshTokensRepository.revokeAllForUser`) and all trusted devices.
- **Neither denylists the session ids.** `SessionRevocationService.markRevoked` is called only by sign-out, revoke-session, account deletion and student blocking (`grep markRevoked`).
- `JwtAuthGuard` checks only the Redis denylist on the hot path. The database fallback is used only when Redis errors (`session-revocation.service.ts:90`).
- **Effect:** after a password reset (the account-recovery event), every access token issued before the reset keeps working for up to `JWT_ACCESS_TTL_SECONDS` (900 s).

### 4.2 Exact fix

- `RefreshTokensRepository.revokeAllForUser` returns the distinct `session_id`s it revoked (a single `UPDATE … RETURNING session_id`).
- Both callers then `markRevoked(sid)` for each returned id, using the existing service. It already swallows Redis errors, and the database fallback treats a family with no live rows as revoked, so this fails safe.
- The existing security model is unchanged: **all** sessions end, including the one that changed the password. That matches the current refresh-row behaviour. The frontend already handles 401 by sending the user to sign in.
- Also fixed in the same helper: `markRevoked` for all sids is reused by account deletion, which already does this.

### 4.3 Impact

- No schema, API contract, frontend or RLS change.
- **AuthN:** sessions end immediately instead of within 15 minutes.

### 4.4 Tests, verification, rollback, observability, do-not-change

- **e2e:**
  - Sign in on two devices, reset the password, and both access tokens get 401 on the next request.
  - Change the password in the profile, and other sessions plus the current one get 401.
  - With Redis unavailable, the database fallback still refuses.
- **Production verification:** a controlled account signs in twice, resets its password, and both tokens are refused (browser-verify workflow).
- **Rollback:** redeploy the previous image.
- **Observability:** audit `auth.sessions.revoked_on_password_change {count}`, and a counter.
- **Must not change:** the reset token rules, TTLs, trusted-device revocation, or the reset email.

---

## 5. A4 — Cross-Academy learner identity

### 5.1 Does the schema already support it? Yes (verified)

- `users.email` is UNIQUE, so there is one global identity.
- `academy_students` has `UNIQUE(academy_id, user_id)` and `@@index([userId])`, so one user can have many learner rows.
- `enrollments` are keyed `(student_id, course_id)` with a denormalised `academy_id`.
- The RLS `academy_students_self_insert` (`user_id = current_user_id`) and `enrollments_self_insert` (`is_academy_student(academy_id, me)`) already allow a user's own session to hold memberships in many academies.
- The local probe created one user with learner rows in two academies and both academy sessions worked.
- **The data model needs no change.** The blocker is only the signup flow.

### 5.2 Current signup behaviour for each case (verified in `AuthService.registerInternal`)

`POST /api/v1/auth/register` from an academy host (`academyId` required; the host is verified by `assertAcademyMatchesHost`). The first thing it does is `usersRepository.findByEmail(email)`, and **if the email exists it throws 409 `errors.auth.emailAlreadyRegistered`, whatever the account's relationships.**

| Case | Today |
|---|---|
| 1. Email does not exist | 201. User + `academy_students` row per the registration policy (open → active; approval → pending + staff notified; invite → token claimed, email-bound). Verification link sent only when academy OTP is `off` (DL-44). No session. |
| 2. Learner in the same Academy | 409 `emailAlreadyRegistered` |
| 3. Exists, no relationship with this Academy | 409 |
| 4. Learner elsewhere | 409 |
| 5. Instructor elsewhere | 409 |
| 6. Manager elsewhere | 409 |
| 7. Client Owner elsewhere | 409 |
| 8. Multiple relationships | 409 |

- The frontend (`PublicWebsiteSignUpPage` → `RegistrationForm`) shows the error and a "Sign in" link.
- Signing in instead does join an **`open`** academy silently (`resolveSurface` → `sign_in_join`).
- For **`invite`** and **`approval`** academies, an existing account has **no path at all**: sign-in returns 403 `notAMemberOfAcademy`, and signup returns 409.

### 5.3 Design: existing-account authentication, then new membership creation

The two steps are kept strictly separate.

**Step 1 — existing-account authentication (reuses the password check and rate limiter).**
`registerInternal` on an **academy** registration (`academyId` present) where the email exists:
1. Consume the **existing per-account sign-in limiter** (`AuthRateLimiterService`, key `signin:account:<email>`, the same budget as `SignInRateLimitGuard`), in addition to the existing `RegisterRateLimitGuard` IP limit. This stops the endpoint becoming a second password-guessing oracle.
2. `passwordHasher.verify(user.passwordHash, input.password)`. This is one argon2 operation, comparable to the `hash` a new registration performs.
3. Then:
   - Mismatch, or account `deleted`/`invited`: **the exact 409 `emailAlreadyRegistered` that is returned today.** No new disclosure.
   - `suspended`: 403 `accountSuspended`, the same as sign-in after a correct password.
   - Match: continue to step 2.

**Step 2 — new membership creation (reuses admission and the transaction).**
1. Refactor the membership block of `registerInternal` into one helper, `admitLearner(tx, {academyId, userId, admission, hostname})`. It is shared by the new-user and existing-user branches, so there is one code path for: `academySurfaceService.admissionForNewLearner` (policy; invite claim bound to the account's email), `academyStudentsRepository.create`, and the approval moderator notification.
2. Run it inside `runInUserContext(existingUser.id)`. RLS `academy_students_self_insert` applies.
3. The account already has a row in this academy (case 2):
   - `blocked` → 403 `academyAccessBlocked` (as sign-in).
   - Otherwise → 409 **`errors.auth.alreadyLearnerHere`** (new key: "You already have access to this academy — sign in"). It is revealed only after password proof.
4. A concurrent duplicate (a `P2002` on `academy_students(academy_id,user_id)`) is mapped to the same 409.
5. **Nothing else is written:**
   - No `users` row, and no change to name, password, email, verification state or status.
   - No organization, membership or permission change.
   - No session is minted. Registration never signs in (unchanged). The person then signs in on the academy host, and the **academy OTP policy and trusted-device rules apply exactly as today**.
6. Response: `201 { account: 'existing' }`. New accounts get `201 { account: 'new' }`; today the body is empty, so this is an additive field. The existing-account value is returned only after password proof.

**Security notification (recommended, small):** a new catalogue event `academy.learner.joined_existing_account` emails the account owner: "Your Atlas account was used to join *Academy B*. If this wasn't you, reset your password." It uses the existing outbox. It detects misuse of a leaked password. It is included by default and is an approval decision (§12).

**Frontend (minimal):** the `RegistrationForm` academy success state distinguishes `account:'existing'`: "You already had an Atlas account — you now have access to *Academy B*. Sign in with your existing password." No new pages.

### 5.4 What must not happen, and why it can't

| Must not | Guarantee |
|---|---|
| Second `users` row | No `user.create` on the existing branch; `users.email` UNIQUE |
| Role or ownership change | The only write is one `academy_students` row (+ approval outbox) |
| Password change | No hash write on this path |
| Exposing other roles or academies to Academy B | Academy B staff read the roster through `academy-roster.repository.ts`, where every query filters `academyId` (lines 51, 123, 174, 271). Student analytics is organization/academy scoped. The learner's own `/users/me` on academy hosts is projected (A5). |
| Academy A learning of Academy B | No write touches A. A's RLS and queries are academy-scoped. |
| Weakened RLS | No policy change |

### 5.5 Security analysis (proof sketch)

- **A. Authentication:** attaching to an existing identity requires that identity's password, verified with the same argon2 check as sign-in and the same per-account limiter. Registration issues no session; getting a session still requires sign-in plus OTP policy plus trusted-device rules.
- **B. Authorization:** the new row grants learner capability in Academy B only, through the existing `is_academy_student`. No organization or staff capability is derived from `academy_students` (`ManagementSurfaceGuard`, tenant guards and `SaasLevelCallerGuard` read other tables).
- **C. RLS:** unchanged. The insert passes `academy_students_self_insert`. Enrollments still need `is_academy_student(academy, me)`.
- **D. Session/revocation:** unchanged. A1 ensures the resulting academy-B session cannot reach management, and cannot act on Academy A's learner endpoints.
- **E. Email verification:** unchanged state. The verification link is not re-sent. An unverified account stays unverified until its next OTP or link. There are no new verification requirements.
- **F. OTP:** applies at the subsequent sign-in on B (academy policy; B's host has no trust cookie → new device → code under `new_device`).
- **G. Trusted devices:** host-only cookies; B is a separate trust.
- **H. Recovery:** a learner who doesn't remember the password uses B's "forgot password". The reset is global (one password), and A3 revokes all sessions.
- **I. Cross-Academy isolation:** see §5.4.
- **J. Enumeration:** the existing registration 409 already reveals that an email exists. The new behaviour adds **no** new signal before password proof: a wrong password gets the identical 409. After password proof only the password holder learns anything. The per-account limiter prevents using registration to brute-force.
- **K. Duplicate accounts:** impossible (UNIQUE email, no create on this path).
- **L. Role escalation:** the only capability added is learner-in-B, which is exactly what a brand-new signup would get.
- **M. Tenant escape:** the host must match `academyId` (existing `assertAcademyMatchesHost`). Invite tokens stay bound to their academy and email (`claim_academy_invite`).
- **N. Existing-user takeover:** no path changes credentials or mints a session. An attacker who **already knows** the password gains only a learner row the victim is emailed about, which is less than they could already do by signing in.

### 5.6 Impact

| Area | Impact |
|---|---|
| Data model | **None** |
| API | `POST /auth/register` from academy hosts accepts existing emails with proof of password; `201 {account}`; new 409 key `alreadyLearnerHere`. Platform-host (organization) registration is **unchanged**: an existing email still gets 409 (the owner/onboarding redesign is deferred to Plan B). |
| Frontend | `RegistrationForm` success copy (en/ar) and the new error key |
| RLS | Unchanged |
| Compatibility | Additive |

### 5.7 Tests

- **Unit:**
  - The `admitLearner` helper for each policy.
  - The existing-account branch matrix (password ok/wrong × status × already-member × policy).
- **e2e:**
  - Cases 1–8 from §5.2.
  - A wrong password returns the byte-identical 409 body.
  - Limiter: the 6th wrong attempt gets 429 and shares the budget with sign-in.
  - Concurrent double signup gives one 201 and one 409.
  - Invite policy: an email-bound invite for another address is refused.
  - Approval gives a pending row plus the staff outbox.
  - After joining, sign-in on B works with the existing password (OTP per policy); A and management are unaffected.
- **RLS:**
  - As `atlas_app` with Academy A staff context, B's rows are invisible.
  - Roster, analytics and results for A never include B enrollments.
- **Adversarial:**
  - An existing email with a wrong password, many times → 429 with no oracle.
  - A body `academyId` not matching the host → 403.
  - Tampered invite → refused.
  - An IDOR attempt: the joined learner requests A's course content on B's host → 403.
- **Playwright:** journeys J1–J7 in en and ar.

### 5.8 Production verification, rollback, observability, risks

- **Production verification:** J2 and J5 with controlled accounts on two production test academies.
- **Rollback:** redeploy the previous image. Rows created remain valid learner memberships.
- **Observability:**
  - `atlas_signup_total{mode="academy_existing", outcome}`.
  - Audit `academy.student.joined {source: self_signup, existingAccount: true}`.
  - The notification's outbox metrics.
- **Risks:**
  - Password-guessing via register. Mitigated by the shared limiter.
  - Email delivery of the security notice (KI-EMAIL-1). This is non-blocking; the notice is informational.
- **Must not change:**
  - The new-user signup path.
  - Organization signup.
  - `resolveSurface` (including `sign_in_join`).
  - Academy OTP.
  - Routes.

---

## 6. A5 — `/users/me` leaks cross-tenant relationships to academy origins

### 6.1 Current behaviour (verified)

- `toCurrentUser` (`src/identity/dto/contracts.ts:165`) returns `academies` (**all** learner academies: name, slug, host, status) and `organizations`/`organizationMemberships` (every organization role).
- It does this for `GET /users/me` and in every sign-in response, including sessions minted on an academy website.
- **Local probe:** Ziad's `/users/me` listed "Academy B" and his organization owner membership.
- On Academy A's origin (tenant-operated; possibly a custom domain whose DNS the tenant controls), that response exposes the person's other academies and their Client Owner, Manager or Instructor roles.

### 6.2 Why now

A4 multiplies the number of people with several relationships. Requirement: *"Academy A must not see Academy B membership … Organization memberships … roles."*

### 6.3 Exact fix

- When the session surface is `academy`, using A1's `SessionSurfaceService`:
  - `/users/me` and the sign-in / OTP / 2FA response `user` project `academies` to **only the session's academy entry**.
  - They return `organizations: []`, `organizationMemberships: []`, `roles: []`, `permissions: BASE_USER_PERMISSIONS`.
- `principalKind` for academy sessions is always reported as `learner`, because it is a routing hint only. The server-side authorization is unchanged.
- Management sessions are unchanged.

### 6.4 Compatibility (verified)

The academy frontend reads only `user.academies.find(a => a.academyId === <this academy>)` (`StudentMyLearningPage.tsx:141`). `IdentityProvider`'s organization restore tolerates an empty list (`organizations.some/find`). Academy hosts never mount organization UI.

### 6.5 Tests, verification, rollback

- **e2e:**
  - Academy-B session `/users/me` → exactly one academy, no organizations.
  - Management session → unchanged full shape.
  - Sign-in response on the academy surface → projected.
- **Frontend:** existing academy tests stay green; the pending-approval banner still works.
- **Rollback:** redeploy the previous image.

---

## 7. User journeys (expected behaviour)

| Journey | UX | API | DB | Session | Security result |
|---|---|---|---|---|---|
| **J1** New user → A signup | "Account created — sign in" (unchanged) | `201 {account:'new'}` | `users` + `academy_students(A)` | None until sign-in | Unchanged |
| **J2** Learner of A → B signup, correct password | "You now have access to B — sign in with your existing password" | `201 {account:'existing'}` | + `academy_students(B)` only; security email | None; then B sign-in (academy OTP) | One identity, two learner rows; A unaffected |
| J2' Same, wrong password | Existing "email already registered — sign in" | 409 (identical to today) | none | none | No oracle; limiter |
| **J3** Instructor (org X) → B signup | As J2 | 201 existing | + `academy_students(B)` | B session learner-only (A1, A5) | Instructor rights in X untouched; B cannot see them |
| **J4** Manager → B | As J3 | | | | |
| **J5** Client Owner → B | As J3 | | | | Ownership untouched |
| **J6** Learner of A → A signup again | "You already have access — sign in" (after password) / 409 generic (wrong password) | 409 `alreadyLearnerHere` / 409 `emailAlreadyRegistered` | none | none | No duplicate row |
| **J7** Multi-academy user signs in to A and B | Each academy site signs in separately | academy sign-in per host | none | Two independent academy sessions (per origin) | A-token refused on B learner routes (A1) |
| **J8** Staff management login | Unchanged | unchanged | none | management session | Management routes work (regression) |
| **J9** Password reset | Reset works; other devices signed out immediately | reset endpoints unchanged | password hash + revocations | **All** sessions 401 on next request (A3) | Recovery evicts attackers immediately |
| **J10** Academy session → management endpoint | n/a | **403** `managementSurfaceOnly` (A1) | none | unchanged | D1 closed |
| **J11** Management session → learner operation without authorization | n/a | 403/404 from existing enrollment/membership checks and RLS (regression test) | none | unchanged | Existing boundary proven |
| J12 Invited staff before setup | Sign-in fails like an unknown account | 401 | none | none | D2 closed |

## 8. Migration strategy

- **No schema migration.** Everything uses existing columns and enum values: `refresh_tokens.surface/academy_id`, `users.status='invited'`, `academy_students` uniqueness.
- The new 409 key and catalogue event are code only. The catalogue event needs its template (en/ar) and an entry in `docs/COMMUNICATIONS_EMAIL_NOTIFICATION_CATALOG.md`.
- **Data:** see §10 (the reset recommendation). If there is no reset, a one-off script handles D2 test accounts (§3.4).

## 9. Plan v3 items: re-evaluation

| Plan v3 item | Class | Why |
|---|---|---|
| D1 academy token → management | **[DO NOW] / [SECURITY FIX ONLY]** | Verified by probe. Fixed by a guard lookup, not context tokens. |
| D2 third-party passwords | **[DO NOW]** | Verified in code |
| D3 revocation on password change | **[DO NOW]** | Verified in code |
| Cross-academy learner identity | **[DO NOW]** | New requirement; the schema already supports it |
| `/users/me` relationship exposure on academy origins | **[DO NOW] (A5)** | Verified; required by the privacy rule |
| Schema support for one user → many learner rows | **[ALREADY SOLVED]** | `UNIQUE(academy_id,user_id)` |
| Academy tenant isolation for staff views | **[ALREADY SOLVED]** | Academy-scoped queries + RLS |
| OTP code binding to its challenge | **[ALREADY SOLVED]** | The code hash is salted with the row id; the surface comes from the row |
| Organization hostnames, org login/reset hosts, host resolver, label namespace | **[DEFER]** → Plan B | Not needed for the milestone |
| Context tokens (`ctx/cid`), organization-bound sessions | **[DEFER]** | D1 fixed without them |
| Organization-level OTP | **[DEFER]** | Explicitly out of scope |
| Account Center | **[DEFER] / [NOT NEEDED]** | Plan v3 already dropped it |
| Mailbox-first marketing signup, existing-account → Client Owner onboarding, multi-org cap, Platform Owner exclusion trigger | **[DEFER]** | Organization onboarding redesign |
| Post-signup hand-off, "Find my organization" | **[DEFER]** | Depends on organization hosts |
| Explicit Join replacing silent `sign_in_join` | **[DEFER]** | Consent improvement; not security-critical. `sign_in_join` stays unchanged. |
| OTP supersede scope per academy; TOTP challenge context binding | **[DEFER]** | UX / low severity (re-validated server-side) |
| `trusted_devices.academy_id` | **[DEFER]** | Host-only cookie already confines trust |
| Reset link follows the context host | **[DEFER]** | UX; not a security defect (the token is global and mints no session) |
| `X-Forwarded-Host` trust (LB-HOST) | **[DEFER — verify]** | Unverified. The host only selects context; authorization is database-derived. A read-only production probe is recommended before commercial launch. |
| Reserved labels `video`, `ssh` (LB-RESERVED) | **[DEFER]** | Namespace hygiene, not a tenant-isolation defect. A one-line fix can join Plan A if the owner wants it (§12). |
| CSP on SPA hosts | **[DEFER]** | Defence in depth; D1 removes the highest-value token exposure |
| RLS tightening (`academy_students_self_insert`, `enrollments_self_update`) | **[DEFER]** | No endpoint exposes them. The application enforces policy. Documented in Plan B. |
| `?academyId` learner fallback on the platform host | **[DEFER]** | Self-data only; A1 already binds academy sessions |
| Domain migration off `atlass.dpdns.org` | **[DEFER — required before commercial launch]** | Infrastructure, not this engineering milestone |
| Payment methods (LB-PAY), KI-EMAIL-1 measurement, Platform Owner TOTP, backup restore rehearsal | **[DEFER — commercial launch gate]** | Operational |
| Controlled test-data reset | **Recommended in the launch sequence** (§10) | Not executed now |

## 10. Controlled production test-data reset (recommendation; NOT executed)

**Recommendation: yes, but after Plan A is deployed and verified in production, and before any real customer is onboarded.**
- It removes the D2 test accounts, the test organizations and academies, stale sessions and test media, so launch starts clean.
- The strategy is "keep the platform, delete tenants" (Plan v3 option C). It is summarised here; the full procedure is in Plan B §R.

**What it keeps and what it deletes:**
- **Preserved:**
  - Platform Owner users (plus their TOTP).
  - Plans, add-ons, trial policy, platform settings, commission and payment-provider configuration, payment methods.
  - Platform domain configuration, platform-scope access policies.
  - `_prisma_migrations`, `schema_meta`.
- **Deleted:** every tenant row and every non-Platform-Owner user.

**Safeguards and steps:**
1. **Backup:** a verified `pg_dump` to `atlas-backups-production` (R2) plus a test restore into a scratch database.
2. **Inventory:** counts per table and a manifest of R2 keys and Stream video ids.
3. **Dependency analysis:** the delete order is generated from `pg_constraint` and the ON DELETE rules. Never hand-ordered.
4. **Maintenance window:** API maintenance; stop the workers.
5. **Queues:** drain BullMQ.
6. **External resources:**
   - Delete test academies' Cloudflare custom hostnames through the existing `DomainProviderRelease` / `deleteCustomHostname` path.
   - Delete Stream videos by the manifest and R2 tenant prefixes.
   - Clear the Worker KV denylist.
7. **Database:** one transaction as the owner role. `TRUNCATE … CASCADE` the tenant roots, then delete non-Platform-Owner users. Assert the preserved-table counts are unchanged.
8. **Redis:** flush the revocation, rate-limit, cache and queue keys.
9. **Verification:**
   - SQL zero-counts on tenant tables.
   - Platform Owner sign-in with TOTP.
   - `/public/plans` is correct.
   - Post-reset smoke tests: J1, J2, J8, J9, J10.
10. **Rollback/recovery:** restore the dump. Deleted R2 and Stream objects are not recoverable; that is accepted because they are test data. Optionally copy them to the backups bucket first.

Never an uncontrolled wipe. It needs its own written approval at execution time.

## 11. Test and verification summary

- **Unit:** A1 guard/service, A2 status handling, A3 revocation helper, A4 admission matrix, A5 projection.
- **Integration/e2e** (Jest + supertest + Postgres, in the existing `test/*.e2e-spec.ts` style): every table row in §2.5, §3.5, §4.4, §5.7 and §6.5, plus J1–J12.
- **RLS:** `atlas_app` probes for cross-academy isolation (roster, enrollments, progress, certificates).
- **Adversarial:**
  - Enumeration (identical 409 bodies and timing band).
  - Brute force through register (shared limiter).
  - IDOR on learner and management routes.
  - Concurrent signup.
  - Invite tampering.
  - Invited-account login.
  - Stale token after reset.
  - Academy token on management.
- **Frontend (Vitest):** the staff dialogs without a password; the registration existing-account success state; the new error key (en/ar).
- **Playwright (local host aliases + production browser-verify):**
  - J1, J2, J3/J5 (staff or owner signs up at another academy), J6, J7, J9, J10, J12.
  - Owner invites Manager and Instructor; each sets their password; each signs in.
- **CI gate:** backend and frontend typecheck, lint, unit, e2e and build all green. The reflection route-inventory test is green.
- **Production smoke (after deploy):**
  - The `onboarding-verify` extensions.
  - The browser-verify journeys J2, J9, J10, J12 with controlled accounts.

## 12. Decisions needed before implementation

1. Approve Plan A scope (A1–A5).
2. **A4 security notification email** ("your account joined Academy B"). Recommended: include.
3. **Controlled test-data reset** in the launch sequence (§10). Recommended: yes, after Plan A is verified; a separate approval at execution time.
4. Optional one-line addition: reserve the `video` and `ssh` subdomain labels (LB-RESERVED).

## 13. Explicitly NOT changed by Plan A

- Routes: platform, management, academy, custom domains, dashboard URLs, auth URLs.
- Organization signup/onboarding, Platform Owner model, OTP policy and behaviour, trusted devices.
- `sign_in_join`, the RBAC permission arrays, all RLS policies, the token format.
- Caddy, DNS, Cloudflare, environment flags (other than the temporary `SURFACE_SESSION_ENFORCE`, which is removed afterwards).

## 14. Commercial launch items outside this milestone

These are required before **real commercial launch**, not for this engineering milestone:
- An Atlas-owned domain (LB-DOMAIN).
- Payment methods configured (LB-PAY).
- KI-EMAIL-1 delivery latency measured and accepted.
- Platform Owner TOTP enabled.
- Backup restore rehearsed.
- The `X-Forwarded-Host` probe.
- The controlled reset.

Details are in Plan B.
