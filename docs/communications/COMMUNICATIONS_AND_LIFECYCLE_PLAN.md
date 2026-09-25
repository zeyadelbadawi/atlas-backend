# Atlas Communications, Email Infrastructure, In-App Notifications & Lifecycle Automation — Initiative Plan

**STATUS: APPROVED — IN PROGRESS (owner approval 24 September 2026; see "Approved decisions and execution record" at the end of this document).** Sections §1–§50 and the Owner summary below are the proposal as approved and are preserved as written; implementation status, decisions, evidence and remaining work are tracked in the execution record, which is append-and-update only. The cross-project acceptance layer is `docs/ATLAS_PRODUCT_QUALITY_MASTER_PLAN.md`; every phase here must satisfy it.
No code, migration, schema, provider configuration, cron job, authentication or notification behaviour was changed to produce this document, and no email was sent. It was written from a read-only inspection of both repositories and current provider documentation on 24 September 2026.

**Relationship to Phase 4.** This is a *parallel* initiative. Phase 4 of `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` remains **open / in progress** with every blocker recorded there unchanged (production verification of learner and Platform Owner surfaces, hosted-video infrastructure, alert receiver wiring, the seed fixture gap). Where this plan needs something Phase 4 has not delivered, it is listed in §K as a dependency, not assumed.

---

**How to read this document.** Section numbers follow the owner's deliverable list (1–50) but appear in dependency order, not numeric order: §1–§7 current state · §8–§12 events, matrix, OTP · §16–§25 architecture · §26–§33 lifecycle and retention · §34–§41, §43–§47, §50 security, observability, UX, APIs, schema, jobs, flags, testing, phases · §13–§15, §42, §48–§49 provider comparison, configuration and cost · **Owner summary (A–O)** at the end, with the questions needing approval in O.
## 1. Executive summary

Atlas already has the *skeleton* of a communications system and none of its *muscle*. A `notification-events` module (P17) writes deduplicated in-app notifications inside the caller's transaction and then sends a plain-text email after commit through a thin, replaceable `EmailProvider` interface that has a stub and a Resend HTTP adapter. That is the right shape, and this plan keeps it. What is missing is everything that makes it dependable and controllable at product scale: emails are sent synchronously, un-retried (except password reset), unobserved, un-throttled, English-only for ten of fourteen templates, carry raw tokens instead of links, respect a single global on/off switch, and — as far as the repository can show — **production has never sent a real email**: `EMAIL_PROVIDER` defaults to `stub`, the deploy workflow injects no `EMAIL_*` secret, and the host env is the only place it could be set (owner must confirm, §O-1). Roughly half of the user-significant transitions in the product (enrollment, revocation, course completion, review moderation, payment proof submitted, learner approval/blocking, device events, trial expiry) emit nothing at all, and no lifecycle sequence of any kind exists: the only scheduled lifecycle job flips trials to `trial_expired` silently.

The recommendation is therefore not a rewrite but a deliberate completion of P17's architecture: one typed **communication event catalogue**; a **transactional outbox** written in the same transaction as the business change and drained by one BullMQ worker; per-event **channel policy** (in-app / email / both / digest) with category-aware preferences where security and transactional mail cannot be switched off; **quota-aware email dispatch** with a provider capability model, suppression list, cooldowns and daily caps that protect a free tier; **localized EN/AR templates** with a real link builder and platform/academy branding; **email OTP as step-up authentication on unrecognised devices** rather than on every login; a **tenant lifecycle + hosted-video retention state machine** with staged, auditable warnings and asynchronous, verified deletion; and Platform Owner observability for all of it. Provider: start on a free tier that permits arbitrary recipients and webhooks, behind the existing adapter, with a documented migration to a paid provider when volume or deliverability demands it (§13–§15). Implementation is decomposed into seven phases (§50); nothing here has been built.

## 2. Current-state architecture discovered

Facts below carry file references; "does not exist" statements were verified by search.

