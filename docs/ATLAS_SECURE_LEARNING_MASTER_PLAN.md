# Atlas Secure Learning — Master Implementation Plan

**Single source of truth for the P64 initiative: secure learning content, assessments, learner identity and the complete learner journey.**
Supersedes the published proposal versions 1 and 2 (https://claude.ai/artifact/QzfCw5aH9rJ3WnTjKEZhkE), which remain as research background only. When this file and any other document disagree, this file wins.

Repository: `atlas-backend` (this file) and `atlas-front` (frontend work referenced here). Related authorities that stay in force: `docs/plans/ENTITLEMENT_SEMANTICS.md`, `docs/course/UNIT_CURRICULUM.md`, the P63 custom-domain design in `src/domain`.

---

## Document Status

| Field | Value |
|---|---|
| Status | **Phase 1 implementation complete (local), not yet deployed** (19 Sep 2026). Phases 2–4 not started and not approved. |
| Version | 1.0 — 18 Sep 2026 |
| Approved product decisions | 9 (see below) |
| Implementation approval | **Phase 1 approved and delivered** (18 Sep 2026); Phases 2–4 not yet approved |
| Current phase | Phase 1 — implementation, tests, Playwright J2/J3, the `surface.enforce` rollout flag, browser validation and security review all complete. Only the two production steps of its Definition of DONE remain, and they need explicit authorisation. Awaiting explicit Phase 2 approval. |

Allowed status values: Planning / Awaiting Approval / Approved / In Progress / Blocked / Complete.

---

## How this file is used (mandatory workflow)

Before starting any phase, the implementer (human or agent) must:

1. Read this master plan in full.
2. Read the current phase's scope, acceptance criteria and definition of done.
3. Read the previous phase's **Phase Completion Record** at the bottom of this file.
4. Inspect the current repository state (`git log`, `git status`, schema, migrations, tests) and confirm it matches the previous completion record.
5. Confirm every dependency of the current phase is satisfied and every acceptance criterion is understood.
6. Implement **only** the current approved phase. Work from another phase is allowed only when a hard dependency requires it, and must be recorded as a deviation.
7. Run the required unit, integration, RLS and e2e tests for the phase.
8. Perform the required Chrome browser validation with a learner account created through an academy website.
9. Record actual results (tests run, browser checks, commits, deploy SHAs) in the **Phase Completion Record**.
10. Set the phase status (In Progress / Blocked / Complete) in the phase header and in **Document Status**.
11. Record deviations, discoveries, decisions and unresolved issues in the **Decision Log** and **Implementation Change Log**.
12. **STOP** before starting the next phase and wait for explicit approval.

The next phase always starts from the updated master plan and the recorded completion state of the previous phase. This file must stay synchronized with reality; a phase whose record is missing or stale is not complete.

Hard rules inherited from the project rulebook: guard decides and RLS independently agrees; no destructive production changes; no migrations outside an approved phase; entitlement zero-delta rules apply to every new limit; Live Sessions add-on stays untouched.

---

## Approved Product Decisions

| # | Decision | Ruling (binding) |
|---|---|---|
| D1 | Cloudflare DRM | Proceed **without DRM**. Use Cloudflare Stream with mandatory signed tokens, short-lived authorization, allowed origins, entitlement checks at academy/course/lesson level, watermarking, and a provider abstraction with capability flags. Do not design around DRM. Keep the architecture extensible so a DRM-capable provider can be added later. Verifying DRM availability with Cloudflare in writing happens during provider onboarding and **must not block** implementation. |
| D2 | Staff who are also learners | **Remove learner routes from the management dashboard.** Staff who are enrolled learn through the academy website exactly like students. Management surface = Platform Owner / Client Owner / Manager / Instructor → management dashboard. Learning surface = learner → academy website → academy login → learner dashboard → learning experience. No duplicate learner routes in the dashboard. |
| D3 | Registration policy | Existing academies default to **open** registration. New academies choose the policy at creation. The model supports open and invitation-only/restricted policies and must remain changeable later (no hard-coding). |
| D4 | Device takeover | **Allowed.** Inform the learner another active learning session exists; require explicit confirmation; revoke/terminate the previous learning session; activate the new one; record an auditable `DEVICE_SESSION_TAKEOVER` event with learner, old device/session, new device/session, academy, course/session context and timestamp. |
| D5 | Video storage quota | Add `videoStorageMinutes` to Atlas plans: Starter 500, Professional 2,000, Business 5,000 minutes. These are Atlas entitlements, **not** Cloudflare billing values. Atlas enforces the quota when video content is added (reject when `usage + new > quota`, e.g. 1,850 + 180 = 2,030 > 2,000 → reject with a clear message; 1,850 + 100 = 1,950 → allow). No delivery/consumption quotas now, but keep the model extensible. Cloudflare billing stays external and Atlas never depends on a Cloudflare price. Atlas owns plan quota, usage, enforcement and upgrade messaging; Cloudflare owns provider usage and charges. |
| D6 | Certificate branding | Platform-standard certificate template with academy logo/identity, academy signature where applicable, and an "Issued via Atlas" footer. Lifecycle supports eligibility, issuance, certificate ID/reference, visibility, verification, status, revocation, explicit regeneration rules, and immutable issuance facts. |
| D7 | Quiz retake after certificate | Learners may retake a required quiz after a certificate is issued. The certificate preserves the score/result at issuance; a later retake never silently modifies it. Regeneration/reissuance is an explicit workflow, never a side effect. |
| D8 | Security policy permissions | **Client Owner**: academy-wide authority including security-sensitive policies (device/session enforcement, content protection/security configuration). **Manager**: academy-wide operational course/content/curriculum management, learner outcomes, grading/review, operational settings — **no** authority over device enforcement or other high-impact security policies. Owner and Manager are never collapsed into one permission set; RBAC stays explicit and granular. |
| D9 | `administrator` academy role | Keep in the enum/model for compatibility; hide from the UI; not selectable for new assignments; no new functionality built on it; existing records preserved; retirement is a separate future migration decision. |

Note on D5 naming: the repository's seeded and typed plan tiers are `Starter`, `Growth`, `Enterprise` (`prisma/seed.ts`, `src/plans`). The approved quotas are mapped Starter → 500, Growth (the tier the decision calls "Professional") → 2,000, Enterprise (the tier the decision calls "Business") → 5,000 unless the owner corrects the mapping (Decision Log DL-3). The existing `videoStorage` limit is in **GB** (R2 file storage); `videoStorageMinutes` is a new, separate key for provider-hosted video.

---

## Architecture Decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | **Atlas is the sole authorization authority; Cloudflare Stream and R2 are delivery layers that only honour capabilities Atlas signs.** Video bytes are never proxied through the backend. | Keeps the single VPS off the media path; revocation and entitlement stay centralized. |
| AD-2 | **Entitlement is evaluated at the moment bytes are requested**, per lesson, per request, and again on every playback-token refresh. Sections/curriculum responses never carry content URLs. | Closes the "one enrollment = whole course forever" model. |
| AD-3 | **Lesson bodies and resources live in `lesson_contents` / `lesson_resources` with no public RLS policy.** | Structural fix for the published+public lesson policy gap. |
| AD-4 | **Principal kind is derived, not stored**: `platform_owner` (flag), `staff` (any organization membership or active `academy_members` row), otherwise `learner`. A person can be staff in one organization and a learner in another; the surface decides which capabilities apply. | Matches the existing "students are global users + `academy_students`" rule without adding a contradictory flag. |
| AD-5 | **Surface-aware authentication**: sign-in carries `surface: 'management' \| 'academy'`; learners are refused a management session; `ManagementSurfaceGuard` protects every management controller server-side. | Finding 1 requires enforcement beyond frontend routing. |
| AD-6 | **Scopes**: platform → organization → academy → course. Instructor is course-scoped (`course_instructors`), Manager and Client Owner are academy-wide, with D8's split between operational and security-sensitive authority. New helpers `assertCanReviewCourse`, `assertCanViewAcademyStudents`, `assertCanManageSecurityPolicy` and SQL `can_review_course`. | Finding 5. |
| AD-7 | **Video provider abstraction** `VideoProvider` with `capabilities()` (`signedPlayback`, `allowedOrigins`, `staticWatermark`, `drm`, `downloads`) and `CloudflareStreamProvider` as the only production implementation. | D1; extensibility. |
| AD-8 | **Server-authoritative quiz attempts**: server clock, deadline, autosave with monotonic revisions, delayed auto-submit job plus sweep, database uniqueness (attempt number; one open attempt), grading policies, results disclosure by policy. Expiry grades as-is and never auto-fails. | D5 of the previous round (quiz expiry), finding evidence. |
| AD-9 | **Integrity tiers**: enforcement (server), detection (browser signals with server timestamps), deterrence (fullscreen, selection/copy/context-menu limits, watermark), UX (warnings, counters, thresholds). No claim that recording or screenshots can be prevented. | Honest security model. |
| AD-10 | **Device policy** via server-issued `atlas_device` cookie and `student_devices`; concurrent learning session via Redis lease with heartbeats; defaults 2 devices / 1 session in `access_policies` (platform → academy → plan override, Client Owner only). Takeover per D4. | D4, D8. |
| AD-11 | **Completion rules** per course (`completion_rule` JSON) evaluated server-side from lesson evidence, quiz results and assignment grades; certificates issued from an eligibility evaluator with immutable issuance snapshot. | Finding 2, D6, D7. |
| AD-12 | **One learner surface**: learner dashboard and player live on the academy website under `/my/*`; dashboard learner routes are removed after redirects. | D2. |
| AD-13 | **Additive migrations only**; every projection change is behind a per-academy flag with a platform default; rollback = flag off. | Rollout safety on a single-VPS deployment. |
| AD-14 | **Quota model**: `videoStorageMinutes` is a `PlanResourceLimits` key following `granted_limits ?? plan.limits` and zero-delta semantics; usage is Atlas-owned (`media_assets.duration_seconds` for ready videos plus active upload reservations); enforcement happens before a direct-upload URL is issued and again when the provider reports the real duration. | D5. |

---

## Scope

**In scope**: everything in the four phases below — critical fixes; identity surfaces; registration integrity; student roster; RBAC realignment; learner dashboard; unified course player; protected content tier; Cloudflare Stream video; device/session policy; video quota; quiz engine v2; integrity layer; assignment drafts/due dates; completion rules; certificates; catalog, preview and checkout; observability; hardening; production rollout.

**Out of scope**: DRM integration (D1), forensic A/B watermarking, Live Sessions add-on changes, marketplace/cross-academy course sharing, payment gateway integrations beyond the existing manual-payment order pipeline, native mobile apps.

**Estimate**: 17–19 engineering weeks with one backend and one frontend engineer in parallel (Phase 1 ≈ 4 weeks, Phase 2 ≈ 7 weeks, Phase 3 ≈ 5 weeks, Phase 4 ≈ 3 weeks).

---

## Findings Traceability

### Manually discovered findings (owner testing, reproduced 18 Sep 2026)

| Finding | Root cause (verified) | Required architectural change | Phase | Tests | Acceptance criteria |
|---|---|---|---|---|---|
| **F1. Student dashboard / student access model.** Learner signs in at central `/auth/sign-in` and lands on the management dashboard (Create organization, Organization, Plans); `/dashboard/platform`, `/dashboard/settings`, `/dashboard/organization/create` render; academy learner area is a single list plus a reused dashboard profile. | No principal classification (`users` has no kind; only `SaasLevelCallerGuard` infers "student"); `POST /auth/sign-in` ignores memberships; `AUTHENTICATED_ENTRY_ROUTE = /dashboard` with auth-only guard; `JwtAuthGuard`-only controllers callable by any token; no learner shell on the academy site. | AD-4, AD-5, AD-12: `PrincipalResolver`, surface-aware sign-in with refusal, `ManagementSurfaceGuard`, staff-only `/dashboard` guard, academy chooser, learner dashboard on the academy site, removal of dashboard learner routes. | 1 (identity), 2 (dashboard) | e2e: learner refused on management surface; learner token 403 on management controllers; component tests for refusal screen and chooser; Playwright journey J2. | A learner principal can never obtain a management session or call a management controller; learners have a full dashboard on the academy site; no dashboard learner route remains. |
| **F2. Certification / course completion.** `certificateStatus` is a two-value enum; nothing to view, download or verify; course completes before required quiz. | Certificates explicitly unimplemented (master plan §24 "SPECIFICATION-UNDEFINED"); completion = all lessons only. | AD-11: completion rules including quizzes/assignments; certificate service, renderer, verification, revocation, regeneration; learner and staff UIs. | 3 | Rules evaluator unit tests; e2e issuance/regeneration/revocation/verification; Playwright J1 steps 20–21. | Certificate is a verifiable, revocable, academy-branded artifact issued only when the course's rules are met. |
| **F3. Course-taking UX.** Quiz and assignment pages render outside the player shell; Next skips quizzes; assignment ordered before lesson one; lesson-only locking; no lock reasons; video without states/deterrents; result card offers retry after passing; submitted assignment text not shown. | `LearningLayout` wraps `LessonPage` only; navigation iterates `flatLessons`; unlock model applies to lessons only; native `<video>`; no sequence endpoint with states. | Unified player shell and ordered sequence with per-item state and lock reasons; video adapter with states; completion behaviours; assignment timeline; completion screen. | 2 (shell, sequence, player, video), 3 (completion rules, assignment status, results) | Component tests for shell states; e2e for sequence and locks; axe; Playwright J1. | Every activity renders in the shell; Next/Previous cover all items; lock reasons shown; learner always sees where they are, what is done, what remains, what is next. |
| **F4. Student missing from Client Owner Members.** Registered learner not listed; Members shows only staff roles. | Members page and `GET academies/:id/members` list `academy_members`; **no endpoint or UI lists `academy_students`**; registration creates the student row correctly but in a second transaction; management-host registration drops `academyId`; purchase path skips membership. | Student roster endpoint + Students tab + drawer; atomic registration; membership created on purchase; provenance columns; policy-aware registration. | 1 | e2e: signup → roster; atomic rollback under fault injection; roster isolation across academies; Playwright J3. | A learner registered on an academy site appears in that academy's Students tab in the same request; membership is never lost or duplicated. |
| **F5. Client Owner / Manager course management (RBAC).** Owner and manager get 404 on attempt review, submissions and grading; instructors cannot edit curriculum; owner attaching a quiz to a section of a draft course gets 500; owner analytics "failing quiz" can never fire; owner sees Teaching items; org member reads curriculum. | `assertTeachesCourse` and RLS key on `course_instructors` only; curriculum services use `MANAGING_ROLES`; `course_sections` has no author-tier SELECT policy while quiz authoring runs in user-only context; no tenant policy on `quiz_attempts`; navigation is permission-string driven. | AD-6: `assertCanReviewCourse`, review RLS policies, author-tier section/lesson policies, tenant attempts policy, instructor curriculum editing, role-driven navigation, D8 split, D9 hiding. | 1 | e2e role matrix (owner, manager, instructor own/other, staff, org member, student × view/grade/edit/list); RLS negative cases. | Permission matrix (Section "RBAC matrix") is true at guard, RLS and navigation layers. |

### Code-audit security findings (verified)

| ID | Finding | Root cause | Change | Phase | Tests | Acceptance |
|---|---|---|---|---|---|---|
| S1 | All stored media served anonymously with 1-year immutable cache; refund cannot revoke. | `public/media` route has no guard and no DB read by design. | Protected bucket + per-lesson grants (AD-2). | 2 | e2e grant matrix; anonymous fetch of protected key 403/404. | No durable URL to protected content in any learner response. |
| S2 | RLS lesson policy for published+public courses has no session predicate; RLS test uses draft fixtures. | `course_lessons_public_discovery_select`. | `lesson_contents` with no public policy (AD-3); honest RLS spec. | 1 (spec), 2 (table) | RLS spec with published+public fixtures. | Zero rows without context, foreign tenant, non-enrolled user. |
| S3 | One enrollment returns every lesson URL; lock is React-only. | `GET courses/:id/sections` projects `contentUrl`. | Grants; sections without URLs. | 2 | e2e locked lesson has no content. | Locked items carry no content. |
| S4 | Quiz: no timer/autosave/deadline; reload loses answers; concurrent starts bypass `maxAttempts` (3 attempts created against a cap of 2, two numbered "2"); second attempt while one open. | No constraints; read-then-insert without lock. | Unique + partial unique indexes, row lock, open-attempt return (Phase 1); engine v2 (Phase 3). | 1, 3 | Promise.all(10) start → 1 attempt; reload resumes. | Exactly one attempt per start burst; resume restores answers and time. |
| S5 | Registration into any academy by id. | `register()` validates only existence. | Registration policy (D3). | 1 | e2e per policy. | Non-open academies refuse unsolicited joins. |
| S6 | Progress read/completion 500 without progress rows; UI shows lessons anyway. | `backfillLessonProgress` updates a missing row. | Upsert; materialize on read. | 1 | e2e. | Never 500. |
| S7 | Completion is a client assertion. | No evidence model. | Playback heartbeats, dwell, rules (AD-11). | 2, 3 | e2e rules. | Certificates not forgeable by N calls. |
| S8 | No device/session limits; refund is the only revocation; leaving an academy keeps access; enrollments lack lifecycle. | Model gap. | Enrollment lifecycle columns; device policy (AD-10). | 1 (lifecycle), 2 (devices) | e2e revoke/expire/device. | Revocation refuses new grants immediately. |
| S9 | Plain org member reads all curriculum; students hold unrestricted UPDATE on own enrollment; `uploadForSubmission` unauthenticated internally. | Service/RLS gaps. | Author check on read; WITH CHECK; membership check. | 1 | e2e/RLS. | Closed. |
| S10 | Production: course page links by slug while API resolves by id → 404; dead `/api/config` call. | Resolver gap. | Slug-or-id resolver; remove dead call. | 1 | e2e; production read-only check. | Course page renders by slug. |
| S11 | Media route buffers whole objects, no Range. | Implementation. | Range support on the public route. | 4 | e2e Range. | Range requests honoured. |
| S12 | Assignment `dueAt` never enforced; attachment URL unvalidated. | Service gap. | Due date + late policy; attachment must be a protected asset of the student. | 3 | e2e. | Late policy enforced. |

### Findings from Phase 1 browser validation (18 Sep 2026)

Found by driving real Chrome against the running stack AFTER the whole Phase 1 test suite was already green. None of them was reachable from the seeded fixtures the automated tests build, which is exactly why the browser pass is mandatory. All four are fixed and carry regressions (`test/p64-browser-findings.e2e-spec.ts`).

| ID | Symptom in the browser | Root cause | Fix | Regression |
|---|---|---|---|---|
| B1 | A learner manually enrolled by staff into a `draft`/`private` course got **HTTP 500** on their own "My Learning" list: `Inconsistent query result: Field course is required to return data, got null instead`. | `courses` had five SELECT tiers (public discovery, academy participant, course instructor, tenant, platform owner) and **none for an enrolled student**, so the required relation resolved to NULL. Invisible until Phase 1 gave staff a way to grant access to a non-public course. | `20261008000600_p64_phase1_courses_enrolled_student_select` — a student may SELECT a course they hold an enrollment for. Content tiers unchanged (DL-11). | 2 tests, incl. the negative case for another learner of the same academy. |
| B2 | The Students tab read **"1 active of 1"** for an enrollment that had already expired, while the learner was being refused the content. | `AcademyRosterRepository.findMany` counted `status` + `revokedAt` but not `expiresAt`, so "active" meant something different from `isEnrollmentActive`. | The count now applies the same three conditions. | 1 test asserting roster and learner agree. |
| B3 | A blocked learner stayed **signed in** on the academy site: content was refused, but the session lived until the access token expired. | `block()` wrote the membership row and nothing else; nothing revoked the sessions. | `RefreshTokensRepository.revokeSessionsForUserInAcademy` + `SessionRevocationService.markRevoked`, after the membership transaction commits, scoped to that academy (DL-10). | 2 tests: the old token is refused, and a session on another academy survives. |
| B4 | "My Learning" offered an enabled **Start Course** button on a revoked enrollment, which led into a 404. | The learner contract exposed only `status`, which stays `enrolled` on an expired enrollment, so the card could not know. | `EnrollmentResponse` now carries `isActive`/`expiresAt`/`revokedAt`; the card disables the action and reads "Access ended". UI reflecting backend authorization, never replacing it. | 2 e2e + 9 frontend unit tests. |

### Gaps closed after the first readiness checkpoint (19 Sep 2026)

The checkpoint found two Phase 1 items genuinely unbuilt rather than merely unrecorded. Both are now built and tested.

| Gap | What was missing | What was built |
|---|---|---|
| G1 — Playwright J2/J3 | No Playwright project existed in either repository, so the two journeys the plan names in §P had never been automated; the ground was covered only by manual Chrome. | `atlas-front/playwright.config.ts`, `e2e/support/atlas.ts`, `e2e/support/global-setup.ts`, `e2e/j2-surface-enforcement.spec.ts` (9 tests), `e2e/j3-roster-rbac.spec.ts` (9 tests). They drive the real Vite server, the real API and the real database — no mocks — with Chrome via `channel: 'chrome'`. `npm run test:e2e`. |
| G2 — `surface.enforce` | §T requires the surface refusal to roll out staged by allowlist. Nothing implemented it; enforcement was unconditional, so there was no staged rollout and no rollback short of a redeploy. | `SurfaceEnforcementConfig` (`SURFACE_ENFORCE_MODE` = `off` \| `allowlist` \| `on`, default `on`; `SURFACE_ENFORCE_ACADEMY_IDS`), `SurfaceEnforcementService`, consulted by `ManagementSurfaceGuard` and by `AuthService.resolveSurface`, and reported to the frontend as `managementSurfaceEnforced` on `/users/me` so routing follows the server rather than guessing. |

### Findings from the Playwright and rollout-flag work (19 Sep 2026)

| ID | Symptom | Root cause | Fix | Regression |
|---|---|---|---|---|
| B5 | The guarded course-list endpoint took **5.8 s** and returned HTTP 500 (`Transaction already closed`), and **25 of 25** concurrent requests failed against **3 of 25** on an unguarded endpoint. | `courses_enrolled_student_select` (B1's fix) was an inline `EXISTS` over `enrollments`. That subquery runs as the invoking role, so it evaluated all eleven `enrollments` policies **once per candidate course row**, through the pre-existing `course_categories_public_discovery_select` correlated subquery. | `20261008000700` — the lookup moved into the `is_enrolled_in_course` SECURITY DEFINER function, the same correction `20261008000400` made for quiz attempts. Measured: 2,319 ms without the tier, 3,658 ms with the inline version, **2,025 ms** with the function; the endpoint went to **0.68 s** and 23/25 concurrent. | `p64-rls-review-and-published` asserts the policy resolves through the function and that the function is SECURITY DEFINER — a shape assertion, because a timing assertion would be flaky. |
| B6 | A rate-limited sign-in showed the raw key `auth.rateLimited` instead of a sentence. | `errors.auth.rateLimited` was missing from both locale files; the backend has emitted that key since long before P64. Pre-existing, surfaced by the journeys hitting the real limiter. | Added to `en` and `ar`. Verified in the browser: the alert now reads "Too many attempts. Please wait a few minutes and try again." | Covered by the locale files themselves; the journeys now flush the limiter rather than depending on it. |

### Security observations recorded, not changed in Phase 1

| ID | Observation | Assessment | Recommendation |
|---|---|---|---|
| O1 | Twenty tables carry no RLS: platform-global configuration (`plans`, `add_ons`, `platform_settings`, `trial_policy`, commission and provider config, `platform_domain_configuration`, `schema_meta`, `_prisma_migrations`, sweep cursor, `live_provider_events`) and the identity/credential tables (`users`, `refresh_tokens`, `password_reset_tokens`, `email_verification_tokens`, `user_two_factor`, `two_factor_recovery_codes`, `trial_redemptions`, `payment_methods`). 69 of 89 tables do have it, FORCE-enabled. | Pre-existing and architectural, not introduced by Phase 1. Identity is deliberately cross-tenant: one person can belong to many organizations, so a tenant predicate on `users` has no meaning. Not reachable through the API — a learner JWT was refused on every management endpoint and on another user's record. It matters only to an attacker who already executes arbitrary SQL as `atlas_app`. | Decide deliberately whether the identity tables get user-scoped RLS as defence in depth. It touches every module, so it belongs in its own phase, not in Phase 1. |
| O3 | A 25-way concurrent burst still fails 2–3 requests with `Transaction already closed`, on guarded and unguarded endpoints alike, on this development machine. Prisma's defaults apply: interactive transactions wait 2 s for a connection and live 5 s. | Pre-existing and configuration-level, not a Phase 1 behaviour — the unguarded public endpoint fails at the same rate. It is visible here only because the local database carries ~2,400 accumulated test courses and an expensive pre-existing `course_categories_public_discovery_select` policy. | Before production, size the connection pool and the transaction budget deliberately, and consider an index or a redesign of that category policy. Not a Phase 1 change. |
| O2 | `POST /auth/register` answers `409 errors.auth.emailAlreadyRegistered`, letting an anonymous caller test whether an address has an Atlas account. Now reachable on every academy sign-up page. | Pre-existing. Sign-in and password reset are both correctly neutral (identical responses for known and unknown addresses), so registration is the only enumeration surface left. | DL-12 — owner decision. Removing it means answering neutrally and emailing the existing account instead, which changes the sign-up experience. |

---

## Security Model (end-to-end, preserved)

| Tier | Meaning | Controls in this plan |
|---|---|---|
| **Enforceable** (backend decides) | Cannot be bypassed from the client. | Per-request entitlement checks (identity, academy context, active non-revoked non-expired enrollment, published course, unlocked lesson, valid session/device, no suspension); tenant isolation via guards + RLS; signed media access (Stream tokens, R2 presigned URLs) with short TTLs; protected media delivery; lesson locking on delivery; server-authoritative quiz timer, state, autosave, auto-submit, grading, attempt limits, results disclosure; session/device caps and takeover; revocation; audit logs; surface enforcement for learners; roster and review RBAC. |
| **Detection** (browser signals, server records) | Advisory; never changes a score by itself. | Visibility/blur/fullscreen/copy/paste/print events with server timestamps; lease conflicts and device changes; heartbeat gaps; answer timing; grant-rate anomalies; concurrent playback. |
| **Deterrence** | Raises effort; defeatable. | `controlsList="nodownload noremoteplayback"`, no picture-in-picture, media context-menu suppression, no-select on text lessons (academy setting), print stylesheet, fullscreen request in exam mode, static academy watermark (Stream profile), per-viewer visible overlay (name, masked email, time). |
| **UX only** | Shapes behaviour. | Warnings, violation counter, thresholds, consequence copy, honor-code style disclosure. |
| **Impossible in a browser** | Never promised. | Preventing screen recording, phone cameras, HDMI capture, a second device viewing the screen; preventing fullscreen exit; unbreakable DRM. |

---

## RBAC Matrix (final)

| Capability | Instructor (assigned courses) | Manager (academy) | Client Owner (academy-wide) | Platform owner |
|---|---|---|---|---|
| See courses | Assigned only | All in academy | All | All (platform views) |
| Create / publish / archive course | No | Yes | Yes | Support only |
| Edit curriculum (sections, lessons, bodies, media) | Yes, assigned | Yes | Yes | No |
| Author quizzes and assignments | Yes, assigned | Yes | Yes | No |
| Assign instructors | No | Yes | Yes | No |
| View attempts, answers, submissions | Assigned | All | All | Aggregates only |
| Grade manual quiz questions and assignments | Assigned | Yes | Yes | No |
| Void attempt, extra time/attempts, reopen window | Assigned | Yes | Yes | No |
| View student roster | Students of assigned courses | Whole academy | Whole academy | Counts |
| Enroll, revoke, extend, block students | No | Yes | Yes | No |
| Certificates view / issue / revoke | View (assigned) | All | All | Counts |
| Registration policy | No | No | Yes | Platform defaults |
| Content protection configuration | No | No (D8) | Yes | Platform defaults |
| Device/session enforcement policy | No | No (D8) | Yes (within platform maximums) | Platform defaults and maximums |
| Integrity reports and exports | Assigned | All | All | No |
| Billing, plans, provisioning, domains | No | No | Yes | Yes |
| `administrator` role | hidden (D9) | hidden | hidden | hidden |

---

## Learner Journey (end-to-end ownership)

| Stage | Owner phase | Acceptance criterion |
|---|---|---|
| Academy discovery (public site, catalog) | 4 | Catalog is server-paginated with search/filters; cards show level, duration, price, preview badge. |
| Academy registration / login | 1 | Registration atomic and policy-aware; login on academy host redirects to the learner dashboard; 2FA, forgot/reset/verify work on academy hosts; central login refuses learners. |
| Learner dashboard | 2 | Overview, My Courses, Course progress, Assessments, Certificates, Purchases, Devices, Profile, Security under `/my/*`, EN/AR, mobile. |
| Course discovery / details | 4 (details revamp), 1 (slug fix) | Single state-aware CTA; slug resolution. |
| Preview / welcome video | 4 (preview lessons, intro video) with 2 (grant `is_preview`) | Preview lessons open anonymously with an enroll rail. |
| Enrollment (free) / purchase (paid) | 1 (lifecycle), 4 (checkout) | Free: one click, idempotent; paid: order → proof → approval → enrollment + membership in one transaction. |
| Course player / curriculum / lesson | 2 | Unified shell, ordered sequence, states, lock reasons. |
| Protected video / content | 2 | Grants per lesson; Stream signed tokens; allowed origins; watermark; no durable URLs. |
| Progress and persistence | 2 | Playback heartbeats, resume position, watched ratio, dwell; undo. |
| Quiz, timer, autosave, submission, expiry | 3 | Server clock; reload resumes; auto-submit grades as-is; never auto-fail. |
| Assignment, grading, feedback | 3 | Drafts, due date/late policy, status timeline, grade and feedback visible. |
| Required completion rules → course completion | 3 | Rules evaluated server-side; completion screen. |
| Certificate issuance, dashboard, verification | 3 | Issued on eligibility; immutable snapshot; PDF; `/verify/:code`; revocation. |
| Devices / sessions | 2 | 2 devices, 1 session, takeover with audit. |

---

# Phase 1 — Foundation, Identity Surfaces, Membership Integrity and RBAC

**Status:** In Progress (started 18 Sep 2026)
**Estimate:** ~4 weeks
**Consolidates:** P64a (critical fixes), P64b (identity surfaces, registration, roster), P64c (RBAC realignment), plus enrollment lifecycle columns and seed alignment.

### A. Objective
Make identity, membership and authorization truthful: learners authenticate only through academy websites and can never reach the management surface; registration is atomic and policy-driven; every academy student is visible to its Client Owner; owners, managers and instructors get exactly the authority in the RBAC matrix; and the live defects and races found by the audits are removed.

### B. Why this phase exists
Every later phase (content grants, quiz engine, certificates) relies on a correct answer to "who is this, on which surface, with which authority". Findings F1, F4 and F5 and security findings S2 (spec), S4 (constraints), S5, S6, S8 (lifecycle), S9 and S10 are all identity/authorization/integrity defects that must be fixed before content or assessment work is built on top of them.

### C. Dependencies
None. Requires owner approval to start.

### D. Backend work
1. **Critical fixes**: upsert `course_progress` in `backfillLessonProgress` and materialize on read; enrollment row lock in `startAttempt`, return the open attempt instead of creating a second, validate option ids belong to the question, idempotent submit; slug-or-id course resolution in the public website API; `getSections` on the academy route requires `assertCanAuthorCourseContent`; `uploadForSubmission` checks academy membership.
2. **Principal model**: `PrincipalResolver` (per-request cached) returning `platform_owner | staff | learner` plus `academies[]` from `academy_students`; exposed in `GET /users/me` and the sign-in response.
3. **Surface-aware auth**: `POST /auth/sign-in` accepts `surface` and `academyId` (academy id re-verified against the request host); management surface refuses learners with `403 errors.auth.studentUseAcademySignIn` and the learner's academy hosts; academy surface joins under `open` policy (recorded `source = 'sign_in_join'`) or refuses under restricted policies; sessions store `surface` and `academy_id`; refresh preserves them.
4. **`ManagementSurfaceGuard`** applied to organization, academy, provisioning, website, tenant, platform, instructor/review, media-manage, search and notifications-admin controllers; shared endpoints (profile, sessions, two-factor, notifications feed) remain open to all principals.
5. **Registration integrity**: atomic `register` (user + `academy_students` + verification outbox in one transaction); management-host registration limited to staff onboarding (never creates a learner); `academies.registration_policy` (`open` default for existing, chosen at creation for new, `invite` and `approval` supported) with invite tokens and an approval queue; purchase path (`createEnrollmentInTransaction`) upserts `academy_students` (`source = 'purchase'`); password-reset token validation endpoint; email-verification landing endpoint.
6. **Enrollment lifecycle**: `expires_at`, `revoked_at`, `revoke_reason`, `access_source`, `course_order_id`; `assertActiveEnrollment` checks expiry and revocation; manual enroll / revoke / extend endpoints for owners and managers; refund sets revocation fields.
7. **Student roster**: `GET academies/:id/students` (pagination, search, status and course filters, sort), `GET academies/:id/students/:userId` (enrollments with progress, quiz and assignment outcomes, devices count), `POST …/block`, `POST …/unblock`; `assertCanViewAcademyStudents` (owner/administrator/manager whole academy; instructors only students enrolled in their courses).
8. **RBAC realignment**: `assertCanReviewCourse` (course instructor OR academy owner/administrator/manager) on every review/grade endpoint (paths renamed `review/*`, `instructor/*` kept as aliases for one release); curriculum services accept course instructors for assigned courses; `AcademyScopeGuard` also accepts active `academy_members` rows; `assertCanManageSecurityPolicy` (owner only, D8) for registration policy, content protection and device policy settings; `administrator` never offered by role-assignment endpoints (D9).
9. **Analytics fix**: tenant-scoped read of attempts for the "failing quiz" signal.
10. **Seed alignment**: explicit `academy_students` row for the seeded student; organization memberships for seeded instructor and staff; a seeded manager; a seeded restricted-policy academy.

### E. Frontend work (atlas-front)
1. Central `/auth/sign-in`: refusal screen "You are a student. Please sign in through your academy's website." with the academy links from the response; `/dashboard/*` guard requires `principalKind ∈ {staff, platform_owner}`; learners with a session on the platform host see an academy chooser page; dashboard learner routes (`/dashboard/learning/*`) redirect to the learner's academy host (chooser when several) — removal completes in Phase 2 (D2).
2. Academy site: 2FA challenge handling, `/forgot-password`, `/reset-password`, `/verify-email`, sign-in redirect to `returnTo` or `/my-learning` (later `/my`), header sign-in/register affordance when the CMS CTA is unset, registration error mapping (field-level deliverability message), registration policy states (invite required, pending approval).
3. Members page: **Students** tab with roster table, filters, pagination, student drawer with actions (block/unblock, revoke, extend expiry); staff team table unchanged; registration policy and pending approvals settings (owner only).
4. Role-driven navigation: Teaching section only for principals with at least one `course_instructors` row; Review items for owners and managers; `administrator` hidden everywhere; grading and attempts pages reachable by owners and managers; instructor curriculum editor for assigned courses.
5. Remove the dead `/api/config` request; public course links use slug.

### F. Database / schema / migration work
- Migration 1: dedupe duplicate `quiz_attempts.attempt_number` rows (renumber by `created_at`), then `UNIQUE (quiz_id, student_id, attempt_number)` and partial `UNIQUE (quiz_id, student_id) WHERE status = 'in_progress'`.
- Migration 2: `enrollments` lifecycle columns with backfill (`unavailable` → `revoked_at`, `revoke_reason = 'refund'`; `access_source` from matching `course_orders`, else `free`); materialize missing `course_progress` rows.
- Migration 3: `academy_students` + `source`, `registered_via_host`, `blocked_at`, `blocked_reason`, `invited_by`, `last_activity_at`; index `(academy_id, last_activity_at)`; backfill `source`.
- Migration 4: `academies.registration_policy` (default `open`), `academy_invites` table (token hash, expiry, created_by, used_by).
- Migration 5: `refresh_tokens.surface`, `academy_id` with backfill by principal kind.
- Migration 6 (RLS): `can_review_course(course_id, user_id)` definer; review SELECT policies on `quiz_attempts`, `assignment_submissions`, `lesson_progress`, `course_progress`; grading UPDATE policy on `assignment_submissions` replacing the instructor-only one; `course_sections_author_select` and `course_lessons_author_select` via `can_author_course_content`; `quiz_attempts_tenant_select`; instructor course-scoped SELECT on `academy_students`; `enrollments_self_update` WITH CHECK that lifecycle columns are unchanged.
- Seed updates (no migration).

### G. Authentication and authorization
AD-4, AD-5, AD-6 in full; D8 and D9 applied; every widened capability has a negative test.

### H. Tenant isolation / RLS
All new policies are additive (OR); roster reads run under tenant + user context; instructor roster visibility is course-scoped; cross-academy tests extended to roster, review and grading; the misleading fail-closed RLS test is replaced by one that creates published + public fixtures.

### I. Security work
Closes S4 (constraints), S5, S6, S8 (lifecycle), S9, S10; surface enforcement server-side; rate limits on sign-in per surface and registration per academy; audit entries for revocations, blocks, policy changes, role assignments.

### J. Learner UX work
Refusal and chooser screens; academy-site auth pages; registration states; EN/AR copy for all of them.

### K. Staff/admin UX work
Students tab and drawer; registration policy settings; role-driven navigation; review/grading reachability; instructor curriculum editing.

### L. API changes
`POST /auth/sign-in` (+surface, academyId), `POST /auth/register` (academy host only for learners), `GET /users/me` (+principalKind, academies), `GET/POST academies/:id/students*`, `POST /academies/:id/enrollments`, `POST /enrollments/:id/revoke`, `PATCH /enrollments/:id/expiry`, `review/*` (aliases `instructor/*`), academy curriculum writes accept instructors, `PATCH /academies/:id/security-policies` (owner), invite endpoints, reset-token validation, verify-email.

### M. Testing strategy
Backend unit + e2e + RLS; frontend component tests; Playwright journeys J2 (surface enforcement) and J3 (roster and roles).

### N. Unit tests
`PrincipalResolver`; policy helpers; invite token hashing/expiry; roster query builder; deviation guard for `administrator`.

### O. Integration tests (Jest e2e against PostgreSQL)
Learner refused on management surface; academy sign-in join per policy; atomic registration rollback (fault injection between steps); roster visibility by role and isolation across academies; review/grade matrix (owner, manager, instructor own/other, staff, org member, student); owner creates a quiz attached to a section of a draft course; analytics failing-quiz signal; Promise.all(10) attempt starts → one attempt; open attempt returned; foreign option ids rejected; progress read on an enrollment without rows; org member refused on curriculum read; enrollment revoke/expire refuses `assertActiveEnrollment`; RLS negative cases for every new policy.

### P. E2E tests (Playwright)
J2: learner on central sign-in refused with academy links; learner token on management routes 403; direct dashboard URLs redirect to the chooser.
J3: academy signup → Client Owner login → Members → Students tab shows the learner → drawer shows enrollment; manager grades an assignment and views attempts; instructor edits assigned curriculum and is refused on another course.

### Q. Chrome browser validation
With a learner created through the academy site: academy registration (including a refused undeliverable address showing a field-level message), academy login with redirect, forgot/reset password, 2FA on the academy host; central login refusal; `/dashboard/platform` and `/dashboard/organization/create` redirect for learners; Client Owner login → Students tab lists the learner; manager views attempts and grades; instructor scoping; cross-academy enrollment refused (403); revoked enrollment blocks the course.

### R. Adversarial / security validation
Learner token against every management controller (expect 403); registration with a foreign `academyId` under `invite` policy (expect refusal); attempt-start race; enrollment self-update attempt to flip `status` via any endpoint (expect no path); instructor of course A reading attempts of course B (expect 404 and zero RLS rows); org member curriculum read (403).

### S. Migration requirements
Production check for duplicate attempt numbers before Migration 1; all migrations additive; session surface backfill idempotent; existing academies `open`; no forced sign-out.

### T. Rollout requirements
Deploy with the standard workflow; flag `surface.enforce` staged by allowlist (internal academy first, then global within one week); `instructor/*` aliases kept one release; production read-only verification: a production learner cannot enter the dashboard, the roster lists production students, course details by slug renders, no `/api/config` 404, no duplicate attempt numbers remain.

### U. Observability / metrics / logging
`auth_signin_refused_total{reason}`, `surface_guard_denied_total{controller}` (alert: one principal > 50 in 10 min), roster reads per staff user, registration outcomes per academy and policy, revocation/block audit entries with request id, academy id, principal id and reason.

### V. Acceptance criteria
- [x] **No learner principal can obtain a management session or call a management controller** — `p64-identity-surfaces` e2e, Playwright J2 (a learner token refused on twelve management controllers, each asserted to carry `errors.auth.managementSurfaceOnly`), and manual Chrome. Also asserted for every `surface.enforce` mode.
- [x] **A learner registered on an academy site appears in that academy's Students tab in the same request; registration is atomic** — `p64-roster-lifecycle` e2e, Playwright J3 (registration through the real form, then found on the tab), and "registration is atomic: an unknown academy leaves no user behind". *Recorded honestly:* atomicity is proven by rolling back on an invalid academy inside the real transaction, not by injecting a fault into a healthy one.
- [x] **Registration policies `open`, `invite`, `approval` behave per D3; existing academies are `open`** — `p64-identity-surfaces` covers all three, including single-use invite redemption; the migration defaults existing academies to `open`.
- [x] **RBAC matrix true at guard, RLS and navigation layers** — `p64-rbac-review` and `p64-rls-review-and-published` e2e, Playwright J3 (manager reviews and grades, instructor edits their own curriculum and is refused another course), and the adversarial pass.
- [x] **Draft-course quiz attachment works for owners; analytics failing-quiz signal fires in test** — `p64-critical-fixes` e2e.
- [x] **Ten concurrent attempt starts create exactly one attempt; progress never 500s; course page resolves by slug** — `p64-critical-fixes` e2e; slug resolution also verified anonymously in the browser, by slug and by id, with the draft course 404 on both.
- [x] **Enrollment revocation/expiry refuses access immediately** — `p64-roster-lifecycle` and `p64-browser-findings` e2e, plus the manual Chrome lifecycle pass.
- [x] **All listed unit, e2e, RLS and Playwright tests green; browser validation recorded** — 938 backend unit, 513 frontend unit, 56 Phase 1 e2e, 8 RLS, 18 Playwright (J2 + J3), full backend e2e with every failure individually accounted for, and two recorded Chrome passes. *Recorded honestly:* "green in CI" cannot be claimed — nothing is committed, so no CI run exists. Everything above ran locally, repeatedly, on the real stack.

### W. Definition of DONE
All acceptance boxes checked; migrations applied in production; production read-only verification recorded; Phase Completion Record filled (commits, deploy SHA, test run summary, browser evidence, deviations); Document Status updated; explicit STOP before Phase 2.

**Status against this definition (19 Sep 2026, after the readiness checkpoint):** all eight acceptance boxes are checked with evidence, including the Playwright journeys and the `surface.enforce` flag that the first checkpoint found missing. Tests run, browser evidence recorded, adversarial review done, Completion Record filled, Document Status updated, and the work stopped before Phase 2.

**Two items remain outstanding, deliberately:** migrations are applied to the local database only, and the production read-only verification has not been performed. Both need an explicit deployment authorisation that has not been given. Nothing is committed or pushed. Phase 1 is therefore complete as implementation and **not yet DONE by this definition** — and it cannot be, because this definition includes production.

---

# Phase 2 — Learner Dashboard, Course Player, Protected Content, Video and Devices

**Status:** Not Started
**Estimate:** ~7 weeks
**Consolidates:** P64d (learner dashboard), P64e (protected content tier and grants), P64f (Cloudflare Stream video), P64g (device/session policy), the player-shell and sequence half of P64j, plus the video storage quota (D5) and the dashboard learner-route removal (D2).

### A. Objective
Give learners one complete, academy-branded learning surface (dashboard + unified player) and make every byte of paid content entitlement-checked, short-lived, provider-signed and device-policed, with progress evidence recorded server-side.

### B. Why this phase exists
S1–S3 (anonymous media, RLS gap, whole-course URL delivery) are the critical security findings; F1's dashboard and F3's player are the learner-facing product gaps; D1, D2, D4 and D5 all land here. Content grants, video and device policy share the same policy decision point, so they ship together as one vertical slice.

### C. Dependencies
Phase 1 complete (principal model, lifecycle columns, review RBAC). Cloudflare Stream account enabled with signing key and webhook (onboarding checklist in Rollout); D5 quota mapping confirmed (Decision Log DL-3).

### D. Backend work
1. **Protected content tier**: protected R2 bucket and upload endpoint; `lesson_contents`, `lesson_resources`; `media_assets` gains `access`, `provider`, `provider_id`, `processing_status`, `duration_seconds`, `course_id`; `course_lessons` gains `is_preview`, `available_at`, `duration_seconds`, `completion_rule`, `video_asset_id`.
2. **Policy decision point** `LessonContentService.getContent()` implementing all seven entitlement conditions (identity/session, academy context, active enrollment, published course, deliverable lesson or preview, device/lease, no suspension), rate-limited, logged to `content_access_log`, returning `{ kind: text|video|file|external, …, watermark, playbackLease, expiresAt }`; `ContentGrantSigner` (R2 presign 10 min; Stream token 2 h bound to session and device, never `downloadable`).
3. **Sections projection** without `contentUrl` (behind `content.protected`), adding `isPreview`, `durationSeconds`, `lockState`, `lockReason`; **sequence endpoint** `GET /learning/courses/:id/sequence` returning ordered items across lessons, quizzes, assignments and live sessions with per-item state and lock reasons (unified curriculum ordinals; assignment/quiz ordering bug fixed).
4. **Video provider**: `VideoProvider` interface with `capabilities()`; `CloudflareStreamProvider` — direct creator upload with `maxDurationSeconds` reservation and `requireSignedURLs`, allowed-origins sync from the domain module (platform wildcard + apex + every live custom hostname; updated on domain go-live/release), local token signing, webhook HMAC verification (`time + "." + body`, constant-time compare, 5-min replay window, idempotent by uid), status-poll fallback, static academy watermark profile (optional); `FakeVideoProvider` for local/tests; DRM capability reported `false` (D1).
5. **Video storage quota (D5)**: `videoStorageMinutes` added to `PlanResourceLimits`, plan catalog (Starter 500 / Growth 2,000 / Enterprise 5,000 per DL-3), `granted_limits` semantics, tenant usage (`videoStorageMinutes = ready video minutes + active reservations`); enforcement before issuing an upload URL (`usage + requested > quota` → `409 errors.entitlement.videoStorageMinutesExceeded` with used/quota/requested) and reconciliation when the provider reports real duration; usage exposed in the tenant usage endpoint; no Cloudflare price anywhere in Atlas.
6. **Playback and progress evidence**: `POST …/playback` heartbeats (position, watched seconds, max ratio) bounded to plausible deltas; `lesson_progress` evidence columns; resume position; lesson completion via watched-ratio rule or manual mark above the minimum; undo completion; `course_progress.time_spent_seconds`.
7. **Device and session policy (AD-10, D4)**: `atlas_device` cookie issued at sign-in; `student_devices` registry; `access_policies` (platform default 2 devices / 1 session; academy override by Client Owner within platform maximums; plan scope reserved); Redis lease `learning_lease:{userId}` (60 s TTL, heartbeat every 20 s); grant/refresh enforce the lease; `POST /learning/session/takeover` (inform → confirm → revoke previous lease and block its token refresh → activate → audit `DEVICE_SESSION_TAKEOVER` with learner, old device/session, new device/session, academy, course/lesson, timestamp); device list/removal; staff reset (owner).
8. **Learner dashboard aggregates**: `GET /learning/overview`, `/learning/assignments`, `/learning/quizzes`, global counts for My Courses; sessions list for the Devices section.
9. **Deterrents and watermark data** in grants; academy content-protection settings (owner only, D8).

### E. Frontend work
1. **Learner dashboard** `features/learner` under `/my/*`: shell (branded header, desktop side navigation, mobile bottom nav Overview/Courses/Assessments/Profile, breadcrumbs), Overview (continue learning, progress rings, due dates, recent results, certificates placeholder until Phase 3, announcements), My Courses (All/In progress/Completed with server counts, search), Course progress (outline with states and lock reasons), Assessments (Quizzes/Assignments lists), Certificates (empty state until Phase 3), Purchases (orders), Devices (registered devices, active sessions, remove/sign out elsewhere), Profile (no Organizations tab), Security; redirects from `/my-learning`, `/my-account` and `/dashboard/learning/*`; **dashboard learner routes removed** (D2) after redirects; notification templates updated.
2. **Unified player shell**: lessons, quizzes, assignments and live sessions render inside one shell (course title, back link, overall progress, curriculum drawer/sidebar, activity header with type/number/title/duration, content area, one action bar); one ordered sequence drives sidebar, Previous/Next and Continue; numbering "2.3" with locale digits; per-item states (locked with reason, available, in progress, completed, passed, failed, submitted, graded, overdue) with icons + text and `aria-current`; the six learner questions answered on every screen.
3. **Player content**: grant consumer with silent refresh; video adapter (hls.js on Chromium/Firefox, native HLS on Safari/iOS; DASH optional) with poster, loading skeleton, explicit error states (processing, expired grant, access ended, network), resume, playback rate, captions, keyboard shortcuts, `controlsList`/no-PiP/context-menu deterrents, per-viewer visible watermark overlay; text lessons with rich body, reading progress, resources panel; preview rail for non-enrolled visitors; lock cards; completion behaviours (inline confirmation, "Next: …", optional auto-advance, undo); external embeds labelled "not protected".
4. **Devices UX**: limit-reached dialog with device list; "already learning on another device" takeover dialog with explicit confirmation; lease-lost pause state (no progress loss).
5. **Staff UX**: video upload with progress and processing state, captions upload, thumbnail choice; quota meter and clear quota-exceeded message with upgrade path; lesson body editor with protected image upload; resources list; `is_preview` toggle; drip date; content-protection panel (owner only) and device policy settings (owner only); "protected/unprotected" badges.
6. Accessibility fixes carried from the audit: `role="progressbar"` everywhere, no nested interactive controls, live regions, captions track, reduced motion; RTL mirroring of drawer and chevrons; mobile bottom nav hidden inside the player.

### F. Database / schema / migration work
- `lesson_contents`, `lesson_resources`, `content_access_log` (retention 90 days), `student_devices`, `access_policies` (seed platform row 2/1), `media_assets` additions, `course_lessons` additions, `lesson_progress` evidence columns, `course_progress.time_spent_seconds`/`last_activity_at`, `refresh_tokens.device_id`, `academies.content_protection jsonb`, plan catalog `videoStorageMinutes` (limits JSON) with seed values and `granted_limits` compatibility.
- RLS: `lesson_contents`/`lesson_resources` select for active enrollment (via `can_access_lesson` definer resolving enrollment, unlock and preview), course instructor, academy manager/owner, platform owner — **no public policy**; `content_access_log` self/manager/platform; `student_devices` self + owner reset; `access_policies` owner/platform.
- Backfill: copy public lesson objects to the protected bucket per academy under the flag (public copies deleted after 30 days); text descriptions copied into `lesson_contents.body_html`; external `contentUrl` rows become `kind: 'external'`.

### G. Authentication and authorization
Grant endpoint enforces the seven conditions; device cookie is a server-issued credential (no fingerprinting); takeover requires the learner's own confirmed request; device policy editable by Client Owner only (D8); content protection settings owner only (D8).

### H. Tenant isolation / RLS
Protected object keys prefixed by academy id and course id from verified context; Stream videos carry `meta.academyId`/`courseId` and the signer refuses cross-academy tokens; allowed origins limited to the academy's hosts; RLS spec creates published + public fixtures for `lesson_contents` and asserts zero rows without context, in a foreign tenant context and for a non-enrolled user.

### I. Security work
Closes S1, S2 (table), S3, S7 (evidence), S8 (devices); tokens never `downloadable`; TTLs 10 min / 2 h; `Cache-Control: private, no-store` on grant responses; CSP on academy hosts allows the Stream customer subdomain only; `Referrer-Policy: no-referrer`; webhook HMAC; rate limits on grants and token refresh; audit for takeovers, device resets, policy changes.

### J. Learner UX work
Everything in E.1–E.4 in EN and AR, desktop and 400 px width, keyboard-only operable.

### K. Staff/admin UX work
E.5; quota messaging; policy panels gated by role.

### L. API changes
`GET /learning/courses/:id/lessons/:lessonId/content`, `POST …/playback`, `POST …/playback/refresh`, `GET /learning/courses/:id/sequence`, `DELETE …/progress/complete-lesson/:lessonId` (undo), `GET /learning/overview`, `/learning/assignments`, `/learning/quizzes`, `GET /auth/devices`, `DELETE /auth/devices/:id`, `POST /learning/session/takeover`, `POST /academies/:id/media/protected`, `POST /academies/:id/media/video-uploads`, `POST /webhooks/video/stream`, `PATCH /academies/:id/content-protection` (owner), `PATCH /academies/:id/device-policy` (owner), tenant usage gains `videoStorageMinutes`; sections projection changes behind flag.

### M. Testing strategy
Unit (signer, policy resolution, lease, quota arithmetic, completion rule for lessons), e2e (grant matrix, quota, devices, playback), RLS (published+public), k6 load, frontend component tests, Playwright J1 (dashboard, player, video, progress, devices), axe.

### N. Unit tests
Token claims and TTL clamps; session/device binding; allowed-origin list builder (wildcard caveats); webhook signature verification; quota check (`1,850+180 → reject`, `1,850+100 → allow`, reservation release on failed upload); lease semantics with fake Redis; policy resolution most-specific-first with platform maximums; watched-ratio completion; sequence ordering and lock-reason derivation.

### O. Integration tests
Grants for enrolled / locked / preview / revoked / expired / refunded / anonymous / suspended / unpublished course; sections contain no URLs; instructor and owner preview access; cross-academy token refused; third device refused; concurrent grant conflict and takeover with audit event; lease revoked on enrollment revocation; heartbeat bounds; undo completion; quota enforcement across `granted_limits` and plan limits; usage reconciliation from webhook; anonymous fetch of a protected key fails; overview/assessments aggregates scoped to the host academy.

### P. E2E tests (Playwright)
J1 (partial): academy login → learner dashboard every section (EN/AR, desktop/mobile) → course → player shell → lesson with grant → protected video plays → reload resumes position → mark complete/undo → next activity → devices page; J5 (revocation): refund → grants refused → lease revoked. Two-browser test: second device triggers conflict; takeover pauses the first.

### Q. Chrome browser validation
Learner dashboard on desktop and at 400 px in EN and AR; network panel shows no durable content URLs; video plays on the platform host and on a custom domain; manifest request from a foreign origin fails; expired grant refreshes silently; revoked enrollment shows "access ended"; third device refused; takeover flow with confirmation; staff: upload a video, watch processing → ready, quota meter, quota-exceeded message; preview lesson opens anonymously; dashboard learner routes redirect.

### R. Adversarial / security validation
Replay a presigned URL after revocation (expected to work until TTL; new grant refused); token for another academy's video (refused); grant flood from one learner (rate-limited, alert); forged webhook (rejected); attempt to fetch `lesson_contents` under foreign tenant context (zero rows); device cookie tampering (unknown device → re-registration under the cap).

### S. Migration requirements
Provider onboarding before `video.stream` is enabled anywhere: Stream enabled, signing key stored, webhook verified on staging, allowed origins synced, quota seeded; DRM availability asked of Cloudflare in writing (non-blocking, recorded in DL-1). Per-academy flags `content.protected`, `video.stream`, `devices.policy`, `learner.dashboard_v2`, `player.v2`; protected-bucket backfill per academy; redirects for two releases before the dashboard learner routes are deleted.

### T. Rollout requirements
Canary on an internal academy, then the first customer academy that asked for protection, one week each; metrics in U watched; rollback = flag off (old projections and pages remain until flags are global); the previous image runs against the new schema.

### U. Observability / metrics / logging
`content_grants_total{kind,result}`; per-student grant rate (p99 > 40/10 min → owner report); `video_token_mint_duration_ms` and provider errors (> 2 % alert); `video_processing_pending_age_s` (> 30 min alert); webhook signature failures (any → alert); `lease_conflicts_total`, `device_limit_hits_total`, takeovers per student per day (> 5 → sharing report); `video_storage_minutes_used{organization}` vs quota; readiness reports protected bucket, Stream config and Redis lease store; structured logs for every grant, refusal, takeover and policy change.

### V. Acceptance criteria
- [ ] No learner-facing response contains a durable URL to protected media; file URLs expire ≤ 10 min, video tokens ≤ 2 h and are bound to session and device.
- [ ] Locked lessons carry no content until unlocked; preview lessons open without enrollment.
- [ ] Every uploaded video requires a signed token; playback only from allowed origins; no video byte passes through the VPS.
- [ ] `videoStorageMinutes` enforced per D5 with clear messaging; no Cloudflare price in the codebase.
- [ ] Device defaults (2/1) enforced and changeable via `access_policies`; takeover requires confirmation and writes `DEVICE_SESSION_TAKEOVER`.
- [ ] Learner dashboard sections exist with real data; dashboard learner routes removed (redirects in place); axe clean; EN/AR parity.
- [ ] Unified player: quizzes and assignments render in the shell and participate in Next/Previous; lock reasons shown; watched-ratio completion works; resume works after reload.
- [ ] RLS: zero `lesson_contents` rows without context, in a foreign tenant and for a non-enrolled user, with published+public fixtures.
- [ ] All tests green; Playwright J1 (partial) and J5 green; browser validation recorded.

### W. Definition of DONE
All boxes checked; flags enabled on the canary academies with metrics reviewed for one week each; Phase Completion Record filled; Document Status updated; STOP before Phase 3.

---

# Phase 3 — Assessments, Integrity, Completion Rules and Certificates

**Status:** Not Started
**Estimate:** ~5 weeks
**Consolidates:** P64h (quiz engine v2 incl. manual grading and assignment due dates), P64i (integrity layer), the completion-rules and assignment-status half of P64j, P64k (certification lifecycle), D6 and D7.

### A. Objective
Make assessments trustworthy and the course outcome real: server-authoritative timed quizzes with autosave, resume, auto-submit and policy-based disclosure; an honest integrity layer; assignments with drafts, due dates and grading feedback; course completion rules that include required quizzes and assignments; and an academy-branded, verifiable, immutable certificate.

### B. Why this phase exists
S4 (engine), S7 (completion), S12 (assignments), F2 (certification) and the assessment half of F3 form one dependency chain: results feed completion, completion feeds certificates. Shipping them together avoids a half-built completion model.

### C. Dependencies
Phase 1 (attempt constraints, review RBAC) and Phase 2 (player shell, sequence endpoint, learner dashboard sections, lesson evidence). D6 template assets from the owner (logo/signature per academy are academy-provided at runtime).

### D. Backend work
1. **Quiz settings model** (defaults reproduce today): `mode`, `time_limit_seconds`, `available_from/until`, `due_at`, `late_policy`, `grading_policy`, `shuffle_questions/options`, `questions_per_attempt`, `layout`, `show_score`, `show_answers`, `show_explanations`, `integrity_mode`, `max_violations`, `require_fullscreen`, `required_to_progress`, `required_for_completion`, `hide_timer`; per-question `points`, `explanation`, `related_lesson_id`, new types `short_answer` (accepted answers) and `essay` (manual); `quiz_student_overrides` (time multiplier, extra attempts, window override).
2. **Attempt lifecycle**: start (window check, lock, one open attempt, seed, settings snapshot, `deadline_at = min(started + limit×multiplier, available_until)`, delayed BullMQ job at `deadline + 30 s`), resume (saved answers, order, `serverNow`, `deadlineAt`), autosave (`PUT …/answers` with monotonic `client_revision`, `sendBeacon`-compatible), submit (idempotent, partial allowed, answer/option validation), auto-submit by job and by sweep (latest server-confirmed answers, grade by rules, unanswered = incorrect, `auto_submitted_reason = 'timeout'`, **never auto-fail**), grading policies, results projection by disclosure policy, `quiz_results` materialization, manual grading queue (`grading_status`, `graded_by`, `graded_at`; attempt finalizes when all manual points are entered), void/extra time/extra attempts by reviewers.
3. **Integrity**: `POST …/attempts/:id/events` (batched ≤ 50; types visibility_hidden/visible, blur/focus, fullscreen_exit/enter, copy/paste/cut/contextmenu/print, heartbeat, second_session, device_change) with client and server timestamps; debounce (2 s), warm-up (5 s), sub-second visibility ignored; escalation per mode (off / monitor / warn / strict with auto-submit `reason = 'integrity'`); timing analysis job; integrity report and CSV export for reviewers.
4. **Assignments**: draft autosave (`PUT …/draft`), `dueAt` enforcement with `late_policy` (block / accept-and-flag `is_late`), submission view exposing response, attachments, status timeline, grade and feedback; attachment must be a protected asset uploaded by the student; grading by reviewers (Phase 1 RBAC) with notifications.
5. **Completion rules (AD-11)**: `courses.completion_rule` (`lessons`, `quizzes`, `assignments`, `minOverallScore`), item-level `required_for_completion`; pure evaluator run after every progress, quiz result or grading write; materializes `completion_state`, `completed_at`; recomputes when a reviewer voids a result.
6. **Certificates (D6, D7)**: `certificate_templates` (platform-standard layout; academy logo, identity, signature; "Issued via Atlas" footer; EN/AR variants), `certificates` (enrollment unique, per-academy serial e.g. `WDA-2026-000123`, 12-char base32 `verification_code`, immutable `snapshot` of learner name, course, academy, instructors, completion date, **score summary at issuance**, template version, `issued_by` null = automatic, `version`, `revoked_at/reason`); eligibility evaluator (`certificate_status`: unavailable | eligible | issued | revoked; requires certificates enabled on the course, completion reached, `certificate_min_score` met); BullMQ render job (server-side PDF, Arabic-capable embedded fonts, no headless browser) storing into the protected bucket, idempotent by enrollment; download via 1-hour signed link; public `GET /verify/:code` (issued-to, course, academy, date, status only; rate-limited; uniform timing); revocation (voided result, refund, misconduct) with audit; **regeneration is an explicit reviewer/owner action** (name or template change → new version, same serial and code); a later quiz retake never modifies an issued certificate (D7); manual issuance for edge cases; anonymization on account deletion; staff endpoints (list, issue, revoke, regenerate) per RBAC.

### E. Frontend work
1. **Quiz builder**: presets (practice / exam) and every setting with plain explanations of what is enforced vs recorded; per-question points/explanations/related lesson; new question types; preview as student; overrides UI.
2. **Attempt page** inside the player shell: instructions with time limit, attempts left, window, integrity disclosure and acknowledgement; sticky header with countdown (hideable), question progress, save indicator ("Saved 3 s ago / Saving… / Offline, will retry"); navigator with answered/unanswered/flagged states and `aria-current`; one-question-per-page mode (default < 640 px); submit confirm listing unanswered; auto-submit notice; results per policy (score, pass/fail, per-question review, explanations when allowed); attempt history; "Continue to next activity"; retake only when allowed and useful; timer `aria-live` announcements at 10/5/1 min; 401 during an attempt re-authenticates without losing answers; offline autosave queue.
3. **Integrity UX**: listeners per mode; fullscreen request in exam mode; copy/print handling; banner on first violation, acknowledged modal thereafter with remaining count and consequence; watermark on the attempt page; copy in EN/AR.
4. **Assignments**: due date and late policy shown; draft autosave; submission view with submitted text/attachments; status timeline (submitted → grading → graded) with grade and feedback; resubmission when allowed; assessments section in the learner dashboard shows windows, due dates, grades.
5. **Completion**: course completion screen (lessons, quizzes, assignments summary; what is missing; certificate issuance state; rate the course placeholder for Phase 4); lock cards for "pass Quiz 1.2" rules.
6. **Certificates**: learner Certificates section (preview, expiring download link, verification code, share link, print view); `/verify/:code` page on academy and platform hosts; staff certificate management (list, issue, revoke, regenerate with confirmation), template settings (logo, signature, wording), per-course enable and minimum score.
7. **Staff review**: attempts list with status, score, duration, violations, late flag; attempt detail with answers and event timeline; manual-grading queue; void/extra time/extra attempt actions; integrity CSV export.

### F. Database / schema / migration work
- `quizzes` settings columns; `quiz_questions` additions; `quiz_attempts` columns (`started_at`, `deadline_at`, `seed`, `settings_snapshot`, `question_ids`, `answers_revision`, `last_saved_at`, `auto_submitted`, `auto_submitted_reason`, `is_late`, `violation_count`, `integrity_flagged`, `points_earned/total`, `grading_status`, `graded_by/at`, `invalidated_at/by`; status enum + `submitted`-pending semantics, `expired`, `invalidated`); `quiz_attempt_events`; `quiz_results`; `quiz_student_overrides`; `assignments` + `late_policy`, `required_for_completion`; `assignment_submissions` + `is_late`, `draft_response`, `draft_saved_at`, `submitted_revision`; `courses` + `completion_rule`, `certificate_template_id`, `certificate_min_score`; `course_progress.completed_at`, `certificate_status` enum + `issued`, `revoked`; `certificate_templates`; `certificates`.
- RLS: events/results/overrides self + review tier (from Phase 1 function); certificates self, academy manager/owner, platform; verification through a `SECURITY DEFINER` function returning public fields only; templates academy-scoped.
- Backfill: existing open attempts get `started_at = created_at`, no deadline (sweep ignores attempts without deadlines); completion rules default to "all lessons"; no automatic certificate issuance for historical completions.

### G. Authentication and authorization
Attempt endpoints: owner of the attempt with active enrollment (all seven conditions from Phase 2 re-checked on start/save/submit/results); review endpoints via `assertCanReviewCourse`; certificate issue/revoke/regenerate via owner/manager, view via instructor for assigned courses; template settings owner/manager; verification public and rate-limited.

### H. Tenant isolation / RLS
Certificates of academy A never verify as B's (verification returns the issuing academy); serials per academy; events and results isolated by review tier; cross-academy tests extended to attempts, events, certificates and verification.

### I. Security work
AD-8 and AD-9 in full; answers validated against attempt question/option sets; event batches capped; results never include correct answers before policy allows; certificate links signed; verification enumeration-resistant; audit for void, override, issue, revoke, regenerate; attachments restricted to the student's own protected assets.

### J. Learner UX work
E.2–E.6 in EN/AR, mobile, keyboard-only; expiry message "Time ran out. Your answers were submitted automatically."

### K. Staff/admin UX work
E.1, E.6 (staff), E.7.

### L. API changes
Quiz attempt lifecycle (`POST …/attempts` returns open attempt or new; `GET …/attempts/:id`; `PUT …/attempts/:id/answers`; `POST …/attempts/:id/submit`; `POST …/attempts/:id/events`; `GET …/attempts/:id/results`), `review/*` attempts list/detail/invalidate/grade, `POST /courses/:id/quizzes/:quizId/overrides`, assignment draft/submit/submission with grading, `GET/PUT /academies/:id/courses/:courseId/completion-rule`, certificate endpoints (`GET /learning/certificates`, `GET /learning/certificates/:id/download`, `GET /verify/:code`, `GET/POST /academies/:id/certificates*`, `POST …/certificates/:id/revoke|regenerate`, `POST /academies/:id/enrollments/:id/certificate`), template endpoints.

### M. Testing strategy
Fake-clock unit tests for the engine; e2e for the full lifecycle including timeout auto-submit graded as-is; integrity escalation; manual grading; completion rules; certificate lifecycle; RLS; Playwright J1 (assessment and certificate steps) and J4 (tenancy for certificates).

### N. Unit tests
Deadline/grace with multipliers and windows; grading policies; disclosure matrix; seed-based ordering determinism; exact-set scoring and points; short-answer matching; debounce/warm-up/escalation; completion rule evaluator (lessons only, with required quiz, with graded assignment, min score); eligibility evaluator; serial and code generators; snapshot immutability (retake does not change stored score); regeneration versioning.

### O. Integration tests
Ten concurrent starts → one attempt (regression); resume returns saved answers and server-derived remaining time; autosave revision ordering and rejection after deadline + grace; timeout auto-submit with partial answers → graded, unanswered incorrect, `reason = timeout`, not auto-failed; manual question → pending → graded by manager → pass computed; strict-mode auto-submit at threshold; void refunds an attempt; overrides extend one student only; disclosure per policy never leaks correct answers early; assignment late block/flag; attachment ownership check; completion transitions (quiz pass triggers completion; voiding recomputes); certificate issuance on eligibility, immutable snapshot after a higher retake (D7), explicit regeneration bumps version, revocation reflected on verification, uniform verification for unknown codes; RLS for events/results/certificates review tier and cross-academy negatives.

### P. E2E tests (Playwright)
J1 (assessment + certificate steps): timed quiz with autosave → reload resumes → timer expiry auto-submits → results → assignment draft → submit → manager grades → feedback visible → required rules met → completion screen → certificate appears → download works → `/verify/:code` valid → revoke → verification shows revoked → retake quiz with higher score → certificate score unchanged. J4: certificates of academy A verify as A on both hosts and never as B.

### Q. Chrome browser validation
Timed quiz: countdown, tab switch produces a warning (warn mode), reload restores answers and time, expiry auto-submits with the notice and results; essay question graded by the manager and result finalizes; assignment due date shown, late submission handled per policy, feedback shown; completion screen; certificate PDF opens with academy logo, signature and "Issued via Atlas"; verification page; revoke then verify; owner sees attempts with the event timeline and exports CSV.

### R. Adversarial / security validation
Submit after deadline + grace (rejected); save with stale revision (ignored); foreign option ids (rejected); results request before disclosure policy allows (no answers); event spoofing cannot raise a score; certificate code enumeration (uniform timing, rate-limited); regenerate by an instructor (403); retake does not touch the certificate row.

### S. Migration requirements
Additive columns with today's defaults; open attempts untouched; no historical auto-issuance; flags `quiz.engine_v2`, `quiz.integrity` (default mode off), `certificates`.

### T. Rollout requirements
Engine v2 on canary academy first; integrity mode remains off until an instructor turns it on; certificates enabled per course by owners; owner communication explaining disclosure policies and integrity honesty; rollback = flags off.

### U. Observability / metrics / logging
`quiz_attempts_started/submitted/auto_submitted{reason}` (auto-submit share > 30 % per quiz → report); `quiz_autosave_lag_s` (p95 > 10 s alert); `quiz_deadline_jobs_overdue` (> 2 min alert); `integrity_events_total{type}` and flagged attempts (report); manual-grading queue age; `certificates_issued_total`, verification lookups and failed lookups (spike → throttle); structured logs for void, override, grade, issue, revoke, regenerate.

### V. Acceptance criteria
- [ ] Reload during an attempt restores answers and remaining time from the server clock; saves/submits after deadline + grace are rejected.
- [ ] Timer expiry auto-submits the latest server-confirmed answers, grades by rules, marks unanswered incorrect, records `timeout`, and never auto-fails.
- [ ] Ten concurrent starts create one attempt; one open attempt per student per quiz.
- [ ] Score and answer disclosure follow policy; correct answers never appear early.
- [ ] Integrity events recorded with server timestamps; escalation acts only at configured thresholds; reviewers can void and refund; no prevention claims in copy.
- [ ] Owners and managers grade manual questions and assignments; instructors only for assigned courses.
- [ ] Assignments enforce due dates per policy; learners see status, grade and feedback.
- [ ] Course completion follows the configured rule including required quizzes/assignments; completion screen shown.
- [ ] Certificates: eligibility → issuance → academy-branded PDF with "Issued via Atlas" → verification → revocation; issuance facts immutable (retake test); regeneration explicit and versioned.
- [ ] All tests green; Playwright J1 (assessment/certificate) and J4 green; browser validation recorded.

### W. Definition of DONE
All boxes checked; canary rollout reviewed; Phase Completion Record filled; Document Status updated; STOP before Phase 4.

---

# Phase 4 — Catalog, Preview, Checkout, Observability, Hardening and Production Rollout

**Status:** Not Started
**Estimate:** ~3 weeks
**Consolidates:** P64l (catalog, preview, checkout, reviews), P64m (observability, abuse monitoring, hardening), S11, and the full end-to-end Playwright suite and production rollout of every flag.

### A. Objective
Complete the front of the learner journey (discovery, preview, purchase), turn on production observability and abuse monitoring, finish hardening, run the complete adversarial and end-to-end suites, and roll every P64 flag out to all academies.

### B. Why this phase exists
Discovery and purchase depend on the protected preview tier (Phase 2) and the learner dashboard; monitoring needs every producer of metrics in place; the final rollout must happen once, with the full journey verified end to end.

### C. Dependencies
Phases 1–3 complete; organizations' payment mode configured where paid checkout is expected (existing `unconfigured` rule stays: paid courses remain non-purchasable with clear copy until configured).

### D. Backend work
1. **Catalog**: public course list gains search, category, price filters, sort, level/duration metadata; instructor profile data; `mode: 'selected'` fetches by ids; slug resolver already in Phase 1.
2. **Course details and preview**: intro video asset (preview-tier public token, no watermark); preview lessons via Phase 2 grants; "what you will learn", requirements, level, language fields.
3. **Checkout**: student checkout on the existing order API (order summary and terms → payment per organization mode: manual transfer with proof upload today → pending review → platform approval creates enrollment + membership in one transaction); order status notifications; purchases and refund status for learners; idempotency key on enrollment creation.
4. **Post-course**: `course_reviews` (enrollment-unique rating and body, moderated status), recommendations within the academy, completion email/share.
5. **Hardening**: Range support on the public media route (S11); retention sweeps (`content_access_log` 90 days, `quiz_attempt_events` 180 days); readiness checks; final adversarial pass fixes.
6. **Observability**: all metrics and alerts from every phase wired to the observability stack; owner reports (sharing signals, integrity summaries, quota usage); alert routing.

### E. Frontend work
1. Catalog page `/courses` on every academy site (server pagination, search, filters, sort, RTL grid, preview badges); instructor profile pages; featured block fetches selected ids.
2. Course details revamp: single state-aware CTA (Preview / Enroll for free / Buy for $X / Continue / Pending approval / Sign in to enroll), preview markers and durations, intro video, outcomes/requirements, instructor cards, related courses.
3. Checkout steps, pending states on course page and My Courses, purchases page completion, refund status; entitlement-limit copy on both surfaces.
4. Completion screen rating prompt, reviews display, recommendations, share certificate.
5. Owner reports pages (sharing signals, integrity summaries, quota usage); platform-owner dashboards for video minutes and provider health.
6. Final accessibility and RTL sweep across the learner surface.

### F. Database / schema / migration work
- `courses` catalog fields (`level`, `language`, `outcomes`, `requirements`, `intro_video_asset_id`); `course_reviews`; retention jobs (no schema); indexes for catalog search.
- RLS: reviews readable publicly when approved and the course is published+public; write by the enrolled learner; moderation by owner/manager.

### G. Authentication and authorization
Checkout only for the authenticated learner on the academy surface; order approval remains platform-owner only; reviews by enrolled learners; reports by owner/manager per RBAC matrix.

### H. Tenant isolation / RLS
Catalog and reviews are academy-scoped by host; recommendations never cross academies; reports scoped to the academy; the cross-academy suite (J4) runs in full.

### I. Security work
Proof uploads to the protected tier; catalog query bounds; review content sanitized; enumeration resistance on verification retested; final run of the adversarial checklist against production read-only; dependency and CSP review; rate limits verified under load.

### J. Learner UX work
Catalog, details, preview, checkout, purchases, rating, recommendations — EN/AR, mobile, keyboard.

### K. Staff/admin UX work
Reports; review moderation; catalog metadata in course settings.

### L. API changes
Public catalog filters; intro video; checkout/order status notifications; reviews CRUD and moderation; reports endpoints; Range on `public/media`.

### M. Testing strategy
Unit + e2e for catalog, checkout, reviews, retention, Range; full Playwright journeys J1–J5 end to end; k6 for catalog and grants; alert-rule tests.

### N. Unit tests
Catalog filter/sort builders; CTA state resolver; review sanitizer and moderation transitions; retention window computation; Range header parsing.

### O. Integration tests
Checkout → proof → approval → enrollment + membership in one transaction; idempotent enrollment; refund → revocation → certificate revocation when the rule requires; reviews only by enrolled learners; recommendations scoped; Range requests; retention deletes only expired rows; alert rules fire on synthetic data.

### P. E2E tests (Playwright)
Full **J1** (academy signup → verify email → login → dashboard → catalog → details → preview → enroll free → buy paid with proof → approval → lessons with grants → protected video → quiz with timer/reload/expiry → assignment with due date → completion → certificate → verification → devices), **J2**, **J3**, **J4**, **J5**, and a mobile-viewport run of J1 in AR.

### Q. Chrome browser validation
Complete the entire learner journey as a real learner on a production academy after rollout (read-only where production data is involved; a dedicated test academy on the platform host is used for writes): catalog, details, preview, free enroll, paid purchase with proof, approval, player, protected video, progress, quiz timer/autosave/reload/expiry, assignment, completion, certificate and verification; Client Owner: roster, course management, reports; manager permissions; instructor scoping; central login rejection; cross-academy rejection; device/session behaviour.

### R. Adversarial / security validation
Full Appendix checklist against production read-only plus a synthetic grant flood on staging that triggers the alert; review of every new guard by a second engineer; confirmation that no metric or log leaks PII beyond ids.

### S. Migration requirements
Catalog columns additive; reviews table new; flags `checkout.student`, `catalog.v2`; retention jobs enabled after the first successful dry run.

### T. Rollout requirements
Enable all remaining P64 flags globally in the order: `learner.dashboard_v2` → `player.v2` → `content.protected` → `video.stream` → `devices.policy` → `quiz.engine_v2` → `certificates` → `checkout.student` → `catalog.v2`; one production verification per flag; owner communication; `--rollback` path re-tested before the global switch.

### U. Observability / metrics / logging
Every metric from Phases 1–3 visible; `checkout_orders_total{state}`, approval latency; catalog latency; retention job outcomes; alert routing confirmed by a fired synthetic alert; readiness reports every dependency.

### V. Acceptance criteria
- [ ] Catalog is server-paginated with search and filters; course details show the correct single CTA in every state; preview converts anonymous visitors to sign-up.
- [ ] Paid path works end to end with proof and platform approval; pending states visible; refunds propagate to access and certificates.
- [ ] Reviews and recommendations scoped to the academy.
- [ ] Range requests honoured on the public media route; retention jobs verified.
- [ ] Every metric and alert from all phases emits and routes; readiness reports all dependencies.
- [ ] Full Playwright suite (J1–J5, AR mobile run) green in CI; production learner-journey verification recorded; adversarial checklist recorded with zero open criticals.
- [ ] All P64 flags enabled globally with per-flag production verification recorded.

### W. Definition of DONE
All boxes checked; Document Status set to Complete with the final deploy SHAs; Phase Completion Record filled; open items moved to the Decision Log or a new initiative.

---

## Cross-Phase Security Requirements

1. Deny by default on every request; no inference from earlier calls; every new endpoint lists its guard and service check in this file before implementation.
2. Guard decides and RLS independently agrees: every new table has `FORCE ROW LEVEL SECURITY` and policies; every widened read has a negative RLS test.
3. Short-lived, logged capabilities only for protected content; revocation refuses new capabilities immediately and revokes leases.
4. Surface enforcement: learners never reach management controllers; staff learn on the academy surface.
5. RBAC matrix is the authority; D8 keeps security-sensitive settings with the Client Owner; D9 hides `administrator`.
6. Server-authoritative assessments; client signals are advisory.
7. Audit log entries for revocations, blocks, takeovers, policy changes, role assignments, voids, overrides, certificate issue/revoke/regenerate.
8. No PII in metrics; ids only in logs.
9. Rate limits on sign-in, registration, grants, token refresh, verification, roster export.
10. Adversarial checklist executed at the end of every phase and recorded.

## Cross-Phase Testing Requirements

- Backend: Jest unit; e2e against real PostgreSQL with RLS; fake clock for time-dependent code; BullMQ in-memory mode for jobs; k6 for grants, heartbeats and catalog.
- Frontend: Vitest + Testing Library component tests for every new page/hook; RTL snapshots; axe on every learner page; Playwright journeys J1–J5 wired into CI on the local stack.
- Every phase's acceptance criteria map to named tests; a criterion without a test is not accepted.
- Test data: the seed provides owner, manager, instructor, staff, org member, learner and a restricted-policy academy.

## Browser Verification Matrix

| Check | Phase | Status |
|---|---|---|
| Academy registration (incl. field-level error mapping) | 1 | ☐ |
| Academy login with redirect, forgot/reset, verify email, 2FA on academy host | 1 | ☐ |
| Central Atlas login rejection for learners with academy links | 1 | ☐ |
| Learner direct access to `/dashboard/*` redirected; management APIs 403 | 1 | ☐ |
| Client Owner login → Members → Students roster shows the learner | 1 | ☐ |
| Client Owner course management (courses, quizzes, curriculum, review) | 1 | ☐ |
| Manager permissions (review/grade yes; security policies no) | 1 | ☐ |
| Instructor scoping (assigned vs other course; curriculum editing) | 1 | ☐ |
| Cross-academy access rejection (enroll, roster, management) | 1 | ☐ |
| Learner dashboard (all sections, EN/AR, desktop/mobile) | 2 | ☐ |
| Course player shell, sequence, lock reasons | 2 | ☐ |
| Protected video (signed playback, allowed origins, no durable URLs, deterrents, watermark) | 2 | ☐ |
| Lesson progression, progress persistence, resume, undo | 2 | ☐ |
| Device limit and session takeover with audit | 2 | ☐ |
| Video upload, processing, quota enforcement | 2 | ☐ |
| Quiz: timer, autosave, reload/resume, expiry auto-submit, results | 3 | ☐ |
| Integrity warnings and escalation; reviewer timeline | 3 | ☐ |
| Assignment: due date, draft, submit, grading, feedback | 3 | ☐ |
| Completion rules and completion screen | 3 | ☐ |
| Certificate issuance, dashboard, PDF, verification, revocation, retake immutability | 3 | ☐ |
| Course discovery / catalog, course details CTA states, preview | 4 | ☐ |
| Enrollment (free) and purchase (paid, proof, approval) | 4 | ☐ |
| Full production learner-journey run | 4 | ☐ |

## Migration Strategy

Additive only; defaults reproduce current behaviour; every projection change behind a per-academy flag; duplicate attempt numbers deduped before constraints; enrollment lifecycle and progress rows backfilled; session surface and device ids backfilled lazily; protected-bucket copy per academy with 30-day public deletion; text descriptions copied into lesson bodies; open attempts without deadlines untouched; no historical certificate auto-issuance; `instructor/*` aliases and dashboard learner redirects kept for one/two releases; the previous image must run against the new schema; the deploy script's `--rollback` path re-tested before each phase's global flag switch.

## Rollout Strategy

Phase 1 ships directly after tests and production read-only verification (surface enforcement staged by allowlist). Phases 2 and 3 ship behind flags to an internal academy, then one customer academy, one week each, then globally in Phase 4 in the listed order with a verification per flag. Provider onboarding (Stream account, signing key, webhook, allowed origins, quota seed, written DRM question) precedes any `video.stream` enablement. Communication to staff before Phase 1 (sign-in rule, Students tab, review permissions) and before Phase 2 (protected content, preview, quota). Rollback is always flag-off; migrations are never reverted.

### Deployment-path blocker (found 19 Sep 2026 at the final authorization checkpoint)

Phase 1 was authorised for production and **was not deployed**, because the delivery path cannot execute the sequence below in the order it requires. Recorded as fact, with no change made to any pipeline.

**Root cause.** A push to `main` in `atlas-backend` triggers `.github/workflows/deploy.yml` with no approval gate. That workflow SSHes to the VPS and runs `deploy/deploy.sh`, which runs `npx prisma migrate deploy` against the production database. Pushing therefore *is* migrating. Steps 1–3 of the sequence — restore point, duplicate-attempt count, open-attempt count — all have to precede the migration, and the path offers no point at which they can run. It also offers no way to express the low-traffic window that step 3's numbers are meant to inform.

**Contributing facts, each verified in the repository:**

- `deploy/deploy.sh` never invokes `deploy/backup.sh` (grep count: 0). The backup runs only on its own systemd timer, so no snapshot is tied to a deployment.
- `deploy/backup.sh` verifies a dump only by size (`> 1024` bytes). It never checks gzip integrity, schema presence or restorability, so it does not by itself satisfy "backup restore/readability confirmation".
- Rollback is code-only and correctly so: `deploy.sh --rollback` re-pins the last-good image digests. Migrations are never reverted. The Phase 1 migration rewrites learner-visible data — renumbering `quiz_attempts.attempt_number` and closing stale in-progress attempts as failed with score 0 — and that has no undo without restoring a backup nothing has taken.
- Production is unreachable from the implementation environment: `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` are GitHub Actions secrets, and the local `DATABASE_URL` points only at the local database.
- Separately, the CI lint job has been red on `main` since before Phase 7 and `deploy.yml` is deliberately un-gated from it. Phase 1 adds none of those failures: all 113 remaining lint errors are in 17 files, **none** of which Phase 1 modifies or adds.

**Conclusion.** The automatic "push to `main` = deploy = migrate" model is incompatible with the approved Phase 1 safety sequence. Phase 1 stays **not DONE** until a production backup is taken and verified, the approved migrations are applied, both services are deployed, and production verification is recorded.

**Blocker patch — implemented locally on 19 Sep 2026, not committed, not deployed.** Three delivery files changed, no application or database code touched: `deploy/deploy.sh` (argument loop, `--preflight`, `--with-migrations`, and a migration gate that takes a verified backup and records the pre-migration counts before any schema change), `deploy/backup.sh` (gzip integrity, pg_dump completion marker, and presence of the tables the migration rewrites), and `.github/workflows/deploy.yml` (a `workflow_dispatch` input plus an `approve-migrations` job naming a protected environment). Migration now requires BOTH an explicit flag and a protected-environment approval; a push that carries pending migrations aborts before touching the schema, and a push that carries none behaves exactly as before. The gate is inert until the repository defines a `production-migrations` environment with at least one required reviewer.

### Phase 1 production execution sequence (prepared 19 Sep 2026, NOT executed)

Nine steps, in this order. Nothing below has been run; each needs explicit authorisation.

1. **Restore point.** Take a database backup or snapshot and record how to restore it. Note the current deploy SHAs of both services so a rollback target exists.
2. **Pre-migration duplicate-attempt check (read-only).** Count `(quiz_id, student_id, attempt_number)` groups with more than one row. This is what the renumbering step fixes; the number tells you how many learners' attempt numbers will change.
3. **Pre-migration open-attempt check (read-only).** Count `(quiz_id, student_id)` pairs holding more than one `in_progress` attempt, and count in-progress attempts overall. Every in-progress attempt beyond the newest per pair will be closed as failed with score 0. Choose a low-traffic window on this number.
4. **Migrations.** `prisma migrate deploy`, all eight in timestamp order, never a subset — `000200`–`000700` correct policies and a trigger created by `000000`, so a partial application leaves the wide policies live. The role must be able to create `SECURITY DEFINER` functions and to `GRANT` on `academy_invites`. Index builds take a normal lock (no `CONCURRENTLY`), so `quiz_attempts` and `refresh_tokens` are briefly blocked for writes.
5. **Backend deploy.** Immediately after step 4. The gap between them matters: the new unique indexes and the stricter `is_academy_student` take effect at migration time, so the old build is briefly running against tightened rules.
6. **Frontend deploy.** With or immediately after the backend. The learner refusal screen, the academy chooser, the Students tab and the access-ended states are all frontend.
7. **Production read-only verification.** A production learner cannot enter the dashboard and is refused on the management surface; a Client Owner's Students tab lists real students; a course page resolves by slug; no `/api/config` 404; no duplicate attempt numbers and no student holding two open attempts remain; and a learner enrolled in a non-public course gets 200 on their own enrollment list (finding B1's symptom).
8. **Rollback decision criteria.** Set `SURFACE_ENFORCE_MODE=off` — no redeploy — if learners are wrongly refused, if staff sign-in breaks, or if surface denials spike beyond the expected learner population. Redeploy the previous build if anything outside the surface boundary regresses. **Migrations are not reverted**; every one is additive and the application tolerates the new columns being present. Restore from step 1 only for data corruption, which no step here performs.
9. **Post-deployment monitoring.** Watch `auth_signin_refused_total{reason}` and `surface_guard_denied_total{controller}` (alert: one principal over 50 in 10 minutes), registration outcomes per academy and policy, roster reads per staff user, and revocation/block audit entries. Also watch for `Transaction already closed` errors, which observation O3 says to size for before this deployment.

## Risks / Dependencies

| Risk | Mitigation |
|---|---|
| Stream has no DRM; a customer may require it | Provider interface with capability flags; DRM-capable provider addable later; no DRM promises in copy (D1). |
| Signed URLs valid until expiry after revocation | Short TTLs; lease revocation; documented behaviour. |
| Device policy friction | Self-service removal, owner reset, clear copy, takeover with confirmation (D4). |
| Staff who learn expect the dashboard | Academy surface only (D2); chooser page; staff preview on the academy site. |
| Integrity false positives | Debounce, warm-up, monitor default, human review, void/refund. |
| Wider RLS review tier | Function unit tests, negative RLS e2e, second-engineer review. |
| Certificate rendering load on one VPS | Queue concurrency 2; no headless browser; batch window. |
| Removing dashboard learner routes breaks links | Redirects for two releases; templates updated. |
| Plan-name mapping for `videoStorageMinutes` | DL-3; adjustable seed values; not blocking. |
| Single VPS capacity during rollout | Canary per academy; metrics gates; rollback per flag. |

## Decision Log

| ID | Date | Decision | Status |
|---|---|---|---|
| DL-1 | 2026-09-18 | Proceed without DRM (D1); ask Cloudflare in writing during onboarding; answer to be recorded here. | Approved (owner) |
| DL-2 | 2026-09-18 | Learner routes removed from the management dashboard; staff learn on the academy site (D2). | Approved (owner) |
| DL-3 | 2026-09-18 | `videoStorageMinutes` quotas 500 / 2,000 / 5,000 mapped to the repository tiers Starter / Growth / Enterprise (decision text says Starter / Professional / Business). Existing `videoStorage` (GB) kept for R2 files. | Assumed mapping — owner to confirm; **not blocking** |
| DL-4 | 2026-09-18 | Device takeover allowed with confirmation and `DEVICE_SESSION_TAKEOVER` audit (D4). | Approved (owner) |
| DL-5 | 2026-09-18 | Certificate branding and lifecycle per D6; retake immutability per D7. | Approved (owner) |
| DL-6 | 2026-09-18 | Security-sensitive policies Client Owner only; Manager operational only (D8); `administrator` kept but hidden (D9). | Approved (owner) |
| DL-7 | 2026-09-18 | Existing academies `open` registration; new academies choose at creation (D3). | Approved (owner) |
| DL-8 | 2026-09-18 | Thirteen proposal phases consolidated into four vertical slices with all scope preserved. | Approved in principle; implementation approval pending |
| DL-9 | 2026-09-18 | `academy_students_tenant_select` admits the academy's whole roster under an organization context; the instructor's narrowing to assigned courses is done by the application layer (`viewerScope: 'assigned_courses'`) and verified under a user-only context. Layering choice, taken deliberately: an RLS predicate that also narrowed by course would have to re-derive the instructor relation on every roster row. | Taken (implementation); recorded for review |
| DL-10 | 2026-09-18 | Blocking a student revokes that learner's sessions **for that academy only**, never the whole account. A learner may belong to several academies, so `revokeAllForUser` (password change / reset) stays the account-wide tool. | Taken (implementation) |
| DL-11 | 2026-09-18 | An enrolled learner may SELECT the `courses` row they hold any enrollment for, including a `draft`/`private` course and including revoked or expired enrollments, so their own list can render the state. Course *content* tiers are unchanged and still require an accepted status. | Taken (implementation) |
| DL-13 | 2026-09-19 | `surface.enforce` is ROLLOUT control, never a boundary. `ManagementSurfaceGuard` and every RLS policy run in all three modes; `off` restores the pre-P64 surface behaviour and grants nothing RLS or another guard would refuse. Default `on`, so an unset or unreadable variable can never be the reason a learner reaches the management surface, and an invalid value fails startup. | Taken (implementation) |
| DL-14 | 2026-09-19 | Playwright journeys run against the real stack and the repository's own seed, with the learner created fresh through the academy website each run. Learner addresses use Atlas's own platform domain: the dev API runs the real deliverability check, which correctly refuses `@atlas.test` (no DNS) and `@example.com` (RFC 7505 null MX). | Taken (implementation) |
| DL-12 | 2026-09-18 | `POST /auth/register` still answers `409 errors.auth.emailAlreadyRegistered`, which lets an anonymous caller test whether an address has an Atlas account. Pre-existing and now reachable on every academy sign-up page. Changing it means emailing the existing account instead of answering — a product decision, not an implementation one. | **Open — owner decision required** |

## Implementation Change Log

| Date | Phase | Change | Author | Notes |
|---|---|---|---|---|
| 2026-09-18 | — | Master plan created from proposal v2 and the nine approved decisions. No code, schema, migration or production changes. | Claude (planning) | Awaiting implementation approval. |
| 2026-09-18 | 1 | Phase 1 implemented in full: critical fixes, derived principal model, surface-aware authentication, management-surface protection on 51 controllers, registration integrity, enrollment lifecycle, student roster, RBAC realignment, RLS tiers, frontend, 7 migrations, seed alignment. | Claude (implementation) | Local only. Nothing committed, pushed or deployed. |
| 2026-09-19 | 1 | Readiness checkpoint closed the two remaining gaps: the Playwright project with journeys J2 and J3 (18 tests, real stack), and the `surface.enforce` staged-rollout flag with its own e2e matrix (6 tests) and unit coverage. | Claude (implementation) | Local only. Still nothing committed, pushed or deployed. |
| 2026-09-19 | 1 | A performance regression introduced by B1's fix was found by the journeys and corrected in `20261008000700`; a pre-existing missing translation (B6) was fixed; `PrincipalResolverService` now resolves in one transaction instead of three round trips. | Claude (implementation) | See findings B5, B6 and observation O3. |
| 2026-09-18 | 1 | Four defects found by real Chrome validation fixed after the first green test run: learner enrollment list 500 on a non-public course; roster counting an expired enrollment as active; block leaving the learner's sessions alive; My Learning offering an action the backend refuses. Six new e2e regressions plus nine frontend unit tests added. | Claude (implementation) | See Phase 1 record. |

## Phase Completion Records

### Phase 1 — record

- **Status: Complete** (local). Implemented, tested, browser-validated and security-reviewed on 18–19 Sep 2026.
- **Start / end:** 18 Sep 2026 → 19 Sep 2026.
- **Commits / deploy SHA:** none. Nothing was committed, pushed, deployed or run against production — the phase brief forbade destructive production changes and no deployment was authorised. All work is uncommitted in the two working trees.

**Migration reconciliation — why §F says "1–6" and the repository holds 8 files.**

§F above lists six *logical* units of schema work. They ship as **one** physical migration, `20261008000000`, whose own section headers are numbered 1–5 and cover all six: enrollment lifecycle (§F Migration 2's columns and backfills), `academy_students` provenance plus `academies.registration_policy` and `academy_invites` (§F Migrations 3 and 4), `refresh_tokens` surface (§F Migration 5), the `quiz_attempts` dedupe and indexes (§F Migration 1), and the RLS block (§F Migration 6). One file because the RLS tiers depend on the columns added above them and the whole set must apply or fail together.

The other seven files are therefore **one addition and six corrections made during implementation and testing**, not extra scope:

| File | Why it exists beyond §F |
|---|---|
| `000100` | Addition. `resolve_learner_academies` — the definer function the principal resolver and the sign-in refusal payload both need; §F did not anticipate it. |
| `000200` | Correction to `000000`: its enrollment/progress/roster tenant write policies were wide enough for a *pending* student to enrol themselves. |
| `000300` | Correction to `000000`: the enrollment self-update trigger also fired on staff and platform writes. |
| `000400` | Correction to `000000`: `quiz_attempts_tenant_select` resolved its organization through an inline `EXISTS` that was itself RLS-filtered. |
| `000500` | Correction: a missing tenant SELECT tier on `quizzes`, without which a Prisma relation filter returned nothing. |
| `000600` | Correction: the missing `courses` SELECT tier for an enrolled student (finding B1). |
| `000700` | Correction to `000600`: its inline `EXISTS` was a measured cost regression (finding B5). |

One §F item deliberately did **not** become SQL: "materialize missing `course_progress` rows". It is done in application code by `CourseProgressService.upsertCourseProgress`, which materialises on read, so no historical backfill is needed and no migration writes progress rows.

**Migrations applied (local database only, 8):**

| Migration | What it does |
|---|---|
| `20261008000000_p64_phase1_identity_rbac_foundation` | Enrollment lifecycle columns and backfills; `academy_students` provenance and backfills; `academies.registration_policy`; `academy_invites` + RLS + `claim_academy_invite`/`resolve_academy_registration_policy`; `refresh_tokens.surface`/`academy_id` + backfill; `quiz_attempts` dedupe + UNIQUE + partial UNIQUE for one open attempt; `is_academy_student` now requires active and unblocked; `can_review_course` + review policies; author-tier section/lesson policies; `quiz_attempts` tenant policy; `can_view_academy_student` + roster policy; enrollment self-update trigger. |
| `…000100_p64_phase1_learner_academies` | `resolve_learner_academies(user_id)` SECURITY DEFINER returning the academy and its canonical host. |
| `…000200_p64_phase1_staff_enrollment_policies` | **Correction.** The first enrollment INSERT/UPDATE tenant policies were too wide — a *pending* student could enrol themselves. Replaced with `can_manage_academy_students`-checked staff policies. |
| `…000300_p64_phase1_enrollment_guard_scope` | **Correction.** The self-update trigger fired on staff and platform updates too; now scoped to `v_user = OLD.student_id` with no organization context. |
| `…000400_p64_phase1_quiz_attempts_tenant_lookup` | **Correction.** `quiz_belongs_to_organization` SECURITY DEFINER replaces an inline EXISTS that was itself RLS-filtered. |
| `…000500_p64_phase1_quizzes_tenant_select` | **Correction.** Missing tenant SELECT tier on `quizzes` (a Prisma relation filter needs the quiz row visible). |
| `…000600_p64_phase1_courses_enrolled_student_select` | **Correction (B1).** Missing `courses` SELECT tier for an enrolled student — the learner's own list 500ed on a non-public course. |
| `…000700_p64_phase1_enrolled_course_lookup` | **Correction (B5).** That tier's inline `EXISTS` evaluated every `enrollments` policy per candidate row; the lookup moved into the `is_enrolled_in_course` SECURITY DEFINER function. Same semantics, measured cost restored. |

Every backfill is written to be deterministic, idempotent and safe to retry. No production data was touched.

**Tests run and results:**

| Suite | Result |
|---|---|
| Backend unit (Jest) | **938 / 938 pass** (82 suites) |
| Frontend unit (Vitest) | **513 / 513 pass** (48 files) |
| Phase 1 e2e (`test/p64-*`, 7 suites) | **56 / 56 pass** |
| Playwright J2 + J3 (real stack, Chrome) | **18 / 18 pass** |
| RLS spec (`p64-rls-review-and-published`) | **8 / 8 pass** |
| Full backend e2e (110 suites, serial) | **1160 / 1168 pass**; 8 failures, none from Phase 1 — see below |

Accounting for the 8 full-run failures, each **demonstrated** rather than assumed:

- **6 pre-existing, demonstrably independent of Phase 1** — `platform-add-ons-management` (5) and `platform-add-ons-http` (1). The local `add_ons` table has accumulated **150** rows from repeated test runs while both specs hard-code `pageSize: 100`, so a newly registered key falls off page 1. The independence is not an inference: `platform-add-ons-management` calls `service.list(...)` **directly**, with no HTTP request and therefore no guard in the path at all, so no Phase 1 change can reach it — and every Phase 1 edit to add-ons code is the `ManagementSurfaceGuard` line plus its test stubs, with nothing touching the service, its pagination or the catalog.
- **2 resource contention** — `media` (1) and `p53-support-attachments` (1), both "oversized payload is refused" tests. Both pass when run on their own, verified twice.

Earlier runs also showed `course-commerce`, `courses-tenant-isolation`, `phase10-1-trial-abuse` and `p63-domain-operations` P63-DOM-021 failing under the same serial pressure; each passes in isolation and none appeared in the final clean run.

Two failures are recorded for honesty rather than explained away. On one batch run of the Phase 1 suites a single `p64-browser-findings` test failed and never reproduced across five later runs. And one full run showed two genuine Phase 1 failures that were **my own interference**: the run was in progress while the `surface.enforce` flag was temporarily set to `off` in `.env` for the rollback verification, so suites that started inside that window correctly observed no surface refusal. Both suites pass with the environment restored, and the clean run above was taken with nothing else touching the environment.

**Browser validation evidence (real Chrome, local stack, 18–19 Sep 2026).** A real learner account, `atlas.p64.phase1@gmail.com`, was created through the academy website, not seeded. All 27 mandated checks were carried out:

1. Academy header renders default Sign in / Sign up when no CMS call-to-action is configured. 2. Registration succeeded; the database confirmed one atomic write — user, `academy_students` row with `source = self_signup` and the registration host, and exactly one verification token. 3. Central management sign-in refused the learner with the dedicated card ("You are a student. Please sign in through your academy's website."), a link to their academy, and **no token issued** — `localStorage` held nothing. 4. Academy sign-in redirected to `/my-learning`. 5. The learner token was refused (`403 errors.auth.managementSurfaceOnly`) on ten management endpoints, and on ten more in the adversarial pass. 6. `GET /users/me` reported `principalKind: "learner"` with the academy and its canonical host. 7. `/dashboard/platform` redirected to the academy chooser. 8–10. Client Owner signed in, opened Members → the new **Students** tab, and saw the learner with "Website sign-up" provenance. 11. The drawer showed membership, provenance, verification state, active sessions and lifecycle actions. 12. Manual enrolment with an expiry recorded `access_source = manual` and no order. 13. A past expiry date was refused ("The expiry date must be in the future"). 14. An expired enrollment lost sections, progress, quizzes and assignments (404) while the enrollment list still rendered. 15. Re-granting restored access. 16. Revoke through the UI denied content, stored the reason, and wrote an `enrollment.revoked` audit entry. 17–19. Block denied content, refused a fresh sign-in (`errors.auth.academyAccessBlocked`), ended the learner's existing sessions, and left another student's sessions untouched; unblock restored sign-in. 20. Manager could run operational actions but was refused the owner-only registration policy (D8). 21–23. Instructor saw only the student enrolled in her own course, with `viewerScope: assigned_courses` and no session count; review on an unassigned course 404ed, on her own returned 200; a student outside her courses 404ed. 24. Cross-academy: a real academy host with another academy's id was refused (`errors.auth.academyHostMismatch`). 25. Public courses resolved anonymously **by slug and by id**, while the draft/private course 404ed on both. 26. Existing course-taking still works end to end — curriculum, sequential locking, lesson completion, progress to 33%, next lesson unlocked. 27. Email verification, forgot-password, reset, and the invalid-token card all behaved correctly on the academy surface; the old password was refused afterwards and the new one accepted.

The browser pass found **four defects that the green test suite had not** (B1–B4 in Findings Traceability). All four are fixed and now carry regressions.

**Adversarial review (Appendix A):** run as a deliberate attacker pass after the fixes.

- Learner token refused on 20 management endpoints and on block/manual-enrol writes; another learner's user record 404; an unknown query parameter 400 rather than a wider read.
- Instructor confined to assigned courses at every layer: roster list, student detail, review, and the write actions (403).
- Manager refused the owner-only security policy; permitted the operational ones.
- Cross-tenant refused in both directions, including for an owner reaching a second academy in their **own** organization (organization role is never assumed to be academy role).
- IDOR on the enrollment lifecycle: revoking or re-dating another academy's enrollment through one's own academy 404s.
- No token and a garbage token both 401.
- Requesting the management surface as a learner issues nothing: `403 errors.auth.studentUseAcademySignIn`.
- Enumeration: sign-in and password reset answer identically for known and unknown addresses. Registration does not — see O2.
- Concurrency: three parallel manual enrolments leave exactly one enrollment row, guarded by `enrollments_student_id_course_id_key` as well as the service check.
- Invites: only the hash is stored; the raw token never reaches the database.
- **RLS agrees independently of the guard.** Under a user-only context a learner sees zero enrollments, quiz attempts, assignment submissions, invites or audit entries belonging to anyone else; an instructor sees zero enrollments outside her own courses.

**Playwright J2 and J3 (19 Sep 2026).** 18 tests, both journeys green together and individually, against the real Vite server, the real API and the real database.

- **J2, 9 tests** — a learner created through the academy sign-up form; the same credentials refused on the central management sign-in with nothing written to storage; the academy sign-in landing on `/my-learning`; `/dashboard/platform` and `/dashboard/organization/create` both redirecting a *signed-in* learner to the academy chooser; the chooser naming their academy and offering a way out; a learner token refused on twelve management controllers, each asserted to carry `errors.auth.managementSurfaceOnly` rather than merely a 403; the same token still serving `/users/me` and `/enrollments`; and a host/academy mismatch refused.
- **J3, 9 tests** — academy signup; Client Owner sign-in; the Students tab selected and carrying the new learner with "Website sign-up" provenance; the drawer opening and granting a course; the drawer and the API agreeing about that enrollment; the learner taking a quiz (asserting the payload never carries `isCorrect`) and submitting an assignment; the Manager reading attempts and **grading** the submission; the Instructor editing their assigned course's curriculum for real; the Instructor refused another course on read and write and narrowed to `viewerScope: assigned_courses`; and cross-academy isolation for all three staff principals, including the sharper same-organization case and an unknown academy id answering identically.

Three defects in the journeys' own setup were found and fixed rather than worked around: the dev API's real email-deliverability check refuses both `@atlas.test` and `@example.com` for correct and different reasons, a fresh browser context per test would have made the dashboard redirects pass for the wrong reason, and the real sign-in rate limiter (10 per IP per 15 minutes) needed flushing per journey exactly as the Jest suites already do.

**`surface.enforce` (19 Sep 2026).** Tested at every layer and in both directions.

- `p64-surface-enforce-flag` e2e, 6 tests: `on` refuses sign-in and controllers; `off` issues a management session and stops refusing the surface; `allowlist` refuses a listed academy's learner and admits an unlisted one; **`off` still refuses that learner another tenant's data, staff actions, the owner-only policy and review** — the assertion that keeps the flag honest; the owner, manager, instructor and platform owner are unaffected in all three modes; and `on → off → on` rolls back and forward with no residue, including a session minted while off ceasing to reach management controllers the moment it is on again.
- Unit: 6 guard tests covering all three modes, a learner belonging to several academies, and a missing configuration failing closed; 7 frontend tests for the routing predicate.
- Browser: with `SURFACE_ENFORCE_MODE=off` in the real dev environment, the learner signed in centrally and reached the dashboard, and the frontend did **not** strand them at the chooser; with the variable removed, the refusal card returned immediately. The environment file was restored from a backup taken beforehand.

**A correction to the earlier record.** The first Phase 1 report said the instructor's student detail hides the active-session count. That was wrong: the count was zero at that moment because the learner's sessions had just been revoked. An instructor does see `activeSessionCount` for a student of their own course. It is a count, not device data, for a student they are already authorised to see, and the device model itself is Phase 2 (D4). Left as it is, recorded rather than quietly changed.

**Production verification: not performed.** Nothing was deployed. This remains open and needs explicit authorisation.

**Deviations from plan:** none in scope. Four layering or implementation choices were taken and recorded as DL-9 through DL-11, DL-13 and DL-14; two RLS tiers were added beyond the original migration list (`000600`, `000700`).

**Working-tree classification (19 Sep 2026).** Audited read-only, every path in `git status` classified exactly once. All P63 custom-domain work is already committed, so no uncommitted P63 *feature* work exists in either tree and no file mixes P64 with P63 hunks. Four paths in `atlas-front` must stay out of a Phase 1 commit: `MASTER_HANDOVER.md` and `NEW_HANDOVER.md` (untracked handover documents dated before P64 with no P64 content), the two-line banner on `ATLAS_HANDOVER.md` pointing at them, and a one-line fix to `canonical-redirect.utils.test.ts` that removes a bogus `probeHostAnswers` import shipped in the committed P63g commit — a genuine P63 fix that deserves its own commit. Playwright's generated `test-results/` was not ignored and is now in `.gitignore` alongside `playwright-report/`, `blob-report/` and `playwright/.cache/`.

**Discoveries and unresolved issues:** B1–B6 (all fixed); O1 (identity tables carry no RLS — pre-existing and architectural, recommended as its own phase); O2/DL-12 (registration reveals whether an email is already registered — **owner decision required**); O3 (connection-pool and transaction budget need sizing before production); DL-3 (`videoStorageMinutes` tier-name mapping still unconfirmed).

**Decisions taken:** DL-9, DL-10, DL-11 (implementation); DL-12 raised and open.

### Phase 2 — record
- Status: Not Started
- (same fields as above)

### Phase 3 — record
- Status: Not Started
- (same fields as above)

### Phase 4 — record
- Status: Not Started
- (same fields as above)

---

## Appendix A — Adversarial checklist (run at the end of every phase)

1. Anonymous: public course/curriculum endpoints expose only metadata and titles; a stored protected key fetched directly fails; a public asset still serves.
2. Learner: sections/sequence responses contain no content URLs; locked items have no content; quiz payloads have no `isCorrect`; authoring and review endpoints 404.
3. Learner: reload during an attempt resumes; parallel attempt starts create one; second start returns the open attempt; expiry auto-submits and grades as-is.
4. Learner: management sign-in refused; management controllers 403; organization creation 403; cross-academy enrollment/roster 403.
5. Staff: owner and manager review and grade; manager cannot change device or content-protection policy; instructor limited to assigned courses; org member cannot read curriculum; academy staff cannot author.
6. Devices: third device refused; concurrent playback conflict; takeover audited; revoked enrollment cannot refresh a token.
7. Certificates: verification uniform for unknown codes; revoked shows revoked; retake leaves the certificate unchanged.
8. Production read-only: course by slug; no dead config call; anonymous endpoints unchanged; no duplicate attempt numbers.

## Appendix B — Evidence from the planning audits (18 Sep 2026)

Local Chrome validation with a learner created through the academy website reproduced: central-login acceptance of learners and dashboard rendering; Students missing from Members (rows present in `users` and `academy_students`, none in `organization_memberships`/`academy_members`); owner/manager 404 on review and grading; instructor 404 on other courses and 403 on academy routes; owner 500 when attaching a quiz to a section of a draft course (201 after publishing); quiz and assignment pages outside the player shell; Next skipping the quiz; course completion before the required quiz; certificate enum only; native video with download/PiP enabled; concurrent attempt starts exceeding the cap; reload clearing answers; anonymous media fetch 200 with 1-year immutable cache.

Cloudflare Stream official documentation verified: signed tokens (`exp` ≤ 24 h, `nbf`, `downloadable`, `accessRules` ≤ 5), local signing keys (≤ 1,000, not rate-limited), allowed origins with wildcard caveats, direct creator uploads (`maxDurationSeconds` reservation; 200 MB basic / TUS), MP4 downloads opt-in and token-gated, static PNG watermark profiles applied at upload, webhook HMAC-SHA256 signature, HLS/DASH manifests never cached, $5 per 1,000 stored minutes and $1 per 1,000 delivered minutes (external billing facts only, never encoded in Atlas), 30 GB max upload, **no DRM in docs, FAQ or changelog**.

Code locations: `src/identity/services/auth.service.ts`, `src/identity/dto/contracts.ts`, `src/tenancy/guards/saas-level-caller.guard.ts`, `src/academy/guards/academy-scope.guard.ts`, `src/academy/services/academies.service.ts`, `src/course/services/course-curriculum.service.ts`, `src/learning/services/learning-access.util.ts`, `src/learning/services/quizzes.service.ts`, `src/learning/services/course-progress.service.ts`, `src/learning/services/assignments.service.ts`, `src/instructor/services/instructor.service.ts`, `src/dashboard/services/student-analytics.service.ts`, `src/media/controllers/public-media.controller.ts`, `src/plans/dto/entitlement.types.ts`, `prisma/schema.prisma`, migrations p6/p7/p13/p21/p22b/p24/p24c/p27c/p30; `atlas-front/src/app/routes/*`, `src/app/navigation/navigation.config.ts`, `src/features/auth/*`, `src/features/public-website/*`, `src/features/academy/pages/AcademyMembersPage.tsx`, `src/features/learning/*`, `src/features/website/renderer/*`.
