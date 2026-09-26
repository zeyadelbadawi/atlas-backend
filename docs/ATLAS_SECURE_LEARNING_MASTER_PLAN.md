# Atlas Secure Learning — Master Implementation Plan

**Single source of truth for the P64 initiative: secure learning content, assessments, learner identity and the complete learner journey.**
Supersedes the published proposal versions 1 and 2 (https://claude.ai/artifact/QzfCw5aH9rJ3WnTjKEZhkE), which remain as research background only. When this file and any other document disagree, this file wins.

Repository: `atlas-backend` (this file) and `atlas-front` (frontend work referenced here). Related authorities that stay in force: `docs/plans/ENTITLEMENT_SEMANTICS.md`, `docs/course/UNIT_CURRICULUM.md`, the P63 custom-domain design in `src/domain`.

---

## Document Status

| Field | Value |
|---|---|
| Status | **Phase 1 COMPLETE in production** (19 Sep 2026). **Phase 2 COMPLETE in production** (21 Sep 2026, see the closeout section at the end of this file). **Phase 3 COMPLETE in production** (22 Sep 2026: migrations 109 → 114; backend `b13c790`, frontend `3c5ee3d`; flags on the canary academy; validated on production with seven defects found, fixed and re-verified — see the Phase 3 record; learner-session Chrome journeys NOT VERIFIED by the implementer, DL-37). Phase 4 next (DL-15). CodeRabbit unavailable from here (DL-39). |
| Communications | **CLOSED in production** (25 Sep 2026). 74 catalogue keys; backend `1318acd`, frontend `6671557`. Production flags: `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` and `_ACADEMY` = **`new_device`** (ON), `FLAG_VIDEO_RETENTION_MODE` = **`warn_only`** (ON, warnings only — no deletion is enqueued), `FLAG_LIFECYCLE_SEQUENCES_MODE` = `dry_run`, `EMAIL_PROVIDERS` = `brevo`. Both OTP and retention were enabled on owner approval on 25 Sep; see MR-9 in `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`. Open: BL-3 (Resend sending domain `send.<domain>`), BL-2, BL-4. Moving retention to `on` is a separate decision and is **not** approved. |
| Version | 1.4 — 25 Sep 2026 |
| Approved product decisions | 9 (see below) |
| Implementation approval | **Phases 1–4 all approved.** Phase 1 delivered to production 19 Sep 2026; Phases 2, 3 and 4 approved together under DL-15 and run back to back with no per-phase approval. |
| Current phase | **Phase 3 — Complete.** Phase 4 starts next under the DL-39 workflow (fix locally → test → commit → push to `main` → deploy → verify). |

Allowed status values: Planning / Awaiting Approval / Approved / In Progress / Blocked / Complete.

**Execution governance.** This plan is executed autonomously across Phases 1 → 2 → 3 → 4, then a Final Master Plan Audit, a final repository-wide review, and the Final Report. The implementer does not pause between phases. Each phase must still earn its completion through the full lifecycle in the next section — implement, test, pull request, CodeRabbit review loop, merge, deploy, migrate, and real Chrome production validation — and stops only for the six blocker conditions listed there.

---

## How this file is used (mandatory workflow)

**Execution model: autonomous sequential.** Phases 1 → 2 → 3 → 4 run continuously. When a phase satisfies every acceptance criterion and its Definition of DONE, the implementer proceeds to the next phase **without requesting another phase-start approval**. Approval for Phases 2, 3 and 4 was granted together with this workflow change (DL-15); it is not re-sought per phase.

### The per-phase lifecycle

**Phase start.** Re-read this file in full; read the phase's scope, acceptance criteria and Definition of DONE; read the previous phase's Completion Record; inspect the repository (`git log`, `git status`, schema, migrations, tests) and confirm it matches that record; confirm every dependency is satisfied.

**Implementation.** Implement the phase completely, across backend and frontend as the phase requires. No knowingly-left TODOs, placeholders, fake implementations, skipped tests or broken flows. Work from another phase is allowed only when a hard dependency requires it, and is recorded as a deviation. Existing architecture and security decisions are preserved unless a real implementation dependency forces a change, which is then documented.

**Local validation.** Run the phase's unit, integration, RLS, frontend, Playwright and adversarial/security tests. Fix every real failure and re-run until clean. A pull request is not opened while a known implementation or test failure remains, unless that failure is documented as unrelated **and** independently demonstrated to be pre-existing.

**Git and pull request.** Commit the phase to a dedicated feature branch (`feat/p64-phase2`, `feat/p64-phase3`, `feat/p64-phase4`) and **push that branch to the remote** — a pull request cannot exist without it. "Do not push to main" forbids pushing the phase *directly* to main; it does not forbid pushing the feature branch. Open a pull request targeting `main`. Do not merge yet.

**Review loop (mandatory).** Wait for the configured checks and the CodeRabbit review. Read every comment and classify it: real bug or security issue; real correctness issue; real architectural issue; real testing gap; real performance or reliability issue; valid code-quality issue; false positive; or already handled elsewhere. Verify each against the actual code — CodeRabbit is a reviewer, not the authority, and correct code is never changed merely to satisfy it. Fix what is justified, add or update tests, run the affected tests, commit, push the branch, and let the review run again. Repeat until every actionable finding is resolved or explicitly justified in writing.

**Merge.** Merge the pull request into `main` when the implementation is complete, local tests pass, required CI checks pass, the current review cycle is finished, all actionable findings are resolved or justified, no known blocking defect remains, the diff has been reviewed, the migrations are understood and safe, and the acceptance criteria are satisfied. Merging does not require a further request to the owner.

**Production deployment.** Let the normal deployment workflow run and monitor it. If build or deploy fails: diagnose, fix, commit, re-check, re-review, merge and redeploy. A failed deployment is not a reason to abandon a phase. Never bypass a protected-environment approval or any other GitHub permission control; where one genuinely requires a human, record the blocker and stop there.

**Production migrations.** Follow the existing migration architecture: preflight, verified backup, migration order, data-safety checks, no destructive migration, rollback procedure. Apply **only** the migrations belonging to the phase being executed; a future phase's migrations are never applied early. Afterwards verify the migration count, the schema, application health, database and Redis health, and the expected routes.

**Real Chrome production validation (mandatory, every phase).** Against the real production academy website and a real learner journey — never only unit tests, Jest, local Playwright, mocked APIs, a local browser, screenshots or a green build. Validate every browser requirement the phase names, capturing actual evidence. If Chrome finds a defect, the phase is **not** complete: fix it, re-test, update the pull request, re-review, merge, redeploy and re-run the production validation until the Definition of DONE is genuinely satisfied.

**Record, then continue.** Update this file (see *Phase Completion Record requirements*), then **immediately begin the next phase**. After Phase 4: the Final Master Plan Audit, the final repository-wide review, the Final Report, then stop.

### When to stop

Solve problems autonomously. Do **not** stop merely because a phase is large, many files changed, CodeRabbit left comments, a test needs fixing, a deployment needs retrying, a pull request needs another review cycle, a browser test found a defect, code needs refactoring, or a preflight caught a fixable issue. Investigate, fix, re-test, continue.

Stop only when one of these is true:

1. A human decision is genuinely required and cannot be inferred from this approved plan.
2. A required secret, credential or access is unavailable.
3. A protected GitHub or environment permission requires a human approval the agent cannot supply.
4. Continuing would violate an explicit project safety or security rule.
5. A production incident makes continuation unsafe.
6. A requirement here is internally contradictory and cannot be resolved from the recorded decisions.

When blocked, never bypass the blocker silently. Record the exact blocker, the evidence, what was attempted, why it cannot be resolved autonomously, and the exact action needed from the owner.

### Quality bar

Autonomous execution is not permission to rush. Forbidden: skipping tests to save time; ignoring CodeRabbit findings; merging with known critical or security defects; claiming Chrome validation, a deployment or a migration without evidence; suppressing failing tests; weakening a security control to make a test pass; marking a phase complete because the implementation is "mostly done"; starting the next phase while the current one has unresolved blockers. Never fabricate evidence, and never mark something complete merely because the code exists.

The sequence is: complete → review → fix → test → deploy → real Chrome → verify → record → next phase.

Hard rules inherited from the project rulebook: guard decides and RLS independently agrees; no destructive production changes; no migrations outside the phase being executed; entitlement zero-delta rules apply to every new limit; Live Sessions add-on stays untouched.

---

## Approved Product Decisions

| # | Decision | Ruling (binding) |
|---|---|---|
| D1 | Video protection model | **AMENDED 19 Sep 2026** (see D10; original ruling preserved in the Decision Log as DL-16). Proceed **without DRM on either tier** — Cloudflare Stream does not offer DRM at all, so this is a property of the provider, not only a choice. Atlas ships **two video security tiers**. **Premium** uses Cloudflare Stream with signed playback, short-lived authorization, allowed origins, managed processing, adaptive bitrate, managed delivery and watermarking. **Normal** uses Atlas-owned object storage behind an Atlas-controlled gate, with short-lived credentials and the **same** Atlas entitlement checks. Neither tier may be described as "unsecured"; Normal is **"Basic Video Protection" / "Self-Managed Video Delivery"**. Neither tier may claim DRM, piracy-proofing, download-proofing or screen-record-proofing. **The tier a grant was issued under, and exactly which protections it actually enforces, are reported to the client rather than assumed** — never advertise a security property merely because an identifier exists inside a JWT (AD-16). |
| D2 | Staff who are also learners | **Remove learner routes from the management dashboard.** Staff who are enrolled learn through the academy website exactly like students. Management surface = Platform Owner / Client Owner / Manager / Instructor → management dashboard. Learning surface = learner → academy website → academy login → learner dashboard → learning experience. No duplicate learner routes in the dashboard. |
| D3 | Registration policy | Existing academies default to **open** registration. New academies choose the policy at creation. The model supports open and invitation-only/restricted policies and must remain changeable later (no hard-coding). |
| D4 | Device takeover | **Allowed.** Inform the learner another active learning session exists; require explicit confirmation; revoke/terminate the previous learning session; activate the new one; record an auditable `DEVICE_SESSION_TAKEOVER` event with learner, old device/session, new device/session, academy, course/session context and timestamp. |
| D5 | Video storage quota | `videoStorageMinutes` is a plan entitlement: baseline Basic 500, Growth 2,000, Enterprise 5,000 minutes. These are Atlas entitlements, **not** provider billing values. Atlas enforces the quota when video content is added (reject when `usage + new > quota`, e.g. 1,850 + 180 = 2,030 > 2,000 → reject with a clear message; 1,850 + 100 = 1,950 → allow). No delivery/consumption quotas now, but keep the model extensible. Provider billing stays external and Atlas never depends on a provider price. **AMENDED 19 Sep 2026:** the quota is **provider- and tier-independent** — it counts every minute of Atlas-hosted video whichever tier delivers it, so Normal video does **not** additionally consume `videoStorage` (GB) and the two tiers stay directly comparable. The catalog **may** set different quota values for the Normal and Premium variants of the same tier (e.g. `NORMAL_BASIC` ≠ `PREMIUM_BASIC`); the mechanism is one provider-independent key, not two. Where a provider does not report a measured duration, Atlas derives it and records how it was obtained — a declared duration is never silently trusted. |
| D6 | Certificate branding | Platform-standard certificate template with academy logo/identity, academy signature where applicable, and an "Issued via Atlas" footer. Lifecycle supports eligibility, issuance, certificate ID/reference, visibility, verification, status, revocation, explicit regeneration rules, and immutable issuance facts. |
| D7 | Quiz retake after certificate | Learners may retake a required quiz after a certificate is issued. The certificate preserves the score/result at issuance; a later retake never silently modifies it. Regeneration/reissuance is an explicit workflow, never a side effect. |
| D8 | Security policy permissions | **Client Owner**: academy-wide authority including security-sensitive policies (device/session enforcement, content protection/security configuration). **Manager**: academy-wide operational course/content/curriculum management, learner outcomes, grading/review, operational settings — **no** authority over device enforcement or other high-impact security policies. Owner and Manager are never collapsed into one permission set; RBAC stays explicit and granular. |
| D10 | **Plan families and video tiers** | Atlas has **two plan families** — `normal` and `premium` — each with three tiers (`basic`, `growth`, `enterprise`), giving six commercial variants: `NORMAL_BASIC`, `NORMAL_GROWTH`, `NORMAL_ENTERPRISE`, `PREMIUM_BASIC`, `PREMIUM_GROWTH`, `PREMIUM_ENTERPRISE`. **The family determines the video security capability class; the tier determines commercial limits and features.** Prices are catalog/business data and must never appear in provider or authorization logic. The resolution chain is **plan → entitlement → security tier → provider registry → provider**; `premium` must never be hard-wired to `CloudflareStreamProvider` anywhere in the authorization layer. |
| D11 | **Premium → Normal downgrade** | **No automatic migration.** When an academy moves from Premium to Normal: existing Premium assets stay on their existing provider and tier, new uploads use the newly entitled tier, **mixed provider/tier state within one academy is valid and expected**, nothing is silently migrated, and no destructive conversion occurs. No Premium → Normal video migration is promised until provider capabilities are verified and a dedicated migration workflow is designed. An academy's current plan **never rewrites the historical security tier of an existing asset**. |
| D9 | `administrator` academy role | Keep in the enum/model for compatibility; hide from the UI; not selectable for new assignments; no new functionality built on it; existing records preserved; retirement is a separate future migration decision. |

Note on D5 naming: the repository's seeded plan keys are `starter`, `growth`, `enterprise` (`prisma/seed.ts`, `src/plans`). D10's tier vocabulary calls the first of these **`basic`**; the seeded key `starter` is that tier, and the existing rows are not renamed (Decision Log DL-3, DL-17). The approved baseline quotas map basic/`starter` → 500, growth → 2,000, enterprise → 5,000. The existing `videoStorage` limit is in **GB** (R2 file storage) and is unrelated; `videoStorageMinutes` is the provider-independent key for hosted video (D5).

---

## Architecture Decisions

| ID | Decision | Rationale |
|---|---|---|
| AD-1 | **Atlas is the sole authorization authority; EVERY video provider is a delivery layer that only honours capabilities Atlas signs.** Video bytes are never proxied through the backend, **on any tier**. (Amended 19 Sep 2026 — was "Cloudflare Stream and R2 are delivery layers"; the rule was never Cloudflare-specific and is now stated that way.) | Keeps the single VPS off the media path; revocation and entitlement stay centralized; prevents the tempting shortcut of serving Normal-tier video from the VPS. |
| AD-2 | **Entitlement is evaluated at the moment bytes are requested**, per lesson, per request, and again on every playback-token refresh. Sections/curriculum responses never carry content URLs. | Closes the "one enrollment = whole course forever" model. |
| AD-3 | **Lesson bodies and resources live in `lesson_contents` / `lesson_resources` with no public RLS policy.** | Structural fix for the published+public lesson policy gap. |
| AD-4 | **Principal kind is derived, not stored**: `platform_owner` (flag), `staff` (any organization membership or active `academy_members` row), otherwise `learner`. A person can be staff in one organization and a learner in another; the surface decides which capabilities apply. | Matches the existing "students are global users + `academy_students`" rule without adding a contradictory flag. |
| AD-5 | **Surface-aware authentication**: sign-in carries `surface: 'management' \| 'academy'`; learners are refused a management session; `ManagementSurfaceGuard` protects every management controller server-side. | Finding 1 requires enforcement beyond frontend routing. |
| AD-6 | **Scopes**: platform → organization → academy → course. Instructor is course-scoped (`course_instructors`), Manager and Client Owner are academy-wide, with D8's split between operational and security-sensitive authority. New helpers `assertCanReviewCourse`, `assertCanViewAcademyStudents`, `assertCanManageSecurityPolicy` and SQL `can_review_course`. | Finding 5. |
| AD-7 | **Video provider abstraction and registry.** `VideoProvider` with `capabilities()` reporting what is ACTUALLY enforced — `signedPlayback`, `boundToSession`, `boundToDevice`, `revocableBeforeExpiry`, `originRestricted`, `staticWatermark`, `adaptiveBitrate`, `drm`, `downloads`, `reportsReadinessAsynchronously`, `enforcesMaxDuration`. A **`VideoProviderRegistry`** resolves the adapter **by security tier on upload** and **by `media_assets.provider` on playback**, following the established `PaymentProviderAdapter` registry shape. Production implementations: `CloudflareStreamProvider` (premium) and `BasicVideoProvider` (normal). **Capability flags are CONSUMED, not merely declared** — the content grant reports them to the client (AD-16). (Amended 19 Sep 2026 — superseded the clause naming `CloudflareStreamProvider` as "the only production implementation"; see DL-16.) | D1, D10; two first-class production tiers. |
| AD-8 | **Server-authoritative quiz attempts**: server clock, deadline, autosave with monotonic revisions, delayed auto-submit job plus sweep, database uniqueness (attempt number; one open attempt), grading policies, results disclosure by policy. Expiry grades as-is and never auto-fails. | D5 of the previous round (quiz expiry), finding evidence. |
| AD-9 | **Integrity tiers**: enforcement (server), detection (browser signals with server timestamps), deterrence (fullscreen, selection/copy/context-menu limits, watermark), UX (warnings, counters, thresholds). No claim that recording or screenshots can be prevented. | Honest security model. |
| AD-10 | **Device policy** via server-issued `atlas_device` cookie and `student_devices`; concurrent learning session via Redis lease with heartbeats; defaults 2 devices / 1 session in `access_policies` (platform → academy → plan override, Client Owner only). Takeover per D4. | D4, D8. |
| AD-11 | **Completion rules** per course (`completion_rule` JSON) evaluated server-side from lesson evidence, quiz results and assignment grades; certificates issued from an eligibility evaluator with immutable issuance snapshot. | Finding 2, D6, D7. |
| AD-12 | **One learner surface**: learner dashboard and player live on the academy website under `/my/*`; dashboard learner routes are removed after redirects. | D2. |
| AD-13 | **Additive migrations only**; every projection change is behind a per-academy flag with a platform default; rollback = flag off. | Rollout safety on a single-VPS deployment. |
| AD-14 | **Quota model**: `videoStorageMinutes` is a `PlanResourceLimits` key following `granted_limits ?? plan.limits` and zero-delta semantics; usage is Atlas-owned (`media_assets.duration_seconds` for ready videos plus active upload reservations); enforcement happens before a direct-upload URL is issued and again when the provider reports the real duration. **Amended 19 Sep 2026:** usage counts **every** provider, never one. The two independent aggregates (`EntitlementEnforcementService` for enforcement and `TenantUsageRecomputeService` for reporting) must be changed together and asserted to agree, because divergence means enforcement and the Usage page tell a customer different numbers. A reservation released by a failed upload stops counting. | D5, D10. |
| AD-15 | **`securityTier` is not `provider`.** `media_assets.provider` records **where the bytes are** (a storage fact). `media_assets.security_tier` records **what Atlas promised and enforces** for that asset (a product fact). They are separate columns and neither is derived from the other at read time. | A future change of Normal-tier provider must not change any customer's promise; and a learner must be told the truth about an INDIVIDUAL video, not about their academy's current subscription (D11). |
| AD-16 | **Capability-honest grants.** The content grant reports the tier and the capabilities the delivering provider actually enforces, read from `capabilities()` — never an aspiration. Specifically: Cloudflare Stream does **not** enforce Atlas session/device claims at its edge (investigation finding D-5), so a Premium grant reports `boundToSession: false` / `boundToDevice: false` and says plainly that binding is enforced at grant-issue time only. | Finding D-5. The alternative is telling a paying customer their content has a protection it does not have. |

---

## Scope

**In scope**: everything in the four phases below — critical fixes; identity surfaces; registration integrity; student roster; RBAC realignment; learner dashboard; unified course player; protected content tier; two-tier hosted video (Normal and Premium, D10); device/session policy; video quota; quiz engine v2; integrity layer; assignment drafts/due dates; completion rules; certificates; catalog, preview and checkout; observability; hardening; production rollout.

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
- [x] **All listed unit, e2e, RLS and Playwright tests green; browser validation recorded** — 938 backend unit, 513 frontend unit, 56 Phase 1 e2e, 8 RLS, 18 Playwright (J2 + J3), full backend e2e with every failure individually accounted for, and two recorded Chrome passes. *Recorded honestly:* "green in CI" still cannot be claimed, though the reason has changed. Both repositories are now merged to `main`, but the `CI` workflow is **disabled** in GitHub (`disabled_manually`), so no CI run exists for these commits. Every suite above ran locally, repeatedly, against the real stack, and the `Deploy` workflow succeeded for the current `main`.

### W. Definition of DONE
All acceptance boxes checked; migrations applied in production; production read-only verification recorded; Phase Completion Record filled (commits, deploy SHA, test run summary, browser evidence, deviations); Document Status updated. **Satisfied on 19 Sep 2026** — see the Phase 1 record for the evidence, including the two production Chrome checks that remain blocked on credentials. Under DL-15 the implementer proceeds directly to Phase 2 from here.

**Status against this definition (19 Sep 2026, after production delivery):** all eight acceptance boxes are checked with evidence, including the Playwright journeys and the `surface.enforce` flag that the readiness checkpoint found missing. Tests run, browser evidence recorded, adversarial review done, Completion Record filled, Document Status updated — and the production steps this definition demands are now done too.

**The two production items this definition requires are complete, verified 19 Sep 2026 and re-verified before Phase 2 began.** Migrations are applied in production: 103 applied, all eight `p64_phase1` among them, none unfinished or rolled back. The production read-only verification was performed in real Chrome against the live `ghg` academy. Both repositories are merged to `main` — backend `0b884e7` deployed at `7672ee3`, frontend `92f80bc` — and the backend reports healthy with the Phase 1 routes live.

**Phase 1 is therefore DONE by this definition**, with one honest qualification carried forward rather than hidden: the Client Owner Students tab and the Manager/Instructor UI boundaries were **not** exercised in production Chrome, because no Client Owner credential for that academy is available and the platform-owner account is correctly refused its data. Those two checks stay recorded as BLOCKED in the completion record above. They do not block Phase 2: the same boundaries are covered by Playwright J3 and by the server-side data verification, and the gap is one of observation, not of implementation.

---

# Phase 2 — Learner Dashboard, Course Player, Protected Content, Video and Devices

**Status:** Not Started
**Estimate:** ~7 weeks
**Consolidates:** P64d (learner dashboard), P64e (protected content tier and grants), P64f (hosted video — **both** the Normal and Premium tiers, D10), P64g (device/session policy), the player-shell and sequence half of P64j, plus the video storage quota (D5) and the dashboard learner-route removal (D2).

### A. Objective
Give learners one complete, academy-branded learning surface (dashboard + unified player) and make every byte of paid content entitlement-checked, short-lived, provider-signed and device-policed, with progress evidence recorded server-side.

### B. Why this phase exists
S1–S3 (anonymous media, RLS gap, whole-course URL delivery) are the critical security findings; F1's dashboard and F3's player are the learner-facing product gaps; D1, D2, D4 and D5 all land here. Content grants, video and device policy share the same policy decision point, so they ship together as one vertical slice.

### C. Dependencies
Phase 1 complete (principal model, lifecycle columns, review RBAC). D5 quota mapping confirmed (Decision Log DL-3).

**Amended 19 Sep 2026 (D10).** Cloudflare Stream onboarding — account, signing key, webhook secret — is a dependency of the **Premium tier only**. The **Normal tier depends on nothing that does not already exist** (R2, the protected bucket, the presign path and the Worker gate), so Phase 2 as a whole is no longer blocked on provider onboarding. The Normal tier's Worker architecture must pass the validation spike in §S before it is declared production-ready.

### D. Backend work
1. **Protected content tier**: protected R2 bucket and upload endpoint; `lesson_contents`, `lesson_resources`; `media_assets` gains `access`, `provider`, `provider_id`, `processing_status`, `duration_seconds`, `course_id`; `course_lessons` gains `is_preview`, `available_at`, `duration_seconds`, `completion_rule`, `video_asset_id`.
2. **Policy decision point** `LessonContentService.getContent()` implementing all seven entitlement conditions (identity/session, academy context, active enrollment, published course, deliverable lesson or preview, device/lease, no suspension), rate-limited, logged to `content_access_log`, returning `{ kind: text|video|file|external, …, watermark, playbackLease, expiresAt }`; `ContentGrantSigner` (R2 presign 10 min; Stream token 2 h bound to session and device, never `downloadable`).
3. **Sections projection** without `contentUrl` (behind `content.protected`), adding `isPreview`, `durationSeconds`, `lockState`, `lockReason`; **sequence endpoint** `GET /learning/courses/:id/sequence` returning ordered items across lessons, quizzes, assignments and live sessions with per-item state and lock reasons (unified curriculum ordinals; assignment/quiz ordering bug fixed).
4. **Video providers and the registry (AD-7, D10)**: `VideoProvider` with `capabilities()` reporting what is actually enforced; a `VideoProviderRegistry` resolving **by security tier on upload** and **by `media_assets.provider` on playback**.
   - **`CloudflareStreamProvider` (premium)** — direct creator upload with `maxDurationSeconds` reservation and `requireSignedURLs`, allowed-origins sync from the domain module (platform wildcard + apex + every live custom hostname; updated on domain go-live/release), local token signing, webhook HMAC verification (`time + "." + body`, constant-time compare, 5-min replay window, idempotent by uid), status-poll fallback, static academy watermark profile (optional). Reports `drm: false` (D1) **and `boundToSession`/`boundToDevice` `false`** — its `accessRules` are `any/allow` and Cloudflare does not interpret Atlas's custom claims (AD-16, finding D-5).
   - **`BasicVideoProvider` (normal)** — R2 + Cloudflare CDN + an Atlas-controlled Worker gate validating an Atlas-minted token. Upload is a presigned PUT; readiness is **synchronous** (`reportsReadinessAsynchronously: false`) and finalised by the completion endpoint in §L, because there is no webhook. Duration is derived by Atlas, never taken from the client (§D.5). Reports `enforcesMaxDuration: false` — a presigned PUT cannot bound runtime minutes — and `adaptiveBitrate: false`.
   - **`FakeVideoProvider`** for local/tests; refuses to run under `NODE_ENV=production`.
   - Methods a synchronous adapter cannot honour (`verifyWebhookSignature`, `parseWebhookEvent`, `fetchAsset`, `syncAllowedOrigins`) are **capability-gated, never stubbed dishonestly**.
5. **Video storage quota (D5, AD-14)**: `videoStorageMinutes` in `PlanResourceLimits`, plan catalog baseline (basic 500 / growth 2,000 / enterprise 5,000 per DL-3, per-family values permitted per D5), `granted_limits` semantics, tenant usage (`videoStorageMinutes = ready video minutes + active reservations`); enforcement before issuing an upload URL (`usage + requested > quota` → `409 errors.entitlement.videoStorageMinutesExceeded` with used/quota/requested) and reconciliation when the real duration is known; usage exposed in the tenant usage endpoint; **no provider price anywhere in Atlas**.
   **Counted across every provider**, not one (AD-14). Normal-tier video does not additionally consume `videoStorage` (GB), so the tiers stay comparable.
   **Duration provenance**: Cloudflare measures it; R2 does not. Atlas resolves it (ranged `mvhd` parse, falling back to a worker probe) and records whether the figure was `measured`, `parsed` or `declared`. A declared duration is never silently trusted — that would make the quota self-reported.
6. **Playback and progress evidence**: `POST …/playback` heartbeats (position, watched seconds, max ratio) bounded to plausible deltas; `lesson_progress` evidence columns; resume position; lesson completion via watched-ratio rule or manual mark above the minimum; undo completion; `course_progress.time_spent_seconds`.
7. **Device and session policy (AD-10, D4)**: `atlas_device` cookie issued at sign-in; `student_devices` registry; `access_policies` (platform default 2 devices / 1 session; academy override by Client Owner within platform maximums; plan scope reserved); Redis lease `learning_lease:{userId}` (60 s TTL, heartbeat every 20 s); grant/refresh enforce the lease; `POST /learning/session/takeover` (inform → confirm → revoke previous lease and block its token refresh → activate → audit `DEVICE_SESSION_TAKEOVER` with learner, old device/session, new device/session, academy, course/lesson, timestamp); device list/removal; staff reset (owner).
8. **Learner dashboard aggregates**: `GET /learning/overview`, `/learning/assignments`, `/learning/quizzes`, global counts for My Courses; sessions list for the Devices section.
9. **Deterrents and watermark data** in grants; academy content-protection settings (owner only, D8).

### E. Frontend work
1. **Learner dashboard** `features/learner` under `/my/*`: shell (branded header, desktop side navigation, mobile bottom nav Overview/Courses/Assessments/Profile, breadcrumbs), Overview (continue learning, progress rings, due dates, recent results, certificates placeholder until Phase 3, announcements), My Courses (All/In progress/Completed with server counts, search), Course progress (outline with states and lock reasons), Assessments (Quizzes/Assignments lists), Certificates (empty state until Phase 3), Purchases (orders), Devices (registered devices, active sessions, remove/sign out elsewhere), Profile (no Organizations tab), Security; redirects from `/my-learning`, `/my-account` and `/dashboard/learning/*`; **dashboard learner routes removed** (D2) after redirects; notification templates updated.
2. **Unified player shell**: lessons, quizzes, assignments and live sessions render inside one shell (course title, back link, overall progress, curriculum drawer/sidebar, activity header with type/number/title/duration, content area, one action bar); one ordered sequence drives sidebar, Previous/Next and Continue; numbering "2.3" with locale digits; per-item states (locked with reason, available, in progress, completed, passed, failed, submitted, graded, overdue) with icons + text and `aria-current`; the six learner questions answered on every screen.
3. **Player content**: grant consumer with silent refresh — **mandatory, not an optimisation**, because a Normal-tier credential is shorter than a long lesson (§I); the protection badge renders the AD-16 capability object honestly, including saying plainly when playback is **not** device-bound (which, per finding D-5, is the *Premium* tier); video adapter driven by the grant's `format` discriminator — native `<video>` for the Normal tier's progressive MP4 (no new player dependency, Range/seek already works), hls.js on Chromium/Firefox and **native HLS on Safari/iOS** for Premium (iOS ManagedMediaSource makes hls.js on iPhone a trap; DASH is not used) with poster, loading skeleton, explicit error states (processing, expired grant, access ended, network), resume, playback rate, captions, keyboard shortcuts, `controlsList`/no-PiP/context-menu deterrents, per-viewer visible watermark overlay; text lessons with rich body, reading progress, resources panel; preview rail for non-enrolled visitors; lock cards; completion behaviours (inline confirmation, "Next: …", optional auto-advance, undo); external embeds labelled "not protected".
4. **Devices UX**: limit-reached dialog with device list; "already learning on another device" takeover dialog with explicit confirmation; lease-lost pause state (no progress loss).
5. **Staff UX**: video upload with progress and processing state, captions upload, thumbnail choice; quota meter and clear quota-exceeded message with upgrade path; lesson body editor with protected image upload; resources list; `is_preview` toggle; drip date; content-protection panel (owner only) and device policy settings (owner only); "protected/unprotected" badges.
6. Accessibility fixes carried from the audit: `role="progressbar"` everywhere, no nested interactive controls, live regions, captions track, reduced motion; RTL mirroring of drawer and chevrons; mobile bottom nav hidden inside the player.

### F. Database / schema / migration work
- `lesson_contents`, `lesson_resources`, `content_access_log` (retention 90 days), `student_devices`, `access_policies` (seed platform row 2/1), `media_assets` additions, `course_lessons` additions, `lesson_progress` evidence columns, `course_progress.time_spent_seconds`/`last_activity_at`, `refresh_tokens.device_id`, `academies.content_protection jsonb`, plan catalog `videoStorageMinutes` (limits JSON) with seed values and `granted_limits` compatibility.
- RLS: `lesson_contents`/`lesson_resources` select for active enrollment (via `can_access_lesson` definer resolving enrollment, unlock and preview), course instructor, academy manager/owner, platform owner — **no public policy**; `content_access_log` self/manager/platform; `student_devices` self + owner reset; `access_policies` owner/platform.
- **Amended 19 Sep 2026 (D10, AD-15):** `plans` gains `family` (`normal` | `premium`) and `tier` (`basic` | `growth` | `enterprise`) so the six commercial variants are modelled once rather than duplicated; `media_assets` gains `security_tier` (what Atlas promised for THIS asset) alongside `provider` (where the bytes are) and a duration-provenance column; `academies` gains the default upload tier, bounded by the plan entitlement; `content_access_log` gains `security_tier` and `provider` (§Q — Normal and Premium coexist in one academy, so the log must say which delivered).
- Backfill: copy public lesson objects to the protected bucket per academy under the flag (public copies deleted after 30 days); text descriptions copied into `lesson_contents.body_html`; external `contentUrl` rows become `kind: 'external'`. Existing plans are backfilled to `family: normal` with their current tier, and existing assets to the tier they were actually created under — **never to the academy's current plan** (D11).

### G. Authentication and authorization
Grant endpoint enforces the seven conditions; device cookie is a server-issued credential (no fingerprinting); takeover requires the learner's own confirmed request; device policy editable by Client Owner only (D8); content protection settings owner only (D8).

### H. Tenant isolation / RLS
Protected object keys prefixed by academy id and course id from verified context; Stream videos carry `meta.academyId`/`courseId` and the signer refuses cross-academy tokens; allowed origins limited to the academy's hosts; RLS spec creates published + public fixtures for `lesson_contents` and asserts zero rows without context, in a foreign tenant context and for a non-enrolled user.

### I. Security work
Closes S1, S2 (table), S3, S7 (evidence), S8 (devices); tokens never `downloadable`; `Cache-Control: private, no-store` on grant responses; CSP on academy hosts allows only the delivering host for the tier in use; `Referrer-Policy: no-referrer`; webhook HMAC; rate limits on grants and token refresh; audit for takeovers, device resets, policy changes.

**Amended 19 Sep 2026 — the honest tier difference (D1, AD-16).**

| | Normal | Premium |
|---|---|---|
| Credential lifetime | ≤ 10 min, refreshed | ≤ 2 h |
| Bound to session/device **at the edge** | **No** (corrected 19 Sep 2026 — see below) | **No** — `accessRules: any/allow`; Atlas enforces at grant-issue only (finding D-5) |
| Revocation before expiry | **Yes, per request** — only once the revocation list is wired, and reported from configuration rather than assumed. **Prompt, not instant**: bounded by denylist propagation (~1 min measured) plus the gate's cache, so no sub-second SLA may be promised | **No** — only by revoking a signing key, which invalidates every token minted with it |
| Adaptive bitrate | No (single 720p rendition) | Yes, managed |
| Encoding | Atlas | Provider, free |

**Correction, 19 Sep 2026.** An earlier version of this table claimed the Normal tier binds to session and device at the edge. It does not, and it cannot: the delivery host is an Atlas-owned hostname, cross-site from the academy the learner is signed in to, so no Atlas session reaches it. The gate verifies the token's signature, object key, expiry, request `Origin` and the revocation list — not who is presenting it. A Normal-tier token lifted from one browser plays in another until it expires or is revoked, which is **the same shape as finding D-5**. Asserting otherwise would have reproduced D-5 on the tier this plan presents as the stronger one. The capability is now reported `false` by the adapter and surfaced to the client (AD-16).

Neither tier has DRM. Neither may claim download- or screen-record-proofing, and **neither may claim edge-enforced session or device binding**. On revocation latency Normal remains the stronger of the two — a ten-minute credential plus a revocation list, against Stream's two hours and a key-wide kill switch — which is why the tiers are sold as *self-managed* versus *platform-managed* delivery and never as "less secure" versus "secure".

### J. Learner UX work
Everything in E.1–E.4 in EN and AR, desktop and 400 px width, keyboard-only operable.

### K. Staff/admin UX work
E.5; quota messaging; policy panels gated by role.

### L. API changes
`GET /learning/courses/:id/lessons/:lessonId/content` (its `protection` field is the capability object of AD-16, not a boolean), `POST …/playback`, `POST …/playback/refresh` (**mandatory for the Normal tier**, whose credential is shorter than a long lesson), `POST /academies/:id/media/video-uploads/:assetId/complete` (synchronous readiness, §D.4), `PATCH /academies/:id/video-tier` (owner-only, bounded by plan entitlement), `GET /learning/courses/:id/sequence`, `DELETE …/progress/complete-lesson/:lessonId` (undo), `GET /learning/overview`, `/learning/assignments`, `/learning/quizzes`, `GET /auth/devices`, `DELETE /auth/devices/:id`, `POST /learning/session/takeover`, `POST /academies/:id/media/protected`, `POST /academies/:id/media/video-uploads`, `POST /webhooks/video/stream`, `PATCH /academies/:id/content-protection` (owner), `PATCH /academies/:id/device-policy` (owner), tenant usage gains `videoStorageMinutes`; sections projection changes behind flag.

### M. Testing strategy
Unit (signer, policy resolution, lease, quota arithmetic, completion rule for lessons), e2e (grant matrix, quota, devices, playback), RLS (published+public), k6 load, frontend component tests, Playwright J1 (dashboard, player, video, progress, devices), axe.

**Amended 19 Sep 2026 (D10, D11, AD-15, AD-16)** — additionally required:
- all **six** plan variants (`NORMAL_*`, `PREMIUM_*`) resolve the right entitlements, tier and provider;
- tier resolution and provider resolution as separate, independently asserted steps;
- asset-level `provider` and asset-level `security_tier`, including that they can differ from the academy's current plan;
- **mixed Normal and Premium assets inside one academy** behave correctly (D11);
- quota enforced across both providers, with the two aggregates asserted to agree (AD-14);
- capability reporting: a Premium grant asserts `boundToDevice: false` (D-5) rather than inheriting an aspiration;
- **regressions for findings D-1 … D-5** specifically;
- Normal playback, Premium playback, token expiry, refresh, revocation;
- downgrade behaviour: **no silent provider migration** (D11);
- access-log tier/provider recording.

### N. Unit tests
Token claims and TTL clamps; session/device binding; allowed-origin list builder (wildcard caveats); webhook signature verification; quota check (`1,850+180 → reject`, `1,850+100 → allow`, reservation release on failed upload); lease semantics with fake Redis; policy resolution most-specific-first with platform maximums; watched-ratio completion; sequence ordering and lock-reason derivation.

### O. Integration tests
Grants for enrolled / locked / preview / revoked / expired / refunded / anonymous / suspended / unpublished course; sections contain no URLs; instructor and owner preview access; cross-academy token refused; third device refused; concurrent grant conflict and takeover with audit event; lease revoked on enrollment revocation; heartbeat bounds; undo completion; quota enforcement across `granted_limits` and plan limits; usage reconciliation from webhook; anonymous fetch of a protected key fails; overview/assessments aggregates scoped to the host academy.

### P. E2E tests (Playwright)
J1 (partial): academy login → learner dashboard every section (EN/AR, desktop/mobile) → course → player shell → lesson with grant → protected video plays → reload resumes position → mark complete/undo → next activity → devices page; J5 (revocation): refund → grants refused → lease revoked. Two-browser test: second device triggers conflict; takeover pauses the first.

### Q. Chrome browser validation
**Run for BOTH the Normal and Premium paths** (amended 19 Sep 2026). Learner dashboard on desktop and at 400 px in EN and AR; network panel shows no durable content URLs on either tier; video plays on the platform host and on a custom domain; manifest request from a foreign origin fails; expired grant refreshes silently; revoked enrollment shows "access ended"; third device refused; takeover flow with confirmation; staff: upload a video, watch processing → ready, quota meter, quota-exceeded message; preview lesson opens anonymously; dashboard learner routes redirect.

### R. Adversarial / security validation
Replay a presigned URL after revocation (expected to work until TTL; new grant refused); token for another academy's video (refused); grant flood from one learner (rate-limited, alert); forged webhook (rejected); attempt to fetch `lesson_contents` under foreign tenant context (zero rows); device cookie tampering (unknown device → re-registration under the cap).

### S. Migration requirements
Provider onboarding before the **Premium** tier is enabled anywhere: Stream enabled, signing key stored, webhook verified on staging, allowed origins synced, quota seeded. DRM is not available on Stream at all (D1), so nothing is pending on that question.

**Normal-tier Worker validation spike — required before the Normal architecture is declared production-ready (amended 19 Sep 2026).** The presigned-GET probe already run (206 on Range, 403 unsigned, 403 on a swapped key) validates the *presign* path and is explicitly **not** sufficient to prove the Worker path. The spike must empirically establish: per-request authorization; session binding; revocation before expiry; HLS/segment behaviour if HLS is used; caching behaviour; realistic concurrency; Worker request volume and cost at realistic segment counts; hotlink behaviour; failure behaviour; expiry behaviour.

Per-academy flags `content.protected`, `video.normal`, `video.premium`, `devices.policy`, `learner.dashboard_v2`, `player.v2`; protected-bucket backfill per academy; redirects for two releases before the dashboard learner routes are deleted.

### T. Rollout requirements
Canary on an internal academy, then the first customer academy that asked for protection, one week each; metrics in U watched; rollback = flag off (old projections and pages remain until flags are global); the previous image runs against the new schema. **Amended 19 Sep 2026:** the **Normal** tier can canary immediately (it depends on nothing new); the **Premium** tier waits for Stream onboarding. Rollback of a tier change costs nothing because existing assets keep their provider and tier (D11).

### U. Observability / metrics / logging
`content_grants_total{kind,result,tier}` and `video_token_mint_duration_ms{tier}` (labelled so the tiers are compared, not averaged); `video_upload_completions_total{tier,result}` (the synchronous path has no webhook to alert on); a duration-provenance counter (`measured`/`parsed`/`declared` — a rise in `declared` means the quota is drifting toward self-reported); grant-refresh rate per learner (the Normal tier's expected load, and the signal that reveals a TTL misconfiguration); per-student grant rate (p99 > 40/10 min → owner report); `video_token_mint_duration_ms` and provider errors (> 2 % alert); `video_processing_pending_age_s` (> 30 min alert); webhook signature failures (any → alert); `lease_conflicts_total`, `device_limit_hits_total`, takeovers per student per day (> 5 → sharing report); `video_storage_minutes_used{organization}` vs quota; readiness reports protected bucket, Stream config and Redis lease store; structured logs for every grant, refusal, takeover and policy change.

### V. Acceptance criteria
- [ ] No learner-facing response contains a durable URL to protected media; file URLs expire ≤ 10 min, video tokens ≤ 2 h and are bound to session and device.
- [ ] Locked lessons carry no content until unlocked; preview lessons open without enrollment.
- [ ] Every uploaded video requires a signed token; playback only from allowed origins; no video byte passes through the VPS.
- [ ] `videoStorageMinutes` enforced per D5 with clear messaging, counted across **every** provider; no provider price in the codebase.
- [ ] **No learner-facing response overstates the protection actually enforced** (AD-16) — in particular a Premium grant reports `boundToDevice: false`.
- [ ] All **six** plan variants resolve the correct entitlements, security tier and provider; `premium` is nowhere hard-wired to a provider class in the authorization layer (D10).
- [ ] `media_assets.provider` records the **acting** adapter and `security_tier` records what was promised; neither is derived from the academy's current plan (AD-15, D11).
- [ ] Mixed Normal and Premium assets coexist correctly in one academy, and a downgrade migrates **nothing** (D11).
- [ ] `content_access_log` records the security tier and provider for every decision.
- [ ] Findings D-1 … D-5 each have a regression test.
- [ ] Device defaults (2/1) enforced and changeable via `access_policies`; takeover requires confirmation and writes `DEVICE_SESSION_TAKEOVER`.
- [ ] Learner dashboard sections exist with real data; dashboard learner routes removed (redirects in place); axe clean; EN/AR parity.
- [ ] Unified player: quizzes and assignments render in the shell and participate in Next/Previous; lock reasons shown; watched-ratio completion works; resume works after reload.
- [ ] RLS: zero `lesson_contents` rows without context, in a foreign tenant and for a non-enrolled user, with published+public fixtures.
- [ ] All tests green; Playwright J1 (partial) and J5 green; browser validation recorded.

### W. Definition of DONE
All boxes checked; flags enabled on the canary academies with metrics reviewed for one week each; feature branch pushed and a pull request opened against `main`; the CodeRabbit review cycle completed with every actionable finding fixed or explicitly justified; required CI checks green; pull request merged; production deployment succeeded; only this phase's migrations applied and verified; **real Chrome production validation performed against the live academy website** with evidence captured; Phase Completion Record filled in the extended format; Document Status updated. **Then proceed directly to Phase 3** — no further phase-start approval is sought (DL-15).

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
All boxes checked; canary rollout reviewed; feature branch pushed and a pull request opened against `main`; the CodeRabbit review cycle completed with every actionable finding fixed or explicitly justified; required CI checks green; pull request merged; production deployment succeeded; only this phase's migrations applied and verified; **real Chrome production validation performed against the live academy website** with evidence captured; Phase Completion Record filled in the extended format; Document Status updated. **Then proceed directly to Phase 4** — no further phase-start approval is sought (DL-15).

---

# Phase 4 — Catalog, Preview, Checkout, Observability, Hardening and Production Rollout

**Status:** IN PROGRESS (authorized 23 Sep 2026 per DL-40, despite two open Phase 3 blockers that remain recorded and NOT resolved: Quiz B/C/D learner-session Chrome check, and Issue E hosted-video E2E). Workflow: DL-39 direct-to-`main` (fix → test → commit → push `main` → deploy → verify), NOT the PR/CodeRabbit flow in this section's older Definition of DONE. Phase 4 core proceeds now; the §T video-flag rollout and the full learner-journey Chrome/Playwright step stay gated on the two blockers' infra/credential dependencies.
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
Enable all remaining P64 flags globally in the order: `learner.dashboard_v2` → `player.v2` → `content.protected` → `video.normal` → `video.premium` → `devices.policy` → `quiz.engine_v2` → `certificates` → `checkout.student` → `catalog.v2`; one production verification per flag; owner communication; `--rollback` path re-tested before the global switch.

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
All boxes checked; feature branch pushed and a pull request opened against `main`; the CodeRabbit review cycle completed with every actionable finding fixed or explicitly justified; required CI checks green; pull request merged; production deployment succeeded; only this phase's migrations applied and verified; **real Chrome production validation performed against the live academy website** with evidence captured; Phase Completion Record filled in the extended format; Document Status updated; Document Status set to Complete with the final deploy SHAs; open items moved to the Decision Log or a new initiative. **Then, without stopping:** the Final Master Plan Audit, the final repository-wide CodeRabbit review, and the Final Report — and only then stop.

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

Phase 1 ships directly after tests and production read-only verification (surface enforcement staged by allowlist). Phases 2 and 3 ship behind flags to an internal academy, then one customer academy, one week each, then globally in Phase 4 in the listed order with a verification per flag. Provider onboarding for the **Premium** tier only (Stream account, signing key, webhook secret, allowed origins, quota seed) — the Normal tier depends on nothing new and canaries first (D10, DL-19); the Normal Worker validation spike (DL-22) gates its production readiness precedes any `video.premium` enablement (the `video.normal` tier needs no provider onboarding). Communication to staff before Phase 1 (sign-in rule, Students tab, review permissions) and before Phase 2 (protected content, preview, quota). Rollback is always flag-off; migrations are never reverted.

### Deployment-path blocker (found 19 Sep 2026 at the final authorization checkpoint)

Phase 1 was authorised for production and **was not deployed**, because the delivery path cannot execute the sequence below in the order it requires. Recorded as fact, with no change made to any pipeline.

**Root cause.** A push to `main` in `atlas-backend` triggers `.github/workflows/deploy.yml` with no approval gate. That workflow SSHes to the VPS and runs `deploy/deploy.sh`, which runs `npx prisma migrate deploy` against the production database. Pushing therefore *is* migrating. Steps 1–3 of the sequence — restore point, duplicate-attempt count, open-attempt count — all have to precede the migration, and the path offers no point at which they can run. It also offers no way to express the low-traffic window that step 3's numbers are meant to inform.

**Contributing facts, each verified in the repository:**

- `deploy/deploy.sh` never invokes `deploy/backup.sh` (grep count: 0). The backup runs only on its own systemd timer, so no snapshot is tied to a deployment.
- `deploy/backup.sh` verifies a dump only by size (`> 1024` bytes). It never checks gzip integrity, schema presence or restorability, so it does not by itself satisfy "backup restore/readability confirmation".
- Rollback is code-only and correctly so: `deploy.sh --rollback` re-pins the last-good image digests. Migrations are never reverted. The Phase 1 migration rewrites learner-visible data — renumbering `quiz_attempts.attempt_number` and closing stale in-progress attempts as failed with score 0 — and that has no undo without restoring a backup nothing has taken.
- Production is unreachable from the implementation environment: `DEPLOY_HOST`, `DEPLOY_USER` and `DEPLOY_SSH_KEY` are GitHub Actions secrets, and the local `DATABASE_URL` points only at the local database.
- Separately, the CI lint job has been red on `main` since before Phase 7 and `deploy.yml` is deliberately un-gated from it. Phase 1 adds none of those failures: all 113 remaining lint errors are in 17 files, **none** of which Phase 1 modifies or adds.

**Conclusion (as assessed on 19 Sep 2026, now RESOLVED).** The automatic "push to `main` = deploy = migrate" model was incompatible with the approved Phase 1 safety sequence, and Phase 1 could not be DONE until a production backup was taken and verified, the approved migrations applied, both services deployed, and production verification recorded. **All four have since happened** — see the Phase 1 completion record. This section is retained as the history of the blocker and the reasoning behind the migration gate, not as a current state.

**Blocker patch — since merged and live** (PR #1 as `b9ef0e5`, plus the backup-prune fix `7672ee3` found by the first real preflight). As implemented on 19 Sep 2026: Three delivery files changed, no application or database code touched: `deploy/deploy.sh` (argument loop, `--preflight`, `--with-migrations`, and a migration gate that takes a verified backup and records the pre-migration counts before any schema change), `deploy/backup.sh` (gzip integrity, pg_dump completion marker, and presence of the tables the migration rewrites), and `.github/workflows/deploy.yml` (a `workflow_dispatch` input plus an `approve-migrations` job naming a protected environment). Migration now requires BOTH an explicit flag and a protected-environment approval; a push that carries pending migrations aborts before touching the schema, and a push that carries none behaves exactly as before. The gate is inert until the repository defines a `production-migrations` environment with at least one required reviewer.

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

### Superseded decisions — preserved, not deleted

| ID | Superseded text | Superseded by | Date |
|---|---|---|---|
| DL-16 | **D1 (original):** *"Use Cloudflare Stream with mandatory signed tokens … and a provider abstraction with capability flags."* and **AD-7 (original):** *"`CloudflareStreamProvider` as the only production implementation."* Both assumed exactly one production video provider. | D1/D10 as amended, AD-7 as amended. Superseded by `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md`, approved 19 Sep 2026. The original reasoning remains valid **for the Premium tier**; what changed is that it is no longer the only tier. | 19 Sep 2026 |
| DL-17 | **D5 naming note (original):** mapped the approved quotas onto the seeded tiers `Starter`/`Growth`/`Enterprise`. | D10's tier vocabulary renames the first tier `basic` in the product model; the seeded key `starter` is unchanged in the database. Values are unaffected. | 19 Sep 2026 |


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
| DL-15 | 2026-09-19 | **Execution model changed to autonomous sequential.** Phases 2, 3 and 4 are approved together; the implementer runs them back to back and no longer stops between phases for approval. Every quality gate is unchanged and in fact tightened: each phase must pass its acceptance criteria, a CodeRabbit review loop, a merged pull request, a successful deployment, its own migrations only, and real Chrome production validation before the next phase begins. Stopping is reserved for the six blocker conditions in the workflow section. Phase 4 is followed by a Final Master Plan Audit, a final repository-wide review and the Final Report. No technical scope, acceptance criterion, security requirement, D1–D9 decision or AD-1–AD-14 architecture decision was changed by this. | Approved (owner) |
| DL-13 | 2026-09-19 | `surface.enforce` is ROLLOUT control, never a boundary. `ManagementSurfaceGuard` and every RLS policy run in all three modes; `off` restores the pre-P64 surface behaviour and grants nothing RLS or another guard would refuse. Default `on`, so an unset or unreadable variable can never be the reason a learner reaches the management surface, and an invalid value fails startup. | Taken (implementation) |
| DL-14 | 2026-09-19 | Playwright journeys run against the real stack and the repository's own seed, with the learner created fresh through the academy website each run. Learner addresses use Atlas's own platform domain: the dev API runs the real deliverability check, which correctly refuses `@atlas.test` (no DNS) and `@example.com` (RFC 7505 null MX). | Taken (implementation) |
| DL-18 | 2026-09-19 | **Two plan families approved (D10).** `normal` and `premium`, each with `basic`/`growth`/`enterprise` — six commercial variants. Family decides the video security capability class; tier decides commercial limits. Prices are catalog data and never appear in provider or authorization logic. Resolution is plan → entitlement → security tier → provider registry → provider; `premium` is never hard-wired to a provider class. | Approved (owner) |
| DL-19 | 2026-09-19 | **Normal tier = R2 + Cloudflare CDN + Atlas-controlled Worker gate**, progressive MP4, single 720p rendition, **no ABR initially** — deliberately, to avoid inheriting the transcoding/ABR burden. Premium keeps Cloudflare Stream's managed ABR pipeline. | Approved (owner) |
| DL-20 | 2026-09-19 | **No automatic Premium → Normal migration (D11).** Existing Premium assets stay on their provider and tier; new uploads use the newly entitled tier; mixed state in one academy is valid and expected; nothing is silently migrated or destructively converted. Not promised until provider capabilities are verified and a dedicated workflow is designed. | Approved (owner) |
| DL-21 | 2026-09-19 | **Finding D-5 recorded as binding (AD-16).** Cloudflare Stream mints `accessRules: any/allow` and does not interpret Atlas's custom JWT claims, so Premium session/device binding is enforced at grant-issue time only, not at the Stream edge. The API must report actual enforced capabilities; a security property is never advertised because an identifier exists inside a JWT. | Approved (owner) |
| DL-22 | 2026-09-19 | **Normal-tier Worker validation spike is mandatory** before the Normal architecture is production-ready. The presigned-GET probe already run is explicitly insufficient to prove the Worker path. | Approved (owner) |
| DL-22b | 2026-09-19 | **DL-22 discharged — the Normal-tier Worker spike passed.** Recorded in `ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md`. Revocation proved by a control experiment: a gate token with ~600 s of life left returned `403 revoked` after one denylist write, while a presigned URL for the same object kept returning `206` — which is the entire argument for the gate over a presign. Range/seek, tamper, key-swap, expiry, concurrency (50 concurrent ranged reads, 0 errors) and fail-closed behaviour all verified locally against the real Worker module. Three qualifications recorded: revocation is PROMPT not instant (KV propagation ~1 min plus cache); "bound to session" means the session is nameable and revocable, **not** proof-of-possession — a lifted token still plays, confirming the `boundToSession: false` correction; and HLS would need a prefix claim in the token, which progressive MP4 (DL-19) does not. CDN caching, Worker CPU and real pricing remain UNVERIFIED pending a real deployment. | Approved (evidence recorded) |
| DL-23 | 2026-09-19 | **Cloudflare CDN terms** require video served through the Cloudflare proxy to be hosted on a Cloudflare service (R2 named as sanctioned). This eliminates VPS-disk-behind-Cloudflare on licensing grounds — independently of AD-1, which already forbade it — and eliminates Backblaze B2 + Cloudflare. Recorded so the option is not revisited. | Recorded (investigation evidence) |
| DL-24 | 2026-09-19 | **Open — owner decision required.** Whether Normal and Premium variants of the same tier carry different `videoStorageMinutes` values, and whether Normal is metered in minutes or gigabytes. D5 requires the mechanism to support per-variant values; the baseline 500/2,000/5,000 stands until the catalog says otherwise. | **Open — not blocking** |
| DL-12 | 2026-09-18 | `POST /auth/register` still answers `409 errors.auth.emailAlreadyRegistered`, which lets an anonymous caller test whether an address has an Atlas account. Pre-existing and now reachable on every academy sign-up page. Changing it means emailing the existing account instead of answering — a product decision, not an implementation one. | **Open — owner decision required** |
| DL-25 | 2026-09-22 | **A submit that arrives after the deadline, inside the 30 s grace window, is recorded as auto-submitted for reason `timeout`.** It is what the client sends when its countdown reaches zero; the server's clock says time ran out, so the outcome is the same as the deadline job's, and the results screen can say "Time ran out. Your answers were submitted automatically." whichever side finalised the attempt. Found by Playwright J1 against the real stack. | Implemented (PR #9) |
| DL-26 | 2026-09-22 | **`quiz.engine_v2` off keeps today's semantics exactly:** no deadline, no autosave revision checks, every question must be answered on submit, no integrity events, no results projection beyond score/pass. On, the attempt carries a settings snapshot, a seeded order, a deadline and the disclosure matrix. Rollback is the flag. | Implemented |
| DL-27 | 2026-09-22 | **Certificate download links are minted per request** (`CERTIFICATE_LINK_TTL_SECONDS`, default and maximum 3600 s) and never stored; the learner's Download button fetches a fresh link on click and says until when it is valid. The PDF lives in the protected bucket; there is no public URL. | Implemented |
| DL-28 | 2026-09-22 | **Account deletion anonymises certificates rather than deleting them:** the snapshot's learner name becomes "Deleted account" / «حساب محذوف», `anonymizedAt` is recorded, the PDF is re-rendered by the queue, and serial, code, score and status are untouched — verification keeps answering truthfully for a credential the academy issued. | Implemented |
| DL-29 | 2026-09-22 | **Phase 3 code must not reach production before its migrations.** Prisma selects every model column, so the widened `courses`, `quizzes`, `quiz_attempts`, `assignments` and `assignment_submissions` tables would 500 on every read until `20261011000000`–`000400` exist. The push-triggered Deploy run `35724009923` (code only, by design since the Phase 1 blocker patch) was **cancelled** by the implementer; the owner runs `deploy.yml` with `apply_migrations=true` and approves `production-migrations` (the `migrate-and-deploy` job), then the frontend PRs merge in order #4 → #5. | **Open — owner action required** |
| DL-30 | 2026-09-22 | **The backend CI workflow was found `disabled_manually`** (every run since 18 Sep had died at the MinIO step: Docker Hub no longer serves `minio/minio`). Re-enabled; image moved to quay.io; pre-existing prettier drift reformatted; the e2e suites now run in CI again and revealed pre-existing failures on `main`: the plan-catalog / checkout suites read a seeded catalog CI never seeded (seed step added, PR #9, which also made `p63-domain-operations` pass). **Four CI-only failures remain** after the seed step and the raised transaction limits: `media` and `p53-support-attachments` (oversized upload answers 500 on the runner, 413 locally) and `p62-entitlement-concurrency` and `phase10-1-trial-abuse` (connection-pool timeouts under concurrent creation on the runner). All four pass locally; none touch Phase 3 code. | Partly implemented — four CI-only failures remain |
| DL-31 | 2026-09-22 | **CodeRabbit reviews at most 100 files per PR** and, on the backend organisation, reported insufficient usage credits. The Phase 3 change sets were split (backend: CI/format PR #8 + phase PR #7 stacked; frontend: foundation #4 + screens #5 stacked). Reviews that the service refuses to run are recorded as such in the phase record, never claimed. | Recorded — owner-side (credits) |
| DL-32 | 2026-09-22 | **Integrity copy says "recorded" and "reported", never "prevented".** Nothing is blocked client-side; tab switches, focus loss, fullscreen exits, clipboard and print events are recorded with client and server timestamps, the server applies warm-up, debounce and thresholds, `warn` tells the learner the count, `strict` auto-submits at the limit, `monitor` is silent to the learner. A refused fullscreen request is an event, not a wall. | Implemented |
| DL-33 | 2026-09-22 | **The legacy quiz and assignment pages are retired.** Every attempt renders inside the unified player at `/my/courses/:courseId/activities/:itemId`; `/my-learning/courses/:id/quizzes|assignments/:id` and the dashboard-era URLs redirect there with the ids carried across. | Implemented (frontend PR #5) |
| DL-34 | 2026-09-22 | **The gated production migration was approved by the implementer's own GitHub identity.** The owner instructed (in writing, same day) that the Claude Code permission configuration be extended so `gh api … pending_deployments` could approve the `production-migrations` environment, refusing to approve it manually; the environment's required reviewer is `zeyadelbadawi`, which is that identity, so no protection, reviewer rule or repository setting was changed or bypassed. Permission rules for `gh run/pr/workflow/variable`, `git`, `curl` against the production API and the Chrome tools were added to the user's Claude Code settings for the same reason. DL-29 is closed by run `35749157369`. | Done |
| DL-35 | 2026-09-22 | **Rollout flags are synced from GitHub repository variables through the existing deploy** (`deploy.sh --sync-env`, the base64 fragment the `vps-deploy` action already used): only `FLAG_[A-Z0-9_]+` keys with `[A-Za-z0-9_,-]+` values are accepted, both deploy jobs pass them, and an empty variable leaves the server value untouched. No new deployment mechanism; the canary (§T) is `allowlist` + the validation academy's id for the three Phase 3 flags. Phase 4 decides the wider rollout order. | Implemented (PR #10) |
| DL-36 | 2026-09-22 | **Two-segment custom BullMQ job ids containing `:` are refused by BullMQ 5.x** (`Custom Id cannot contain :`, unless the id has exactly three segments). `quiz-deadline:<attemptId>` and `certificate-anonymize:<userId>` were therefore never enqueued; the producers' best-effort catches logged warnings nobody read, and no test drove a job through the real worker. Found on production. Fixed with colon-free ids, the overdue-attempt sweep wired into the ten-minute maintenance job (it had no caller), error-level logging on scheduling failure, and e2e tests through the worker for the deadline job, the sweep and the anonymisation. Rule going forward: every custom job id is a unit-tested constant without `:`. | Fix branch (PR #11) |
| DL-37 | 2026-09-22 | **Learner-session Chrome journeys were not driven by the implementer on production.** The browser tooling refuses to inject session tokens and the implementer must not type passwords; a learner session on the academy site is therefore only obtainable by a person. Every server behaviour behind those journeys was verified on production through the API exactly as the frontend calls it, every public surface was verified in Chrome, and the UI journeys themselves are LOCAL VERIFIED by Playwright J1/J4. The record labels them NOT VERIFIED in Chrome rather than claiming otherwise; the owner can complete them by signing in as the disposable learner. | Recorded |
| DL-38 | 2026-09-22 | **Disposable production fixtures** created for the validation (all named "TEMPORARY … (disposable)"): QA owner `p3qa.1790097390@…`, organisation `53aa6b05…` with academy `60037b11…` (`p3-validation`), its course/quiz/assignment, learner `p3learner.1790098085@…`, instructor `p3instr.…`, a second owner `p3qa2.…` with organisation `a2b05c32…` and academy `4d04b689…` (`p3-isolation`) for the cross-academy checks, and one accidental organisation `87a06dcf…` created from the Platform Owner form. They are archived once the fix PRs are re-verified (attempt `a7b17e99…` is kept `in_progress` until the deployed sweep finalises it). | Open — archive after re-verification |
| DL-39 | 2026-09-22 | **PR / CodeRabbit workflow dropped for the remaining Phase 3 work** (owner instruction, evening of 22 Sep): the organisation's CodeRabbit credits are exhausted and the owner does not want review ceremony. From here: fix locally → run the relevant tests → commit → push directly to `main` → let the normal deploy run → verify production → repeat. No feature branches, no pull requests, no review waits, no confirmation requests. Every security, migration, testing and production-safety rule stays; protected GitHub/environment controls are never bypassed; CodeRabbit is recorded as unavailable, never as a clean review. Phase 4 and the certificate redesign wait until Phase 3 is genuinely complete. | Recorded — governs the rest of Phase 3 |
| DL-40 | 2026-09-23 | **Phase 4 explicitly authorized to START despite two open pre-Phase-4 stabilization / Phase 3 blockers** (owner instruction, 23 Sep). Phase 3 is **NOT** closed and these two blockers are **not** deleted, hidden, downgraded or reinterpreted (see the "Pre-Phase-4 Stabilization — SECOND PASS" record): **(1) Quiz B/C/D** — the `quizEngineV2`/`quizIntegrity` flags are now `on` and synced to production and the engine is e2e-verified (32 assessment tests) + Phase-3 canary real-attempt evidence + owner-config real-browser-verified, but the **non-canary real learner-session Chrome check** (a learner watching the countdown / triggering integrity) is blocked because the learner portal is a separate origin needing a password sign-in, which the safety rules forbid me to perform (a person must). Confirmed 23 Sep: owner self-enrol returns 403, so owner-as-learner is not a substitute. **(2) Issue E hosted-video E2E** — root cause understood (a frontend gap: the dashboard uses the base64 media path which rejects video, while the backend R2/Stream direct-upload flow exists but is never called; a Growth trial IS entitled to the normal tier; backend 500→`videoNotEnabled` mapping bug fixed and deployed), but genuine production end-to-end verification needs the video infrastructure that is not set: `FLAG_VIDEO_NORMAL_MODE` (+ `FLAG_VIDEO_NORMAL_ACADEMY_IDS` or `on`) and the provider delivery config `BASIC_VIDEO_DELIVERY_HOST` + `BASIC_VIDEO_SIGNING_SECRET`. **Relationship to Phase 4:** the Phase 4 CORE (catalog, course details, preview, checkout, reviews/recommendations, hardening, observability) does **not** hard-depend on either blocker and proceeds now; the parts that DO depend on them stay gated — §T's `video.normal`/`video.premium` global rollout waits on blocker (2)'s infra, and the full-journey Playwright J1 / production learner-journey Chrome step (which includes a learner taking a timed quiz and playing protected video) inherits blocker (1)'s learner-session constraint and blocker (2)'s video infra. Phase 4 is therefore run to completion on the independent scope; the two dependent rollout/verification steps remain explicitly open until the owner clears the blockers. All Phase 4 quality gates (production engineering standard, RLS/tenancy, tests, migrations via the approved workflow, real-Chrome verification of what is reachable) stay in force. | Approved (owner) — Phase 4 authorized; Phase 3 remains open |
| DL-41 | 2026-09-23 | **Multi-agent orchestration for the remaining Phase 4 work** (owner instruction). The lead session is the SINGLE orchestration, integration and deployment authority; sub-agents are isolated implementation workers only. Mechanics: each worker runs in its own git worktree on its own branch (backend `p4-obs-retention`, frontend `p4-catalog`) with the toolchain symlinked, a lead-defined file-ownership scope, and hard prohibitions — no push, no `gh`, no deploy, no migrations/schema, no auth/RLS/guard/tenancy/security changes, no Master Plan edits, no dependency changes, no unrelated refactors; anything outside scope is reported, not done. Decomposition chosen for zero cross-stream file overlap: Wave 1 = (a) backend observability metrics + `quiz_attempt_events` retention (extends the EXISTING metrics service and maintenance sweep — `content_access_log` retention and the `/metrics` infra already existed), (b) frontend public catalog section; the lead keeps the security-critical **owner reports** backend (RLS-sensitive) and all integration. Every worker result is audited by the lead (diff, ownership, tests, typecheck, security/RLS/tenancy impact) before anything reaches `main`; worker summaries are not evidence. Two-agent Wave 1 (not more) was a deliberate safety choice after the earlier rogue-fork incident; wider parallelism is reassessed after each integrated increment. | Approved (owner) — orchestration mode; lead is sole integrator/deployer |
| DL-42 | 2026-09-24 | **Production product audit (owner-directed) — "backend capability is not product completion".** The owner opened the live academy site and found `/courses` basic. Audited in real Chrome against production with the available Client Owner session (org "German Lectrue", academy `ssfsdf3232`, site `https://ssfsdf3232.atlass.dpdns.org/`) and anonymous visits. **Root cause of `/courses`:** every academy's `courses` core page is seeded with one `featuredCourses{mode:'latest'}` section (`shared-support-pages.template.ts`); the Phase 4 `courseCatalog` section shipped as an opt-in builder block that no site ever received, and minimal-mode sites had an EMPTY Courses page. The page did call the new catalog API (`/courses?page=1&pageSize=9`) but through the featured block, which renders none of the new metadata. Classification: implemented in the Website Builder but not on `/courses` — a real Phase 4 gap against §E.1. **Fix:** template seeds `courseCatalog`; data migration `20261012000003` upgrades untouched seeded/empty Courses pages, leaves customised pages alone; list contract gains duration/preview/rating aggregates; cards upgraded. **Flags:** the plan's `catalog.v2`/`checkout.student` flags were never created, and the frontend has no dynamic flag contract at all (`PlatformProvider` documents this) — Phase 4 UI is ungated by construction. Decision: not retro-fitting flags for surfaces that are now production-verified; §S/§T's flag steps for these two are recorded as a deviation, not pending work. **Platform Owner IA:** checkout/approval/refusal/retention metrics existed only as Prometheus series; a video card on the dashboard was the sole UI. Decision: dedicated Analytics tabs (Commerce, Content delivery) with counts-only endpoints; the dashboard keeps a summary. **Limits recorded honestly:** no Platform Owner or learner session exists in the browser and passwords may not be typed, so Platform Owner pages and `/my/*` were audited from code + local real-Chrome journeys, not production. | Approved (owner instruction) — audit findings and fixes recorded here; evidence in the Phase 4 record |

## Implementation Change Log

| Date | Phase | Change | Author | Notes |
|---|---|---|---|---|
| 2026-09-18 | — | Master plan created from proposal v2 and the nine approved decisions. No code, schema, migration or production changes. | Claude (planning) | Historical: awaiting implementation approval *at that date*. Superseded by DL-15. |
| 2026-09-19 | 2 | **Master Plan amended for the two-plan-family video model** (D1, D5, D10, D11, AD-1, AD-7, AD-14, AD-15, AD-16; Phase 2 §C, D.4, D.5, E.3, F, I, L, M, Q, S, T, U, V). Base was `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md`'s §20 amendment set, extended with the owner's six-variant plan model. Superseded text preserved as DL-16/DL-17 rather than deleted. Documentation only — no code changed by this entry. | Claude (planning) | Phase 2 implementation continues from the preserved working tree. |
| 2026-09-18 | 1 | Phase 1 implemented in full: critical fixes, derived principal model, surface-aware authentication, management-surface protection on 51 controllers, registration integrity, enrollment lifecycle, student roster, RBAC realignment, RLS tiers, frontend, 7 migrations, seed alignment. | Claude (implementation) | Local only. Nothing committed, pushed or deployed. |
| 2026-09-19 | 1 | Readiness checkpoint closed the two remaining gaps: the Playwright project with journeys J2 and J3 (18 tests, real stack), and the `surface.enforce` staged-rollout flag with its own e2e matrix (6 tests) and unit coverage. | Claude (implementation) | Local only. Still nothing committed, pushed or deployed. |
| 2026-09-19 | 1 | **Phase 1 delivered to production.** Backend PR #2 merged as `0b884e7`, frontend PR #1 merged as `92f80bc`; backend deployed at `7672ee3`, frontend at `92f80bc`; the eight Phase 1 migrations applied under environment approval after a verified backup, taking production from 95 to 103; real Chrome validation passed on the live `ghg` academy with two staff-UI checks blocked on credentials. | Claude (implementation) | See the Phase 1 record. |
| 2026-09-19 | — | **Execution model changed to autonomous sequential (DL-15).** Workflow section rewritten; the three "STOP before the next phase" clauses replaced; Document Status and Phase 1 transition language reconciled; extended Phase Completion Record format, Final Master Plan Audit, final repository-wide review and Final Report sections added. No technical scope, acceptance criterion, security requirement, D-decision or AD-decision changed. | Claude (planning) | Documentation only — no code, migration or deployment. |
| 2026-09-19 | 1 | A performance regression introduced by B1's fix was found by the journeys and corrected in `20261008000700`; a pre-existing missing translation (B6) was fixed; `PrincipalResolverService` now resolves in one transaction instead of three round trips. | Claude (implementation) | See findings B5, B6 and observation O3. |
| 2026-09-18 | 1 | Four defects found by real Chrome validation fixed after the first green test run: learner enrollment list 500 on a non-public course; roster counting an expired enrollment as active; block leaving the learner's sessions alive; My Learning offering an action the backend refuses. Six new e2e regressions plus nine frontend unit tests added. | Claude (implementation) | See Phase 1 record. |
| 2026-09-22 | — | **Lesson content states and YouTube inside the unified player (pre-Phase-3 baseline).** `LessonContentService` raises `noContent` / `processing` (new `ContentAccessReason` values, free-text log column, no migration) only after entitlement, answered as 404 with `errors.learning.lessonNoContent` / `lessonProcessing`; `errors.notFound` unchanged for unreachable content. Grants for `external` lessons carry `externalEmbed` when `classifyExternalEmbed` vets a YouTube link (hosts allowlist, 11-char id); everything else stays a link-out. Frontend: unified player gains a YouTube source (iframe by vetted id, nocookie host, sandboxed) beside R2/Worker and Stream; no-content is a neutral empty state with an outline action; completion never claims watched time for YouTube. See `atlas-front/docs/learner/LEARNER_UX_BASELINE.md` §G. | Claude (implementation) | Code only, both repos. Production still has 6 lessons without content rows (authoring UI pending). |
| 2026-09-21 | — | **Search restored (P65, standalone, outside the P64 phases).** Migration `20261010000000_p65_search_vector_generated_columns` re-creates the four `search_vector` columns p44 dropped as STORED GENERATED tsvectors (weighted A/B/C) with GIN indexes, now ALSO modelled in `schema.prisma` (`Unsupported("tsvector")` + `@@index(type: Gin)`, `dbgenerated` default) so `prisma migrate diff` is clean and the p44 drop cannot recur. Found while verifying: under FORCE RLS PostgreSQL never uses a GIN index for `@@` (not LEAKPROOF) — the original P17 design seq-scanned the RLS tables (1.3 s at 300k courses). Added `search_{courses,academies,organizations}_candidates` SECURITY DEFINER functions (caller re-verified, scope explicit, ≤50 ids) with the projection still read under RLS: 9 ms at 300k courses. `SearchRepository`/`SearchService` updated; search e2e 17 → 25 tests. Production confirmed missing the columns since 13 Sep 2026. | Claude (implementation) | Branch `fix/p44-search-vector-restore`. Needs the gated migration deploy. |
| 2026-09-22 | 3 | **Phase 3 backend implemented and merged to `main`** (merge `a0c31aa`: PR #7 `feat/p64-phase3` → `chore/ci-green`, then PR #8 → `main`, both merged by the owner). Quiz engine v2, integrity layer, assignments with drafts/late policy/protected attachments, completion rules, certificates (templates, serials, verification codes, immutable snapshot, pdfkit render with vendored Noto Sans / Noto Sans Arabic, protected storage, one-hour links, public verification, revoke, versioned regeneration, manual issue, anonymisation). Five migrations `20261011000000`–`000400`, applied locally only. Flags `FLAG_QUIZ_ENGINE_V2_*`, `FLAG_QUIZ_INTEGRITY_*`, `FLAG_CERTIFICATES_*` (default off). **NOT deployed** — see DL-29. | Claude (Phase 3) | Unit 1307/1307; e2e 117/117 suites locally (95 in one run, 22 rerun after a jest heap exhaustion); Phase 3 suite 18 scenarios. |
| 2026-09-22 | 3 | **Follow-ups PR #9** (`fix/p64-phase3-followups`): first-keystroke draft save 500 fixed (Prisma `create` has no `disconnect`), grace-window submits recorded as `timeout` (DL-25), CI seeds the database before e2e. Both defects were found by Playwright J1 against the real stack. | Claude (Phase 3) | Must merge before or with the production migrate-and-deploy. |
| 2026-09-22 | 3 | **Phase 3 frontend on two stacked PRs** in `atlas`: #4 foundation (contracts, services, hooks, EN/AR copy incl. one sentence per backend message key, `apiErrorMessage`; legacy quiz/assignment paths → player) and #5 screens (in-player quiz intro/attempt/results with server-corrected countdown, autosave, integrity, disclosure; assignment draft/submit/timeline/grade; completion screen; learner certificates; `/verify/:code` on both hosts; quiz builder presets/settings/question types/preview; assignment late policy; course completion & certificate settings; reviewer attempt detail, manual grading, void, overrides, integrity CSV; academy certificates management and template; manual issue from the roster). Design review first: `docs/learner/P64_PHASE3_DESIGN_REVIEW.md`. Playwright J1 (6 steps) and J4 (3 steps) green against the local real stack. | Claude (Phase 3) | Frontend tsc/lint/build clean; vitest 640/640. Merge after the backend is migrated and deployed. |
| 2026-09-22 | — | **CI restored** (DL-30): workflow re-enabled, MinIO image from quay.io, prettier drift reformatted, seed step. Four pre-existing CI-only e2e failures remain (`media`/`p53` oversized → 500; `p62`/`phase10-1-trial-abuse` pool timeouts). | Claude (Phase 3) | Pre-existing on `main`; not Phase 3 code. |
| 2026-09-22 | 3 | **Phase 3 delivered to production.** Backend PR #9 merged (`111f0e3`); `migrate-and-deploy` run `35749157369` (verified backup `atlas-20260922T164606Z.sql.gz`, migrations 109 → 114, backend and Caddy healthy); frontend PRs #4, #5, #6 merged (`ad5a1b8`, deploy run `35757465316`); backend PR #10 (`f497ff1`) syncs the rollout flags from repository variables (DL-35) and the canary academy is enabled. | Claude (Phase 3) | Approval under DL-34. Production `GET /verify/:code` answers 200 where it answered 404 before. |
| 2026-09-22 | 3 | **Production validation on the canary academy** (API as the frontend calls it + real Chrome on the public surfaces; Phase 3 record): quiz lifecycle, autosave, timeout grading, integrity, disclosure, assignments, grading, completion, automatic issuance, signed download, verification on both hosts, revocation, retake immutability, attempt cap, cross-academy and role boundaries all VERIFIED. Eight findings recorded, six of them Phase 3 defects: the deadline and anonymisation jobs never enqueued (colon job ids, DL-36) and the sweep never called; a revoked certificate shown as "does not match"; an English heading on the Arabic verify page; dark status panels on a light academy page. | Claude (Phase 3) | Fix PRs backend #11 and frontend #8; learner-session Chrome journeys NOT VERIFIED by the implementer (DL-37). |
| 2026-09-22 | 3 | **Defects fixed and re-verified on production.** Frontend PR #8 (`3c5ee3d`, run `35765587586`): revoked banner, Arabic heading, light status panels, plus the theme-scoped chrome-free fallbacks CodeRabbit asked for. Backend PR #11 (`eb4aead`, run `35767638750`): colon-free job ids, sweep wired, error-level scheduling log, three e2e scenarios through the worker. Production: the delayed job finalised attempt `56eb6cc0…` 79 ms after `deadline + grace`; the sweep finalised the abandoned attempt `a7b17e99…` at 18:40:00Z. | Claude (Phase 3) | CodeRabbit ran on both PRs (5 findings, all fixed and confirmed) and is unavailable afterwards (DL-39). |
| 2026-09-22 | 3 | **Defect 9 — expired-attempt finalisation was rolled back with the 409** (`start`/`getSession`/`saveAnswers`/`submit`); fixed by committing before throwing, e2e strengthened (`b13c790`, pushed directly to `main` under DL-39, run `35769701786`). Fixtures archived except the canary academy and QA owner (kept for the flag allowlist and an optional owner-run learner Chrome pass); the deleted learner's certificate anonymised in production within a minute. **Phase 3 closed.** | Claude (Phase 3) | Phase 3 e2e 22/22, learning unit 151/151 locally; CI on `main` green except the four pre-existing CI-only e2e suites (DL-30). |
| 2026-09-23 | Pre-P4 | **Pre-Phase-4 stabilization, two passes** (owner-directed, 22–23 Sep). Manual authenticated testing after Phase 3 close found further learner-facing defects. Fixed at the root, deployed, and (where reachable) real-browser-verified: course-builder sequential-lock enforcement; builder→learner content bridge (YouTube); video-upload error copy; `/me` progress across the whole sequence; integrity reviewer transparency; extra-attempt override (one override-aware allowance across detail/list/results, focus refetch); certificate branding relative-media URL; certificate professional redesign; category keep-decision. Second pass added: certificate config-based readiness (Issue F, de-gated from the rollout allowlist), a professional certificate colour system + real-PDF live preview + Arabic bidi fix (Issue G), invitation email binding + creation trust (Security A), authenticated-learner auth-route guard (Security B), and the Issue E backend 500→`videoNotEnabled` mapping fix. Migrations `20260923021943_p4_certificate_palette` and `20261012000000_p64_invite_email_binding` applied via the owner-approved `production-migrations` run `35814031102`; quiz flags promoted to `on` by the owner and synced. **Two blockers remain open (DL-40): Quiz B/C/D learner-session Chrome check (credential-constrained) and Issue E hosted-video E2E (video infra).** | Claude (stabilization) | Backend through `26fc699`; frontend through `80cad90`. Real-Chrome verified: certificate editor colour system/presets, live preview = real PDF updating in real time, save/persist, contrast rejection, Issue F toggle. e2e: certificate/assessment 32/32, invitation 15, video spec 8/8, auth guard 14/14. |
| 2026-09-23 | 4 | **Phase 4 authorized to start (DL-40)** despite the two open Phase 3 blockers; both kept explicitly recorded. Phase 4 core (catalog, details/preview, checkout, reviews, observability, hardening) does not hard-depend on them; the §T video-flag rollout and the full learner-journey Chrome/Playwright step stay gated on the blockers' infra/credential dependencies. | Claude (Phase 4) | Documentation only in this entry; implementation follows under the DL-39 direct-to-main workflow. |
| 2026-09-23 | 4 | **Wave 1 of DL-41 integrated (lead-audited).** Backend: five Phase-4 metrics series, `quiz_attempt_events` 180-day retention, and a fix for the pre-existing no-context retention no-op (Phase 2's `content_access_log` sweep never pruned in production) via the platform-owner sweep precedent; `courseCatalog` accepted server-side field-for-field. Frontend: the Course Catalog website section registered across the whole section kit. Both worker branches were diffed, ownership-checked, and re-tested by the lead before merge; single push per repo. | Claude (lead) | Backend `9038733` (merge `16aeaeb`), push-deploy; frontend merge `d3258e5` (push sequenced after the backend schema deploy). Backend combined e2e 55/55 + unit 14/14 + schema spec 43/43; frontend 120/120, typecheck at baseline. |
| 2026-09-23 | 4 | **Owner reports backend delivered; orchestration mode adopted (DL-41).** `academies/:id/reports/integrity` + `.../sharing` — academy-scoped, two independent auth gates (service role check mirrors `can_manage_academy_students`; reads in tenant+user RLS context), bounded single-snapshot aggregation, no schema/RLS change; quota reuses the existing usage endpoint. Two isolated worker streams launched in parallel (backend metrics+retention; frontend catalog section), lead-audited before integration. | Claude (lead) | Backend `c31b9d1`, push-deploy. e2e 7/7 (real Postgres + RLS). Frontend reports page and the two worker streams pending lead audit/integration. |
| 2026-09-23 | 4 | **Phase 4 frontend — catalog/reviews surfaces delivered (atlas-front).** F1 course-details revamp (ratings/reviews/related + level/language/outcomes/requirements + shared StarRating, `be00694`); F2 dashboard catalog-metadata authoring (`27fa0ad`, prod-verified read-only on the owner dashboard); F3 learner review authoring (`fdc9480`); F4 review moderation dashboard (`46c8cd9`). Reviews feature complete end-to-end. Mandatory UI/UX skill applied; EN+AR/RTL; StarRating unit-tested. Each increment zero-new-`tsc`-errors over a pre-existing 34-error `atlas-front` baseline (unrelated platform-add-ons/zoom; builds via esbuild). | Claude (Phase 4 FE) | atlas-front `main` `80cad90`→`46c8cd9`, four push-deploys success. Prod-verified: dashboard "Catalog details" card (Arabic/RTL). Not browser-verifiable: public details (canary site unpublished; user's course not mutated) and signed-in review flows (learner-session constraint) — code/type/unit-verified, backend e2e-verified. |
| 2026-09-24 | 4 | **Playwright J5 + J6 journeys delivered, and they caught a real production defect.** J5 (3 tests): register on the academy website → buy → enrol on approval → protected grant for a file lesson → refund → next grant refused, held lease refused, player shows the blocked state. J6 (6 tests): anonymous catalog filter/search → details page (level, outcomes, requirements, no rating block without reviews) → learner review awaiting moderation → owner approval publishes it with its rating → paid checkout (method, proof, "submitted for review") → platform-owner approval enrols. **Defect found and fixed: student checkout was broken for every learner in production.** `CourseCheckoutPage` read payment methods from `GET /payment-methods`, which is behind `ManagementSurfaceGuard`; as a learner that is `403 managementSurfaceOnly`, so `enabledMethods` was always empty and the page showed "Not available for purchase yet" regardless of the academy's configuration. Fixed by adding the learner-surface route `GET /course-orders/:id/payment-methods` — self-scoped to the caller's own order (explicit `studentId` filter inside `runInUserContext`, so the service check and `course_orders` RLS agree independently) and filtered by the SAME `paymentCollectionMode` branch `createPayment` walks, so an offered method is always a payable one. No schema or RLS change. Two spec corrections were mine, not the worker's: J6 now returns to the public course page after enrolling (enrolling deliberately navigates the learner INTO the course) and scopes the approved-review assertion to the public list (the body legitimately appears twice once approved). | Claude (lead) | Backend `d4de52b` (run `35936192084` success); frontend `090d3a9` incl. merge `367d8a1` of `p4-playwright` (run `35936973512` success). Local real-stack Chrome: **J5 3/3, J6 6/6**. Backend e2e 6/6 new + course-commerce regression 41/41. Frontend typecheck at the 34-error baseline, learner suite 68/68. Prod-verified: new route 401-guarded (a nonexistent sibling returns 404, so the route is registered); shipped `CourseOrderService` chunk contains `getPaymentMethods`/`payment-methods`, and the `CourseCheckoutPage` chunk no longer contains `usePaymentMethods`. |
| 2026-09-24 | 4 | **Course preview delivered — the free sample, playable by an anonymous visitor.** The public curriculum now projects `CourseLesson.isPreview`, which the schema's own architecture note already designates public ("the lesson row stays publicly listable (title, order, duration, preview flag)") and which the content gate had always honoured via `getContent()`'s `isOpenPreview` short-circuit behind `OptionalJwtAuthGuard`. The marketing page acts on it: a labelled Preview control on preview lessons opens `CoursePreviewDialog`, which reuses `useLessonGrant` and the vetted-id YouTube player rather than growing weaker copies of either rule, and refuses to reuse `ProtectedVideoPlayer` because its watermark/resume/credential props are session concepts an anonymous visitor cannot honestly supply. No new access is granted: the content gate is untouched, and the 404-for-unreachable posture is asserted so the flag cannot become a catalogue-enumeration oracle. | Claude (lead) | Backend `94ae528` (+ `ecc6696` formatting), frontend `fe56fb5`; deploy runs `35957868282` and `35958426160` both success. e2e 5/5, component 6/6, **J6 7/7** and J5 3/3 in real Chrome, renderer 23/23, typecheck at the 34 baseline. Prod-verified: live curriculum returns `isPreview` on canary data; shipped bundle carries the dialog, its keys and the nocookie embed builder. |
| 2026-09-24 | 4 | **Pre-existing defect found and fixed: `createLesson` silently dropped four fields its own DTO declares.** `CreateCourseLessonDto` declares `videoAssetId`, `isPreview`, `availableAt` and `completionRule`; the create path wrote none of them. With `forbidNonWhitelisted` the fields are accepted, so the API answered 201 and discarded them — a lesson created as a free preview, with a video, a drip date or a watched-ratio rule came back looking correct and had none of it, and the author had to save a second time through `updateLesson` before any of it stuck. Found because a preview lesson created in one step was never previewable. The create path now mirrors the update path exactly, including the tenancy check before linking a video (an id alone proves nothing, so without it an author could attach another academy's video by guessing and the grant path would sign it because the lesson claims it), and the audit context names the video link and the preview flag as update's does. | Claude (lead) | Backend `389db4a`, run `35957868282` success. Curriculum e2e 10/10 (declared fields asserted on the stored row, since the response contract exposes only `isPreview`/`availableAt`; foreign-academy video refused 404 with no lesson created); unit-curriculum + courses + preview 24/24. |
| 2026-09-24 | 4 | **Accessibility: card titles can now carry the heading level their position needs.** `CardTitle` always emitted `h3`, so a page whose own title is an `h1` and whose cards are its top-level sections announced h1 then h3 (a skipped level), and a card containing `h3` subsections gave its title and its subsections the same rank — both real structure defects for anyone navigating by headings, not cosmetic ones. `as` sets the level without touching the look and defaults to `h3`, leaving all 77 call sites unchanged; the default was deliberately NOT moved to `h2`, because a card nested in an `h2` section is correct at `h3` and only the page knows where it sits. Applied to the learner checkout's six cards and the platform video card. `AcademyReportsPage` needed nothing — it composes `SectionCard`, which already renders `h2`. | Claude (lead) | Frontend `fc9f7e7`, run `35959476507` success. 4 contract tests + platform suite 48/48; J5 3/3 and J6 7/7 re-run green afterwards. Prod-verified in the shipped bundles: 6 `as:"h2"` in the checkout chunk, 1 in the platform dashboard chunk. |
| 2026-09-24 | 4 | **Production product audit → the Courses page IS the catalog (owner-reported, DL-42).** Root cause traced in production and code: every academy's `courses` core page carried the seeded `featuredCourses{latest}` block and the Phase 4 catalog only existed as an opt-in builder section. Fixed at every layer: (1) template seeds `courseCatalog` for new sites; (2) data migration `20261012000003` upgrades untouched seeded/empty Courses pages, leaves customised pages alone, proven on fixtures of the exact live shape; (3) the public list/detail contract gains batched `durationSeconds` / `hasPreview` / `averageRating` / `totalReviews` (published lessons, approved reviews only); (4) catalog cards show level, duration, lesson count, free-preview chip, rating (only when reviews exist), instructor, price, with shape-matched skeletons and equal-height grid. Also fixed the `/api/config` 404 issued on every page load. | Claude (lead) + worker `p4-catalog-cards` (lead-audited) | Backend `642ca58`, `7b52452`, migration applied by owner-approved gated run `35962442261` (success). Frontend `ed7572f` (merge), `c07fff1`. Backend catalog e2e 11/11, website unit 113/113, website e2e 37/37; frontend sections 20/20, parity 115/115, J6 7/7 locally. **Production-verified in real Chrome:** `https://ssfsdf3232.atlass.dpdns.org/courses` renders search, Level, Pricing, Sort, live count and grid; `/ar/courses` fully RTL; live API shows the section upgraded with its id/title kept and `stats` carrying the new fields. |
| 2026-09-24 | 4 | **Platform Owner reporting given a real home (DL-42 IA decision).** Checkout/approval/refund, grant-refusal and retention signals existed only as Prometheus series with a single dashboard video card. Added counts-only endpoints `GET /platform-metrics/commerce` and `/delivery` (`days` 1–90, same three guards as `/video`, every read in the platform owner's user context so the existing `*_platform_select` policies decide, parameterised SQL, capped, no PII), and two Analytics tabs — **Commerce** (`/dashboard/analytics/commerce`: orders by status incl. draft, revenue by currency, awaiting-review backlog, approval p50/p95, refunds) and **Content delivery** (`/dashboard/analytics/delivery`: grants vs refusals by reason, full video inventory moved here, retention backlog). The dashboard keeps a compact video summary linking to it. EN + AR with full plurals, skeleton/empty/error/truncated states, `h1→h2→h3`. | Claude (lead) + workers `p4-platform-ops`, `p4-platform-ops-ui` (lead-audited: SQL, context, guards, contract parity — lead added the `draft` bucket the frontend omitted) | Backend merge `d90244e`; e2e ops 5/5 + video 2/2 + analytics 12/12 (19/19 re-run by lead), tsc 0. Frontend merge `e2ad437` + `2ceaf3b` + `1f77f16`; platform+analytics+sections+parity 202/202; typecheck at the 34 baseline. Deploys: backend `35963991021`, frontend `35964098559` — production verification recorded below once complete. **Limit:** no Platform Owner session exists in the browser, so these pages are verified by tests and the guarded routes' production responses, not by a signed-in production screenshot. |
| 2026-09-23 | 4 | **Course reviews — public surface delivered.** Approved-reviews list + rating summary (mean + histogram) on `public/websites/:academyId/courses/:courseId/reviews` and `.../rating`, through `PublicWebsiteService` (serving-eligibility gated; course must be published+public; slug canonicalised). Visible-but-no-reviews → zeroed rating; draft/private → 404. Reviews module (authoring + moderation + public) now complete except in-academy recommendations. | Claude (Phase 4) | Backend `65421c3`; push-deploy success. e2e `p64-course-reviews.e2e-spec.ts` 13/13. Prod-verified on canary `60037b11…`: list 200 empty, rating 200 zeroed, unknown id 404. |
| 2026-09-23 | 4 | **Course reviews — authenticated surface delivered.** Learner authoring (enrollment-gated, one per course+student, always `pending`, sanitized) and staff moderation (instructor/owner/administrator/manager list/approve/reject/remove) on `courses/:id/reviews*`, all under `runInUserContext` so the service guard and `course_reviews_*` RLS agree independently; scalar-FK inserts; cross-academy isolation. Public approved-list/rating/recommendations deferred to the next increment. | Claude (Phase 4) | Backend `ba099dd`; push-deploy `35838833679` success. e2e `test/p64-course-reviews.e2e-spec.ts` 10/10 (real Postgres+RLS). Prod: all review routes 401 (deployed+guarded). |
| 2026-09-23 | 4 | **Phase 4 catalog foundation delivered (3 increments).** (1) Schema + migration `20261012000001_p64_phase4_catalog_reviews` — Course catalog columns, `CourseReview` model, level/review-status enums, `course_is_published_public` helper + 9 review RLS policies; also repaired a CI-breaking migration-ordering bug in the palette migration (verified by full `migrate reset` replay). (2) Public catalog v2 read path — level/language/price-range/ids filters, `price` sort, description-spanning search on `GET /public/websites/:academyId/courses`; new fields on `CourseResponse`. (3) Catalog authoring write path — create/update accept and persist level/language/outcomes/requirements/introVideoAssetId with bounds. All tenancy/RLS/server-side rules preserved; catalog stays published+public-scoped. | Claude (Phase 4) | Backend `de3e04f`→`1f5032c`. Migration applied via owner-approved run `35832583076`; push-deploys `35834744872`, `35836345426` success. e2e: catalog v2 8/8, course suite 46/46 (real Postgres + RLS). Prod-verified live on canary `60037b11…`: read contract + all filters (level/language/search/price-range/ids/price-sort) behave correctly on the real course; non-null-metadata-on-prod-course left honestly unverified (email-acceptability control blocks throwaway provisioning; write path e2e-proven instead). |

## Phase Completion Record requirements

Every phase record from Phase 2 onward must carry these sections. A record missing any of them means the phase is not complete, whatever the code says.

**Git / PR** — feature branch; PR number and URL; commits; merge commit; final `main` SHA.

**CodeRabbit** — review completed yes/no; number of review cycles; actionable findings; findings fixed; findings rejected or closed, each with the justification that was verified against the code.

**CI** — build; unit; integration; RLS; e2e; Playwright; security/adversarial; frontend tests. Real numbers, not "passing".

**Production** — migration count before and after; backend deploy SHA; frontend deploy SHA; health checks; **real Chrome production validation**; network evidence; console evidence; security evidence.

**Final phase status** — COMPLETE or BLOCKED, and if blocked, the exact blockers.

Also required, in the shared logs rather than the record: every deviation, discovery and decision in the **Decision Log**, and every implementation change in the **Implementation Change Log**, including each phase's PR, merge and deploy SHAs. Never fabricate evidence; never mark something complete because the code exists.

## Final Master Plan Audit (after Phase 4, before the Final Report)

Do not stop when Phase 4 deploys. Audit the whole plan, Phase 1 through Phase 4, against the actual repository and actual production, not against the phase reports. Verify: findings F1–F5; security findings S1–S12; browser findings B1–B6 and anything added later; decisions D1–D9; architecture decisions AD-1–AD-14; the RBAC matrix; the learner journey; every phase's acceptance criteria and Definition of DONE; every migration; every production deployment; every flag; every security control; every test suite; every Chrome production validation; every CodeRabbit review; every recorded observation and deferred item; every deviation; and every unresolved issue.

Look for contradictions, stale statements, missing evidence, unticked checklist items, undocumented changes, and requirements implemented differently from how they are described. Anything wrong gets fixed — and if the fix touches code, it goes through the same loop: branch, pull request, CodeRabbit, merge, deploy, Chrome validation, plan update. Repeat until this file is consistent with the code and with production.

## Final repository-wide review (after the audit)

One final review pass over the repository through CodeRabbit on the appropriate final surface. Read and evaluate every finding, fix every legitimate one, re-test, re-review. The project is not complete while a legitimate critical, security or correctness issue remains open.

## Final Report (last step)

Written only after the audit and the final review pass. Covers the whole journey, Phase 1 to Phase 4: executive summary; each phase's implementation; every original finding and how it was addressed; security improvements; identity, tenancy and RBAC changes; learner dashboard; course player; protected content; video provider and security; device and session system; quiz engine; integrity layer; assignments; completion rules; certificates; catalog, preview and checkout; observability and hardening; database migrations; test totals; Playwright results; Chrome production validation results; CodeRabbit cycles and findings; branches, PRs, commits and merge SHAs; production deploy SHAs; documented deviations; deferred observations; final security status; the consistency audit result; and any remaining blockers.

It must distinguish plainly between: implemented; tested locally; tested in CI; **verified in production**; observed but intentionally deferred; and not implemented or out of scope. Unresolved items are never hidden. Then, and only then, stop — no new features, no unrelated cleanup.

## Phase Completion Records

### Phase 1 — record

- **Status: COMPLETE IN PRODUCTION** (19 Sep 2026), with two production Chrome checks recorded as blocked on credentials (below). Implemented, tested, browser-validated and security-reviewed 18–19 Sep 2026; deployed and migrated 19 Sep 2026.

**Production delivery (19 Sep 2026).**

| Item | Evidence |
|---|---|
| Backend PR | #2, branch `feat/p64-phase1-secure-learning`, commit `e4d1b0b`, merged as `0b884e7` |
| Frontend PR | #1, branch `feat/p64-phase1-learner-experience`, commit `001c07f`, merged as `92f80bc` |
| Backend deploy SHA | `7672ee3` (includes the backup-prune fix found by the preflight) |
| Frontend deploy SHA | `92f80bc`, run `35433219464`, success |
| Migrations before → after | **95 → 103**; the eight `p64_phase1` migrations, none unfinished or rolled back |
| Pre-migration backup | `atlas-20260919T084204Z.sql.gz`, 8.7 MB, integrity + completion marker + required tables verified, uploaded to the backup bucket |
| Preflight counts | `rows_to_renumber=0`, `duplicate_number_groups=0`, `attempts_to_close=0`, `in_progress_total=0` — both data-rewriting steps were no-ops, so no learner record changed |
| Migration authorisation | Dispatch with `apply_migrations=true` plus `production-migrations` environment approval; the gate refused three earlier push-triggered deploys exactly as designed |
| Health after rollout | `status: ok`, database up, Redis up; all four containers healthy |

**Real Chrome production validation (19 Sep 2026)** against the live `ghg` academy, with a learner registered through the production academy website:

PASS — academy site loads; registration under the `open` policy; academy sign-in landing on `/my-learning`; `principalKind: learner` with the academy's real host; central sign-in refusal (`403 errors.auth.studentUseAcademySignIn`, no token issued, nothing written to browser storage); **twelve** management endpoints each refused with `403 errors.auth.managementSurfaceOnly`; protected content 404 before enrolment; enrolment flipping access on; the course player rendering sections, lessons and progress; public course by slug; Arabic and RTL on `/ar/my-learning`; a clean console; 65 network requests with zero non-2xx/3xx; and roster provenance recorded as `active / self_signup / ghg.atlass.dpdns.org` with the session stored on the `academy` surface.

**BLOCKED — two checks, recorded honestly rather than claimed.** The Client Owner Students tab and the Manager/Instructor UI boundaries were not exercised in production Chrome. No Client Owner credential for that academy is available, and the production platform-owner account is correctly refused that academy's data (`errors.tenancy.notAMember`). The underlying data was verified server-side and the same boundaries pass in Playwright J3, but the production UI was not observed. Resolving this needs a Client Owner test account.

**Test data created in production,** clearly marked and removable on request: learner `p64.prodcheck.1789808533758@atlass.dpdns.org` on `ghg`, and one free-course enrolment.
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

- **Status: IMPLEMENTED AND VERIFIED LOCALLY — NOT DEPLOYED** (19 Sep 2026). Nothing is committed, pushed, merged or run against production. Every number below was observed in this session; no field is filled from expectation.

**What was built.** The two-plan-family video model (D10): `normal` and `premium` × `basic`/`growth`/`enterprise`, six commercial variants. A `VideoProviderRegistry` resolving the adapter **by security tier on upload** and **by `media_assets.provider` on playback** (AD-7). `BasicVideoProvider` (R2 + CDN + Atlas-controlled Worker gate, progressive MP4, single 720p rendition, DL-19) alongside `CloudflareStreamProvider`. `security_tier` recorded per asset and never re-derived from the academy's current plan (AD-15, D11). Capability-honest grants (AD-16). Plus the Phase 2 scope proper: protected content tier, the seven-condition policy decision point, device registry and lease, takeover with audit, unified sequence, playback evidence, learner dashboard, `videoStorageMinutes` end to end, observability, and the learner shell and player.

**Verified test evidence (19 Sep 2026).**

| Suite | Result |
|---|---|
| Backend typecheck | 0 errors |
| Frontend typecheck | 0 errors |
| Backend unit (media, learning, plans, tenancy) | **533 passing** |
| Security + RLS/tier e2e | **59 / 59 passing** |
| API verification + quota e2e | **61 / 61 passing** |
| Frontend | **563 passing, 55 files** (baseline was 523) |
| Phase 1 regression (`p64-*`, `auth-signin`, `auth-refresh`) | **66 passing — unchanged** |
| App boot | `/health` 200, database and Redis up; `/metrics` 401 (guarded) |

**Migrations added (5).** `20261009000000` protected content, video and devices · `…000100` plan families and video tiers · `…000200` the three premium plans · `…000300` the SEC-1/SEC-2 corrections · `…000400` `ALTER ROLE atlas_app SET jit = off`. All applied locally only.

**Defects found and fixed — fourteen.** Recorded because the pattern matters more than the count: almost every one was caught by an independent review pass, and the serious ones were invisible to a passing suite and a clean typecheck.

| | Defect | How it presented |
|---|---|---|
| D-1 | `media_assets.provider` wrote a hardcoded literal | Column recorded a constant, not a fact; playback resolves from it |
| D-2 | Direct-upload ticket carried an empty `uploadUrl` | Adapter did not satisfy its own contract |
| D-3 | Grant advertised up to 2 h for a credential clamped to 10 min | Player would be stranded mid-lesson with no reason to refresh |
| D-4 | No readiness path without a webhook | A Normal asset would sit at `processing` forever |
| D-5 | Cloudflare Stream does not enforce Atlas's session/device claims | A capability was being sold that the provider never checked |
| B1 | `createVideoUpload` read a `const` inside the callback producing it | **`ReferenceError` on every call — whole upload path dead, `tsc` green** |
| SEC-1 | `media_assets` had no user-context SELECT policy | **Every video grant silently returned no video, while reporting `signedUrl: true`** |
| SEC-2 | Refusal log rejected by RLS (two independent causes) | **Not one content-access refusal had ever been recorded** |
| SEC-3 | Lease taken before the asset-readiness refusal | A refused request held the learner's single lease for 60 s |
| SEC-5 | Webhook resolved the process-wide provider | Under a Normal-first rollout, every Cloudflare webhook would be rejected |
| SEC-6 | Local adapter's webhook verifier had no production guard | Verifiable against a constant published in this repository |
| P2-API-2 | Completion endpoint advertised a public URL for protected assets | Finding S1's shape, on an empty storage key |
| P2-API-4 | 6.5 s of PostgreSQL JIT on learner-context reads | Intermittent **500s**, worse at scale — `jit = off` for the app role gives 4.4 ms |
| — | `course_lessons.video_asset_id` had no write path | The hosted-video feature was unreachable in practice |

**Corrections made to this plan's own claims.** Three security properties were asserted and then withdrawn once evidence contradicted them; the originals are preserved in §I and in the investigation rather than overwritten:

1. **Neither tier binds to session or device at the delivery edge.** Cloudflare mints `accessRules: any/allow` and ignores custom claims (D-5); the Normal gate is cross-site from the academy and receives no Atlas session. A lifted token plays elsewhere on both tiers until it expires or is revoked.
2. **Revocation is prompt, not instant** — bounded by denylist propagation (~1 min measured) plus the gate's cache. No sub-second SLA may be promised.
3. The investigation's "cache-key fix is Enterprise-only" was out of date; "ignore query string" is available on all plans.

**Evidence produced.** `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` (approved), `ATLAS_PHASE2_RECONCILIATION.md`, `ATLAS_PHASE2_SECURITY_AUDIT.md`, `ATLAS_PHASE2_API_VERIFICATION.md`, `ATLAS_NORMAL_VIDEO_WORKER_SPIKE.md` (DL-22 discharged — revocation proved by control experiment: a gate token with ~600 s left returned `403 revoked` after one denylist write while a presign for the same object kept returning `206`).

**NOT DONE — required before this phase can be called complete.**

- Local Chrome validation (§Q), for **both** tiers.
- Adversarial validation (§R) beyond what the security e2e covers.
- Canary flag enablement with a week of metrics per academy (§W) — cannot be compressed.
- Pull request, CodeRabbit review cycle, merge, deployment, production Chrome validation.
- **Open business decision:** what the Premium tier is sold as, given correction 1 above. Premium's premium is managed delivery, ABR and provider-side processing — not stronger cryptographic protection. That is a commercial position and is recorded as requiring explicit sign-off.

### Phase 3 — record

- **Status: DEPLOYED TO PRODUCTION, VALIDATED ON THE CANARY ACADEMY, DEFECTS FIXED AND RE-VERIFIED ON PRODUCTION** (22 Sep 2026). Seven Phase 3 defects were found by that validation (see "Defects" below); all are deployed and re-verified. Every number below was observed in this session; nothing is filled from expectation. Labels: VERIFIED = observed on production; LOCAL VERIFIED = observed only against the local real stack; NOT VERIFIED = not observed.

**Git / PR.**

| Repo | Branch | PR | State | Merge |
|---|---|---|---|---|
| atlas-backend | `chore/ci-green` (CI fix + formatting) | #8 → `main` | merged by the owner | `a0c31aa` |
| atlas-backend | `feat/p64-phase3` (Phase 3, 91 files) | #7 → `chore/ci-green` | merged by the owner | `15548d6` |
| atlas-backend | `fix/p64-phase3-followups` | #9 → `main` | merged | `111f0e3` — the SHA the production migration ran against |
| atlas-backend | `feat/ci-managed-feature-flags` (DL-35) | #10 → `main` | merged | `f497ff1` — current production backend |
| atlas-backend | `fix/p64-phase3-prod-validation` (DL-36) | #11 → `main` | merged | `eb4aead` — deploy run `35767638750` |
| atlas-backend | direct push to `main` (DL-39) | — | pushed | expired-attempt commit fix (defect 9); SHA and deploy run in the change log |
| atlas-front | `feat/p64-phase3-foundation` (58 files) | #4 → `main` | merged | `bf51918` |
| atlas-front | `feat/p64-phase3` (screens + journeys) | #5 → #4 | merged | `8a6a193` |
| atlas-front | `fix/main` interim | #7 → `main` | merged by the owner | `d38969d` |
| atlas-front | `feat/p64-phase3` (foundation + screens + journeys) | #6 → `main` | merged | `ad5a1b8` — current production frontend |
| atlas-front | `fix/p64-phase3-prod-validation` | #8 → `main` | merged | `3c5ee3d` — deploy run `35765587586`, live bundle `/assets/index-Udfu9cd0.js` |

**CodeRabbit.** Backend #7: review not run (file limit, then insufficient usage credits on the organisation — DL-31). Backend #9 and #10, frontend #6: review requested; no actionable inline finding was raised on them. Fix PRs: frontend #8 — one actionable finding (the chrome-free loading / unavailable / not-found fallbacks rendered outside the website theme scope; the dark loading skeleton seen on production), fixed in `ac0c685` and confirmed by the reviewer; backend #11 — four documentation-consistency findings on this record, fixed in `a68693f` and confirmed. **CodeRabbit is unavailable from here on: the organisation's monthly credits are exhausted and the owner dropped the PR/review workflow for the remaining Phase 3 work (DL-39).** Later Phase 3 changes are self-reviewed and pushed to `main` directly; none is claimed as reviewed.

**CI.**

| Check | Result |
|---|---|
| Backend typecheck / lint | clean |
| Backend unit | **1307 / 1307** (local, before the fix branch); the fix branch adds `quiz-deadline.types.spec.ts` (1 / 1) |
| Backend e2e (local) | 117 / 117 suites at the time of the merge (DL-30 for the CI-only failures) |
| Phase 3 e2e suite | **18 / 18** on `main`; the fix branch adds three scenarios — the delayed deadline job through the real BullMQ worker, the maintenance sweep finalising overdue attempts, and certificate anonymisation through the queued job — the first and third fail on `main` because its job ids are refused (DL-36), the second because nothing on `main` calls `finalizeOverdue`; all three pass on the branch (LOCAL VERIFIED) |
| Backend CI (`ci.yml`) | lint / typecheck / unit / build green; four pre-existing CI-only e2e failures (`media`, `p53-support-attachments`, `p62-entitlement-concurrency`, `phase10-1-trial-abuse`) unchanged — DL-30, classification C |
| Frontend typecheck / lint / build | clean |
| Frontend unit | 640 / 640 on `main`; fix branch: certificates + public-website suites 40 / 40 with three new tests |
| Playwright J1 / J4 | 6 / 6 and 3 / 3 against the local real stack (LOCAL VERIFIED, unchanged) |

**Production.**

| Item | Evidence |
|---|---|
| Migrations | **109 → 114.** `migrate-and-deploy` run `35749157369` (workflow_dispatch `apply_migrations=true`, commit `111f0e3`), gated by the `production-migrations` environment and approved under DL-34: verified backup `atlas-20260922T164606Z.sql.gz` uploaded to `s3://atlas-backups-production`, pre-migration row counts recorded, "114 migrations found … Applying migration 20261011000000 / 000100 / 000200 / 000300 / 000400 … All migrations have been successfully applied", backend `/health` healthy, Caddy healthy, last-good digests recorded. VERIFIED from the run log. |
| Backend deploy SHA | `111f0e3` by the run above, then **`f497ff1`** (PR #10) by push run `35759228708` and dispatch run `35760425054` (`apply_migrations=false`, which also synced the flags). The earlier push deploys of `a0c31aa` (cancelled) and `111f0e3` (aborted itself: "Nothing was migrated … running stack is untouched") show the migration gate working. |
| Frontend deploy SHA | **`ad5a1b8`** (run `35757465316`); the live bundle `/assets/index-Cn2x9WpE.js` carries the Phase 3 markers. |
| Flags | Canary (§T): `FLAG_QUIZ_ENGINE_V2_MODE`, `FLAG_QUIZ_INTEGRITY_MODE`, `FLAG_CERTIFICATES_MODE` = `allowlist`, each `_ACADEMY_IDS` = `60037b11-8855-4b85-98f9-963a38874519` (the disposable validation academy), set as GitHub repository variables and synced by the deploy (DL-35). `GET …/completion-rule` on that academy answers `certificatesFeatureEnabled: true`; all other academies keep the legacy behaviour. |
| Public verification endpoint | `GET /api/v1/verify/:code` answers 200 `{valid:false}` for an unknown code on both hosts (was 404 before the deploy). |
| Fix deploys (code only) | Frontend `3c5ee3d` (run `35765587586`); backend `eb4aead` (run `35767638750`: "No pending migrations; skipping backup and pre-migration counts", Backend healthy 18:36:56Z, Caddy healthy, last-good digests recorded); backend expired-attempt fix by direct push (change log). No migration in any of them. |

**Real production validation (22 Sep 2026, canary academy `p3-validation.atlass.dpdns.org`, disposable fixtures — DL-38).** Two lenses were used against the live deployment: the production API called exactly as the frontend calls it (learner requests through the academy host with the `atlas_device` cookie, staff requests through the platform host), and real Chrome for every surface reachable without a learner session.

| Journey | Result |
|---|---|
| Quiz launch: settings snapshot, seeded paper without `isCorrect`, server `startedAt`/`deadlineAt` | VERIFIED (API) |
| Timed quiz: `serverNow` + `remainingSeconds` on resume; 120 s limit honoured | VERIFIED (API) |
| Autosave: client sends `revision + 1`, server answers `applied:true`; a repeat of the same revision answers `applied:false` and changes nothing | VERIFIED (API) |
| Reload / resume: saved answers, revision and `lastSavedAt` returned | VERIFIED (API) |
| Deadline / timeout: read after `deadline + 30 s` finalises the attempt with `autoSubmitted:true`, reason `timeout`, graded as-is (1 of 2 → 50, passed at passing score 50), never auto-failed | VERIFIED (API) — the job itself was defect 1, re-verified below |
| Delayed auto-submit job (after backend `eb4aead`): attempt `56eb6cc0…` started 18:44:23Z, deadline 18:45:24.609Z, left untouched; finalised at **18:45:54.688Z** (79 ms after `deadline + 30 s`), reason `timeout`, autosaved answer graded 1 of 2 → 50, passed | VERIFIED (production, via the reviewer's read which does not finalise) |
| Maintenance sweep (after backend `eb4aead`): attempt `a7b17e99…`, expired 17:48:39Z, nobody reading it; finalised at **18:40:00.268Z** by the ten-minute sweep, reason `timeout`, score 0 (nothing answered) | VERIFIED (production) |
| Quiz paths after backend `b13c790` (defect 9): start 201 → session 200 → autosave 200 → submit 201 (`passed`, 100) → results 200 on a fresh attempt | VERIFIED (production smoke); the rollback itself is LOCAL VERIFIED by the new e2e scenario — on production the delayed job now finalises an attempt 79 ms after grace, so an "expired but still open" attempt can no longer be reproduced there |
| Certificate anonymisation on account deletion (defect 3, DL-28): the disposable learner deleted their account at 18:55:52Z through the academy host; within a minute `GET /verify/RGGVD9RDEBDW` named `issuedTo: "Deleted account"` with serial, code, dates and the revoked status unchanged | VERIFIED (production) |
| Revoked certificate page after frontend `3c5ee3d`: `/verify/RGGVD9RDEBDW` shows the revoked banner with the date, facts and a "Revoked" badge in EN and AR; the panel is light amber (`rgb(253,245,232)`) with dark text while the visitor's OS prefers dark; Arabic heading and subtitle on `/ar` | VERIFIED (Chrome) |
| Integrity events: four events recorded with server timestamps, `violationCount 3`, `action: warn`, attempt stays `in_progress`; the reviewer's attempt detail shows the timeline and `integrityFlagged` | VERIFIED (API) |
| Results / disclosure: score, per-question correctness, correct options, explanations, accepted answers per policy `immediately` | VERIFIED (API) |
| Assignment draft → read back → final submit → resubmit refused `409 errors.assignment.alreadySubmitted` | VERIFIED (API) |
| Grading by the owner through `/review/...`: submissions list, detail, grade 90 with feedback, `gradedBy` | VERIFIED (API) |
| Course completion: rule `requiredQuizzes + requiredAssignments`, `completed:true` the moment the assignment was graded, `overallScore 70` | VERIFIED (API) |
| Certificate issuance: automatic on completion, serial `TPVA-2026-000001`, 12-char code, PDF rendered by the queue within 2 s | VERIFIED (API) |
| Certificate download: one-hour signed R2 link serves a 25 KB `application/pdf` (`%PDF-1.7`); the same object without the signature is refused; no durable URL in any learner payload | VERIFIED (API) |
| Verification page `/verify/:code` on the academy host, EN and AR, unknown and valid codes, with the network panel showing only the public API calls | VERIFIED (Chrome) |
| Verification on the platform host | VERIFIED (API, both hosts answer identically); the Chrome extension refused navigation to the platform host in this session |
| Uniform timing for unknown vs real codes | VERIFIED (API, 0.39–0.42 s both) |
| Revocation: owner revoke → `valid:false, status:revoked`, learner download refused `403 errors.certificate.revoked`, repeat revoke idempotent | VERIFIED (API); the page rendering of that state was defect 4 |
| Regeneration of a revoked certificate refused (`409 errors.certificate.notIssued`); manual issue on the same enrollment returns the existing (revoked) record rather than a second certificate | VERIFIED (API) |
| Retake immutability: attempts 2 and 3 (100 and 0) leave attempt 1's results, the certificate's snapshot (`overallScore 70`, version 1, serial, code) unchanged; completion's live `overallScore` recomputes (95) | VERIFIED (API) |
| Attempt cap: fourth start refused `403 errors.quiz.maxAttemptsReached` | VERIFIED (API) |
| Cross-academy isolation: a second disposable organisation/academy's owner gets `403 errors.tenancy.notAMember` on A's certificates, completion rule and revoke, `404` on A's review routes, and an empty list on their own academy | VERIFIED (API) |
| Instructor boundary: an instructor of the academy gets `403 errors.certificate.insufficientRole` on revoke, regenerate and the certificate list | VERIFIED (API) |
| Learner boundary: a learner token gets `403 errors.auth.managementSurfaceOnly` on review and staff certificate routes | VERIFIED (API) |
| Learner sign-in / sign-up pages on the academy host, EN and AR, RTL, labels, no console errors | VERIFIED (Chrome) |
| Learner-session Chrome journeys (quiz runner UI, countdown, save indicator, integrity dialog, results screen, assignment editor, completion card, certificate card and download button) | **NOT VERIFIED in Chrome** — DL-37: the browser tooling available to the implementer cannot establish a learner session without typing a password or injecting a token, both of which are prohibited; the same journeys are LOCAL VERIFIED by Playwright J1 and their server behaviour is VERIFIED above. The owner can sign in as the disposable learner in the open tab to complete them. |

**Defects found by the validation** (classification per the owner's scheme: A Phase 3 defect, B pre-existing, C CI/environment, D deployment, E GitHub permission, F production data, G documentation).

| # | Class | Finding | Root cause | Fix |
|---|---|---|---|---|
| 1 | A | The delayed auto-submit job never fires: an attempt left alone stays `in_progress` past `deadline + grace` (observed on four attempts; a fourth, `a7b17e99…`, was left untouched on purpose as proof for the sweep). The learner-facing outcome was still correct because every read/save/submit finalises lazily. | BullMQ 5.81 throws `Custom Id cannot contain :` for a two-segment custom id; `quiz-deadline:<attemptId>` was rejected on every `queue.add`, and the producer's best-effort catch logged it as a warning. CI never exercised the job itself. | Backend #11: colon-free id, producer logs at error level, e2e through the real worker (`job.promote()`), unit test pinning the id shape. |
| 2 | A | The "sweep" safety net the plan promises did not exist at runtime: `finalizeOverdue` had no caller. | Never wired into the Phase 2 maintenance job. | Backend #11: the 10-minute maintenance job now runs it and reports `finalizedOverdueQuizAttempts`; e2e. |
| 3 | A | `certificate-anonymize:<userId>` had the same colon defect: deleting an account never anonymised the learner's certificates (DL-28 was not true in production). | Same as 1. | Backend #11: colon-free id; e2e deletes a learner and waits for the queued anonymisation. |
| 4 | A | `/verify/:code` rendered a revoked certificate as "This code does not match any certificate". | The API answers `valid:false` for revoked too; the sheet branched on `valid` alone, so its revoked branch was unreachable; the unit fixture had assumed `valid:true`. | Frontend #8: branch on `status === 'revoked'` first; fixture corrected. |
| 5 | A | On `/ar/verify/:code` the sheet was Arabic while the heading stayed English. | The academy shell switches the i18n language from its own `useEffect`; child effects run before the page's, so the page never refreshed its heading string. | Frontend #8: the page hands the frame self-translating elements; a test reproduces the effect ordering. |
| 6 | A | With the visitor's OS in dark mode, the success/warning panels on the academy site were dark surfaces with dark text (≈1.6:1). | Status tokens were not part of `.website-theme-scope`, so they fell through to the dashboard's `.dark` values. | Frontend #8: light status tokens added to the scope. |
| 7 | B | `GET /api/config` answers 404 on every page load. | Pre-existing runtime-config probe, handled silently by `loadRuntimeConfig`. | None — recorded. |
| 8 | G | The plan's "sweep" and "anonymisation" statements were true of the code but not of the running system. | Defects 2 and 3. | This record and DL-36. |
| 9 | A | After an abandoned attempt expired, every new start answered `409 errors.quiz.attemptExpired` — forever before defect 2's fix, for up to ten minutes after it — and a session read of an expired attempt answered 409 without finalising it (attempt 1 at 17:36:03Z, attempt 4 at 18:38:21Z/18:38:41Z, both still `in_progress` afterwards). | `start`, `getSession`, `saveAnswers` and `submit` finalised the expired attempt and then threw the 409 **inside the same interactive transaction**, which rolled the finalisation back. Only the results read (which does not throw) and the sweep ever committed one. | Direct push to `main` (DL-39): the transaction returns an `ExpiredAttempt` marker and the caller throws after the commit; the timeout e2e now asserts the row is finalised before any results read, and a new scenario restarts after abandoned attempts through the session read, a late submit and the next start, ending at the attempt cap. |

**Closing entry (22 Sep 2026, 18:56Z).** Defect 9 is deployed (`b13c790`, run `35769701786`: "No pending migrations", Backend healthy 18:54:09Z, Caddy healthy, last-good digests recorded) and the quiz paths smoke-tested on production. Fixtures (DL-38): the instructor and the second owner deleted their accounts (`deleted: true`), the isolation academy `4d04b689…` is archived (204) and its organisation's trial cancelled; the disposable learner deleted their account (which is the anonymisation evidence above). **Kept on purpose:** the canary academy `60037b11…` (`p3-validation`), its course and the QA owner account, so the three Phase 3 flags still have a live allowlist target until Phase 4 decides the rollout, and so the owner can register a learner on `https://p3-validation.atlass.dpdns.org/sign-up` and run the learner-session Chrome journeys (DL-37) if wanted; archive later with `POST /academies/60037b11-8855-4b85-98f9-963a38874519/delete {confirm:true, reason:"testing_only"}`, `POST /organizations/53aa6b05-8ef1-4a18-9740-a54ef1c529b4/subscription/trial/cancel {confirm:true, reason:"not_using_it"}` and the QA owner's `POST /users/me/delete`. The accidental Platform-Owner organisation `87a06dcf…` has no archive endpoint and stays as recorded.

**Final phase status: COMPLETE** — every acceptance item verified on production except the learner-session Chrome journeys, which are recorded as NOT VERIFIED by the implementer (DL-37; their server behaviour is VERIFIED on production and the UI is LOCAL VERIFIED by Playwright J1/J4). CodeRabbit: unavailable from PR #11 onward (credits exhausted, DL-39); the last three changes were self-reviewed. Phase 4 starts next (DL-15).

### Pre-Phase-4 Stabilization — record

**A gate before the real Phase 4 scope** (owner directive, 22–23 Sep 2026): ten defects found by manual authenticated testing are fixed at the root, regression-tested, deployed and production-verified BEFORE any Phase 4 feature work begins. Workflow is direct-to-`main` (DL-39): fix locally → test → commit → push `main` → deploy → verify production. CodeRabbit unavailable throughout (DL-39). Each fix reproduced on production first where possible.

| # | Issue | Root cause | Fix | Status |
|---|---|---|---|---|
| 1 | Course-builder ordering flips quiz/lesson locks; progression contradicts the sidebar after a reorder | Atlas models prerequisites as sequential curriculum ORDER (no explicit prerequisite field). The sidebar/curriculum derive lock state LIVE from `CourseSequenceService`, but ENFORCEMENT did not: `completeLesson` checked the materialised `LessonProgress.status` (frozen at enrollment, never recomputed on reorder), and quiz start / assignment submit / lesson-content grant had NO sequential gate at all — progression was rendered, not enforced. | All four enforcement points now consult the one live `CourseSequenceService` derivation, so a reorder can never leave the sidebar and the API disagreeing, and the backend is authoritative. New `errors.quiz.locked`, `errors.assignment.locked`, `locked` content-refusal → `errors.learning.lessonLocked`. e2e: lesson reorder, quiz gate + live reorder. | **DONE** — backend `671f557`, frontend `3826132`; VERIFIED on prod (a lesson after an unsubmitted assignment returned `lessonLocked`, then delivered once the assignment was submitted) |
| 2 | A YouTube-URL lesson shows "no content" | The dashboard course builder writes only legacy `course_lessons.contentType`/`contentUrl` (+ `video_asset_id`) and NEVER a `lesson_contents` row (its own comment: student consumption is "a separate, future module"). The learner's unified player requires that row → `noContent` for every builder-created lesson. | The learner grant path reconciles both representations onto the one grant contract (`effectiveLessonContent`): authored row wins; else a hosted `video_asset` is the video and a `content_url` becomes a YouTube embed (`classifyExternalEmbed`) or an honest link-out. No second model, no migration, existing data fixed at read time. | **DONE** — backend `671f557`; VERIFIED on prod (a builder YouTube lesson delivers `kind:external`, `videoId`, `signedUrl:false`) |
| 3 | Video upload returns "Unexpected error" | Two parts. (a) Specific backend upload errors (`videoNotEnabled`, upload-lifecycle) were missing from the frontend error catalog, so they degraded to the generic "Unexpected error". (b) Deeper: the dashboard uploads video through the base64 data-URL endpoint whose body limit (~30 MB) is exceeded by typical video files → a raw 413 shown as "Unexpected error". A proper video direct-upload flow (reserve → PUT to provider → complete) exists in the backend but the frontend never calls it. | (a) Actionable EN/AR copy added for `errors.media.videoNotEnabled` and the upload-lifecycle keys. (b) The direct-upload flow is implemented together with Issue 10 (below). | **PARTIAL** — error copy in `3826132`-batch; the direct-upload flow is combined with Issue 10 (in progress) |
| 4 | `/me` progress ring always 0% | `course_progress.percentage`/`completedLessons`/`totalLessons` counted only LESSONS, and `recompute` never even wrote `percentage`, so progress via quizzes/assignments (or a course that is not lesson-only) showed 0 or a wrong figure. | `computeItemProgress` is the one definition of overall progress across the unified sequence (finished item = completed lesson, passed/submitted-pending quiz, or submitted assignment). `recompute` materialises it; `getCourseProgress` self-heals it on read; the `/me` overview computes it read-only from batched counts so it is correct immediately for existing enrollments. | **DONE** — backend `8bbcec4`; VERIFIED on prod (a learner with a submitted assignment shows 33.33% where it was 0%) |
| 5 | Integrity "records nothing" | The event pipeline is NOT broken (verified: events ingested, reviewer timeline shows them; the copy is already capability-honest — it never claims to detect screenshots or OS screen recording, which browsers cannot). Two real problems: the `quiz.integrity` canary flag forces integrity `off` at runtime on non-canary academies despite the dashboard config, and the reviewer summary surfaced `violationCount` (0 during the warm-up window) so an empty/monitored attempt read as "nothing recorded". | The reviewer response now carries the attempt's effective `integrityMode`, and the reviewer UI distinguishes "integrity was not monitored for this attempt" from "monitored, no events recorded" (EN/AR). Global rollout of the `quiz.integrity` flag remains a Phase 4 §T action; capability honesty confirmed already present. | **DONE (transparency + honesty)** — backend + frontend in this batch; flag rollout deferred to Phase 4 §T |
| 6 | Extra-attempt override "does not work" | The backend applies the override correctly on every path (start, session, results all add `override.extraAttempts`) — verified on prod: after a reviewer grants +1, the exhausted learner's next attempt starts. The learner never SAW it: the results/attempts reads used the 60 s global stale window with `refetchOnWindowFocus` off, so returning to the quiz kept the cached "no attempts left". | `useQuizAttemptResults` and `useQuizAttempts` re-check eligibility on mount (`staleTime:0`, `refetchOnMount:'always'`). | **DONE** — frontend `2ac46b1`; backend VERIFIED on prod (override → next attempt starts) |
| 7 | Certificate branding save fails "Enter a valid URL" | A media asset's `url` is the app-RELATIVE `/api/v1/public/media/...` path, but the certificate template DTO validated `logoUrl`/`signatureUrl` with a bare `@IsUrl` (absolute only) → `validation:invalidUrl`. The renderer's `new URL(url)` also cannot fetch a relative path. | A scoped custom validator accepts an uploaded-media reference OR an absolute URL (global `@IsUrl` untouched), and the renderer resolves the relative path to absolute against the platform domain before fetching. | **DONE** — backend in this batch; reproduced on prod (400 `validation:invalidUrl`), fix verified after deploy |
| 8 | Certificate looks like a receipt, not a professional certificate | Design quality of the pdfkit layout. | Redesign to an original, professional certificate: a printed-diploma palette (warm paper, deep ink, deep-teal accent, gold rule/seal), engraved double frame, gold rules, a name flourish, auto-fitted learner name and course title (no wrapping/overlap), a bottom band with signatory / gold seal / QR, and a masthead that uses the academy logo or a deterministic Atlas wordmark fallback; footer "Issued & verified through Atlas". A clean short "Authorised by the academy" signatory line when no signatory is configured (no long-name overlap). Every security property preserved (immutability, serial/code, verification, revocation, anonymisation, versioning) — layout-only change, snapshot unchanged. | **DONE** — backend renderer redesign `35790344090`-deploy + signatory refinement `17a4278`; VERIFIED on prod (real certificate `TPVA-2026-000002`, code `0RQ5T774XNCE`, renderStatus `ready`, downloaded PDF inspected: professional design, Atlas wordmark fallback, no overlap) |
| 9 | Course category "useless/redundant" | Investigated: courses accept `categoryId` and the list filters by it and the create/edit forms have a selector, but there is NO endpoint to CREATE categories, so the selector is always empty — the "empty in practice" observed. Phase 4's catalog (§D.1) explicitly needs category search/filter. | **Decision: KEEP.** Category is required by Phase 4 catalog; the missing piece is category MANAGEMENT (create/edit), which is Phase 4 catalog scope. Not removed; management deferred to Phase 4 per the "no early Phase 4 features" rule. | **DONE (decision)** |
| 10 | Video upload has no real progress (appears frozen) | Same root as Issue 3(b): video goes through the base64 data-URL path, which cannot report real byte progress for a large file. | Implement the video direct-upload flow (reserve ticket → XHR PUT to the provider with `upload.onprogress` → complete), with preparing/uploading/processing/ready/failed states and safe abort/retry. | **IN PROGRESS** (combined with Issue 3b) |

**Gate status (23 Sep 2026):** Issues 1, 2, 4, 6, 7, 8 complete and production-verified; Issue 5 transparency/honesty complete (global `quiz.integrity` flag rollout is a Phase 4 §T action); Issue 9 keep-decision recorded; Issue 3(a) error copy shipped. **One item remains blocked:** Issues 3(b)+10, the hosted-video direct-upload flow with real byte progress, are an ENVIRONMENT BLOCKER — building and verifying them safely needs a video-enabled academy (the trial/canary academies return `videoNotEnabled`, so the provider path — R2 presigned PUT for normal tier vs Cloudflare Stream direct-upload POST for premium — cannot be exercised or verified on production without provisioning a paid media tier). The error-copy half (3a) is done; the upload flow is deferred with this reason recorded, not skipped. Every other stabilization item is at the ROOT, regression-tested, deployed to `main`, and verified on production. The gate is therefore satisfied except for the one recorded environment blocker; the real Phase 4 scope may begin, carrying 3(b)+10 as the first media-infrastructure task once a video-enabled tenant exists.

### Pre-Phase-4 Stabilization — SECOND PASS (real-browser, 23 Sep 2026)

A stricter revalidation gate (owner directive): manual authenticated testing after the first pass surfaced more defects; real-browser verification is now mandatory for learner-facing behaviour. Same direct-to-`main` workflow. This pass is NOT closed; the Phase 4 gate stays CLOSED until every item below is done and browser-verified.

| # | Issue | Root cause | Fix | Status |
|---|---|---|---|---|
| A | Extra-attempt override still inconsistent in real use (a +1 appears only after a later +3) | Three separate allowance calculations; two ignored the override — the attempts-list endpoint used `canStartAnotherAttempt` (override-blind) and the learner intro recomputed "attempts left" from `maxAttempts` only; only the results `canRetry` (mount-only refetch) reflected it. Overrides REPLACE (one row per quiz+student, absolute value). | ONE authoritative source: the learner quiz-detail now carries the caller's own `attemptsAllowed`/`extraAttempts` (`maxAttempts` + the override) computed with the same `canStartAttempt` rule the engine uses; the attempts-list `canRetry` is override-aware; the intro reads the server value; the eligibility hooks refetch on window focus so a grant appears when the learner returns. | **DONE** — backend `83d6978`, frontend `0411d38`; e2e regression added and passing; deployed |
| B | Assessment integrity records nothing for a real learner | The `quizIntegrity` (and `quizEngineV2`) flags are `allowlist`-limited to the canary academy, so on every real academy the attempt snapshot forces `integrityMode:'off'` and NO browser listeners attach. Pipeline itself is correct (verified: events ingest, aggregate, display; capability-honest copy already present). | ROOT fix = promote the two flags. **BLOCKED:** `gh variable set` for the production flag repo-variables is denied by the environment permission classifier; not worked around (owner's "do not bypass protected controls" rule). Needs the owner to run the three `gh variable set … --body on` commands or grant that permission. Engine correctness confirmed by code trace + Phase-3 canary evidence. | **BLOCKED (authorization)** — awaiting flag promotion |
| C | Quiz timer does not appear for a timed quiz | Same root as B: the server-authoritative `deadlineAt` is only computed under `quizEngineV2` (allowlist-only), so on a real academy the attempt persists `deadlineAt:null` and the (correctly wired) countdown shows "no time limit". Not a missing component, not a field mismatch. | Same flag promotion as B. | **BLOCKED (authorization)** — same flag |
| D | Whole quiz settings matrix | Enumerated from code: time limit, availability window, due/late, shuffle (questions/options), questions-per-attempt, layout, integrity, max-violations, require-fullscreen are ALL gated behind `quizEngineV2`(+`quizIntegrity`); `passingScore`, `maxAttempts`, grading policy, show-score/answers/explanations, required-to-progress/for-completion, hide-timer are always active. | The gated settings become effective with the B/C flag promotion; the always-active ones already work (covered by existing e2e). | **PARTIAL** — always-active settings verified; gated settings blocked on the same flag |
| F | A configured academy still shows "certificates not enabled" | Certificate readiness was gated on the `certificates` env rollout allowlist, NOT the academy's real configuration. Saving a template never affected it. So a fully-configured academy read "not enabled". | Removed the allowlist gate from EVERY certificate-readiness site (issuance eligibility, completion status, the owner-facing `certificatesFeatureEnabled`, learner list, learner dashboard). Readiness now follows the course's own `certificatesEnabled` toggle + a configured template + completion — one authoritative rule. e2e proves a configured course issues a certificate with the flag OFF. | **DONE (code)** — backend `3764a4e`; deploying; browser verification pending |
| G | Certificate editor too limited; not a professional design system | The renderer palette was fully hardcoded; the editor had four-field branding and an HTML mock preview that could diverge from the PDF. | A constrained four-role colour system (primary/accent/text/background) with curated presets; ONE palette util that validates hex + enforces readability/contrast (rejects unreadable/print-hostile combos) and derives deterministic tints; palette frozen into the immutable issuance snapshot (old snapshots render the original design — backward compatible); the renderer derives its palette per-render from the snapshot; a small dependency-free bidi fix for Arabic (numbers + embedded Latin no longer reversed); the editor's live preview is now the REAL server-side PDF renderer via a new `POST …/certificate-template/preview` endpoint (owner/manager only, nothing persisted), EN/AR. Migration additive; immutability/versioning/anonymisation preserved. | **DONE (code)** — backend `3764a4e`+`e076258`, frontend `52f8c07`; migration `20260923021943_p4_certificate_palette`; palette unit (9), renderer incl. custom+no-palette+bidi (11), e2e persistence/contrast/preview/immutability/tenant-isolation (6) — all passing; three sample PDFs (default, custom burgundy, Arabic navy) rendered and visually inspected; browser verification pending |

**Second-pass gate status (in progress):** Issue A complete and deployed. Issues F and G complete in code, unit+e2e green (32 assessment/certificate e2e pass with no regression), sample PDFs visually verified (professional, colour-customisable, correct Arabic bidi), and the editor UI real-browser-verified on academy `387d63c0` (colour system + presets render; hooks-order crash found and fixed live). Security Issues A (invitation email-binding, backend `47d0946`) and B (authenticated-learner auth-route guard, frontend `149f294`) reviewed, tests re-run and green (invite email-binding e2e 8/8, guard tests 14/14), Issue B deployed.

**Both earlier owner-action blockers are now cleared and verified:**
1. **Production migration — DONE.** The owner approved the protected `production-migrations` deploy (run `35814031102`, SHA `47d0946`): both additive migrations (`20260923021943_p4_certificate_palette`, `20261012000000_p64_invite_email_binding`) applied and the backend deployed. Production healthy.
2. **Quiz flags — DONE.** The owner promoted `FLAG_QUIZ_ENGINE_V2_MODE=on` and `FLAG_QUIZ_INTEGRITY_MODE=on` (23 Sep 04:23Z); a code-only redeploy synced them to production (healthy).

**Final second-pass status (23 Sep 2026):**
- **Issue A** (override) — DONE, deployed. e2e regression green.
- **Issues F/G** (certificate readiness + professional palette/preview) — DONE, deployed, and REAL-BROWSER VERIFIED on academy `387d63c0`: colour system + presets render; live preview is the real server-side PDF and updates in real time on text edits (rapid edits latest-wins, no stale overwrite, no console errors); save persists (version bumped); server-side contrast rejection (400); Issue F course "Issue certificate" toggle now enabled and saving. Palette unit 9/9, renderer 11/11 (incl. custom palette, no-palette backward-compat, Arabic bidi), certificate/assessment e2e 32/32.
- **Security A** (invite email binding + creation trust) — DONE, deployed. Reviewed and re-tested by the implementer: 15 invitation e2e pass (binding: invited-only, cross-academy, expired/revoked/used, manual-bypass; creation trust reuses the existing `EmailRiskService` disposable/deliverability gate, honestly not proving mailbox ownership at creation).
- **Security B** (authenticated-learner auth-route guard) — DONE, deployed. 14 guard tests.
- **Issues B/C/D** (quiz timer / integrity / settings) — root cause was the two flags force-disabling the v2 engine on non-canary academies; the owner has now promoted both flags and they are synced to production. Engine behaviour is e2e-verified (32 assessment tests: server deadline from the time limit, integrity monitor/warn/strict + auto-submit at threshold, shuffle, availability window, questions-per-attempt) and has real-attempt canary evidence from Phase 3 (integrity events recorded). The owner-facing quiz settings surface is real-browser-verified (time limit, hide-timer, late policy, attempts, shuffle, questions-per-attempt, grading, integrity all configurable). **The one remaining piece is a NON-canary learner-attempt visual check (a learner watching the countdown / triggering integrity), which is browser-blocked by an externally-unavoidable credential constraint: the learner portal is a separate origin (`<slug>.atlass.dpdns.org`) with per-origin localStorage, so it needs a password sign-in, and the safety rules forbid entering passwords / creating accounts. This is the standing Phase-3 "learner Chrome journeys need a person" limitation, not a code gap.**
- **Issue E** (hosted-video direct upload) — backend error-mapping bug FIXED and deployed (an unconfigured tier now returns `videoNotEnabled` 403, not a 500; 8/8 spec). Root cause verified from source: a **frontend gap** (the dashboard uploads video via the base64 media endpoint, which rejects video; the backend's direct-upload flow — R2 presigned PUT for the normal tier, Cloudflare Stream for premium — exists but is never called). A Growth free trial IS entitled to the normal tier, so entitlement is not the blocker. **End-to-end is blocked by an externally-unavoidable infrastructure gap PLUS a frontend build:** `FLAG_VIDEO_NORMAL_MODE` is off (needs `gh variable set`, and no repo variable is set), and provider delivery config (`BASIC_VIDEO_DELIVERY_HOST`, `BASIC_VIDEO_SIGNING_SECRET`) is unset in production. Video upload is an OWNER action (dashboard), so once those are set I can build the frontend direct-upload wire-up and verify the full owner upload → provider acceptance → processing → lesson attachment → learner playback myself. Building the frontend blind now would ship code that cannot be end-to-end verified (against the production-safety rule) and would stay inert behind the off flag.

**Phase 3 is NOT marked complete.** Everything implementable and verifiable under the available authorization/infrastructure is done, deployed, and (where reachable) real-browser-verified. Two items remain, both gated by externally-unavoidable constraints, not code: (1) the non-canary learner-attempt VISUAL check for B/C/D (credential/session — needs a real learner sign-in a person must perform); (2) Issue E hosted-video END-TO-END (needs `FLAG_VIDEO_NORMAL_MODE` + `BASIC_VIDEO_*` provider config, after which the frontend wire-up will be built and verified). Phase 4 stays CLOSED until these are resolved or the owner accepts them as documented external blockers.

### Phase 4 — record
- Status: **IN PROGRESS** (authorized 23 Sep 2026, DL-40). Increments delivered and deployed so far, in dependency order:
  1. **Schema foundation** (`de3e04f`, migration `20261012000001_p64_phase4_catalog_reviews`, applied via owner-approved `production-migrations` run `35832583076`). `Course` gained `level`/`language`/`outcomes`/`requirements`/`introVideoAssetId`; new `CourseReview` model with `@@unique([courseId, studentId])`; enums `CourseLevel`/`CourseReviewStatus`; `course_is_published_public` SECURITY DEFINER helper + 9 RLS policies on `course_reviews`. Also fixed a pre-existing CI-breaking migration-ordering bug (palette migration `20260923021943` sorted before the phase-3 tables it referenced) — verified by a full `migrate reset` replay (clean).
  2. **Public catalog v2 read path** (`b506d3e`, no migration; push-deploy `35834744872` success). `CourseResponse` now returns level/language/outcomes/requirements/introVideoAssetId; `GET /public/websites/:academyId/courses` gained level/language/priceMin/priceMax/ids filters, a `price` sort key, and description-spanning search (title + shortDescription + description), still hard-scoped to published+public. e2e `test/p64-phase4-catalog.e2e-spec.ts` (8 specs green against real Postgres + RLS).
  3. **Catalog authoring (write path)** (`1f5032c`, no migration; push-deploy `35836345426` success). `CreateCourseDto`/`UpdateCourseDto` accept level/language/outcomes/requirements/introVideoAssetId with bounds (shared constants); `CoursesService.create`/`update` persist them (list fields replaced only when the key is sent; introVideoAsset connect/disconnect). e2e in `test/courses.e2e-spec.ts` (create round-trip, update+clear, validation 400); full course suite 46 green.
  5. **Course reviews — public surface** (`65421c3`, no migration; push-deploy success). `GET /public/websites/:academyId/courses/:courseId/reviews` (approved only, paginated) and `.../rating` (mean + per-star histogram over approved reviews), wired through `PublicWebsiteService` so they inherit the serving-eligibility gate and require the course to resolve as published+public (defense in depth beyond `course_reviews_public_select` RLS; also canonicalises a slug). A visible course with no approved reviews returns a real zeroed rating; a draft/private course returns 404. e2e added to `p64-course-reviews.e2e-spec.ts` (now 13 specs green). **Prod-verified live on canary `60037b11…`:** reviews list 200 empty, rating summary 200 zeroed (`averageRating:0,totalReviews:0`), unknown course id 404.
  4. **Course reviews — authenticated surface** (`ba099dd`, no migration; push-deploy `35838833679` success). Learner authoring (create-or-replace one review per course+student, requires active enrollment, always lands `pending`, body sanitized at rest; PATCH/DELETE/GET `.../reviews/mine`) and staff moderation (instructor/owner/administrator/manager: `.../reviews/moderation` all-statuses list, approve/reject, remove). All under `runInUserContext` so the service guard (`assertActiveEnrollment`/`assertCanReviewCourse`) and the `course_reviews_*` RLS policies are two independent gates. Inserts use scalar FKs (a student can't SELECT the academy row a nested connect would probe). e2e `test/p64-course-reviews.e2e-spec.ts` (10 specs green): create→pending+/mine, non-enrolled 404, re-post replaces+resets, edit+delete, list/approve/reject+status filter, instructor moderates but plain learner 404, cross-academy isolation, sanitization, rating-range 400, auth-required 401. Prod: all four review routes return 401 (deployed+guarded); the learner/moderation flows are e2e-proven (curl can't exercise them on prod under the email-acceptability/password constraints).
- **Production verification (real prod data, 23 Sep 2026):** the catalog v2 read contract and every new filter are confirmed live against the serving canary academy `60037b11…` at `https://atlass.dpdns.org/api/v1/public/websites/<id>/courses`: the real "P3 Validation Course" renders the new fields (`outcomes:[]`, `requirements:[]`; `level`/`language` omitted because unset→undefined); `level`/`language` filters exclude the unset course (0); description/shortDescription search matches "validation"/"certificate" (1) and excludes a non-match (0); `priceMin` excludes the free course (0); `ids` includes the real course id (1) and excludes a random uuid (0); `sortBy=price` accepted (1). **Not separately verified:** rendering *non-null* level/language/outcomes on a *production* course — the canary course predates authoring and I have no canary-owner credentials, and provisioning a throwaway trial academy is blocked by the production email-acceptability control (`EmailRiskService` rejects disposable domains; a real third-party domain would email a stranger). The write path is instead e2e-proven against the real DB. Recorded honestly; not marked prod-data-authored-verified.
- **Frontend increments delivered (atlas-front, `main`, UI/UX skill applied; each typecheck+lint clean, deployed):**
  - **F1 — Course-details revamp** (`be00694`). `Course` type + public data layer (reviews/rating/recommendations service+keys+hooks, `review.types.ts`); shared **StarRating** (readonly labelled image + interactive keyboard radiogroup, 5 unit tests); `CourseReviews` (aggregate + histogram + approved list), `RelatedCourses`; `CourseDetailsTemplate` now shows level/language badges, "What you'll learn"/Requirements, reviews, related courses. EN+AR (AR full plural set), RTL-safe.
  - **F2 — Dashboard catalog authoring** (`27fa0ad`). `CourseEditPage` "Catalog details" card (level select, language, outcomes/requirements one-per-line textareas → arrays on submit); create/update schemas+payloads+constants extended. **Prod-verified live** on the owner dashboard (Arabic/RTL) — read-only, nothing saved.
  - **F3 — Learner review authoring** (`fdc9480`). `CourseReviewService` + `useMyCourseReview`/`useSubmitMyReview`/`useDeleteMyReview`; `MyCourseReviewForm` on the details page (auth+enrolled only; reuses interactive StarRating; status badge; "submitted for review" copy). EN+AR.
  - **F4 — Review moderation dashboard** (`46c8cd9`). New **Reviews** course-editor tab + route (`instructor.course.view` audience, server-enforced); `CourseReviewModerationService` + hooks; `CourseReviewsModerationPage` (status filter, paginated cards, approve/reject/remove with destructive confirm). EN+AR. Reviews feature now complete end-to-end (author → moderate → display). **Prod-verified live** (read-only) on the owner dashboard: the Reviews tab, status filter and empty state render correctly in Arabic/RTL.
  - **F5 — Student checkout** (`8371466`). Closes the paid-course dead-end: `CourseOrderService` gains createOrder (idempotent) / getOrder / createPayment / getPayment / submitProof (base64 data-URL proof, no new endpoint) + course-order payment types; `useCourseCheckout` hooks; `CourseCheckoutPage` (`/my/courses/:courseId/checkout`) — order summary, payment-method choice (**originally reused the platform catalog — a defect: that route is management-surface-only, so no learner could ever see a method; corrected 24 Sep to the learner-scoped `GET /course-orders/:id/payment-methods`**), manual-transfer proof upload, "submitted for review" confirmation, honest "not available for purchase yet"/"already own it" states; `CourseDetailsTemplate` paid CTA → "Buy this course" → checkout. EN+AR. Signed-in flow **now browser-verified end to end by J6** (24 Sep), which is what exposed the payment-method defect above.
  - **Frontend baseline note:** `atlas-front` `main` carries a **pre-existing 34-error `tsc` baseline** in unrelated `platform-add-ons`/`platform-zoom`/some tests (builds via esbuild regardless); every increment above was checked for **zero new errors** and no error in a touched file.
- **Hardening — S11 byte-range media (`ee9b517`, no migration; deployed).** The public media route (`GET public/media/academies/:id/:file`) now honours a single `Range: bytes=…` header (RFC 7233): 206 + `Content-Range` + slice for a satisfiable closed/open/suffix range, 416 + `bytes */<size>` past the end, malformed/multi-range ignored → whole file (200), `Accept-Ranges: bytes` always. Enables audio/video seeking. `parseByteRange` pure/exported; unit spec (10 cases) + 5 media e2e against real MinIO storage, all green. Immutable-cache / nosniff / traversal guarantees untouched.
- **Observability + retention (worker `p4-obs-retention` → merge `16aeaeb`, lead-audited; §D.5/§U).** Five new Prometheus series on the EXISTING `LearningMetricsService`/`/metrics` (platform-owner-only): `atlas_checkout_orders_total{state}` (created/pending_payment/paid/expired/refunded emitted at the real transition sites; `cancelled` has no emitting path in the codebase yet), `atlas_checkout_approval_latency_seconds` (proof `uploadedAt` → approval, observed post-commit), `atlas_public_catalog_query_duration_ms`, `atlas_retention_sweep_pruned_rows_total{table}`, `atlas_retention_sweep_runs_total{table,result}`. `quiz_attempt_events` 180-day prune added to the maintenance sweep beside the 90-day `content_access_log` prune. **Pre-existing production defect found and fixed:** both prunes ran with no RLS context, and a `DELETE … WHERE` needs SELECT visibility, so they silently deleted 0 rows — the Phase 2 `content_access_log` sweep has never pruned in production (lead-verified against every GUC-gated SELECT policy). Fix follows the established sweep precedent (`findFirstPlatformOwnerId` + `runInUserContext`); the `*_retention_delete` policies (`< now()−90d/180d`) remain the independent bound; missing owner → warn + error-run metric + 0, never throws. No schema/migration/RLS change. Unit 14/14, e2e (181d pruned / 179d + fresh kept / idempotent; `/metrics` 401/403/200 with all five series) green; combined backend 55/55 across website/public-website/RLS-website/observability/reports. **Deploy note:** the first production sweep will remove every `content_access_log` row older than 90 days that Phase 2 never did (expected).
- **Course Catalog website section (worker `p4-catalog` → frontend merge `d3258e5`, lead-audited; §E.1) + server acceptance (`9038733`).** New `courseCatalog` section (filterable, server-paginated public catalog: debounced search, level/pricing/sort selects, `usePagination`, `aria-live` result count, level badge + price cards, `linkRenderer` navigation, EN+AR with full Arabic plurals) registered in every `featuredCourses` analog (type union, defaults, metadata/fields registries, zod schema, renderer, config form min/max). Backend mirrors it field-for-field in `section-config.schemas.ts` (+`SECTION_TYPES`, instance union) so an Owner can actually save a page with it; schema spec 43/43. FE: 15/15 component tests, combined website suites 120/120, typecheck at the 34 baseline. Owners add it from the section picker; not auto-placed. **Prod-verified (read-only, live owner dashboard, Arabic):** the Courses page editor's "إضافة قسم" picker lists "دليل الدورات" (Course Catalog) with its icon directly after Featured Courses; the picker was closed without adding or saving anything.
- **Owner reports — backend (`c31b9d1`, no migration, no new RLS; deployed).** `GET academies/:id/reports/integrity` (attempt events: total/counted, distinct attempts, per-type, top courses) and `GET academies/:id/reports/sharing` (content-access decisions: granted/refused, refusals by reason, distinct users/devices, top courses/users — display name only, never email/device/IP), window `days` 1–90 (default 30). Two independent gates that must agree: the service admits the org owner or an ACTIVE academy owner/administrator/manager (exactly `can_manage_academy_students()`'s role set) and 403s anyone else; reads run in `runInTenantAndUserContext` so `quiz_attempt_events_tenant_select` (org GUC) and `content_access_log_manager_select` (user GUC) scope rows on their own. Guards mirror `StudentAnalyticsController` (`JwtAuthGuard`+`ManagementSurfaceGuard`+`AcademyScopeGuard`). Capped reads (50k) aggregated from one snapshot; `truncated` flag. Quota usage intentionally NOT re-implemented — the existing `GET organizations/:id/usage` answers it. e2e `test/p64-phase4-academy-reports.e2e-spec.ts` 7/7 (exact aggregates, old rows excluded at days=90, manager 200, instructor/staff 403, learner/outsider refused, window 400s, 401, no `@` in any body).
- **Alerting rules (`213c711`; §U).** `ops/alerts/atlas-prometheus-rules.yml` — Prometheus alerting rules over every Phase 1–4 series (checkout approval backlog/slow p95>48h/refund spike, public catalog p95>1s, retention sweep failing or silent, grant-refusal surge, video webhook signature failures [critical], quiz-integrity surge, certificate render failures); `alert-rules.spec.ts` (4/4) fails the build if a rule names a series the service does not emit or lacks expr/severity/team/summary. `ops/alerts/README.md` documents the scrape (platform-owner-gated `/metrics`, not on the public edge — confirmed: the edge `/metrics` is the SPA shell) and the Alertmanager receiver wiring. **Receiver wiring + the one synthetic fired alert are an infrastructure/owner action on the host** (secrets live there), recorded as OPEN, not fabricated.
- **Platform video minutes / provider health — backend (§E.5).** `GET /platform-metrics/video` (same three guards as the overview: `JwtAuthGuard`+`ManagementSurfaceGuard`+`PlatformOwnerGuard`): stored minutes/GB and asset counts per security tier (`normal`/`premium`/`none`), assets per provider (`r2`/`r2_worker`/`cloudflare_stream`), processing pipeline counts (`pending`/`processing`/`ready`/`failed` — the provider-health signal). Kept as a SEPARATE response because the seven-KPI overview contract forbids new fields. Counts only — no tenant names or asset ids (asserted). **Requires migration `20261012000002_p64_phase4_media_assets_platform_select`:** `media_assets` had no platform-owner SELECT policy (tenant/lesson-access/uploader/review only), so the read saw zero rows; the migration adds the read-only `media_assets_platform_select` (`is_platform_owner`) mirroring P15's `courses_platform_select` — additive, idempotent, no write widening. Applied locally via `migrate deploy`; e2e 2/2 (exact per-tier/provider/processing deltas, image + archived assets ignored, 403/401) + analytics regression 23/23. **Production application is gated on the owner-approved `production-migrations` run (dispatched); until approved, backend push-deploys are refused by design.** Frontend card pending (queued after the in-flight frontend workers integrate).
- **Owner Reports page — frontend (worker `p4-reports-page` → merge `6e35397` + lead fix `810eada`, lead-audited; §E.5).** `/dashboard/academy/:academyId/reports` with a 7/30/90-day window: Integrity (headline metrics, per-type breakdown, top courses), Sharing (granted/refused, refusals by reason, distinct users/devices, top courses, top learners by display name only), Quota (reuses the existing tenant-usage hooks/utilities — no math re-implemented). Loading/403-permission/error/empty/truncated states; `<th scope>`, logical props, tabular figures; EN+AR with full Arabic plurals; nav entry + route. **Lead correction:** the worker copied the owner-only `tenant.dashboard.view` gate and flagged it; changed to `academy.view` (owner + manager) to match the backend's owner/administrator/manager rule, which the server still enforces. 11/11 component tests; typecheck at baseline; deployed. **Prod-verified (read-only, live owner dashboard, Arabic/RTL):** the new "التقارير" nav entry is present and active, the 30-day window selector renders, and both the Integrity and Sharing sections render with honest empty states for an academy with no recorded events — no data was mutated.
- **Accessibility / RTL sweep of the Phase 4 surfaces (§E.6) — code-level audit (no axe/jsx-a11y in the repo).** Across `CourseCatalogSection`, `CourseDetailsTemplate`, `CourseReviews`, `MyCourseReviewForm`, `RelatedCourses`, `CourseCheckoutPage`, `CourseReviewsModerationPage`, `AcademyReportsPage`, `StarRating`: **zero physical-direction classes** (all `ms-/me-/text-start/end` — RTL-safe), every `<img>` decorative with `alt=""`, every decorative lucide icon `aria-hidden`, no `div/span onClick`, no unnamed icon-only controls, labelled form controls, `aria-live`/`role="status"` for result counts and truncation notices, `role="img"`/`radiogroup` semantics on `StarRating` (unit-tested). **Runtime RTL verified in production (Arabic)** on the owner dashboard: catalog-metadata authoring card, review moderation page, editor section picker. **Known nit (recorded, not hidden):** the shared `CardTitle` primitive renders `h3`, so card-based pages (checkout, reports) go `h1 → h3` — a pre-existing dashboard-wide pattern (Student Analytics does the same), not introduced by Phase 4; fixing it means changing the shared primitive, queued as a follow-up rather than done mid-phase. Public catalog/learner RTL could not be viewed live (no published site has the section placed; learner session constraint).
- **Remaining Phase 4 scope — reassessed 24 Sep 2026 against the repository, not against the phase reports.**

  **Done and verified since the previous version of this list** (it was stale): the platform video card, the observability metrics, the Range/retention hardening, the a11y/RTL sweep, the owner reports page, the public catalog page (`/courses` — J6 drives its heading, live result count, level filter and search in a real browser), and the Playwright journeys J5/J6. An **adversarial pass** was added (`test/p64-phase4-adversarial.e2e-spec.ts`, 8/8): forged `status` on review create refused and nothing written, forged price on order create refused, the catalog `ids` filter unable to surface a draft/private/other-academy course, a pending review invisible and rating-neutral, a stranger 404'd on another buyer's order / payment / methods / pay / proof, and a buyer 403'd approving their own payment with no enrolment side effect.

  **Genuinely open, with the reason each is open:**

  1. **Course preview — DELIVERED 24 Sep 2026, and the earlier "blocked" reading of this item was wrong in an instructive way.**

     The first pass looked only at `Course.introVideoAssetId` — a marketing trailer on the course record — concluded no public video asset could exist, and recorded the whole item as blocked. That was true of the trailer column and false of the FEATURE. The product already had a preview mechanism, at the lesson level, and the schema says so in its own words: `CourseLesson.isPreview` is "the sample a prospective student watches before buying", and `LessonContentService.getContent()` short-circuits on `isOpenPreview` (lesson `isPreview` + lesson published + course published), skipping identity, enrolment and suspension, behind `OptionalJwtAuthGuard`. The server had always been willing to serve a preview to an anonymous visitor. Nothing on the marketing page could name which lesson that was, because the public curriculum never projected the flag.

     Delivered, end to end: the public curriculum now publishes `isPreview` (backend `94ae528`), the public Course Details page offers a labelled Preview control on those lessons and plays the sample in a dialog with no account at all (frontend `fe56fb5`). `CoursePreviewDialog` reuses `useLessonGrant` — one place that knows how a credential expires and how a refusal is classified — and deliberately does NOT reuse `ProtectedVideoPlayer`, which needs watermark text, a resume position and credential-failure callbacks; an anonymous visitor has no identity to watermark and no progress to resume, and inventing those to satisfy a prop type would put a claim on screen nothing backs. A YouTube preview goes through the existing vetted-id player, so the frame is still built from the server-checked video id on `youtube-nocookie.com` and never from a raw URL.

     It needs NONE of the blocked video infrastructure, which is the whole reason it is finishable: a preview is public marketing content Atlas does not host or protect, so an `external` embed is the honest carrier.

     **Security property pinned, not assumed:** every refusal reads identically to a visitor. `refusalToHttp` answers an unreachable lesson with 404 rather than 401/403 precisely so a preview flag cannot be turned into an oracle for enumerating a paid catalogue's lesson ids, and both the e2e suite and the dialog's own test assert that the reason is never named.

     Evidence: `test/p64-phase4-course-preview.e2e-spec.ts` 5/5 — the advertised lesson plays anonymously, the unadvertised one 404s, and a preview flag on an unpublished lesson or inside an unpublished course advertises nothing and opens nothing. 6 component tests. **J6 gains a real-Chrome journey and now runs 7/7** (J5 3/3 unchanged): an anonymous visitor opens the sample and gets the nocookie embed of the vetted id. **Production-verified:** the live curriculum at `public/websites/60037b11…/courses/4a83b544…/curriculum` returns `isPreview` on real data (the canary's "YouTube Lesson" honestly reports `false`), and the shipped bundle `index-C5cChiNZ.js` contains `previewActionLabel`, `previewDialogTitle`, `previewNotPlayable`, `course-preview-video`, `youtube-nocookie.com/embed` and the `isPreview` gate.

     **What remains genuinely blocked is only the trailer column.** `Course.introVideoAssetId` is still stored, accepted by the create/update DTOs and returned in `CourseResponse`, with no public playback path — and it cannot have one while no public video asset can exist (`file-validation.util.ts` allows JPEG/PNG/GIF/WebP/PDF and no video kind; `ProtectedMediaService` creates `access: 'protected'`; the public media route has no video content type; `FLAG_VIDEO_*`, `BASIC_VIDEO_*` and both Cloudflare Stream variables are UNSET). That is the same owner/infra action as DL-40 blocker (2). It is a redundant second route to a capability the product now has, so it is recorded rather than built.

  2. **Alert receiver wiring + one synthetic fired alert** — infrastructure/owner action on the host, where the Alertmanager secrets live. The rules and their drift-guard spec are committed (`ops/alerts/`).
  3. **`catalog.v2` / `checkout.student` global flags and the §T video-flag rollout** — owner action in a protected environment.
  4. **J1-J4 cannot run in this checkout** — pre-existing and unrelated to Phase 4. `npm run db:seed` creates the seeded academy but no website/subdomain allocation row, so `web-development-academy` 404s on resolve. J5/J6 sidestep it by provisioning their own academy. Fixing the seed is the right remedy and is not Phase 4 scope.
  5. ~~The `h1 → h3` heading nit~~ **FIXED 24 Sep 2026** (frontend `fc9f7e7`). `CardTitle` now takes an optional `as` level, defaulting to the `h3` it always emitted, so all 77 call sites are unchanged. Changing the DEFAULT to `h2` would have been the wrong fix — a card nested inside an `h2` section is correct at `h3`, and a primitive cannot know where it sits; the page can. Applied where the skip actually was: the learner checkout's six cards, and the platform video card, which now outranks the `h3` subsections it contained (title and subsections previously shared a rank). **The earlier note was imprecise on one point:** `AcademyReportsPage` was never affected — it composes `SectionCard`, which already renders `h2`, so it was `h1 → h2 → h3` all along. 4 tests pin the contract, including that the default is untouched and that styling does not vary with the level. **Prod-verified:** the shipped `CourseCheckoutPage-C8BDDwh0.js` carries exactly 6 `as:"h2"` and `PlatformDashboardPage-CNOw_Ky4.js` carries 1.

  **Audit outcome (24 Sep, DL-42):** two further product gaps were found by opening production and are now closed and production-verified — the Courses page not being the catalog (template + data migration + list contract + cards) and the Platform Owner having no destination for the Phase 4 operational signals (Analytics → Commerce / Content delivery). The owner-facing walk-through is `docs/PHASE_4_FEATURE_VERIFICATION_GUIDE.md`.

  **Phase 4 is still NOT complete**, but what remains has changed in kind. With the course preview delivered, no substantive product gap is left in this phase's scope: items 2 and 3 are owner/infrastructure actions in environments this session cannot reach (Alertmanager receiver secrets on the host, and a protected-environment flag rollout), item 4 is a dev-seed fixture gap unrelated to Phase 4, and item 5 is a pre-existing dashboard-wide accessibility nit. None of those can be closed by writing code here, and none will be reported as closed on the strength of anything but real evidence. The phase stays open until the owner-gated items are actually done.

#### Production product audit (24 Sep 2026, real Chrome, owner-directed)

Method: opened production as a human would — the platform host with the Client Owner session already present in the browser, and the academy site `https://ssfsdf3232.atlass.dpdns.org/` anonymously (EN and `/ar`). Every dashboard page inspected made only 2xx API calls (58 requests captured: reports integrity/sharing, usage, members, website, course, all 200); the single recurring non-2xx was `GET /api/config → 404` on every page load — a frontend runtime-config probe with no backend route, fixed (frontend `c07fff1`). No console errors on any inspected page.

| Role | Surface | Route | Phase 4 expectation | Seen in production | Verdict |
|---|---|---|---|---|---|
| Anonymous | Courses page | `/courses` on the academy site | server-paginated catalog, search, filters, sort, RTL grid, preview badges, rating | "OUR COURSES" + one oversized card, no controls, no metadata (EN and AR identical) | **P1 gap → fixed** (template + data migration + cards) |
| Anonymous | Course details | `/courses/:id` | single state-aware CTA, level/language, outcomes, requirements, reviews, related, preview | CTA correct ("Sign in to enroll" for paid+anonymous), curriculum accordion; every Phase 4 block hidden because the owner authored no metadata and there are no reviews/preview lessons | COMPLETE, silent-when-unauthored (by design for visitors; owner discoverability handled via catalog + guide) |
| Anonymous | Sign-in / Sign-up | `/sign-in`, `/sign-up` | learner entry on the academy host | correct forms, cookie consent, AR toggle | COMPLETE |
| Client Owner | Dashboard | `/dashboard` | unchanged by Phase 4 (executive overview) | KPIs, plan usage, revenue block | EXPECTED |
| Client Owner | Course editor → Details | `…/courses/:id` | catalog metadata authoring | "تفاصيل الفهرس" card: level, language, outcomes, requirements | COMPLETE |
| Client Owner | Course editor → Reviews tab | `…/courses/:id/reviews` | moderation | tab present ("التقييمات") | COMPLETE (empty for this owner) |
| Client Owner | Reports | `…/reports` | integrity / sharing / quota | nav entry "التقارير", window selector, honest empty states | COMPLETE (content-free with 0 students, which is why it "looks unchanged") |
| Client Owner | Members / roster, Settings, Website pages/builder | various | Phase 1/2 surfaces intact; builder lists Course Catalog block | all render; Courses page listed and visible | COMPLETE |
| Instructor (same session) | Teaching dashboard | `/dashboard/instructor` | unchanged | renders with honest empty states | EXPECTED |
| Platform Owner | Dashboard / Analytics | `/dashboard/platform`, `/dashboard/analytics/*` | video minutes + provider health; checkout/approval/catalog/retention observability | code: one video card on the dashboard; the other metrics exist only as Prometheus series | **P2 IA gap → Analytics "Commerce" + "Content delivery" tabs** (in progress) |
| Learner | `/my/*`, player, checkout, purchases, devices, certificates | academy site | full learner journey | not browser-auditable here (no learner session; passwords may not be typed) — verified by J5/J6 in local real Chrome against the same code | BLOCKED in production (credential), verified locally |

Feature-flag audit: backend `FLAG_*` (learner dashboard v2, player v2, content protected, video normal/premium, devices policy, quiz engine v2, quiz integrity, certificates) gate backend behaviour only; the frontend reads no dynamic flags. `catalog.v2` and `checkout.student` do not exist in either repo — the Phase 4 catalog, details, preview, checkout, reviews and reports UI is ungated by construction (DL-42).

#### Running the Playwright journeys locally (24 Sep 2026)

The dev server must serve the API **same-origin**, exactly as production
does (`.env.production` sets `VITE_API_BASE_URL=/api/v1`):

```
BACKEND_PORT=3000 VITE_API_BASE_URL=/api/v1 npx vite --port 3001 --strictPort
E2E_BASE_URL=http://localhost:3001 E2E_ACADEMY_SLUG=<provisioned slug> \
  npx playwright test e2e/j5-revocation.spec.ts e2e/j6-phase4-commerce-discovery.spec.ts
```

Two environment facts cost real time and are recorded so they do not again:

- **`CORS_ALLOWED_ORIGINS=http://localhost:3001` only.** A dev server on any
  other port is CORS-blocked and the public site renders "Temporarily
  unavailable" — which looks exactly like an academy-resolution failure and
  is not one.
- **Cross-origin dev drops the `atlas_device` cookie.** axios defaults to
  `withCredentials: false`, so a frontend on `:3001` calling the API
  directly at `:3000` never sends it. The grant path then registers a NEW
  device per request and the third is refused with `deviceLimit`
  (cap 2). Running same-origin through the `/api` proxy — the production
  topology — removes this entirely. **Not a production defect**: production
  serves the API same-origin.

**Open, recorded, not fixed:** the content-grant path calls
`StudentDeviceService.resolveForSession`, which returns an
`issueCookieValue` for a newly registered device, but only the auth
controllers turn that into a `Set-Cookie`. A learner who clears cookies
while keeping their `localStorage` session therefore burns one device slot
per grant until the cap refuses them; recovery exists (remove a device
under `/my/devices`) and signing in again re-issues the cookie, so this is
a robustness gap rather than a lockout, and it is left for a decision
rather than folded silently into Phase 4.

**J1-J4 remain unrunnable in this checkout** — pre-existing and unrelated to
the above. `npm run db:seed` creates the seeded academy but no website /
subdomain allocation row for it, so `web-development-academy` 404s on
resolve. J5/J6 sidestep it by provisioning their own academy. Fixing the
seed is the right remedy and is not Phase 4 scope.
- **Browser-verification reality (honest):** the public course-details revamp could not be browser-verified because the canary academy's public website is not published (every path 404s) and I did not mutate the user's real production course to seed data without permission; it is code/type/unit-verified and composes public API endpoints already live-verified. The dashboard authoring card WAS prod-verified (read-only). Checkout/review-authoring/moderation signed-in flows are not browser-verifiable under the learner-session constraint; they are code/type-verified with the backend e2e-verified.

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

Cloudflare Stream official documentation verified (applies to the **Premium** tier; see `ATLAS_VIDEO_PROVIDER_TIERS_INVESTIGATION.md` for the Normal tier's evidence and for finding D-5, which corrects what these tokens actually enforce): signed tokens (`exp` ≤ 24 h, `nbf`, `downloadable`, `accessRules` ≤ 5), local signing keys (≤ 1,000, not rate-limited), allowed origins with wildcard caveats, direct creator uploads (`maxDurationSeconds` reservation; 200 MB basic / TUS), MP4 downloads opt-in and token-gated, static PNG watermark profiles applied at upload, webhook HMAC-SHA256 signature, HLS/DASH manifests never cached, $5 per 1,000 stored minutes and $1 per 1,000 delivered minutes (external billing facts only, never encoded in Atlas), 30 GB max upload, **no DRM in docs, FAQ or changelog**.

Code locations: `src/identity/services/auth.service.ts`, `src/identity/dto/contracts.ts`, `src/tenancy/guards/saas-level-caller.guard.ts`, `src/academy/guards/academy-scope.guard.ts`, `src/academy/services/academies.service.ts`, `src/course/services/course-curriculum.service.ts`, `src/learning/services/learning-access.util.ts`, `src/learning/services/quizzes.service.ts`, `src/learning/services/course-progress.service.ts`, `src/learning/services/assignments.service.ts`, `src/instructor/services/instructor.service.ts`, `src/dashboard/services/student-analytics.service.ts`, `src/media/controllers/public-media.controller.ts`, `src/plans/dto/entitlement.types.ts`, `prisma/schema.prisma`, migrations p6/p7/p13/p21/p22b/p24/p24c/p27c/p30; `atlas-front/src/app/routes/*`, `src/app/navigation/navigation.config.ts`, `src/features/auth/*`, `src/features/public-website/*`, `src/features/academy/pages/AcademyMembersPage.tsx`, `src/features/learning/*`, `src/features/website/renderer/*`.

---

# PHASE 2 CLOSEOUT — 20 September 2026

## Status: DEPLOYED AND PRODUCTION-VERIFIED

Superseding the earlier record of "IMPLEMENTED AND VERIFIED LOCALLY — NOT
DEPLOYED". Phase 2 is live on production and its protected-video path has
been exercised end to end against the real deployment.

## 1. Deployed and verified in production

| Item | Evidence |
|---|---|
| Backend revision | `4632fbf` (image tag verified in the deploy log) |
| Frontend revision | `09ba905` |
| Migrations | **103 → 108**; all five Phase 2 migrations applied by name, then `Backend healthy.` |
| Six plan variants | `/api/v1/public/plans` returns 6 with `family`/`tier` and 500 / 2,000 / 5,000 minutes, identical across both families |
| Protected R2 | dedicated single-bucket token; protected upload 201, `access: protected`, **no durable URL** |
| Public R2 | unaffected by the credential split — 201 with a durable URL, same academy, same moment |
| Video upload → complete | `durationSource: parsed` — the server measures the container rather than trusting the client's declared ceiling (D-4) |
| `videoAssetId` attach | 200, academy-scoped |
| **Lesson content authoring** | **200** — the writer `lesson_contents` never had |
| **Learner grant** | **404 before authoring → 200 after**, same learner, same request |
| **Worker delivery** | **200, 2,437 bytes, `content-type: video/mp4`**, valid `ftyp` header, from `atlas-media-prod-protected` |
| Device / session model | Devices page shows the cap ("1 of 2 · Platform default") and the lease ("Limit: 1 learning session at a time") |
| Surface isolation | learner `/dashboard` → 404; staff login states "Students sign in on their own academy website, not here" |

### Security controls verified against production

| Control | Result |
|---|---|
| Tampered signature | **403** |
| Forged object key (valid signature, altered claims) | **403** |
| Expired / altered expiry | **403** |
| No token | **401** |
| Cross-academy asset attach | **404** (not 403 — a distinct answer would confirm the id exists) |
| Learner writing lesson content | **403**, zero rows written |
| Public asset as a protected `file` body | **400** |
| Entitlement (`can_access_lesson`) | true only for the enrolled learner |
| RLS | 74 tables FORCE RLS, 0 enabled-but-not-forced; `atlas_app` NOBYPASSRLS, `jit=off` |

## 2. Implemented in this closeout

`PUT /api/v1/academies/:id/courses/:courseId/sections/:sectionId/lessons/:lessonId/content`
(commit `cf760a8`, PR #4, merged as `4632fbf`).

`lesson_contents` shipped with a table, RLS policies, a one-time backfill and
a reader — but no writer. Every lesson created after that migration had no
content row, so `LessonContentService` refused its grant at
`if (!lesson.content)`. The refusal was correct; the row it looks for could
not be created. Attaching `course_lessons.video_asset_id` says which asset a
lesson plays; `lesson_contents` is the row the grant resolves. Both are
required, and only the first had a writer.

Supports `video`, `file` and `external`. Upserts on the UNIQUE `lessonId`, so
one body per lesson is a database fact rather than a convention. No migration
was required.

## 3. Intentionally deferred

- **`kind: text` authoring** — refused with `errors.lessonContent.textNotYetSupported`. The column promises "server-sanitised on write" and this repository has no sanitiser; accepting rich text would mean storing unsanitised HTML behind a field that says otherwise, or inventing a sanitiser under deadline. `bodyHtml` is not on the DTO, so `forbidNonWhitelisted` rejects it before any handler runs. Backfilled text lessons are unaffected. **Needs a reviewed sanitiser (e.g. `sanitize-html`) as its own change.**
- **Revocation before expiry** — `BASIC_VIDEO_REVOCATION_ENDPOINT`/`_TOKEN` are deliberately unset: the shipped Worker accepts only `GET`/`HEAD`/`OPTIONS` and returns **405** to Atlas's revocation `POST`, so there is no HTTP receiver. The capability is therefore reported **false** rather than claimed. Revocation today is the 10-minute token lifetime plus secret rotation. A receiver is a separate change.
- **Premium (Cloudflare Stream)** — architecture and adapter are complete and unit-tested; no `CLOUDFLARE_STREAM_*` credentials are configured, so the tier is unconfigured in production and refuses rather than silently downgrading.

## 4. Implemented but NOT production-verified

- **Premium tier end to end** — blocked on provider credentials, above.
- **Origin restriction** — `ALLOWED_ORIGINS` is empty (allow-all) and `BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED` is unset, so the grant reports `originRestricted: false`. Honest, but unexercised.
- **Learner Chrome flow on the Normal tier** — the API path is fully verified; the browser player was exercised on a text lesson in an earlier round, not on a playing protected video.

## 5. Outside Phase 2

- **`search_vector` schema defect.** Migration `20260922000000_p44` drops the `search_vector` columns that `search.repository.ts` still queries; nothing restores them. On a database built from the migration chain, `GET /search` returns **500** for every query (7 e2e tests). p44 predates Phase 2 by weeks. **Production status UNKNOWN** — the running database may carry the columns out of band ("long-known raw-SQL `search_vector` items" appear in `prisma migrate diff` drift). Needs its own migration and its own PR. **RESOLVED 21 Sep 2026** — production was confirmed missing all four columns and indexes (p44 applied 13 Sep 2026); fixed by P65 on branch `fix/p44-search-vector-restore` (see the Implementation Change Log entry of that date); deployment goes through the gated migration path.
- **Pre-existing e2e flakes** — `media` and `p53-support-attachments` oversized-payload tests; pass in isolation, fail late in a long run. Three hypotheses tested and disproved (regex, heap ceiling, DB size). Mechanism open.
- **Test-environment limits** — the dev database is never reset (`maxWorkers: 1`, no `globalSetup`), and a full suite exhausts Node's default heap around suite 106/116. Do **not** raise transaction timeouts, sweep batch sizes or page sizes to make accumulation-driven failures green.

## 6. Remaining before Phase 3

1. Deploy the Worker's KV namespace ids into version control (currently placeholders in `wrangler.toml`; the live Worker has real ones).
2. Decide on the `text` sanitiser.
3. Decide whether revocation-before-expiry is required for launch; if so, build the HTTP receiver.
4. Configure Premium credentials if Premium is to be sold.
5. Resolve `search_vector` — separately. **Done (P65, 21 Sep 2026); awaiting the gated migration deploy.**
6. Staff authoring **UI** (this closeout delivered the API only).

## 7. Test counts at closeout

- Phase 2 e2e: **138/138** (was 128; +10 covering the regression, idempotency, cross-academy refusal, learner 403 and each kind's validation)
- Backend unit: **1238/1238**
- Typecheck: **0 errors**
- Full backend e2e on a clean database: **1290/1299**, the 9 failures being `search` (7, above) and the two pre-existing flakes

## 8. Environment changes made to production

Added: `R2_PROTECTED_BUCKET`, `R2_PROTECTED_ACCESS_KEY_ID`,
`R2_PROTECTED_SECRET_ACCESS_KEY`, `BASIC_VIDEO_DELIVERY_HOST`,
`BASIC_VIDEO_SIGNING_SECRET`, `VIDEO_PROVIDER=r2_worker`.
`FLAG_VIDEO_NORMAL_MODE` is **off** — the smoke test scoped it to one
disposable academy and it was reverted immediately afterwards. Public R2
credentials were never touched. Every edit took a timestamped `600 root:root`
backup first.

---

# PLATFORM OWNER OBSERVABILITY CENTER — 26 September 2026

## Status: COMPLETE IN PRODUCTION (26 Sep 2026)

Detail: `PLATFORM_OWNER_OBSERVABILITY_GUIDE.md` (operations) and
`PLATFORM_OWNER_OBSERVABILITY_HANDOVER.md` (implementation). No secret
value is recorded anywhere.

### What was delivered

- **Four Platform Owner pages**, EN/AR, behind Platform-Owner-only route
  guards (frontend `174cfd9`, merged `6c72bb0`):
  - System Health;
  - Alerts Center, including the rule detail and timeline that Slack links
    open;
  - System Metrics;
  - Monitoring & Alert Configuration.
- **Backend API** at `/api/v1/platform-observability/*`, guarded by
  JWT + ManagementSurface + PlatformOwner:
  - health probes;
  - alerts: Alertmanager current state, rule pending state, and 15-day
    history from `ALERTS`;
  - rule detail;
  - allowlisted metric catalog (38 ids, no PromQL from the browser);
  - configuration, reporting secrets as present/absent only;
  - audited synthetic alert.
- **New metrics:** HTTP metrics plus dependency, queue and Redis metrics
  collected at scrape time.
- **Alert rules:** 24 in total. The new `atlas-platform` group has seven,
  and every rule now carries `threshold` and `current_value` annotations.
- **Monitoring stack:** production Prometheus and Alertmanager, internal
  only, under compose profile `monitoring`. Slack delivery goes through
  `api_url_file`.
- **Migrations:** none.

### Production environment configuration

- **Slack webhook.** `ALERT_SLACK_WEBHOOK_URL` is an owner-created Actions
  secret, synced by name through the existing deploy fragment into
  `/opt/atlas/.env`.
- **Scrape token.** `METRICS_SCRAPE_TOKEN` was absent from production.
  `deploy.sh` generated it on the host without printing it (deploy run
  186).
- **Verification workflow.** `Observability verify` (workflow_dispatch)
  runs checks on the VPS and prints PASS/FAIL only.

### Verification evidence

**Production checks-only** (runs 36227614339 and 36229796544): 0 failures.
- Both secrets are present, stored as 0444 files in a 0700 directory, and
  match `.env`.
- `/metrics` returns 401 without a token and 401 with a wrong token.
- Prometheus scrapes Atlas with the token, and all 24 rules are healthy.
- The Slack receiver is loaded, and the webhook value does not appear in
  Alertmanager's status.
- The observability API returns 401 to anonymous callers.
- Neither secret appears in the backend, Prometheus or Alertmanager logs.

**Production synthetic alert** (run 36229796544, 26 Sep 2026):

| UTC | Event |
|---|---|
| 08:26:59 | armed |
| +61 s | Prometheus firing |
| +1 s | Alertmanager active |
| 08:28:31 | Slack accepted FIRING, 0 delivery failures |
| 08:28:31 | disarmed |
| +62 s | cleared |
| 08:33:26 | Slack accepted RESOLVED, 0 failures |

`ALERTS` history recorded the episode, which is what the Alerts Center reads.

**Local end-to-end** (real Prometheus and Alertmanager):
- The same chain ran with a Slack-format receiver, and the payload
  carried the Atlas rule-page link.
- The Alerts Center API showed the resolved episode.
- A Slack failure mode gave bounded retries, a redacted URL,
  AtlasAlertDeliveryFailing, and Atlas stayed healthy.

**Browser checks** (Chromium, local stack): all five routes in EN and AR
at 1440 and 390 px, with RTL applied, no horizontal overflow, no raw i18n
keys and no unnamed buttons.

**Tests:**

| Suite | Result |
|---|---|
| Backend observability unit | 53/53 |
| Observability e2e | 6/6 |
| Related e2e | 5/5 |
| Frontend | 1018/1018 |
| Frontend typecheck | 34-error baseline, unchanged |

The one vitest worker-RPC timeout reproduces on the pre-change commit, so
it is pre-existing.

**Security review:**
- Server-side Platform Owner authorization is covered by the e2e matrix.
- There is no SSRF surface: source URLs come from server env only.
- There is no PromQL injection: ids and rule names are validated.
- There is no secret in any API response, log, bundle, document or Git.
- Tenant names are resolved only for IDs on alert labels, in the
  Platform Owner's RLS context.

### Defects found and fixed during verification

- **Alert history lost episodes.** History was rebuilt at the chart step,
  which dropped short episodes and merged nearby ones. Fixed in `709bf34`.
- **Empty error rate.** An API with no errors showed "not reported"; it
  now shows 0 %. Fixed in `709bf34`.
- **Wrong Slack counts.** Counts were fractional and included failed
  attempts. Fixed in `a9a22e9`.
- **Redeploy failed** on the 0444 secret files. Fixed in `d7e458b`.
- **Synthetic arm rejected.** The verify workflow's arm step was rejected
  by `redis-cli` quoting. Fixed in `09c694f`.

### Manual production verification by the owner (26 Sep 2026)

1. **Slack delivery — DONE.** On 26 Sep 2026 the owner confirmed that
   `#atlas-alerts` shows both
   `[Atlas] [FIRING] AtlasSyntheticAlert (warning)` and
   `[Atlas] [RESOLVED] AtlasSyntheticAlert (warning)`, each with the
   **View alert** action.
2. **Production browser verification — DONE.** The owner verified the live
   production UI in a browser:
   - System Health;
   - Alerts Center;
   - the `AtlasSyntheticAlert` rule detail;
   - System Metrics;
   - Monitoring & Alert Configuration.

   The owner checked these in the responsive and Arabic states and reported
   them working correctly. This check was done by the owner. The cloud
   session could not reach `atlass.dpdns.org` because of its network
   policy, so its own browser checks ran against a local stack.

### Remaining

None for Observability/Alerting.