**Communication core (backend `src/notification-events`, `src/notifications`, `src/identity`).**
- `NotificationFanoutService` (`notification-fanout.service.ts`) is the single producer API: `notify(tx, input)` inserts a `notifications` row inside the caller's transaction (raw INSERT; `@@unique([userId, dedupeKey])` violation → returns `false`), then `sendEmailAfterCommit(userId, wasNewlyCreated, {template, values})` runs after commit, no-ops on a deduped retry or when `preferences.notifications.email === false`, and calls `EmailService.sendTemplated`, which never throws (send failures are logged and swallowed). It is explicitly synchronous — the P17 note documents "why not a queue".
- `EmailProvider` (`identity/services/email-provider.interface.ts`): `sendPasswordResetEmail`, `sendEmailVerification`, `sendTransactionalEmail({to, subject, text, html?})`. Implementations: `StubEmailProvider` (logs, keeps last message per address for tests) and `ResendEmailProvider` (`POST https://api.resend.com/emails` via `fetch`, no SDK). Selection: `EMAIL_PROVIDER` env (`stub` | `resend`, default `stub`), `EMAIL_API_KEY`/`EMAIL_FROM_EMAIL`/`EMAIL_FROM_NAME` required when `resend` (`env.validation.ts:511-516`). **All four are UNSET in the local `.env`; the deploy workflow injects only Zoom secrets; the repo compose file is the dev stack only — production's value lives solely in the host env at `/opt/atlas`.**
- Templates (`templates/email-templates.ts`): 14 keys, plain `subject`/`text` functions; only `assignment_graded`, `quiz_attempt_graded`, `certificate_issued`, `certificate_revoked` branch on `values.locale === 'ar'`, and the first two are never passed a locale. No HTML, no layout, no branding, no link builder (reset and verification emails contain the raw token as text — `resend-email.provider.ts:32-55`; the frontend reset/verify pages read `?token=` from the URL, so today's email cannot even be clicked).
- Password reset is the one queued email: BullMQ `password-reset-email` (attempts 5, exponential 2 s, `removeOnFail: false`, no dead-letter). Everything else is a direct post-commit call.
- In-app feed (`src/notifications`): `GET /notifications` (paginated, `type` filter), `/summary` (unread counts by type/priority), `/:id/read`, `/read-all`, `/preferences`. Types `system|account|billing|security|activity|announcement`, priorities `low|medium|high|urgent`. Rows are user-scoped only (no tenancy column); RLS `notifications_self_select/update` on `app.current_user_id`, `notifications_system_insert WITH CHECK (true)`, no DELETE policy, no retention.
- Preferences: `users.preferences` JSON `{theme?, language?, notifications?: {email, push, sms}}`; `email` defaults on; `push`/`sms` exist in the DTO/UI with no delivery behind them.

**Producers today (17 call sites, verified).** Platform subscription payment approved/rejected → org owner (email); course-order payment approved/rejected → learner (email); refund completed → learner (email); password changed → self (email, `dedupeKey: null`); support case status/reply → requester; provisioning failed/completed → requester (email); certificate issued/revoked → learner (email, localized); quiz graded / assignment graded → learner (email, English); live session scheduled/rescheduled/cancelled/starting-soon → every enrolled learner (in-app only, by design); recording available → host (email); Zoom deauthorized → org owners.

**Transitions that emit nothing (verified):** free/self enrollment, staff-granted enrollment, enrollment revoked/expiry changed, course order created/expired, payment proof submitted (no staff-side notification exists at all), refund requested, course completion, certificate regenerated, review submitted/approved/rejected/removed, assignment submitted, quiz auto-submit, quiz integrity events (metric only), attempt invalidated, device registered/removed/limit hit, session takeover (audit + metric only), learner created by staff, learner approved/rejected/blocked/unblocked, invite created/revoked, announcements (module exists: `community/services/announcements.service.ts`, audiences platform/academy/course, statuses draft/scheduled/published/archived — zero notification or email code), trial expiry, subscription transitions other than payment review.

**Infrastructure.** BullMQ on the shared Redis (`BullModule.forRootAsync` in `app.module.ts`), 12 processors; repeatable jobs: `p64-phase2-maintenance` every 10 min (prunes `content_access_log` > 90 d and `quiz_attempt_events` > 180 d under the platform-owner context, polls stalled videos, finalises overdue quizzes), subscription sweep (`plans/queue`), domain verification sweep (5/10 min + 1 h/6 h cadences), live-session sweep, quiz deadline, tenant usage recompute, certificate jobs, media processing, payment webhook, provisioning. Global throttler 120/min per client IP (Redis); auth-specific fixed-window limiter (`AuthRateLimiterService`): register 5/h per IP, password reset 5/h per IP and per account, sign-in 10/15 min per IP and per email. `AuditLogWriterService` (in-transaction `write`, `writeBestEffort`) with tenant + platform RLS; no audit retention. `LearningMetricsService`: 22 Prometheus series, `/metrics` platform-owner-gated, 10 alert rules — **no email or notification metric exists**.

**Frontend.** Management topbar bell (link, no popover) → `/dashboard/notifications` (All/Unread tabs only; `actionUrl` never rendered; pagination state exists but no control is rendered; no polling). No learner notification surface at all under `/my/*`; learners see only an announcements block on `/my` overview. Preferences: `/dashboard/profile` (language, theme, email + push switches), platform-owner `/dashboard/settings` (email/push/sms matrix, `supportEmail`, `twoFactorRequired`, `sessionTimeoutMinutes`), `/my/profile` reuses the same section. Security: `/my/security` = change password + sessions + TOTP card; `/my/devices`. Auth: management `/auth/{sign-in,register,forgot-password,reset-password}` (reset token from `?token=`; **no `/verify-email` route on the management host**); academy `/{sign-in,sign-up,forgot-password,reset-password,verify-email}` mounted twice (EN, `/ar`). `input-otp` primitive exists and is unused. Trial lifecycle: `LifecyclePanel` banner with seven states; no gating wall. Announcements authoring (`/dashboard/academy/:id/announcements`) and feed exist. **No Platform Owner surface for provider health, queues or delivery** (the Zoom health pages are the only analogue).

## 3. Existing email capabilities — summary
Provider abstraction: yes (thin, correct layering). Real provider: Resend adapter present, unproven in production, likely never enabled. Templates: 14 plain-text, English-first. Links: none (raw tokens). Queueing: password reset only. Retry/DLQ: password reset only, no DLQ. Delivery tracking, bounce/complaint handling, suppression, webhooks, quota awareness, cooldowns, digests, HTML/RTL layout, branding, locale resolution: **none exist**.

## 4. Existing notification capabilities — summary
Data model and RLS are sound and reusable (`notifications`, dedupe key, self-only policies, unconditional insert). Producer API is sound (two-step, in-transaction insert). Gaps: single global email switch; no categories beyond `type`; no tenancy column (acceptable — notifications are addressed to a person, and every producer resolves the recipient server-side); no retention; feed UI is minimal on the management host and absent on the learner host; `actionUrl` unused; summary polling absent.

## 5. Existing authentication / email-verification / 2FA capabilities — summary
Registration is one endpoint for both surfaces, atomic (user + `academy_students` + verification token), policy-aware (`open|approval|invite` via `resolve_academy_registration_policy` / `claim_academy_invite`), disposable-domain and MX checks, IP rate limit. Verification token: 32 random bytes, SHA-256 at rest, 24 h TTL, resend endpoint — **verification is enforced nowhere** (`emailVerifiedAt` is never checked at sign-in). Password reset: hashed tokens, 45 min, non-enumerating, queued email, sessions revoked on confirm — confirm writes are not in one transaction, and reset sends no "your password was changed" notification (only the authenticated change-password path does). Sign-in: Argon2id with timing-parity dummy hash, surface resolution (`management`/`academy`, host match, blocked/pending membership), then TOTP 2FA challenge (Redis, 5 min, 5 attempts, replay-guarded time step, 10 recovery codes), then `issueSession`: JWT `{sub, sid}` 15 min, refresh 30 d with rotation but **no reuse detection**, sessions = rotation families in `refresh_tokens` with device label/IP/UA/country, Redis denylist for revocation. Device cookie `atlas_device` (365 d) governs the learner **content** device cap only (default 2 devices / 1 concurrent session; cap never fails sign-in). **No trusted-device concept, no lockout, no OTP of any kind, no audit entries for sign-in/sign-out/2FA changes/device removal, no `locale` column (only `preferences.language`, free-form string), no platform base-URL configuration.** Account deletion anonymises the row (`deleted-<uuid>@account.invalid`) and clears tokens.

## 8. Complete candidate event inventory (discovered from the codebase)

Legend — **Exists**: the domain transition exists in code. **Today**: N = in-app notification, E = email, — = nothing. Recipients are always resolved server-side from the row that changed (never from a request body).

| # | Domain | Event (transition) | Source (file) | Recipient(s) | Today |
|---|---|---|---|---|---|
| A1 | Identity | Account registered (management or learner) | `auth.service.ts:194` | self | E (verification, raw token) |
| A2 | Identity | Email verification requested / resent | `auth.service.ts:319,380` | self | E (raw token) |
| A3 | Identity | Email verified | `auth.service.ts:361` | self | — |
| A4 | Identity | Password reset requested | `auth.service.ts:747` | self | E (queued, raw token) |
| A5 | Identity | Password reset confirmed | `auth.service.ts:786` | self | — (audit only) |
| A6 | Identity | Password changed (authenticated) | `users.service.ts:99` | self | N+E |
| A7 | Identity | Sign-in on unrecognised device / new location | `auth.service.ts:386` | self | — (nothing recorded) |
| A8 | Identity | 2FA enabled / disabled / recovery codes regenerated | `two-factor.service.ts` | self | — (log line only) |
| A9 | Identity | Session revoked / sign out everywhere | `auth.controller.ts:179-207` | self | — |
| A10 | Identity | Account deleted (anonymised) | `account-deletion.service.ts` | self (final) | — (audit) |
| B1 | Learner content | Device registered | `student-device.service.ts:182` | learner | — |
| B2 | Learner content | Device removed | `learner-session.service.ts:126` | learner | — |
| B3 | Learner content | Device limit reached (grant refused) | `lesson-content.service.ts` | learner | — (metric) |
| B4 | Learner content | Session taken over by another device | `learner-session.service.ts:297` | learner | — (audit+metric) |
| C1 | Enrollment | Free / self enrollment created | `enrollments.service.ts:229` | learner | — |
| C2 | Enrollment | Enrollment granted by staff | `academy-students.service.ts:528` | learner | — |
| C3 | Enrollment | Enrollment revoked / access ended | `academy-students.service.ts:580` | learner | — |
| C4 | Enrollment | Enrollment expiry changed | `academy-students.service.ts:678` | learner | — |
| D1 | Commerce | Course order created | `course-orders.service.ts:136` | learner | — |
| D2 | Commerce | Course order expired (30 min, lazy) | `course-order-payments.service.ts` | learner | — |
| D3 | Commerce | Payment proof submitted | `course-order-payments.service.ts` | learner (receipt), platform reviewers (work item) | — |
| D4 | Commerce | Course payment approved → enrolled | `platform-course-order-payments.service.ts:190` | learner | N+E |
| D5 | Commerce | Course payment rejected | `…:286` | learner | N+E |
| D6 | Commerce | Refund requested | `course-order-refunds.service.ts` | learner, platform | — |
| D7 | Commerce | Refund completed → access revoked | `…:220` | learner | N+E |
| E1 | Learning | Assignment submitted | instructor services | instructor | — |
| E2 | Learning | Assignment graded | `instructor.service.ts:616` | learner | N+E (EN only) |
| E3 | Learning | Quiz graded (manual review done) | `quiz-review.service.ts:255` | learner | N+E (EN only) |
| E4 | Learning | Quiz auto-submitted on expiry | `phase2-maintenance.service.ts` | learner | — |
| E5 | Learning | Attempt invalidated | `quiz-review.service.ts:329` | learner | — (audit) |
| E6 | Learning | Course completed | `course-completion.service.ts` | learner | — |
| E7 | Certificates | Certificate issued | `certificates.service.ts:468` | learner | N+E (localized) |
| E8 | Certificates | Certificate revoked | `…:536` | learner | N+E (localized) |
| E9 | Certificates | Certificate regenerated | `…:637` | learner | — (audit) |
| F1 | Reviews | Review submitted | `course-reviews.service.ts:126` | moderators (owner/manager/instructor) | — |
| F2 | Reviews | Review approved / rejected / removed | `…:296,:207,:329` | learner | — |
| G1 | Roster | Learner self-registered (approval-policy academy) | `auth.service.ts` via admission | academy owner/managers | — |
| G2 | Roster | Learner approved / rejected | `academy-students.service.ts:361,:382` | learner | — |
| G3 | Roster | Learner blocked / unblocked | `…:290,:345` | learner | — |
| G4 | Roster | Invite created / revoked | `…:836,:870` | invitee (created) | — |
| G5 | Roster | Learner created by staff (with credentials?) | `academies.service.ts:996` | learner | — |
| H1 | Announcements | Announcement published (platform/academy/course) | `announcements.service.ts` | audience | — (feed only) |
| I1 | Live sessions | Scheduled/rescheduled/cancelled/starting soon | `live-session-notifications.service.ts:121` | enrolled learners | N |
| I2 | Live sessions | Recording available | `…:166` | host | N+E |
| I3 | Live sessions | Zoom connection deauthorized | `live-provider-deauthorization.service.ts:269` | org owners | N |
| J1 | Tenant | Organization created / owner onboarded | registration/provisioning | owner | — (verification only) |
| J2 | Tenant | Academy provisioning completed / failed | `provisioning-orchestrator.service.ts:339,387` | requester | N+E |
| J3 | Tenant | Trial started | plans/subscription services | owner | — |
| J4 | Tenant | Trial ending soon | subscription sweep | owner | — |
| J5 | Tenant | Trial expired (`trial_expired`) | subscription sweep | owner | — (silent flip) |
| J6 | Tenant | Subscription started / plan changed | plans services | owner | — |
| J7 | Tenant | Subscription payment submitted / approved / rejected (Atlas manual) | `platform-payment.service.ts:170,278` | owner | N+E (approve/reject only) |
| J8 | Tenant | Subscription cancelled (at period end) / expired | plans services (`cancelAtPeriodEnd` set, nothing acts on it — handover §30) | owner | — |
| J9 | Tenant | Hosted-video retention warning / deletion | **does not exist** | owner | — |
| J10 | Tenant | Quota threshold reached (video minutes, students…) | `entitlement-enforcement.service.ts` | owner | — |
| K1 | Support | Case status changed / reply posted | `support-cases.service.ts:161,227` | requester | N / N+E |
| K2 | Platform ops | Payment requiring review (course or subscription) | payment services | platform owner | — |
| K3 | Platform ops | Provider failures (video webhook signature, email bounce surge, queue DLQ) | metrics only | platform owner | — |
| K4 | Platform ops | Provisioning failure | `provisioning-orchestrator.service.ts:339` | requester | N+E |

## 9. Recommended event taxonomy

One typed catalogue, `CommunicationEventKey`, declared once in the backend (`src/communications/catalog/`), each entry carrying:

```
key                     'learner.payment.approved'
category                'transactional' | 'security' | 'lifecycle' | 'engagement' | 'operational'
audience                'learner' | 'staff' | 'owner' | 'platform'
channels                { inApp: 'always'|'never', email: 'always'|'preference'|'digest'|'never' }
priority                low | medium | high | urgent                (feeds the in-app row)
notificationType        system|account|billing|security|activity|announcement (existing enum)
dedupe                  scope + key template, e.g. 'per-entity' → 'payment:{paymentId}'
cooldown                per-user seconds (0 for transactional/security)
locale                  'user' | 'academy' | 'platform'
template                localized template key (subject/text/html for en+ar)
branding                'academy' | 'platform'
retention               feed row retention class (see §33)
```

Naming: `<audience>.<domain>.<transition>`; keys are stable identifiers stored on outbox and delivery rows, so the catalogue is also the audit vocabulary. Categories are the policy axis (§11); `notificationType` remains the feed's display axis so the existing UI and enum need no migration.

## 10. Email vs notification vs both — recommended matrix

Rule of thumb applied: **email when the person is likely outside Atlas or the message is consequential enough to reach them externally; in-app for everything they will see the next time they open the product; both for money, access and security; digest for staff work queues.** "Preference" means the category toggle applies (§23); "always" means it cannot be turned off.

| Event | In-app | Email | Notes |
|---|---|---|---|
| A1 verification, A4 reset, OTP (§12) | — | **always** (security) | must carry a real link / code; never an in-app row (no session yet) |
| A5 reset confirmed, A6 password changed, A8 2FA changes, A9 sessions revoked | yes | **always** (security) | "if this wasn't you" recovery link |
| A7 sign-in from a new device | yes | **always** (security) — but only when the device is *not* trusted (§12) and at most once per device | this is also the OTP moment; with OTP on, the OTP email *is* the new-device notice |
| B1/B2 device registered/removed | yes | preference (security digest) | low volume; email only for removal by staff reset |
| B3 device limit, B4 session takeover | yes (urgent) | never | the learner is in front of the screen; the player already explains |
| C1 free enrollment, C2 granted | yes | preference (transactional-lite) | learner just clicked; email is a receipt with the course link — keep, coalesce |
| C3 access revoked (non-refund), C4 expiry changed | yes (high) | **always** (transactional) | access change must reach them |
| D1 order created | yes | never | receipt comes with D3 |
| D2 order expired | yes | never | |
| D3 proof submitted | yes | **always** (receipt) to learner; platform reviewers: in-app + **digest** | |
| D4/D5 approved/rejected | yes | **always** | existing |
| D6 refund requested | yes | preference | D7 remains always |
| D7 refunded | yes | **always** | existing |
| E1 assignment submitted | instructor: yes | digest | |
| E2/E3 graded | yes | preference (learning) | existing, add locale |
| E4 auto-submitted, E5 invalidated | yes (high) | preference | |
| E6 course completed | yes | preference (engagement-positive) | pairs with certificate |
| E7 certificate issued | yes | **always** | existing |
| E8 revoked | yes | **always** | existing |
| F1 review submitted | moderators: yes | digest | |
| F2 review moderated | learner: yes | never | low stakes; feed only |
| G1 learner awaiting approval | staff: yes | digest (daily) + immediate if the academy has < N pending? no — digest only | avoids one email per signup |
| G2 approved | learner: yes | **always** (they cannot enter until then) | |
| G2 rejected, G3 blocked | learner: yes | **always** (transactional) | plain, non-accusatory copy |
| G3 unblocked | yes | preference | |
| G4 invite created | invitee: — | **always** (that *is* the invite) | |
| G5 learner created by staff | learner: — | **always** (welcome + set password via reset link) | never email a password |
| H1 announcement published | audience: yes (type `announcement`) | preference (engagement) with per-announcement "also email" choice for owners, capped (§22) | |
| I1 live session events | yes | starting-soon: never; scheduled/cancelled: preference | existing in-app |
| J2 provisioning done/failed | yes | **always** | existing |
| J3 trial started | yes | **always** (welcome + what happens at day N) | one email |
| J4 trial ending | yes | **always** (lifecycle) | one email, see §26 |
| J5 trial expired | yes | **always** | see §26 |
| J6 subscription started/changed | yes | **always** (receipt) | |
| J7 subscription payment submitted/approved/rejected | yes | **always** | add "submitted" receipt |
| J8 cancellation scheduled / subscription expired | yes | **always** | see §27 |
| J9 video retention warnings / deletion | yes (urgent) | **always** (lifecycle-critical, never suppressible by preference; only by bounce) | see §31–32 |
| J10 quota threshold (80 %, 100 %) | yes | preference (owner ops) | once per threshold per period |
| K1 support | existing | existing | |
| K2 payment awaiting review | platform owner: yes | **digest** (daily) + immediate when backlog age > 48 h (matches `AtlasCheckoutApprovalSlow`) | |
| K3 operational failures | platform owner: yes | **always** but coalesced (one per incident per 6 h) | complements Prometheus alerts, which have no receiver today |

## 11. Transactional vs lifecycle vs security vs engagement vs marketing

| Category | Definition | Examples | Can the user opt out? | Frequency control |
|---|---|---|---|---|
| **Security** | proves or protects account ownership | OTP, verification, reset, password/2FA/session changes, new-device notice | **No** (only suppression by hard bounce) | none beyond rate limits |
| **Transactional** | records a change the user caused or is party to | receipts, approvals, rejections, invites, access granted/revoked, certificates, provisioning | **No** | dedupe per entity; coalesce within 60 s |
| **Lifecycle** | the account/tenant's commercial state changed or will change | trial started/ending/expired, subscription started/cancelled/expired, retention warnings, deletion | **No** for state changes and deletion warnings; **Yes** for the re-engagement follow-ups inside a sequence (§26) | sequence gates, one active sequence per tenant, hard stop on reactivation |
| **Engagement** | helpful but optional | course completed congratulations, announcements, grading, live-session scheduling, weekly learner summary (future) | **Yes** (default on; academy owner can choose per announcement) | per-user daily cap, digest |
| **Operational** (staff/platform) | work queues and incidents | pending approvals, reviews to moderate, payment backlog, provider failures | Digest cadence selectable (immediate / daily / off for non-critical) | digest, incident coalescing |
| **Marketing** | promotional | **none planned**; explicitly out of scope until a consent model and an unsubscribe-header implementation exist | would be **opt-in** with `List-Unsubscribe` | — |

Legal/product notes: every non-security email carries a footer explaining *why* it was sent and a link to communication settings; engagement emails additionally carry `List-Unsubscribe` (one-click) mapped to the engagement toggle; lifecycle deletion warnings state the exact date and the action that stops it. Atlas never sends marketing under a transactional guise.

## 12. OTP / authentication recommendation

**Model: email OTP as step-up on an unrecognised device, not on every sign-in; TOTP, where enabled, supersedes it.**

- *Every login* would multiply email volume by the number of sign-ins (the sign-in rate limit alone allows 10 per 15 min per account), train users to ignore codes, and add nothing when the device is already known.
- *First login only* proves ownership once but leaves stolen passwords usable from any new machine.
- *New/untrusted device* is the SaaS norm and matches Atlas's existing device thinking: it proves email ownership exactly when the risk changes, costs one email per new device, and gives every learner a verified email as a side effect (`emailVerifiedAt` set on first successful OTP), closing the "verification is enforced nowhere" gap without a separate verification chore.

Recommended policy, both surfaces:
1. Password step as today (`AuthService.signIn`), including surface resolution and suspended/deleted checks.
2. If the account has confirmed TOTP → existing 2FA challenge (unchanged). TOTP is stronger than email; never stack both.
3. Else if the request carries a valid **trusted-device token** for this user → issue session.
4. Else → **email OTP challenge**: 6 digits, expiry **10 min**, stored as `challenge_id (32 random bytes) → { userId, codeHash (HMAC-SHA256 with a server secret + per-challenge salt), attempts, resends, surface, academyId, deviceFingerprint, createdAt }` in a new `auth_email_challenges` table (not Redis-only, so it is auditable and survives a Redis flush), plus a Redis attempt counter mirroring the 2FA guard. **Max 5 verify attempts** then the challenge is destroyed; **resend cooldown 60 s**, **max 3 codes per challenge**, a new code invalidates the previous; per-account **5 challenges / hour** and per-IP limits via `AuthRateLimiterService`; verification is constant-time; a consumed challenge is marked `consumed_at` (replay-proof) and the session is minted through the single `issueSession` path (`completeEmailOtpSignIn`, mirroring `completeTwoFactorSignIn`). Success also sets `users.emailVerifiedAt` if null and writes a trusted-device token.
5. **Trusted device**: a separate HttpOnly cookie `atlas_trust` (never reuse `atlas_device`, whose meaning is the content cap): 32 random bytes, SHA-256 at rest in `trusted_devices` (`userId`, `surface`, `label`, `lastUsedAt`, `expiresAt`, `revokedAt`), **90 days** on the management surface and **180 days** on the academy surface (learners sign in less often; a longer trust window is what keeps OTP email volume near one per device per half-year), revoked by password change, password reset, "sign out everywhere" and by the user from the sessions/devices page. Trust is per user per browser, so a shared computer with two accounts yields two rows.
6. **Policy switches** (platform-owner setting, then per-academy override for learners): `emailOtp: 'new_device' | 'always' | 'off'` — default `new_device` for management; default `new_device` for academies. `always` exists for high-security academies; `off` is available but the UI warns that it removes the ownership proof. The existing `twoFactorRequired` platform setting keeps its meaning (require TOTP enrolment for staff).
7. **Delivery failure / not received**: the challenge page offers resend after the cooldown and a "use recovery" path — for TOTP users their recovery code; for everyone else the password-reset flow, which itself proves email; a suppressed address (hard bounce) is told to contact support because no email can reach it (the account is not locked; the failure is surfaced honestly).
8. **Audit**: `auth.otp.requested`, `auth.otp.verified`, `auth.otp.failed` (with attempt count), `auth.trusted_device.created/revoked`, and the currently missing `auth.sign_in.succeeded/failed`, `auth.sign_out`, `auth.session.revoked`, `auth.2fa.enabled/disabled` — all via `AuditLogWriterService` (`writeBestEffort` for the failure paths).
9. **Interaction with sessions/devices**: OTP never counts against the content device cap; a session minted after OTP is an ordinary session family; `rememberMe` (accepted, unused today) is defined as "extend refresh TTL", not "skip OTP" — trust is decided by the trusted-device token only.
10. **Rollout**: flag `auth.email_otp` (`off` → `new_device`) per surface, with the OTP UI (`input-otp` primitive already in the repo) shipped first behind the flag, then enabled for the management surface, then academies; the existing sign-in e2e and J1/J5/J6 journeys gain an OTP step read from the stub provider's last message, as password reset already does.

Why not SMS: no provider, cost, and Atlas's own preference model already says so.

## 6. Existing subscription / trial lifecycle — summary (verified)

- Organizations are created only by `POST /organizations` (never by registration); statuses `active|suspended|archived` exist but **nothing writes `suspended`/`archived`**; there is no org delete. Academies can be archived.
- Trials are never automatic: `OrganizationSubscriptionBootstrapService` starts every org at `no_plan`; `TrialRedemptionService.startTrial` grants exactly one trial per canonical email (`trial_redemptions.subject_hash`, survives deletion), duration `plan.trialDurationDays ?? TrialPolicy.durationDays` (**default 3 days**, Platform-Owner editable at `/trial-policy`).
- Statuses: `no_plan, trialing, trial_expired, active, past_due, paused, grace_period, cancelled, expired`. Live transitions: `no_plan→trialing`, `trialing→trial_expired` (sweep every **15 min**, platform-owner context, `trialEndsAt`/`planId` preserved), `trialing→cancelled`, `→active` on payment approval (`currentPeriodEnd = now + billingCycle`, `grantedLimits` frozen), paid cancel → `cancelAtPeriodEnd = true`. **Dead or absent: `active→expired` (nothing reads `currentPeriodEnd`; `markExpired` is dead code), anything acting on `cancelAtPeriodEnd`, anything setting `grace_period`/`graceEndsAt`, `past_due`, `paused`.** Handover §30 already records "no subscription auto-renewal or paid-period expiry".
- Consequences of `trial_expired|expired|cancelled`: mutations blocked (`SubscriptionAccessInterceptor`), reads open, **public website taken offline** (`isServingEligible` false; 60 s cache), data untouched by design.
- The only subscription communications are payment approved/rejected to the org owner. No trial started/ending/expired, no cancellation, no renewal, no receipt for a submitted payment.
- Timestamps available: `trialEndsAt` (trial start derivable), `trial_redemptions.redeemedAt`, `currentPeriodStart/End`, `subscription_cancellations.cancelledAt/effectiveAt`, `users.lastSignInAt`, `audit_log_entries.occurredAt`; **no org-level `lastActivityAt`** — must be added (§40) or derived.

## 7. Existing video lifecycle and storage model — summary (verified)

- `media_assets`: `status active|archived`, `access public|protected`, `provider r2|r2_worker|cloudflare_stream`, `providerId`, `processingStatus pending|processing|ready|failed`, `durationSeconds` (reserved → reconciled), `securityTier normal|premium` fixed at creation, `courseId`, `sizeBytes`.
- Storage: public bucket (`R2StorageProvider`, images/PDF) and a protected bucket with its own scoped credential (`ProtectedMediaStorageProvider`; key `academies/{academyId}/[courses/{courseId}/]{assetId}.{ext}`). `MediaStorageProvider` has **no delete** ("archive-only lifecycle"); only `ProtectedMediaStorageProvider.deleteObject` exists.
- Video providers behind `VideoProvider` (`createDirectUpload`, `issuePlaybackToken`, `fetchAsset`, **`deleteAsset`**, webhooks, `syncAllowedOrigins`): Cloudflare Stream (premium), `BasicVideoProvider` (R2 + gate Worker, normal), Fake (dev). **`deleteAsset` is implemented for all three and called from nowhere.**
- Lifecycle today is archive-only: `media.service.ts:366` sets `archived` and enqueues usage recompute; reconciliation archives on provider `failed`. Quota `videoStorageMinutes` = ceil(Σ `durationSeconds`/60) over active hosted assets in non-archived academies, recomputed by queue; enforced at upload.
- **No code path physically deletes video bytes for any tenant state**, and the video infrastructure itself is unconfigured in production (Phase 4 blocker — `FLAG_VIDEO_*`, `BASIC_VIDEO_*`, Cloudflare Stream variables unset). Playback revocation (`VideoGateRevocationService`) revokes sessions, never bytes.

## 16. Email sending architecture (proposed)

```
domain service (inside its own transaction)
   └─ CommunicationService.emit(tx, { key, recipientUserId, entity, values, tenant })
        ├─ notifications row            (existing NotificationsRepository, deduped)     — in-app, instant
        └─ communication_outbox row     (new, same transaction)                          — the durable intent
                                   ↓ (after commit; BullMQ 'communications' worker, drained by outbox id)
   CommunicationDispatchService
        ├─ resolve recipient from users (server-authoritative email, locale, preferences, suppression)
        ├─ policy: category → channels; preference; cooldown; frequency cap; digest membership
        ├─ quota gate: provider capability + daily window + priority class
        ├─ render: TemplateRegistry(key, locale, branding) → { subject, text, html, headers }
        └─ EmailProvider.send(...) → communication_deliveries row (status, providerMessageId, attempts, error)
                                   ↑ provider webhooks (delivered / bounced / complained) → deliveries + suppressions
```

Design points, each tied to a fact above:
- **Same transaction, then a queue.** P17's "write the row inside the transaction, send after commit" stays, but "send" becomes "enqueue by outbox id", which is what makes retries, quota gating, digests and observability possible. The password-reset queue is folded in as the first migrated producer (its payload today carries the raw token in Redis; the outbox carries only a reference and the token is re-read from the hashed store at send time — a security improvement).
- **Recipient authority.** The outbox stores `recipientUserId`; the address is read from `users` at dispatch, so a changed or anonymised email (`deleted-<uuid>@account.invalid`) is never mailed and callers can never supply an address. Only three events legitimately target a non-user address — invites (G4) and, before an account exists, nothing else; invites store the invite id and read the bound email from `academy_invites`.
- **Provider contract widened, not replaced.** `EmailProvider` keeps `sendTransactionalEmail` and gains `capabilities(): { dailyLimit?, monthlyLimit?, perSecond?, supportsWebhooks, supportsHtml, supportsHeaders }`, `send(input): { providerMessageId }`, `verifyWebhook(req)`, `parseWebhookEvents(body)`; `sendPasswordResetEmail`/`sendEmailVerification` are removed once those two events are templates. Adapters: `stub` (dev/test, unchanged role), the existing `resend`, plus the recommended free-tier adapter (§14); all HTTP-JSON via `fetch`, no SDKs.
- **Never throws into business code.** `emit` can only fail on the outbox INSERT, which is in the caller's transaction and therefore either commits with the business change or rolls back with it — the exact guarantee P17 asked for, now without a sync HTTP call in the path.
- **Idempotent dispatch.** Outbox rows carry `dedupeKey` (unique per recipient+key+entity, mirroring the notifications constraint) and a `state` machine `pending → dispatched | suppressed | deferred | failed`; the worker claims rows with `SELECT … FOR UPDATE SKIP LOCKED`, so two workers or a retried job can never double-send.

## 17. Notification architecture (proposed)

Keep the `notifications` table, RLS and API. Add: (a) category-aware creation through the same `emit` (the in-app row is written by the catalogue's `inApp: 'always'` rule); (b) `actionUrl` populated for every event that has a destination (course, order, certificate, review queue) so the feed becomes navigable; (c) an `expiresAt`/retention class and a monthly prune (§33); (d) `GET /notifications/summary` polled by the shells every 60 s with `If-None-Match` (cheap; no WebSocket needed at current scale); (e) a learner notification surface under `/my/notifications` and a bell in `LearnerShell` (today learners have none); (f) staff "work queue" notifications (approvals, reviews, payments) grouped by entity so a pending list of 40 learners is one row that updates, not 40 rows — implemented as `dedupeKey = 'approvals:pending:{academyId}'` with `values.count` refreshed on upsert.

## 18. Event / outbox / queue architecture (proposed)

- **`communication_outbox`** (new): `id, key, category, recipient_user_id, recipient_invite_id?, organization_id?, academy_id?, entity_type, entity_id, dedupe_key, locale, branding, values jsonb, channels jsonb, priority, state, available_at, attempts, last_error, created_at, dispatched_at`. Unique `(recipient_user_id, dedupe_key)` where not null. Index `(state, available_at)`.
- **`communication_deliveries`** (new): one per channel attempt: `id, outbox_id, channel, provider, provider_message_id, status queued|sent|delivered|bounced|complained|failed|suppressed|deferred, error_code, attempts, sent_at, updated_at`. Index `(provider_message_id)`, `(status, updated_at)`.
- **`communication_suppressions`** (new): `email_hash (unique), email_domain, reason hard_bounce|complaint|manual|invalid, source, created_at, expires_at?`.
- **`communication_digests`** (new): `id, recipient_user_id, kind, window_start, window_end, item_count, state, sent_at` — pending digest items are outbox rows in state `deferred` with `digest_id`.
- **Queues** (one new BullMQ queue `communications`, three job names): `dispatch` (per outbox id, enqueued after commit and by a 1-min repeatable sweeper for anything left `pending`/`deferred` past `available_at` — the outbox is the source of truth, the job is a hint), `digest` (repeatable hourly; builds and dispatches due digests), `webhook` (provider events, same shape as `payment-webhook`). Retry: attempts 6, exponential from 30 s, `removeOnFail: false`; after exhaustion the outbox row is `failed` with `last_error` and counted (§36) — that row set *is* the dead-letter queue, queryable and re-dispatchable from the Platform Owner console.
- **Ordering** is per recipient per entity via `dedupeKey`; there is no cross-event ordering requirement (a "payment approved" after a "proof submitted" is fine in either order; both are receipts of distinct states).
- **Lifecycle sequences** (§26–§32) are *not* individual outbox rows scheduled far ahead; a `tenant_lifecycle_state` row (§31) is evaluated by the existing 15-min subscription sweep, which emits the next step's event when its condition holds — so a reactivation simply stops producing steps, and nothing scheduled months ahead has to be cancelled.

## 19. Idempotency / deduplication strategy

Three layers, each independent: (1) domain-level `dedupeKey` per (recipient, event, entity[, version]) enforced by a unique index on both `notifications` and `communication_outbox` — a retried transaction or a duplicate webhook produces the same key and is rejected at INSERT; (2) dispatch-level claim with `FOR UPDATE SKIP LOCKED` and a state transition that is itself a conditional `UPDATE … WHERE state='pending'`; (3) provider-level idempotency key = outbox id sent as the provider's idempotency header where supported (Resend supports `Idempotency-Key`), so a timeout after the provider accepted the message cannot double-send on retry. Events that legitimately repeat (password changed, review moderated again) carry a version or timestamp in the key exactly as `certificate.revoked:{id}:{now}` does today.

## 20. Retry / dead-letter strategy

Transient (5xx, 429, network): retry with exponential backoff (30 s → ~30 min) up to 6 attempts, respecting `Retry-After`. Permanent (4xx validation, suppressed address, unknown template): fail immediately, no retry. Provider quota exhausted (§21): not a failure — row goes `deferred` until the next window. Exhausted rows remain in the outbox as `failed` (queryable, re-dispatchable, alert-counted); security-category failures additionally raise an operational notification to the Platform Owner (K3) because a user is likely stuck at a login. Webhook processing is idempotent on `provider_message_id + event type`.

## 21. Email quota protection strategy

- `EmailProvider.capabilities()` declares the free-tier ceilings; `EmailQuotaService` keeps a Redis daily counter per provider (`comm:quota:{provider}:{yyyy-mm-dd}`) and a monthly one, incremented only on an accepted send, reconciled nightly from `communication_deliveries`.
- **Priority classes**: `security` and `transactional` may use 100 % of the daily ceiling; `lifecycle` stops at 85 %; `engagement`/digests stop at 70 %. When a class is over its line, the row is `deferred` to the next day (or folded into a digest), never dropped. This guarantees an OTP still goes out on a day an announcement blast would otherwise have exhausted the tier.
- Per-second smoothing via a token bucket sized from `capabilities().perSecond`.
- **Alerts** at 60 / 80 / 95 % of the daily and monthly ceilings (Prometheus rule + Platform Owner in-app notification, coalesced to one per threshold per day), and a "provider rejected for quota" counter.
- Announcement emails (H1) are sized before enqueue: if `audience × 1` exceeds the remaining daily class budget, the owner is told the email will be spread over N days (or offered in-app only), which is honest and protects the tier.

## 22. Frequency / cooldown / digest strategy

- Cooldown per (user, event key) from the catalogue: 0 for security/transactional; 24 h for quota thresholds and engagement nudges; sequences enforce their own gaps (§26).
- **Per-user daily email cap** for non-security categories: 5 (learners), 10 (staff); overflow is deferred into that user's next digest — so a learner enrolled in six courses with six announcements the same afternoon receives one digest, not six emails.
- **Coalescing window** of 60 s for transactional receipts to the same user about the same entity (e.g. order created → proof submitted seconds apart yields one email).
- **Digests**: staff daily digest (pending approvals, reviews awaiting moderation, submissions to grade, payments to review) at 08:00 in the academy timezone (`academies.timezone` exists); Platform Owner ops digest daily; learner weekly summary is *future* (engagement, off by default).
- Resend of any security email is user-initiated only and rate-limited as today (5/h) plus a 60 s cooldown.

## 23. User preference model

Extend `users.preferences.notifications` (backward compatible; existing `email` boolean maps to the `engagement` toggle for migration, never to security/transactional):
```
notifications: {
  email: boolean            // legacy; read as engagement default during migration, then removed
  channels: { inApp: true },              // in-app cannot be disabled; shown for transparency
  categories: {
    security:      { email: true  }  // locked
    transactional: { email: true  }  // locked
    lifecycle:     { email: true  }  // locked for state changes; `reminders: boolean` toggles sequence follow-ups
    engagement:    { email: boolean, digest: 'immediate'|'daily'|'off' }
    operational:   { email: boolean, digest: 'immediate'|'daily' }   // staff/platform only
  },
  language: 'en'|'ar'        // validated (today free-form)
}
```
Academy-level (Client Owner) settings: default learner engagement digest cadence; whether announcements may be emailed; OTP policy override (§12). Platform-level: OTP default, digest hours, quota alert recipients.

## 24. EN/AR template architecture

- Templates live server-side in `src/communications/templates/<key>/{en,ar}.ts` exporting `{ subject(values), preheader(values), text(values), html(values) }`, rendered through one **base layout** (`layout.ts`) that sets `lang`, `dir` (`rtl` for `ar`), logical alignment, a bilingual-safe font stack, and a footer (why you received this, settings link, `List-Unsubscribe` for engagement). Plain-text is always generated (never derived by stripping HTML) so every email has a faithful text part.
- A registry (`TemplateRegistry.render(key, locale, branding, values)`) with a compile-time check that every catalogue key has both locales (a Jest test mirrors the frontend translation-parity test), and a **template version** recorded on each delivery so a copy change is traceable.
- Locale resolution at emit time, stored on the outbox row: `users.preferences.language` (validated `en|ar`) → for academy-surface events the academy's `language` → `en`. Subject lines are localized and RFC 2047-encoded by the provider (UTF-8); the two existing localized templates prove the encoding path works with Resend.
- Values are typed per key (`CommunicationValues<K>`), never free-form, so a template cannot interpolate PII it was not given.

## 25. Academy / platform branding strategy

`branding: 'academy'` emails (everything a learner receives, and staff emails about a specific academy) render the academy name, logo (public media URL), brand colour from `WebsiteConfiguration`/theme, sender name `"{Academy} via Atlas"` and links on the academy's canonical host (`DomainCheckService`/canonical-host rule from P63: connected custom domain if live, else the Atlas subdomain). `branding: 'platform'` emails (owner lifecycle, billing, security on the management surface, platform ops) render Atlas branding and links on `PLATFORM_WEB_URL` (new required env; today no base URL exists, which is why reset/verify emails carry raw tokens). The `From` address stays the platform's verified domain in both cases (custom sending domains per academy are a future, paid-tier feature); `Reply-To` may be the academy's `contactEmail`. This is also what fixes the security gap in A1/A4: links are built server-side from server-known hosts, never from request headers.

## 26. Trial lifecycle communication strategy (timings and reasoning)

Facts that shape it: the trial is **3 days**, no card, one per email; expiry is detected within 15 min; a `trial_expired` site goes offline immediately; nothing today tells the owner any of this.

| Step | When | Channel | Why this timing |
|---|---|---|---|
| T1 Trial started | immediately on `startTrial` | in-app + email (transactional) | the one email an owner expects; states the exact end date/time and that the site goes offline at expiry unless a plan is chosen |
| T2 Trial ends tomorrow | `trialEndsAt − 24 h` | in-app + email (lifecycle) | with a 72 h trial a "3 days left" mail would duplicate T1 and a 48 h one is noise; one reminder a day ahead is what a busy owner needs to act on manual-transfer payment (which itself needs review time) |
| T3 Trial expired | at expiry (sweep, ≤15 min) | in-app (urgent) + email (lifecycle, not suppressible) | consequential: their site is now offline; the email says exactly that and how to restore it |
| T4 Follow-up | expiry + 3 days, **only if** no plan chosen and no cancellation recorded | email (lifecycle, `reminders` toggle) | long enough to not feel like nagging, short enough that the evaluation is still fresh |
| T5 Follow-up | expiry + 14 days, same condition **and** the org has content (≥1 course or ≥1 student) | email (lifecycle, `reminders`) | an empty org that never built anything gets no second nudge — signal, not volume |
| T6 Long-term reactivation | expiry + 45 days, same conditions | email (lifecycle, `reminders`) | last commercial touch; after it the sequence ends. Combined with §31 this also happens to be the last touch before hosted-video warnings begin |
| — | no email at +7 d, +30 d, +60 d etc. | — | deliberately not sent; every extra touch costs deliverability reputation and free-tier volume for negligible conversion |

A cancelled trial (`trialing→cancelled` with a recorded reason) receives T3's factual expiry email only (their site goes offline too) and **no** T4–T6 — they told us why they left. Any activation (`→active`) ends the sequence instantly because the sweep re-evaluates conditions each tick; no scheduled emails exist to cancel.

## 27. Subscription lifecycle communication strategy

Dependency: the missing paid-period expiry (§6) must be implemented (`active → grace_period → expired` sweep reading `currentPeriodEnd`; §K). Manual bank/wallet transfer with platform review means a renewal needs *lead time*, which sets the timings.

| Event | When | Channel |
|---|---|---|
| S1 Subscription started / plan changed | on approval (exists) — add a receipt with period dates and frozen limits | in-app + email |
| S2 Payment submitted (receipt) | on proof upload | in-app + email |
| S3 Renewal due | `currentPeriodEnd − 7 d` | in-app + email (lifecycle, not suppressible) — manual transfer + review needs days |
| S4 Renewal due tomorrow | `currentPeriodEnd − 1 d`, if still unpaid | in-app + email |
| S5 Period ended → grace | at `currentPeriodEnd` → status `grace_period`, `graceEndsAt = +7 d` | in-app (urgent) + email: "your site stays online for 7 days; pay to continue" |
| S6 Grace ending tomorrow | `graceEndsAt − 1 d` | in-app + email |
| S7 Expired | at `graceEndsAt` → `expired` (site offline, mutations blocked) | in-app + email (not suppressible) |
| S8 Cancellation scheduled | when `cancelAtPeriodEnd` is set | in-app + email (confirmation with effective date) |
| S9 Cancellation effective | at `currentPeriodEnd` → `cancelled` | in-app + email |
| S10 Post-expiry follow-ups | as T4–T6 but at +7 d / +30 d only (a paying customer already knows the product) | email (`reminders`) |

Why a 7-day grace: manual transfers clear in days, not minutes; taking a paying academy offline at midnight of the period end for a bank delay is the wrong product; 7 days is the shortest window that covers a weekend plus review. `past_due`/`paused` remain unused until an automated gateway exists.

## 28. Payment lifecycle communication strategy

Course orders (learner): D1 in-app only; D3 proof submitted → learner email receipt (they are waiting on a human) + reviewer work-queue notification and daily digest, immediate email if the oldest pending item exceeds 48 h; D4/D5 as today (add locale, links, branding); D2 expiry in-app only. Refunds: D6 request in-app + email confirmation; D7 as today plus explicit "access to <course> ended on <date>". Subscription payments (owner): S2 receipt added; approve/reject as today; rejected includes the reviewer's reason field already stored. All amounts/currency from the frozen snapshot, never recomputed.

## 29. Learner lifecycle communication strategy

Account: registration → OTP/verification (one email, real link or code); first sign-in on a device → OTP (§12); password reset/changed → security emails with "wasn't you?" link. Learning: enrollment (free/granted) → in-app + coalesced email receipt with the course link; access revoked / expiry changed → email; graded → localized email under the engagement preference; auto-submitted / invalidated → in-app (high) + preference email; course completed → in-app + optional email that pairs with the certificate email when both fire within 60 s (coalesced into one); certificate issued/revoked → as today with links to `/my/certificates` and `/verify/:code`. Roster: awaiting approval → in-app "your registration is awaiting approval"; approved → email (they cannot enter otherwise); rejected/blocked → factual email; unblocked → in-app + preference email. Devices: registered/removed in-app; limit/takeover in-app only. Announcements: in-app always; email under engagement preference and the academy's per-announcement choice, subject to caps.

## 30. Staff / management communication strategy

Client Owner / Manager: daily digest (pending approvals, reviews to moderate, payments submitted for their courses, submissions to grade) plus immediate in-app rows; immediate email only for: provisioning result, subscription lifecycle (§26–27), quota thresholds (80 %/100 %, once per period), security events on their own account, and incidents affecting their academy (domain went down — `domain-verification-sweep` already detects it and notifies no one). Instructor: in-app for submissions/reviews in assigned courses; digest email; grading confirmations in-app only. Platform Owner: in-app + daily ops digest (payments awaiting review, provisioning failures, support cases, failed communications, quota %), immediate coalesced email for incidents (webhook signature failures, DLQ growth, quota ≥ 95 %, retention deletion failures), and — this is the mechanism the Phase 4 alert rules lack — an **in-product receiver** for the same conditions the Prometheus rules express.

## 31. Video-retention / deletion lifecycle (proposed)

**What is retained and what is deleted.** Retained indefinitely (per the existing "expiry changes what a tenant may do, never what they have" rule): organisation, academies, courses, curriculum, students, enrollments, progress, certificates, reviews, orders, audit log, public images and documents (small, and they define the site). Deleted after the retention window: **hosted video bytes only** — protected `media_assets` with `type='video'` and `provider in (r2_worker, cloudflare_stream)` — at the provider (`VideoProvider.deleteAsset`, already implemented for all three providers and never called) and in the protected bucket; the `media_assets` row is kept as a **tombstone** (`status='deleted'`, `deletedAt`, `deletionReason`, `bytesFreed`, `providerDeleteVerifiedAt`) so lessons show "video removed after inactivity" rather than a broken player, and quota recompute drops it.

**What qualifies as inactive.** A tenant enters `inactive` when its subscription has been continuously in `trial_expired`, `expired` or `cancelled` since an **anchor date** = `trialEndsAt`, `graceEndsAt`/`currentPeriodEnd`, or `effectiveAt` respectively. Any transition to `active` or `trialing` resets everything. Sign-ins do not extend the clock (reads are free; storage is not), but a sign-in during the warning stage triggers an in-app urgent banner so a returning owner cannot miss it.

**Retention windows** (recommended, owner to confirm — §O):
- Formerly **trialing** tenants: hosted video deleted **90 days** after the anchor. Reasoning: a 3-day trial's uploads are evaluation material, never paid for; 90 days is a full quarter of silence — generous relative to typical 30-day trial-data policies — and short enough that abandoned trials do not accumulate provider minutes (Stream is metered per stored minute per month).
- Formerly **paid** tenants: **180 days**. Reasoning: they paid; six months of silence after their last paid period is the conventional "churned" threshold in subscription software, covers a sabbatical or budget cycle, and the storage cost of a Growth plan's 2,000 minutes over six months is small relative to the goodwill cost of deleting a returning customer's content.
- **Legal hold** flag per organisation (Platform Owner) freezes the clock; an open support case tagged "data" also freezes it.

**Warning sequence** (each also an in-app urgent notification and a dashboard banner; emails are lifecycle-critical and only suppressible by hard bounce):
| Stage | When (before deletion) | Content |
|---|---|---|
| W1 Notice | 30 days | what will be deleted (count, minutes, courses affected), the date, and the two ways to stop it (subscribe, or export/download — see below) |
| W2 Reminder | 14 days | same, with the list of affected courses |
| W3 Final warning | 7 days | "final", exact date/time in the academy timezone |
| W4 Last call | 24 hours | short; sent even if W1–W3 bounced (best effort) |
| D Deletion started / completed | on completion (per tenant, one email) | what was deleted, what was kept, that it is irreversible, and that reactivation restores everything else |
Why four: fewer than three fails the "clearly informed" bar; more than four is noise on a free tier. Spacing 30/14/7/1 is the common pattern users recognise from other SaaS deletion notices. **Download before deletion:** the plan proposes a time-limited, owner-only "download your videos" action during the warning window (signed URLs via the protected storage path already used for proofs) — a product decision (§O-6) because it is additional work and bandwidth.

**Cancellation vs expiration.** Both reach the same inactive state; a paid cancellation keeps the 180-day window; a trial cancellation the 90-day one. Reactivation at any stage before D restores normal state and stops the sequence; reactivation after D restores everything except the deleted bytes (the tombstones say so in the player and the owner dashboard).

**Provider specifics.** Cloudflare Stream: `DELETE /accounts/{id}/stream/{uid}` then verify with `GET` → 404; billing stops at deletion. R2 (`BasicVideoProvider`): `DeleteObject` on the protected bucket plus the gate Worker's KV entries; verify with `HEAD` → 404. Both are asynchronous and idempotent (a 404 on delete is success). Public thumbnails/posters are left.

**Execution.** Asynchronous BullMQ jobs, one per asset, enqueued by the subscription sweep when a tenant crosses the deletion date and no hold exists; each job: re-check the tenant is still inactive and unheld (a race with reactivation is resolved in favour of the customer), call `deleteAsset`, verify, write the tombstone, write audit `media.video.deleted` with `{assetId, bytes, minutes, reason}`, enqueue usage recompute; attempts 5 with backoff; after exhaustion the asset stays `active` with `deletionFailedAt` and the Platform Owner is notified (K3) — nothing is marked deleted that was not verified deleted. A tenant-level job emits the D email once all assets settle (or a partial-failure email that is honest about which failed).

**Customer visibility.** Owner dashboard `LifecyclePanel` gains a `retention_warning` state with the date, affected minutes and a link to a **Data & retention** page under `/dashboard/tenant/retention` (state, timeline, affected courses, download action, "reactivate" CTA). Platform Owner: a retention view in Analytics → Content delivery (tenants in warning, scheduled, failed deletions, bytes freed).

## 32. Deletion warning sequence — timeline example
Trial ended 1 Oct → anchor 1 Oct → W1 30 Nov, W2 16 Dec, W3 23 Dec, W4 29 Dec, deletion 30 Dec (90 d). Paid period ended 1 Oct, grace to 8 Oct → anchor 8 Oct → W1 7 Mar, W2 23 Mar, W3 30 Mar, W4 5 Apr, deletion 6 Apr (180 d). T4–T6 (§26) all fall before W1, so the owner has heard from Atlas five times over three months before any destructive warning, and never twice in the same week.

## 33. Data retention policy (communications data)
`communication_outbox`/`deliveries`: 90 days then pruned (aggregates kept in metrics); `communication_suppressions`: indefinite for complaints/hard bounces, 30 days for soft bounces; `auth_email_challenges`: 24 h; `trusted_devices`: until expiry + 30 days; `notifications`: 180 days for engagement/activity rows, 365 days for billing/security/account rows (retention class from the catalogue), pruned by the existing Phase 2 maintenance sweep under the platform-owner context with `*_retention_delete` RLS policies exactly as `content_access_log` does. Audit entries for deletions are never pruned (no audit retention exists today; unchanged).

## 34. Security model

- **Recipient is server-authoritative**: outbox rows reference `users.id` (or `academy_invites.id`); no endpoint accepts an email address to send to. Announcement emails resolve the audience from enrollments/memberships at dispatch time under the academy's tenant context.
- **Guards decide, RLS agrees**: every new table has FORCE RLS with self-select for users (`auth_email_challenges`, `trusted_devices`, `notifications`), tenant-scoped select for owner/manager views (`communication_deliveries` by `organization_id`), platform-owner select/update for the ops console, and system INSERT policies mirroring `notifications_system_insert`. The worker runs under the platform-owner user context (the established sweep precedent) so its reads are policy-bound, never `runWithoutContext`.
- **No cross-tenant leakage**: outbox/delivery rows carry `organization_id`/`academy_id` snapshots; digest builders group strictly by recipient membership; templates receive typed values, never raw rows; academy branding is loaded by the academy id on the row, never from a header.
- **Secrets & PII**: OTP codes are HMAC-hashed with a server key plus per-challenge salt; verification/reset tokens stay SHA-256 opaque tokens; the outbox never stores a raw token (the token is re-read from the hashed store at render time and embedded once into the link); logs carry ids and template keys only (extend the existing audit redaction rules to the new tables); provider webhooks are signature-verified and processed idempotently; emails never include passwords, full card/bank details, or another person's data; certificate emails already show only the learner's own data.
- **Abuse controls**: reuse `AuthRateLimiterService` scopes for OTP request/verify/resend (per account, per IP); announcement email fan-out requires `announcement.manage` and the academy setting; the per-user and per-class caps (§21–22) bound any single actor's email consumption; suppression list honoured before every send.
- **Auditability**: every send attempt is a delivery row; every OTP/trust event and every retention warning/deletion is an audit entry with the outbox id in `context`.

## 35. RLS / tenancy model (tables and policies to add)
| Table | Scope column(s) | Policies |
|---|---|---|
| `communication_outbox` | `recipient_user_id`, `organization_id?`, `academy_id?` | `self_select` (user GUC), `tenant_select` for owner/manager (org GUC + role check via existing helpers), `platform_select`/`platform_update`, `system_insert` |
| `communication_deliveries` | via outbox | same as outbox |
| `communication_suppressions` | none (platform data) | platform-only select/insert/update; the dispatcher reads under the platform context |
| `communication_digests` | `recipient_user_id` | self_select, platform_select, system_insert |
| `auth_email_challenges` | `user_id` | system insert/update only (no user read; verification is server-side), platform select for audit |
| `trusted_devices` | `user_id` | self select/update (revoke), system insert, platform select |
| `tenant_lifecycle_state` | `organization_id` | tenant select (owner), platform select/update, system update |
| `media_assets` (existing) | — | new `status='deleted'` tombstone value; no policy change |

## 36. Observability and metrics
New `CommunicationMetricsService` series (same `counter()`/`histogram()` factories, same `/metrics` gating): `atlas_comm_outbox_total{category,state}`, `atlas_comm_email_sends_total{provider,category,result}` (result = sent|deferred|suppressed|failed), `atlas_comm_email_delivery_events_total{provider,event}` (delivered|bounced|complained|opened?), `atlas_comm_dispatch_latency_seconds`, `atlas_comm_retry_attempts_total`, `atlas_comm_dead_letter_total`, `atlas_comm_quota_used_ratio{provider,window}` (gauge), `atlas_comm_digest_items_total`, `atlas_auth_otp_total{result}` (requested|verified|failed|expired|resent), `atlas_auth_trusted_device_total{event}`, `atlas_lifecycle_step_total{sequence,step}`, `atlas_retention_deletions_total{result}`, `atlas_retention_bytes_freed_total`. Alert rules added to `ops/alerts/atlas-prometheus-rules.yml` (and the drift-guard spec): quota ≥ 80 %/95 %, dead-letter growth, bounce rate > 2 %/complaint rate > 0.1 % over 24 h, OTP failure surge, security-email failures, retention deletion failures, dispatcher silent > 15 min. Logs: structured, ids only.

## 37. Admin / Platform Owner monitoring
Extend the Analytics area (established IA): a **Communications** tab (`/dashboard/analytics/communications`): quota gauges per provider (today/month, ceiling, class lines), sends/delivered/bounced/complained/suppressed over the range, dead-letter list with re-dispatch, suppression list management (add/remove with reason), OTP funnel, digest stats, provider health (last webhook age, last error). Plus the **retention** panel in Content delivery (§31). Platform Settings gains a **Communications** section: provider selection status (read-only display of which adapter is active — the secret stays on the host), from-name/reply-to, OTP defaults, digest hours, quota alert thresholds. Client Owner sees only their academy's communication settings and the Data & retention page — never platform-wide delivery data.

## 38. Required frontend UX (decided after inspecting the product)
- **Notification centre**: management topbar bell becomes a popover (latest 5, mark read, "view all"); `/dashboard/notifications` gains the pagination control it already computes, type/priority filters the JSON already defines, and clickable `actionUrl`. **Learner**: new `/my/notifications` section + bell in `LearnerShell` (currently none), same list component, learner routes for actions.
- **Communication settings**: replace the two switches on `/dashboard/profile` and `/my/profile` with a category matrix (security/transactional shown as locked "always on", lifecycle reminders, engagement email + digest cadence); platform `/dashboard/settings` Notifications tab becomes platform-wide defaults; remove the inert `push`/`sms` toggles until a channel exists (honesty rule already stated in the code).
- **Security**: `/my/security` and `/dashboard/profile` security section gain "Trusted devices" (list, revoke) beside sessions; OTP challenge screen on both sign-in surfaces using the existing `input-otp` primitive, resend with cooldown countdown, recovery path, accessible (announced errors, no colour-only), EN/AR.
- **Email verification** on the management host: add `/auth/verify-email` (exists only on academy hosts today) so links can land on either surface.
- **Lifecycle**: `LifecyclePanel` gains `grace_period` and `retention_warning` states; new `/dashboard/tenant/retention` page (state, timeline, affected courses/minutes, download action if approved, reactivate CTA); trial/renewal emails deep-link to `/dashboard/tenant/subscription`.
- **Academy settings**: Communications card (announcement email allowed, learner digest default, OTP policy override).
- **Platform**: Analytics → Communications tab; Settings → Communications section; a lightweight "Notify" preview in the announcement editor showing estimated audience and whether email is within today's budget.
All built with the UI/UX skill workflow, shared primitives (`SectionCard`, `EmptyState`, `ErrorState`, `SectionTabs`, `Switch`, `Badge`), logical props, full Arabic plurals.

## 39. Required backend APIs / services
Services: `CommunicationCatalog`, `CommunicationService.emit`, `CommunicationDispatchService`, `EmailQuotaService`, `TemplateRegistry`, `LinkBuilder` (platform + canonical academy host), `SuppressionService`, `DigestService`, `EmailOtpService`, `TrustedDeviceService`, `TenantLifecycleService` (sequence evaluator, driven by the subscription sweep), `VideoRetentionService` (+ `video-retention` BullMQ job), `CommunicationMetricsService`, `SubscriptionExpiryService` extended for paid periods/grace. Endpoints: `POST /auth/otp/verify`, `POST /auth/otp/resend`; `GET/DELETE /auth/trusted-devices[/:id]`; `GET/PATCH /users/me/communication-preferences`; `GET/PATCH /academies/:id/communication-settings`; `GET /organizations/:id/retention`, `POST /organizations/:id/retention/download-request` (if approved); platform: `GET /platform-communications/overview?days`, `GET /platform-communications/deliveries` (filters), `POST /platform-communications/deliveries/:id/redispatch`, `GET/POST/DELETE /platform-communications/suppressions`, `GET/PATCH /platform-communications/settings`, `POST /platform-organizations/:id/legal-hold`; webhooks: `POST /webhooks/email/:provider` (public, signature-verified, queued). Existing `notifications` endpoints unchanged; `password-reset-email` producer migrated to `emit`.

## 40. Required database / schema changes (for approval; not created)
New tables: `communication_outbox`, `communication_deliveries`, `communication_suppressions`, `communication_digests`, `auth_email_challenges`, `trusted_devices`, `tenant_lifecycle_state` (`organization_id` unique, `phase`, `anchor_at`, `next_step`, `next_step_at`, `legal_hold`, `hold_reason`, `deletion_scheduled_at`, `updated_at`), `academy_communication_settings` (or columns on `academies`). Columns: `media_assets.status` gains `deleted` + `deleted_at`, `deletion_reason`, `deletion_failed_at`, `bytes_freed`; `notifications.expires_at` + `retention_class`; `users.preferences` shape validated (no column change); `organizations.legal_hold_at` (or in lifecycle state). Indexes as listed in §18. Enum additions only (additive). All via Prisma migrations through the gated `production-migrations` run; each phase's migration is independently reversible (tables can be dropped; enum additions are kept).

## 41. Required background jobs / schedulers
`communications` queue: `dispatch` (event + 1-min sweeper), `digest` (hourly, sends those due at the recipient's local hour), `webhook`. `subscription-sweep` (existing, 15 min) extended: paid-period expiry → grace → expired; lifecycle sequence evaluation; retention stage evaluation and deletion enqueue. `video-retention` queue: `delete-asset`, `finalize-tenant`. `phase2-maintenance` (existing) extended: prune communication tables and notifications by retention class. No `@Cron`; everything stays on BullMQ repeatables as today.

## 43. Feature flags / rollout strategy
Backend `FLAG_*` env pattern (mode + academy allowlist) as with Phase 2–4 flags: `FLAG_COMM_OUTBOX_MODE` (`off` = legacy sync path, `shadow` = outbox written and dispatched with the stub while the legacy path still sends, `on`), `FLAG_AUTH_EMAIL_OTP_MODE` per surface (`off|new_device|always`), `FLAG_LIFECYCLE_SEQUENCES_MODE` (`off|dry_run|on` — `dry_run` records the steps it *would* emit), `FLAG_VIDEO_RETENTION_MODE` (`off|warn_only|on` — `warn_only` sends warnings but never deletes, which is the mode for the first full cycle). Order: outbox `shadow` → `on`; OTP on management then academies; sequences `dry_run` for one sweep cycle then `on`; retention `warn_only` for at least one full window before `on`. Each flag flip gets a production verification entry in the Master Plan's change log; none is a substitute for authorization.

## 44. Testing strategy
Unit: catalogue completeness (every key has en+ar, category, channels), template rendering (RTL attributes, no unescaped values, text part non-empty), quota class math, cooldown/cap logic, OTP hashing/attempt/replay rules, lifecycle step evaluator (pure function of state + now), retention window computation, link builder host selection. E2e (real Postgres + RLS + stub provider + in-memory BullMQ, as today): emit inside a transaction that rolls back → no outbox row; duplicate emit → one row; dispatch → stub receives exactly one message with localized subject; preference/suppression/quota deferral; digest assembly; OTP end-to-end on both surfaces incl. attempts/expiry/resend/trust cookie; sweep-driven trial sequence with a fake clock; grace/expiry transitions; retention warning stages and deletion jobs against `FakeVideoProvider` (verify → tombstone → recompute), reactivation race, legal hold; RLS suites for every new table (self/tenant/platform/outsider) mirroring `rls-*.e2e-spec.ts`; webhook idempotency. Alert-rule drift spec extended. Frontend: component tests (native DOM) for the notification centre, preference matrix, OTP screen, retention page, communications analytics; translation parity.

## 45. E2E scenarios (Playwright, local real Chrome, stub provider inspected via its "last message" API as password reset already is)
J7 **Owner lifecycle**: register → verify link → create org → start trial (T1 email) → fake-clock to T-24 h (T2) → expiry (T3, site offline banner) → subscribe via manual payment (S2 receipt) → approval (S1) → site back. J8 **Learner OTP + comms**: sign-up → OTP on first sign-in (code from stub) → trusted device → second sign-in without OTP → enroll (receipt) → review moderated (in-app only) → certificate (email) → `/my/notifications` shows the trail. J9 **Retention**: tenant driven to inactive with fake clock → W1–W4 emails and banners → deletion with `FakeVideoProvider` → tombstone in player → reactivation restores site. J10 **Platform ops**: quota thresholds, dead-letter re-dispatch, suppression add/remove, Communications tab values. AR mobile run of J8.

## 46. Failure / recovery scenarios
Provider down: rows retry with backoff; security failures alert; after recovery the sweeper drains. Redis flush: outbox is in Postgres, so nothing is lost; quota counters rebuild from deliveries; in-flight OTP challenges survive (table), only attempt counters reset (bounded by challenge TTL). Worker crash mid-send: provider idempotency key prevents a double; the claim lock expires with the transaction. Duplicate webhook: idempotent on message id + event. Provider migration mid-flight: adapter switch is a config change; pending rows dispatch through the new adapter; deliveries keep the old provider name. Wrong-tenant risk: the RLS suites are the regression net; branding is loaded by id under tenant context. Retention: any unverifiable delete leaves the asset intact and alerts; reactivation during deletion wins. Free-tier exhausted: deferral by class; OTP/security continue until the hard ceiling, at which point the login page tells the user honestly to retry later or use recovery — and the Platform Owner has been alerted since 80 %.

## 47. Migration / backward-compatibility strategy
No breaking change to `notifications` or its API. `NotificationFanoutService` stays as a thin façade over `emit` for one release (its 17 call sites migrate to typed keys incrementally; both write the same rows). `preferences.notifications.email` continues to be honoured as the engagement default until the matrix ships, then is migrated in place. Existing 14 templates are re-authored as en+ar catalogue templates; keys keep their names so audit history remains readable. `password-reset-email` queue is drained before its producer is switched. Stub provider remains the default for `NODE_ENV=test`. Every migration is additive (new tables, enum values, nullable columns).

## 50. Implementation phases (proposed decomposition)

| Phase | Scope | Depends on | Effort (eng-days, incl. tests/e2e/docs) |
|---|---|---|---|
| **C0 Foundation & provider go-live** | link builder + `PLATFORM_WEB_URL`; real links in verification/reset emails; `/auth/verify-email` on the management host; provider capabilities in the adapter; free-tier adapter (§14) + webhook endpoint; suppression table; delivery table; first metrics; Platform Settings "Communications" read-only status; enable the provider in production (host env, owner) | owner: provider account + DNS (§42) | 6–8 |
| **C1 Outbox & catalogue** | `communication_outbox`, `CommunicationService.emit`, catalogue with the 17 existing events migrated (typed keys, en+ar templates, branding), dispatcher + queue + retries + dead-letter, quota gating by class, cooldown/caps, `shadow` → `on` flag | C0 | 10–12 |
| **C2 Notification centre & preferences** | learner `/my/notifications` + bell, management popover, feed filters/pagination/actionUrl, category preference matrix (both surfaces, academy defaults, platform defaults), notifications retention class + prune | C1 | 6–8 |
| **C3 Missing transactional events** | enrollment/revocation/expiry, proof submitted (+ reviewer work queue), refund requested, approval/rejection/block, invites (email = the invite), staff-created learner welcome, course completed, review moderation, quiz auto-submit/invalidation, device events, announcements (in-app + capped email), staff daily digest, platform ops digest & incident receiver | C1 | 8–10 |
| **C4 Email OTP & trusted devices & security audit** | `auth_email_challenges`, `trusted_devices`, OTP service + endpoints, both sign-in UIs, security audit actions (sign-in/out, 2FA, sessions, devices), reset-confirmed notification, `emailVerifiedAt` set by OTP, flags per surface | C0 (links), C1 (security emails through outbox) | 8–10 |
| **C5 Tenant lifecycle sequences** | paid-period expiry → grace → expired sweep; `tenant_lifecycle_state`; trial T1–T6; subscription S1–S10; `LifecyclePanel` states; `dry_run` flag; org last-activity derivation | C1, C3 | 6–8 |
| **C6 Hosted-video retention** | retention windows, W1–W4, `video-retention` queue using `deleteAsset`, tombstones, legal hold, owner Data & retention page, platform retention view, `warn_only` mode for one full window, download-before-deletion if approved | C5; **Phase 4 blocker (2)**: real video infrastructure to verify against real providers (Fake provider suffices for e2e) | 8–10 |
| **C7 Platform communications console** | Analytics → Communications tab, dead-letter re-dispatch, suppression management, provider health, alert rules | C1 | 4–5 |

Total ≈ 56–71 engineering days sequentially; C2/C3/C4 can run in parallel after C1 (they touch disjoint modules), C7 alongside C5. Each phase follows the project workflow (local implementation → tests → commit → push main → deploy → production verification → Master Plan change-log entry) and ships behind its flag.

## 13. Free-first email provider comparison (researched 24 Sep 2026)

Facts checked against vendor pages on 24 Sep 2026; vendor pages that were unreachable are noted in the research log. Two 2026 changes matter most: **SendGrid has no free plan** (retired May 2025) and **Amazon SES withdrew its free tier for new accounts on 21 Jul 2026** (new accounts get general AWS credits for six months and start in a sandbox limited to verified recipients).

| Provider | Free tier | Card | Send to anyone on free | API / SMTP | Webhooks on free | Suppression | Data region | First paid tier | Notes |
|---|---|---|---|---|---|---|---|---|---|
| **Brevo** | **300/day** (~9k/mo), permanent | No | Yes (after account validation) | Both | Yes, unlimited logs | Yes | EU (France) | Starter $9/mo, 5k, no daily cap | "Sent with Brevo" footer on free (+$9/mo to remove); one meter shared with campaigns |
| **Resend** (already coded) | 3,000/mo, **100/day**, 3 domains | No | Yes once domain verified | Both | Yes (full event set) | Yes | Send regions US/EU/SA/JP; **metadata stored in US** | Pro $20/mo, 50k | 10 req/s; `Idempotency-Key` supported; cleanest API |
| Mailjet | 6,000/mo, 200/day | No | Yes | Both | Yes | Yes | EU | Starter $9/mo | Logo on free; **over-cap mail is queued then deleted after 3 days** — unsafe for OTP |
| Mailgun | 100/day, 1 domain, 1-day logs | No | After domain verification | Both | Yes | Yes | US/EU | Basic $15/mo, 10k | form-encoded API |
| MailerSend | 500/mo, 100/day, **100 API req/day**, approval | No | After approval | Both | 1 webhook | Yes | EU/US | Hobby $7/mo | too small |
| Postmark | **100/mo** dev plan; test mode until approval | No | After approval | Both | Yes | Yes | **US only** | Basic $15/mo, 10k | deliverability benchmark, not a free option |
| SMTP2GO | 1,000/mo, 200/day | No | Yes | Both | 1 webhook | Yes | US/EU/AU | Starter $10/mo, 10k | monthly cap hard-rejects |
| Zoho ZeptoMail | 10,000 credits, expiry unverified (6 mo per Zoho page, 1 mo per third party); transactional only; 2–3 day review | ? | After review | Both | Yes | Yes (auto hard bounces) | US/EU/IN/AU/JP/CN | $2.50 / 10k | strict no-marketing terms |
| Elastic Email | 100/day | No | Yes | Both | **Pro only** | Yes | — | Starter $19/mo | no webhooks on free |
| Amazon SES | free tier withdrawn for new accounts; sandbox 200/day, verified recipients only | Yes | After production-access request | Both (no SMTP in `me-south-1`/`me-central-1`) | via SNS/EventBridge | account-level | incl. Bahrain/UAE | $0.10–0.16 / 1k | SigV4 signing (use the official SDK) |
| SendGrid | **none** (60-day trial, 100/day) | — | trial | Both | paid | Yes | US | $19.95/mo | — |
| Cloudflare Email Service | public beta; **Workers Free cannot send to arbitrary recipients** | Yes (Workers Paid $5) | paid only | Workers/REST/SMTP | ? | Yes | global | $5/mo incl. 3k | beta |

No free tier anywhere offers a dedicated IP; all free sending is shared-reputation. No provider offers Middle-East-resident free storage; SES has Gulf regions on the paid path.

## 14. Recommended initial provider

**Brevo as the primary free-tier adapter, with the existing Resend adapter registered as the second provider.** Brevo's 300/day is three times the next transactional-grade free ceiling and is permanent; it includes REST + SMTP, delivery/bounce/complaint webhooks, unlimited logs, a suppression list and EU hosting, and its Starter tier removes the daily cap without changing the API or DNS. Its costs are a footer on free emails (owner decision §O-3: accept the footer, or pay $9/mo for a clean footer plus $9/mo cap removal — the first paid dollars Atlas would spend on email) and an account-validation hold on new accounts, which is why Resend — already implemented — is configured as the fallback from day one: together they give ~400 accepted emails/day at zero cost, and the quota service (§21) routes security mail to whichever provider has headroom.

Why not Resend first: 100/day is tight for the OTP-on-new-device model on a single academy's busy morning, and all message metadata is stored in the US regardless of send region. Why not SES first: no free tier for new accounts and a sandbox that cannot reach arbitrary recipients until a written request is approved. Why not Mailjet: its over-cap "queue then delete" behaviour would silently drop OTPs.

## 15. Provider abstraction / migration strategy

- One `EmailProvider` interface (§16) with `capabilities()`, `send()`, `verifyWebhook()`, `parseWebhookEvents()`; adapters `brevo`, `resend`, `stub`, later `ses`. Selection by env: `EMAIL_PROVIDERS=brevo,resend` (ordered), each with its own key/from; the dispatcher picks the first provider with quota headroom for the message's class, records the provider used on the delivery row, and the webhook route is per provider. Adding SES later = one adapter file + env; no template, catalogue, outbox or UI change.
- Normalise the three things that differ between providers inside adapters only: recipient/from object shape, idempotency header, webhook event names → the delivery status enum.
- Sending domain: Atlas's own verified domain (`EMAIL_FROM_EMAIL` on the platform domain) for every academy, with the academy as display name and `Reply-To` (§25); per-academy sending domains are a paid-tier future because free tiers cap verified domains at 1–3.
- **Paid/high-volume stage**: move to Amazon SES Essentials ($0.10–0.16 per 1k, UAE/Bahrain regions available, account-level suppression, SNS→webhook bridge) when monthly volume approaches Brevo Starter's 5k or deliverability needs a custom MAIL FROM and warm-up control; alternatively Postmark Pro for a managed deliverability benchmark (US data only). Migration steps: add adapter → shadow-send 1 % → switch order in `EMAIL_PROVIDERS` → keep Brevo/Resend as fallbacks → decommission. Templates, catalogue, outbox, metrics and UI are untouched by design.

## 42. Required external provider configuration (owner actions; none performed)
1. Create the Brevo account on Atlas's domain; complete account validation; verify the sending domain: TXT `brevo-code:<hash>` at the root, DKIM CNAMEs `mail._domainkey` and `mail2._domainkey`, DMARC TXT `_dmarc` (`p=none` with `rua` for the first weeks, then `p=quarantine`). Create an API key (transactional scope), set `EMAIL_PROVIDERS=brevo,resend`, `BREVO_API_KEY`, `EMAIL_FROM_EMAIL`, `EMAIL_FROM_NAME`, `PLATFORM_WEB_URL`, and the webhook URL `https://atlass.dpdns.org/api/v1/webhooks/email/brevo` with its signing secret — all in the host env at `/opt/atlas`, never in the repo.
2. Resend (fallback): verify the same domain on `send.<domain>` (MX + SPF TXT + `resend._domainkey` TXT), API key, webhook URL and secret; `RESEND_API_KEY` (renaming today's `EMAIL_API_KEY`).
3. Confirm the current production value of `EMAIL_PROVIDER` on the host (§O-1) before C0 flips anything.

## 48. Cost model at current scale
Volume estimate (from production facts: 17 organisations, one real academy with 0 students, 16 trial-expired orgs; add the OTP model and lifecycle sequences): security ≈ 1 email per new device per user, verification/reset on demand; lifecycle ≈ 3–6 emails per org over its first three months; transactional ≈ 3–5 per course purchase; digests ≈ 1 per active staff member per day. Even at 50 active organisations and 500 active learners this is well under 300/day on average with occasional bursts — **$0/month on Brevo free + Resend free**, or $9–18/month if the owner prefers no footer/no daily cap. Infrastructure cost is unchanged (same Postgres/Redis/VPS; the new tables are small and pruned).

## 49. Scaling model for future volume
The outbox + quota + provider-order design scales by configuration: at ~5k/month switch Brevo to Starter or bring SES in as the primary (≈$1–8/month at 10–50k emails); at 50k+/month SES with a dedicated IP and warm-up; multiple worker replicas are safe because dispatch claims rows with `SKIP LOCKED`; per-tenant fairness (a large academy cannot starve others) comes from the per-recipient caps and the class budgets, and can add a per-organisation daily share if ever needed. Pruning keeps the tables bounded; metrics stay label-bounded (no per-tenant labels).

---

## Owner summary (A–O)

**A) What Atlas already has.** A correct two-step notification producer (in-transaction dedup row + post-commit email) with a thin, replaceable `EmailProvider` (stub + Resend adapter), 17 producer sites across billing/commerce/certificates/support/provisioning/live sessions, a user-scoped notifications feed with RLS and a summary endpoint, per-user `email` preference, a queued password-reset email with retries, 12 BullMQ processors and four repeatable sweeps, tenant + platform audit logging, 22 Prometheus series with 10 alert rules, TOTP 2FA with recovery codes, hashed opaque tokens for verification/reset/invites, a learner device cap, EN/AR i18n with full plurals and RTL on the frontend, and an announcements module.

**B) What is missing.** A real provider enabled in production (unverifiable from the repo; the default is `stub`); links in emails (raw tokens today); retries/observability/quota control/suppression/bounce handling for every email except password reset; localized templates (10 of 14 English-only) and any HTML/RTL layout or branding; a category preference model (one global switch today; security mail can be switched off); notifications for roughly half of the user-significant transitions (enrollment, revocation, completion, review moderation, proof submitted, approvals/blocking, devices, announcements); any staff work-queue or Platform Owner incident channel; any lifecycle communication (trial started/ending/expired, renewal, cancellation) — and the paid-period expiry itself, which does not exist; email OTP, trusted devices, sign-in/2FA/session audit events, enforced email verification; a learner notification surface; any hosted-video retention or deletion path (`deleteAsset` exists and is never called); email/notification metrics and monitoring.

**C) What I recommend / D) Why.** Complete P17's architecture rather than replace it: a typed event catalogue and a transactional outbox drained by one queue (durability, retries, quota gating and observability without touching business transactions); category-aware preferences where security/transactional cannot be disabled; quota classes that always leave headroom for OTP; localized EN/AR templates with a real link builder and academy/platform branding; email OTP on unrecognised devices (not every login), superseded by TOTP, with trusted devices; sweep-driven lifecycle sequences with few, well-timed touches; a warn-only-first hosted-video retention policy that deletes bytes only after four warnings and verified provider deletion, keeping every non-video record; Platform Owner monitoring in the existing Analytics IA. Detailed reasoning is in §9–§12, §16–§33.

**E) Provider comparison.** §13. **Recommended:** Brevo (free, 300/day, webhooks, EU) + Resend (already coded) as fallback; SES for the paid stage (§14–15).

**F) Lifecycle / event matrix.** §8 (inventory), §10 (channel matrix), §26–§30 (sequences with timings).

**G) Email + notification architecture.** §16–§25.

**H) Video-retention lifecycle.** §31–§32: inactive = continuously unsubscribed since the anchor date; hosted video only; 90 days (former trial) / 180 days (former paid); warnings at −30/−14/−7/−1 days; async, verified, audited deletion with tombstones; legal hold; warn-only mode for a full first cycle.

**I) OTP / authentication model.** §12: email OTP on new device, TOTP supersedes, 6 digits / 10 min / 5 attempts / 60 s resend / 3 codes, HMAC-hashed in a table, trusted-device cookie 90 d (staff) / 180 d (learners), policy switches, full audit.

**J) Implementation phases.** §50: C0 foundation & provider go-live → C1 outbox & catalogue → C2 notification centre & preferences ∥ C3 missing events ∥ C4 OTP & security audit → C5 lifecycle sequences ∥ C7 platform console → C6 video retention.

**K) Dependencies / blockers.** (1) Owner: provider account, DNS, host env values, confirmation of the current `EMAIL_PROVIDER` (§42). (2) `PLATFORM_WEB_URL` and canonical-host link building (C0). (3) Paid-period expiry does not exist — C5 implements it; until then S3–S10 cannot run. (4) **Phase 4 blocker (2)** (hosted-video infrastructure unset) limits C6's verification to `FakeVideoProvider`; real-provider deletion verification waits on it — recorded as a dependency, not assumed resolved. (5) Phase 4's alert receiver wiring remains open; C7's in-product receiver complements it. (6) Product decisions in O.

**L) Effort by phase.** C0 6–8, C1 10–12, C2 6–8, C3 8–10, C4 8–10, C5 6–8, C6 8–10, C7 4–5 engineering days (≈56–71 sequential; ≈40–45 with the parallel tracks).

**M) Provider cost at the initial stage.** $0/month (Brevo free + Resend free); $9–18/month if the footer/daily cap are unacceptable.

**N) Migration path to paid/high volume.** Add the SES adapter, shadow-send, reorder `EMAIL_PROVIDERS`, keep fallbacks; no change to templates, catalogue, outbox, metrics or UI (§15).

**O) Questions requiring owner approval.**
1. What is `EMAIL_PROVIDER` set to on the production host today, and has any real email ever been sent? (Determines whether C0 is "enable" or "migrate".)
2. Approve Brevo as the primary free provider and Resend as fallback, and the sending domain/from-name to verify.
3. Accept Brevo's "Sent with Brevo" footer during the free stage, or approve $9–18/month from day one?
4. Approve the OTP policy defaults: `new_device` on both surfaces, trust 90 d (staff) / 180 d (learners), TOTP supersedes; and whether an academy owner may set `off`.
5. Approve the lifecycle timings: trial T1/T2(−24 h)/T3/T4(+3 d)/T5(+14 d, content-gated)/T6(+45 d); paid grace 7 days; renewal reminders −7 d/−1 d; post-expiry +7 d/+30 d.
6. Approve the retention windows (90 d former-trial / 180 d former-paid), the four-warning sequence, that only hosted video bytes are deleted, `warn_only` for the first full window, and whether to build "download before deletion".
7. Confirm the preference model: security and transactional emails cannot be disabled by users; engagement/reminders can; no marketing category until a consent model exists.
8. Confirm the seven-phase order and that C2/C3/C4 may run as parallel worker streams under the DL-41 orchestration rules.


---

# Approved decisions and execution record (append-and-update; history is never rewritten)

## AD. Approved business / product decisions (owner, 24 Sep 2026)

| # | Decision | Consequence for this plan |
|---|---|---|
| AD-1 | **No production email has ever been sent from Atlas.** The owner's **Gmail address is the approved sender identity** (From). Sender identity ≠ delivery provider ≠ SMTP infrastructure. | ~~C0 verifies the Gmail address as a *sender* at Brevo and Resend (single-sender verification, no domain DNS required)~~ **CORRECTED 25 Sep 2026 — see AD-1a.** Brevo's half is done and live. DMARC alignment for gmail.com is not achievable, so deliverability rides on the providers' shared reputation — a known limitation until a custom domain is approved. |
| AD-1a | **Correction to AD-1, found while hardening the fallback provider.** Resend has **no single-sender-verification flow**: it sends only from a domain verified by DNS. Its one non-domain path, `onboarding@resend.dev`, can send only to the Resend account owner's own address, so it cannot serve real users. AD-1's premise therefore held for Brevo and does not hold for Resend. | Two consequences. (1) Resend cannot go live on the Gmail identity at all — it needs a sending domain (BL-3). (2) Enabling Resend is **not** a one-line change: `EMAIL_FROM_EMAIL` is a single value shared by both adapters (`brevo-email.provider.ts`, `resend-email.provider.ts`), so switching the From address to the verified domain also changes what Brevo sends as — and **that new address must be verified at Brevo in the same change window**, or the live provider breaks. Sequence recorded in BL-3. |
| AD-2 | **Brevo = primary provider, Resend = fallback.** Clean provider abstraction; no provider logic leaking into the product. | §15 provider order `brevo,resend`; fallback rule: Resend is used when Brevo rejects (5xx / 429 / quota exhausted for the message's class) or is unconfigured; recorded per delivery. |
| AD-3 | **Brevo Free plan and its "Sent with Brevo" footer are accepted for the initial phase.** No engineering effort on footer removal; no plan upgrade for it. | Explicit business decision; templates must look correct with the injected LTR footer under RTL content (§13 note). |
| AD-4 | **OTP policy approved as proposed** (§12), production-grade, never weakening existing controls. | Phase C4 as specified. |
| AD-5 | **Trial and paid-subscription lifetimes approved as proposed** (§26–§27) **plus a mandatory requirement: expiration must be server-authoritative and actually enforced** for trials and paid periods; the existing defect "access remains after the period ended" is in scope now, with regression tests for the ten listed cases. | New phase **C5a Expiry enforcement** pulled forward and made a dependency of everything lifecycle-related; see §EX below. |
| AD-6 | **Video retention windows and warning behaviour approved as proposed** (§31–§32), enforced server-side, tested and observable. | Phase C6 as specified (warn-only for the first full window remains part of the approved behaviour). |
| AD-7 | **Preference model approved** (§23): security-critical never disableable; transactional/lifecycle/engagement distinct; no marketing behaviour without a consent model. | Phase C2 as specified. |
| AD-8 | **Parallel execution approved** under the DL-41 orchestration rules (lead = integration/deploy authority; workers never push, deploy, migrate, or alter this plan). | Dependency graph in §DG. |

## EX. Expiry enforcement requirement (AD-5) — discovery and design

Discovered (D2 report, verified in code): paid subscriptions **never expire** — nothing reads `currentPeriodEnd`, `markExpired` is dead code, `cancelAtPeriodEnd` is never acted on, `grace_period`/`graceEndsAt` are never set. Trials expire only through the 15-minute sweep; `SubscriptionAccessService.getAccessState` already closes the sweep gap for trials by checking `trialEndsAt` against the clock, but nothing equivalent exists for paid periods, so an `active` row whose `currentPeriodEnd` has passed keeps full access indefinitely — the defect the owner reports.

Design (server-authoritative, defence in depth):
1. **Effective entitlement is computed, never trusted from the row.** `SubscriptionAccessService` derives `effectiveStatus` from `(status, trialEndsAt, currentPeriodEnd, graceEndsAt, cancelAtPeriodEnd, now)`: `trialing` past `trialEndsAt` → `trial_expired`; `active` past `currentPeriodEnd` → `grace_period` until `currentPeriodEnd + 7 d` (§27) unless `cancelAtPeriodEnd`, in which case → `cancelled`; `grace_period` past `graceEndsAt` → `expired`. Every consumer of access state (`SubscriptionAccessInterceptor`, `isServingEligible`, `EntitlementEnforcementService`, the lifecycle endpoint, the JWT/refresh path where subscription claims are embedded) uses the effective status, so a stale row, stale cache, stale session or a failed sweep cannot grant access.
2. **The sweep persists what the computation already decided** (`active→grace_period→expired`, `trialing→trial_expired`, `cancelAtPeriodEnd→cancelled`), so the row catches up and lifecycle events fire; a missed or delayed sweep changes nothing about access.
3. **Caches**: the public-website serving-eligibility cache (60 s) keys on effective status and is invalidated on every transition; the frontend `useSubscriptionLifecycleState` refetches on window focus and on 402/403 entitlement responses.
4. **Renewal**: a payment approved before expiry extends from `currentPeriodEnd`; after expiry it starts a new period from approval time; both restore `active` immediately (existing `upsertForPlanPurchase`, adjusted for the extend-vs-restart rule).
5. **Regression tests** (e2e, fake clock): the ten owner-listed cases plus "sweep disabled → access still refused after period end", "grace ends → expired", "cancelAtPeriodEnd → cancelled at period end, no grace".

## DG. Dependency graph and parallel workstreams

```
M1 schema (outbox, deliveries, suppressions, digests, notifications retention)  ─┐
M2 schema (auth_email_challenges, trusted_devices)                               ─┼─ lead, serialized, one gated migration run per wave
M3 schema (tenant_lifecycle_state, media_assets tombstone columns)               ─┘

Wave 1 (parallel)                     Wave 2 (parallel, after M1/M2 + wave-1 audits)      Wave 3 (after wave 2)
  W-EXP  expiry enforcement (C5a)       W-OUT  outbox + catalogue + dispatcher + templates    W-LIFE lifecycle sequences (C5) + video retention (C6)
  W-PROV Brevo adapter, provider        W-OTP  OTP + trusted devices + auth audit (C4)        W-FE3  retention page, lifecycle states, comms analytics
         registry/fallback, webhooks,   W-FE2  OTP screens, trusted devices, comms settings        tab, platform comms settings (C7 UI)
         suppression, quota (C0/B)      W-EVT  missing transactional events + digests (C3)
  W-FE1  notification centre (learner
         + management), preference
         matrix UI (C2 UI)
  Lead   link builder + PLATFORM_WEB_URL,
         /auth/verify-email (mgmt), real
         links in reset/verify (C0)
```
Serialized by the lead: every schema change, every merge, every push/deploy, every gated migration run, every production verification and every update to this record.

## ST. Workstream status (living)

| Workstream | Phase | Owner | Status | Commits | Deploy runs | Production verification | Notes |
|---|---|---|---|---|---|---|---|
| Plan update (this record) | — | lead | DONE | see below | — | n/a | approval recorded |
| Foundation schema (`20261013000000_p64_comm_foundation`) | C0–C6 | lead | **DONE — applied in production** | `112c481` | gated run `36058096657` success | ✅ run log: "Applying migration 20261013000000_p64_comm_foundation … All migrations have been successfully applied"; API booted and healthy afterwards | 7 tables + RLS, `notifications.retention_class`, `media_assets` tombstone columns |
| Lead C0 (verify-email route on the management host) | C0 | lead | **DONE — deployed** | atlas-front `f503ba1` | atlas run `36071154378` success | ✅ `verify-email` present in the production bundle `index-hrSkqOpw.js` | link builder + real links in reset/verification emails delivered by W-OUT (`PLATFORM_WEB_URL`) |
| W-EXP expiry enforcement (AD-5) | C5a | worker (`ws-expiry`), lead-verified | **DONE — deployed** | `dfdb7d3`, merge `932319a` | run `36058096657` (deploy) | ✅ API healthy post-deploy; behaviour proven by 15/15 regression incl. sweep-not-run, stale session, stale cache, 1 ms boundaries | the reported defect (access after period end) is fixed: effective status is computed, not trusted |
| W-PROV Brevo/registry/webhooks/suppression/quota | C0/C1 | worker (`ws-provider`), lead-verified | **DONE — deployed, dormant on the stub** | `c19943d`, merge `d166c96`, boot contract `edef8a0` | run `36058096657` | ✅ `/webhooks/email/{brevo,resend}` answer 404 while no real provider is registered (by design); API booted with the new env validation — proving the deploy is safe with production's unchanged env | goes live when BL-1 is satisfied |
| W-FE1 notification centre + preferences UI | C2 | worker (`ws-notif-ui`), lead-verified | **DONE — deployed** | atlas-front `1f04390`, merge `f5e12f3` | atlas run `36071154378` success | ✅ `my/notifications` and `communication-preferences` present in the production bundle | 4 harness failures found and fixed by the lead (missing localization provider; Radix popover/select never settling under jsdom; an unscoped `listitem` query) |
| W-OUT outbox/catalogue/dispatcher/templates | C1 | worker (`ws-outbox`), lead-verified | **DONE — deployed** | `c6e671a`, fix `3c573f9`, merge `94eb72d` | run `36069472799` success (no migration; none added) | ✅ `GET /api/v1/users/me/communication-preferences` answers 401 (route live and guarded) vs 404 on an unknown route; `POST /api/v1/webhooks/email/brevo` fails closed with 401 | migrates the 17 producers, preserving all 14 pre-existing dedupe keys exactly; adds `PLATFORM_WEB_URL` + link builder. Four integration defects found and fixed at merge — see MR-2 |
| W-OTP | C4 | worker | PENDING | | | | |
| W-EVT missing events + digests | C3 | worker | PENDING | | | | |
| W-FE2 OTP/trusted devices/comms settings UI | C4/C2 | worker (`ws-otp-ui`), lead-verified | **DONE — deployed (UI only; backend is C4/W-OTP)** | atlas-front `e104992`, merge `ead967f` | atlas run `36071154378` success | ✅ `trusted-devices` present in the production bundle | the UI codes against the OTP / trusted-device / communication-settings contracts fixed by the lead; it stays inert until W-OTP ships the backend |
| W-LIFE lifecycle + retention | C5/C6 | worker | PENDING | | | | |
| W-FE3 retention/lifecycle/comms analytics UI | C6/C7 | worker | PENDING | | | | |

## BL. Known blockers (living)

| # | Blocker | Type | Autonomous? | Status |
|---|---|---|---|---|
| BL-1 | Brevo go-live: account, single-sender verification of the Gmail identity, API key, webhook secret, and the host env | credential / human | No | **RESOLVED 25 Sep 2026** — owner supplied the key; sender verified (`active=true`); configured through the authorised env-sync path; real delivery verified end to end (see MR-3) |
| BL-3 | **RESEND SENDING DOMAIN** — the Resend account exists and its dashboard is reachable, but no sending domain is configured. Resend has no single-sender path (AD-1a), so a DNS-verified domain is the only way it can ever send. This is the ONLY external input still missing. Everything not requiring it is complete. | external / human | No | OPEN — narrow. Blocks ONLY: Resend DNS/sender verification, real Resend delivery, and adding `resend` to `EMAIL_PROVIDERS`. Blocks nothing else; the code is finished and proved against Resend's documented contract. |

### BL-3 — exact steps once a sending domain exists

Ordered, because step 6 will break the live provider if it is done alone.

1. **Resend → Domains → Add Domain.** Use a sending SUBdomain (`send.<domain>`), not the root, so sending reputation stays off the corporate domain. The region is chosen at creation and is immutable afterwards.
2. **Add the DNS records Resend then displays** — copy the values from the dashboard, never guess them; the DKIM key and the region inside the MX target are issued per domain:
   - `MX` on the sending subdomain → `feedback-smtp.<region>.amazonses.com`, priority 10 (bounce/complaint feedback).
   - `TXT` (SPF) on the sending subdomain → `v=spf1 include:amazonses.com ~all`.
   - `TXT` (DKIM) at `resend._domainkey.<sending subdomain>` → the `p=MIGfMA0…` value shown.
   - `TXT` (DMARC) at `_dmarc.<domain>` → start `v=DMARC1; p=none; rua=mailto:…`, tighten later. Not required to verify, but required in practice by Gmail/Yahoo bulk-sender rules.
3. **Wait for verified** in the dashboard (usually minutes; up to 72 h for propagation). Do not continue until it reads verified.
4. **API key**: Resend → API Keys → Create, *Sending access*, scoped to the verified domain → set `RESEND_API_KEY`.
5. **Webhook**: endpoint `https://atlass.dpdns.org/api/v1/webhooks/email/resend`, subscribed to exactly the seven events the adapter maps (`email.delivered`, `email.bounced`, `email.complained`, `email.opened`, `email.clicked`, `email.delivery_delayed`, `email.failed`); copy the `whsec_…` secret → `RESEND_WEBHOOK_SECRET`. Until it is set that route accepts nothing (fails closed, asserted by test).
6. **Move the sender identity**: set `EMAIL_FROM_EMAIL` to an address at the verified domain **and verify that same address at Brevo in the same change window** (AD-1a). Doing this without the Brevo half breaks the provider that is currently live.
7. **Only then** set `EMAIL_PROVIDERS=brevo,resend`. Listing `resend` without its key refuses to boot by design — that guard is correct; do not work around it.

A bounded smoke test is possible before any of this, but **only in a throwaway environment**: `EMAIL_PROVIDERS=resend` with `EMAIL_FROM_EMAIL=onboarding@resend.dev`, sending to the Resend account owner's own address. Never in production — `EMAIL_FROM_EMAIL` is shared and it would break Brevo.
| BL-2 | Real-provider video deletion verification depends on Phase 4 blocker (2) (video infrastructure unset) | infrastructure | No | OPEN — C6 verified against `FakeVideoProvider` |


## MR-1. Milestone record — foundation, expiry enforcement and the email provider layer (24 Sep 2026)

**Phase:** C0 (part) + C5a. **Deployed:** backend `edef8a0` via gated run `36058096657` (migrate-and-deploy, success).

**What was implemented.** (1) The communications foundation schema: `communication_outbox`, `communication_deliveries`, `communication_suppressions`, `communication_digests`, `auth_email_challenges`, `trusted_devices`, `tenant_lifecycle_state`, all under FORCE RLS following the P17/P64 discipline (system insert, self/tenant/platform select, platform update, bounded retention DELETE policies), plus `notifications.retention_class` with its own retention policy and `media_assets` tombstone columns and a `deleted` status. (2) **Server-authoritative expiry (AD-5)** — the owner-reported defect. (3) The email provider layer: widened `EmailProvider` contract, Brevo (primary) and Resend (fallback) adapters, ordered registry with quota-aware fallback, `EmailQuotaService` with per-class budgets, `SuppressionService`, delivery webhooks with signature verification, and the first communications metrics and alert rules.

**What changed, and why it matters.** Paid subscriptions never expired: nothing read `currentPeriodEnd`, `markExpired` was dead code, `cancelAtPeriodEnd` was recorded and never acted on, `grace_period`/`graceEndsAt` were never set. Access is now decided from a computed **effective** status shared by the live check and the sweep, so a stale row, stale cache, stale session or a failed background job cannot grant access; grace keeps access and keeps the site served, expiry removes both and invalidates the serving cache; renewal before period end extends, after it restarts.

**Important files.** `src/plans/utils/subscription-effective-status.util.ts`, `src/plans/utils/clock.ts`, `src/plans/services/{subscription-access,subscription-expiry,subscription-sweep}.service.ts`, `src/billing/services/payment-application.service.ts`, `src/communications/providers/*`, `src/communications/services/{email-quota,suppression,delivery-event}.service.ts`, `src/communications/controllers/email-webhook.controller.ts`, `prisma/migrations/20261013000000_p64_comm_foundation/`.

**Tests executed (lead-run, not worker-reported).** Backend unit 1440/1440 across 114 suites on the merged state; e2e 495/495 across 43 suites (expiry, providers, plans, billing, tenant, entitlement, provisioning, trial, notifications, auth-security, password-reset, signup-email-security). New: `p64-comm-expiry-enforcement` 15/15 — active/expired trial, active/expired paid, session minted before expiry, stale serving cache, 1 ms either side of the boundary, cancel-at-period-end, sweep-not-run, idempotent re-runs, renewal before/during-grace/after. `p64-comm-providers` 9/9. `p64-comm-email-env-boot` 6/6. tsc 0; eslint clean.

**Security validation.** Webhook secrets compared constant-time over hashes (length never leaks); unverified webhooks fail closed with 401 and a metric; addresses masked in logs and never logged with secrets; all new raw SQL parameterised; every new table FORCE RLS with the system-insert/self-select/platform-select shape; dispatcher and sweeps run under the platform-owner user context, never without one.

**Production verification.** Migration applied (run log quoted above). API booted with the new env validation and answers 401 on guarded routes rather than 5xx — the specific risk this deploy carried, since production sets no `EMAIL_*` at all. Public catalog read healthy and now carries the Phase 4 stats fields. `/webhooks/email/{brevo,resend}` correctly answer 404 while no real provider is registered.

**Limitations / blockers.** BL-1 (unchanged): no real email is sent until the owner creates the Brevo and Resend accounts, verifies the Gmail sender, and sets the host env — the code is deliberately dormant on the stub until then, which is what makes this deploy safe. BL-2 (unchanged). The outbox dispatcher does not yet write `communication_deliveries` on send; that arrives with C1.

**Next.** C1 (`ws-outbox`): outbox + catalogue + dispatcher + EN/AR templates + link builder + the 17 migrated producers + the communication-preferences endpoint, then the two frontend workstreams (C2 notification centre/preferences, C4 OTP UI).

## MR-2. Milestone record — the outbox, the migrated producers, and the notification/OTP UI (25 Sep 2026)

**Phase:** C1 + C2 + the UI half of C4.
**Deployed:** backend `94eb72d` via run `36069472799` (success, no migration — none was added); frontend `ead967f` via run `36071154378` (success).

**What was implemented.** `CommunicationService.emit` — the one call a domain service makes to tell a person something — writing the in-app row and the durable `communication_outbox` intent inside the caller's own transaction, and never sending. The catalogue (one entry per event: category, channels, priority, dedupe rule, retention class, locale source, action URL), ~24 EN/AR templates with a registry, the link builder, `CommunicationDispatchService` (preferences → suppression → cooldown → daily cap → digest), the `communications` queue (dispatch/sweep/digest/prune), the `/users/me/communication-preferences` endpoint, and communications metrics. All 17 notification producers migrated from `NotificationFanoutService.sendEmailAfterCommit` to `emit`, and P17's `EmailService` deleted with them — there is now no second way to send an email from a domain service. On the frontend: the notification centre on both surfaces, the learner notifications page, the category preference matrix, the academy communication-settings card, and the OTP / trusted-device surfaces (inert until W-OTP ships their backend).

**Defects found and fixed — none of which existed on either branch alone.** Both branches passed their own suites; these appeared only in the combined tree, which is the argument for integrating and re-verifying rather than trusting green workstreams:

1. **Two BullMQ workers on one queue.** Each branch added a `@Processor('communications')`. BullMQ hands a job to whichever worker takes it first, not the one that understands its name, so the two competed for every job and each silently dropped what it did not recognise through its `default` branch — roughly half the outbound emails and half the inbound delivery webhooks, with no error anywhere. Folded into the single `CommunicationsProcessor`; `one-worker-per-queue.spec.ts` now pins the rule structurally (verified to fail when the deleted processor is restored).
2. **Tag shape mismatch.** The dispatcher passed `tags` as a record; the merged provider contract takes a flat string array, so `tags.includes(...)` would have thrown on every outbox email. `EmailTransport` now translates to `key:value` strings in one place and forwards `category`, so the registry reserves the right quota line.
3. **Suppression was still the no-op.** `COMMUNICATION_SUPPRESSION` was bound to the port's default stub, so the dispatcher would have mailed addresses that hard-bounced or filed spam complaints. Bound to the real `SuppressionService`; the test that covered this moved onto the surviving path and now asserts the wiring, which is precisely what a no-op binding hides.
4. **A deduped notification aborted the caller's transaction.** `NotificationsRepository.create` swallows the `(user_id, dedupe_key)` unique violation and returns `false` — but in PostgreSQL the failed statement has already aborted the transaction, so a caller told "already notified, carry on" fails on its next statement with `25P02` and has its COMMIT silently downgraded to a ROLLBACK, losing the business writes it made first. `emit` guarded itself at the call site; the fan-out and every other direct caller did not. The savepoint moved into `create`, where the swallow lives, so all callers inherit it.

**Why (4) matters beyond the outbox.** The affected callers are the money and grading paths — `approvePayment` reads the payment back after notifying, and the live-session announcement loops over every enrolled student. A single duplicate would have taken the whole transaction with it. The pre-existing N11 test missed it because it calls the writer in two *separate* transactions, where the aborted one simply rolls back empty; N13/N14 now call it the way a real producer does and fail with `25P02` on the pre-fix code (verified by reverting).

**Important files.** `src/communications/**` (catalogue, templates, services, queue, controllers, metrics), `src/common/database/savepoint.util.ts`, `src/notification-events/repositories/notifications.repository.ts`, `src/communications/services/{email-transport,communication-dispatch,communication}.service.ts`, `src/communications/queue/{communications.types,communications.processor}.ts`, and the 17 producers across billing, certificates, course-commerce, identity, instructor, live-sessions, notifications, observability, platform and provisioning.

**Tests executed (lead-run, not worker-reported).** Backend: 118 unit suites / 1887 tests passed; tsc exit 0; e2e run serially — `p64-comm-outbox`, `p64-comm-providers`, `p64-comm-expiry-enforcement`, `p64-comm-email-env-boot`, `notifications` — 5 suites / 70 tests passed. New: `savepoint.util.spec.ts` 6/6, `one-worker-per-queue.spec.ts` 3/3, notifications N13/N14. Frontend: 84 suites / 776 tests, with `AcademyReportsPage.test.tsx` (2 tests) failing under full-suite contention and passing 11/11 in isolation — a timeout, not an assertion failure, in a file these commits do not touch. eslint: 36 pre-existing errors, all in files this work does not touch (main itself had 38).

**Production verification (evidence, not assertion).** Backend: `GET /api/v1/users/me/communication-preferences` → 401 with the backend's own error envelope, against 404 for an unknown route under the same prefix — the new route is live and guarded, and the old build could not have answered it. `POST /api/v1/webhooks/email/brevo` with no secret → 401, i.e. fails closed. Frontend: the served shell references `assets/index-hrSkqOpw.js`, byte-identical in name to the bundle built from the pushed commit and different from the pre-deploy `index-CklUIHo9.js`; that bundle contains `my/notifications`, `verify-email`, `communication-preferences` and `trusted-devices`. Not verified: real email delivery, which is BL-1 and cannot be verified without the owner's provider credentials — production still runs the stub and sends nothing.

**Limitations / blockers.** BL-1 unchanged and still the gate on anything actually reaching an inbox. BL-2 unchanged. The OTP frontend is deployed but inert until W-OTP ships `auth_email_challenges`/`trusted_devices` endpoints. `/health` and `/metrics` sit outside the `api` prefix and Caddy proxies only `/api/*`, so neither is reachable from outside the host — worker liveness and the communications metrics cannot be checked remotely, only from `/opt/atlas`.

**Next.** C3 (missing transactional events + digests), C4 backend (OTP challenges, trusted devices, auth audit events), C5 lifecycle sequences T1–T6 / S1–S10, C6 video retention W1–W4, C7 platform communications console.

## MR-3. Milestone record — Brevo live in production, real delivery verified (25 Sep 2026)

**Phase:** C0/B go-live. **Deployed:** backend `3784897` via run `36076556458` (success, no migration).

**What changed.** Production stopped being dormant. Until now every `EMAIL_*` variable was unset, so the provider registry resolved to the stub and Atlas sent nothing — deliberately, because a half-configured provider is worse than none. The owner supplied the Brevo credential, and the configuration now reaches the host through the SAME authorised path the Zoom credentials already used: repository secrets/variables → the `vps-deploy` action → a base64 fragment piped over SSH **stdin** (never a command line, never a log) → `deploy.sh --sync-env`, which upserts `/opt/atlas/.env` atomically and refuses to replace it if the rewritten file is suspiciously small. No credential is in the repository, in this document, or in any build log.

**Configured (names only).** Secrets: `BREVO_API_KEY`, `EMAIL_FROM_EMAIL`, `BREVO_WEBHOOK_SECRET`. Variables: `EMAIL_PROVIDERS=brevo`, `EMAIL_FROM_NAME=Atlas`, `PLATFORM_WEB_URL=https://atlass.dpdns.org`.

**Why the chain is `brevo` alone and not `brevo,resend`.** Naming a provider in the chain without its credentials REFUSES TO BOOT — by design, since a provider that cannot send must fail loudly rather than let the app accept password resets and OTP codes it will never deliver. Resend's credentials cannot exist until its sending domain does (BL-3). Adding `resend` to the chain before then would take production down. There is deliberately **no stub in the production chain**: an unreachable provider now fails observably instead of quietly "sending" into something that delivers nothing.

**Verification — evidence, in order.**
1. *Credential and sender, before touching production.* Brevo `/v3/account` → valid, free plan, 300/day. `/v3/senders` → the Gmail identity `active=true` (single-sender verified). `/v3/senders/domains` → none, which is expected: single-sender is the approved AD-1 path.
2. *The adapter, before deploying.* One real send executed locally through the actual `BrevoEmailProvider.send()` — not a mock — which returned a genuine provider message id (`...@smtp-relay.mailin.fr`). This proved the request shape, auth header and response parsing against the live API while a failure would still have been harmless.
3. *Brevo confirmed the transaction.* Its event log recorded `requests` then `delivered` to the real mailbox.
4. *The boot shape.* Three cases added to `p64-comm-email-env-boot.e2e-spec.ts`, including the shape production actually runs (Brevo alone, no Resend credentials present), an explicit `PLATFORM_WEB_URL` winning over the derived default, and the refusal when neither a web URL nor a base domain can build a link. 9/9 pass.
5. *The env genuinely reached the host.* `POST /api/v1/webhooks/email/brevo` with a wrong secret → **401**; with the correct secret → **202 `{"received":true,"events":1}`**. The 202 is only possible if `BREVO_WEBHOOK_SECRET` synced, the route authenticated, the payload parsed, and the single `communications` worker accepted the job — which also exercises the merged one-processor path in production.
6. *Production itself sent a real email.* A password-reset request against the production API for the owner's own address produced, in Brevo's event log, `requests` at 03:24:49 then `delivered` at 03:24:51 — subject "Reset your Atlas password". That is the full production pipeline: API → registry → Brevo adapter → Brevo → a real inbox.

**Inbound delivery events.** A transactional webhook is registered at Brevo (id 2203146) for the deliverability signals the adapter maps: `delivered`, `hardBounce`, `softBounce`, `spam`, `blocked`, `invalid`, `error`. Open and click tracking were deliberately NOT subscribed — they are engagement telemetry on transactional mail, and Atlas has no product reason to track whether someone opened a password reset.

**Honest limitation.** That inbound events *authenticate and enqueue* is verified (step 5). That they then land as `communication_deliveries` rows and suppression entries is NOT externally verifiable: `/health` and `/metrics` sit outside the `api` prefix and Caddy proxies only `/api/*`, so neither the metrics endpoint nor the database is reachable from outside the host. This is an observability gap in the product, not merely in the test — an operator has the same problem. It is the concrete argument for C7 (platform communications console), which is where it will be closed.

**Quota reality.** Brevo free is 300 emails/day, 9000/month, 5/second. The registry reserves per category against that budget and skips to the next provider when a line is exhausted; with a single-provider chain, exhaustion surfaces as an honest failure with a metric rather than a silent drop. Once Resend is added, exhaustion falls through to it instead.

**Next.** BL-3 (Resend domain) is the only external input still missing, and it blocks only Resend. Wave-2 work (C3 events + digests, C4 OTP backend) and Resend hardening short of the domain are proceeding in parallel.
