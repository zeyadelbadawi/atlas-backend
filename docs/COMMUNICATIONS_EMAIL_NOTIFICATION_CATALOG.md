# Atlas Communications — Email & Notification Catalogue

**The definitive reference for testing every message Atlas sends.**

Generated from `src/communications/catalog/communication-catalog.ts` on
25 September 2026, backend `main`. If this document and the code disagree,
the code is right and this document is stale — regenerate it rather than
patching it by hand.

## The exact count

**Atlas has 74 communication events.**

Not 69. The 69-row matrix in the Communications & Lifecycle master plan was
correct when it was written; the catalogue has legitimately grown by five
since:

| Added | Key | Why |
|---|---|---|
| C8 | `academy.member.invited` | A Manager or Instructor created by staff was never told their account existed. |
| C8 | `academy.learner.invited` | The same for a Student — separate because a learner signs in on the **academy** host, not the management one. |
| W-EXC | `assessment.exception.granted` | A learner given extra time or attempts was never told. |
| W-EXC | `assessment.exception.activated` | A *scheduled* exception opening is a second, later fact. |
| W-EXC | `assessment.exception.revoked` | An accommodation withdrawn is news the learner must not discover mid-attempt. |

Of those 74:

| Split | Count |
|---|---|
| Sends an email (ever) | 61 |
| Appears in the in-app feed (ever) | 64 |
| Both channels | 51 |
| Email only — never in the feed | 10 |
| In-app only — never emailed | 13 |
| Audience: learner / staff / platform | 36 / 32 / 6 |
| Branding: academy host / platform host | 36 / 38 |

## How to read a row

**In-app** and **Email** are the channel rules, and they are not the same vocabulary:

| Value | Meaning |
|---|---|
| `always` | Sent regardless of preferences. Reserved for things the recipient cannot opt out of without being harmed — password resets, purchase receipts, an account someone else created for them. |
| `pref` | Sent unless the recipient has turned that **category** off in their notification settings. The default for a new account is on. |
| `digest` | Not sent immediately; rolled into a periodic summary. |
| `—` (`never`) | This channel is deliberately silent for this event. It is a decision, not a gap; see *Deliberate silences* below. |

**Link goes to** is the path the CTA button resolves to, rendered here with
placeholder ids (`COURSE`, `TOKEN`, …). The host it is built on comes from
the entry's `branding`, and that distinction is the single most common
source of dead links in this system:

- `branding: 'academy'` → built on the **academy's own host**. `/dashboard/*`
  and `/auth/*` are **not mounted there** — the public-website router owns
  that tree and an unmatched path falls into the CMS catch-all, i.e. the
  academy's own 404. Academy hosts mount recovery pages at the **root**
  (`/reset-password`, `/verify-email`).
- `branding: 'platform'` → built on the management host, where `/dashboard/*`
  and `/auth/*` do exist.

`action-url-routes.spec.ts` enforces this both ways: every CTA must resolve
on the host its branding selects, and a learner-audience key may not point
into the management dashboard.

**Emitted by** is the service that calls `CommunicationService.emit`. That is
where to look to find out how to trigger the event by hand.

## The matrix

### Learner — 36 events

| # | Key | In-app | Email | Email subject (EN) | Link goes to | Emitted by |
|---|---|---|---|---|---|---|
| 1 | `course.order.paid` | always | always | Purchase confirmed | `/my/purchases` | `course-commerce/services/platform-course-order-payments.service` |
| 2 | `course.order.payment_failed` | always | always | Payment failed | `/my/purchases` | `course-commerce/services/platform-course-order-payments.service` |
| 3 | `course.order.refunded` | always | always | Refund processed | `/my/purchases` | `course-commerce/services/course-order-refunds.service` |
| 4 | `academy.member.invited` | — | always | You've been added to Northwind Academy on Atlas | `/auth/reset-password?token=TOKEN&setup=1` | `identity/services/account-setup.service` |
| 5 | `academy.learner.invited` | — | always | You've been added to Northwind Academy on Atlas | `/reset-password?token=TOKEN&setup=1` | `identity/services/account-setup.service` |
| 6 | `live_session.scheduled` | always | — | — | `/my/courses/COURSE` | `live-sessions/services/live-session-notifications.service` |
| 7 | `live_session.rescheduled` | always | — | — | `/my/courses/COURSE` | `live-sessions/services/live-session-notifications.service` |
| 8 | `live_session.cancelled` | always | — | — | `/my/courses/COURSE` | `live-sessions/controllers/live-sessions.controller<br>live-sessions/services/live-session-notifications.service` |
| 9 | `live_session.starting_soon` | always | — | — | `/my/courses/COURSE` | `live-sessions/services/live-session-notifications.service` |
| 10 | `assessment.assignment.graded` | always | pref | Your assignment has been graded | `/my/courses/COURSE/activities/ASSIGNMENT` | `instructor/services/instructor.service` |
| 11 | `assessment.quiz.graded` | always | pref | Your quiz has been graded | `/my/courses/COURSE/activities/QUIZ` | `instructor/services/quiz-review.service` |
| 12 | `certificate.issued` | always | always | Your certificate is ready | `/my/certificates` | `certificates/services/certificates.service` |
| 13 | `certificate.revoked` | always | always | A certificate was revoked | `/my/certificates` | `certificates/services/certificates.service` |
| 14 | `enrollment.granted` | always | always | You have been enrolled in Algebra I | `/my/courses/COURSE` | `learning/services/academy-students.service` |
| 15 | `enrollment.revoked` | always | always | Your access to Algebra I has ended | `/my/courses` | `learning/services/academy-students.service<br>media/video/video-gate-revocation.service` |
| 16 | `enrollment.expiry_changed` | always | always | Your access to Algebra I no longer expires | `/my/courses/COURSE` | `learning/services/academy-students.service` |
| 17 | `roster.student.approved` | always | always | Your registration at Northwind Academy has been approved | `/my/courses` | `learning/services/academy-students.service` |
| 18 | `roster.student.rejected` | always | always | Your registration at Northwind Academy was not approved | `none` | `learning/services/academy-students.service` |
| 19 | `roster.student.blocked` | always | always | Your access to Northwind Academy has been suspended | `none` | `learning/services/academy-students.service` |
| 20 | `roster.student.unblocked` | always | always | Your access to Northwind Academy has been restored | `/my/courses` | `learning/services/academy-students.service` |
| 21 | `course.order.proof_submitted` | always | always | We received your payment proof | `/my/purchases` | `course-commerce/services/course-order-payments.service` |
| 22 | `review.moderated` | always | — | — | `/my/courses/COURSE` | `learning/services/course-reviews.service` |
| 23 | `enrollment.self_enrolled` | always | always | You are enrolled in Algebra I | `/my/courses/COURSE` | `learning/services/enrollments.service` |
| 24 | `course.order.created` | always | — | — | `/my/purchases` | `course-commerce/services/course-orders.service` |
| 25 | `course.order.expired` | always | — | — | `/courses/COURSE` | `course-commerce/services/course-order-payments.service` |
| 26 | `assessment.quiz.auto_submitted` | always | pref | Unit 2 Quiz was submitted automatically | `/my/courses/COURSE/activities/QUIZ` | `learning/services/quiz-attempt-engine.service` |
| 27 | `assessment.attempt.invalidated` | always | pref | Your attempt at Unit 2 Quiz no longer counts | `/my/courses/COURSE/activities/QUIZ` | `instructor/services/quiz-review.service` |
| 28 | `assessment.exception.granted` | always | pref | You have an exception for "Unit 2 Quiz" | `/my/courses/COURSE/activities/QUIZ` | `instructor/services/quiz-review.service` |
| 29 | `assessment.exception.activated` | always | pref | Your exception for "Unit 2 Quiz" is now active | `/my/courses/COURSE/activities/QUIZ` | `communications/services/quiz-exception-activation.service` |
| 30 | `assessment.exception.revoked` | always | pref | Your exception for "Unit 2 Quiz" has been removed | `/my/courses/COURSE/activities/QUIZ` | `instructor/services/quiz-review.service` |
| 31 | `course.completed` | always | pref | You finished Algebra I | `/my/courses/COURSE` | `learning/services/course-completion.service` |
| 32 | `device.registered` | always | — | — | `/my/devices` | `identity/services/auth.service<br>learning/services/lesson-content.service` |
| 33 | `device.removed` | always | always | Device removed: a device | `/my/devices` | `learning/services/learner-session.service<br>media/video/video-gate-revocation.service` |
| 34 | `device.limit_reached` | always | — | — | `/my/devices` | `learning/services/lesson-content.service` |
| 35 | `session.taken_over` | always | — | — | `/my/devices` | `learning/services/learner-session.service<br>media/video/video-gate-revocation.service` |
| 36 | `announcement.published` | always | — | — | `/my/courses/COURSE` | `community/services/announcements.service` |

### Staff — 32 events

| # | Key | In-app | Email | Email subject (EN) | Link goes to | Emitted by |
|---|---|---|---|---|---|---|
| 1 | `provisioning.completed` | always | always | Your academy is ready | `/dashboard` | `provisioning/services/provisioning-orchestrator.service` |
| 2 | `provisioning.failed` | always | always | We could not finish setting up your academy | `/dashboard` | `provisioning/services/provisioning-orchestrator.service` |
| 3 | `platform.payment.approved` | always | always | Payment approved | `/dashboard/tenant/billing` | `billing/services/platform-payment.service` |
| 4 | `platform.payment.rejected` | always | always | Payment rejected | `/dashboard/tenant/billing` | `billing/services/platform-payment.service` |
| 5 | `support.case.reply` | always | pref | New reply on "" | `/dashboard/support/ENTITY` | `platform/services/support-cases.service` |
| 6 | `support.case.status_changed` | always | — | — | `/dashboard/support/ENTITY` | `platform/services/support-cases.service` |
| 7 | `live_session.recording_available` | always | pref | Your session recording is ready | `/dashboard/add-ons/live-sessions/recordings` | `live-sessions/services/live-session-notifications.service` |
| 8 | `live_provider.deauthorized` | always | — | — | `/dashboard/add-ons/live-sessions/connection` | `platform/services/platform-zoom.service<br>live-sessions/services/live-provider-deauthorization.service` |
| 9 | `roster.student.awaiting_approval` | always | digest | Someone is waiting to join Northwind Academy | `/dashboard/academy/ACADEMY/members` | `identity/services/auth.service` |
| 10 | `review.submitted` | always | digest | A review is waiting for moderation at Northwind Academy | `/dashboard/academy/ACADEMY/courses/COURSE/reviews` | `learning/services/course-reviews.service` |
| 11 | `lifecycle.trial.started` | always | always | Your Growth trial has started | `/dashboard/tenant/subscription` | `plans/services/trial-redemption.service` |
| 12 | `lifecycle.trial.ending_soon` | always | always | Your trial ends tomorrow | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 13 | `lifecycle.trial.expired` | always | always | Your trial has ended and your site is offline | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 14 | `lifecycle.trial.followup_3d` | — | pref | Your Atlas work is still here | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 15 | `lifecycle.trial.followup_14d` | — | pref | Your courses are still waiting | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 16 | `lifecycle.trial.reactivation_45d` | — | pref | Last note about your Atlas academy | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 17 | `lifecycle.subscription.activated` | always | always | Your Growth subscription is active | `/dashboard/tenant/subscription` | `billing/services/platform-payment.service` |
| 18 | `lifecycle.subscription.payment_submitted` | always | always | We received your payment proof | `/dashboard/tenant/billing` | `billing/services/payment.service` |
| 19 | `lifecycle.subscription.renewal_due` | always | always | Your subscription renews in 7 days | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 20 | `lifecycle.subscription.renewal_tomorrow` | always | always | Your subscription period ends tomorrow | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 21 | `lifecycle.subscription.grace_started` | always | always | Your site stays online for 7 more days | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 22 | `lifecycle.subscription.grace_ending` | always | always | Your grace period ends tomorrow | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 23 | `lifecycle.subscription.expired` | always | always | Your subscription has expired and your site is offline | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 24 | `lifecycle.subscription.cancel_scheduled` | always | always | Your subscription is set to end | `/dashboard/tenant/subscription` | `plans/services/trial-redemption.service` |
| 25 | `lifecycle.subscription.cancelled` | always | always | Your subscription has ended | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 26 | `lifecycle.subscription.followup_7d` | — | pref | Your academy is still stored | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 27 | `lifecycle.subscription.followup_30d` | — | pref | Last note about your Atlas subscription | `/dashboard/tenant/subscription` | `plans/services/tenant-lifecycle.service` |
| 28 | `retention.video.warning_30d` | always | always | Your hosted videos will be deleted on  | `/dashboard/tenant/retention` | `retention/services/video-retention.service` |
| 29 | `retention.video.warning_14d` | always | always | 14 days left: your hosted videos are deleted on  | `/dashboard/tenant/retention` | `retention/services/video-retention.service` |
| 30 | `retention.video.warning_7d` | always | always | Final warning: your hosted videos are deleted on  | `/dashboard/tenant/retention` | `retention/services/video-retention.service` |
| 31 | `retention.video.warning_24h` | always | always | Last call: your hosted videos are deleted tomorrow | `/dashboard/tenant/retention` | `retention/services/video-retention.service` |
| 32 | `retention.video.deleted` | always | always | Your hosted videos have been deleted | `/dashboard/tenant/retention` | `retention/services/video-retention-deletion.service` |

### Platform — 6 events

| # | Key | In-app | Email | Email subject (EN) | Link goes to | Emitted by |
|---|---|---|---|---|---|---|
| 1 | `auth.password.changed` | always | always | Your password was changed | `/auth/forgot-password` | `identity/services/users.service` |
| 2 | `auth.email.verification` | — | always (sent at registration only when the surface's OTP policy is `off`; otherwise the first OTP sign-in verifies) | Verify your email address | `/auth/verify-email?token=TOKEN` | `identity/services/auth.service` |
| 3 | `auth.email.otp` | — | always | 048915 is your sign-in code | `none` | `identity/services/email-otp.service` |
| 4 | `auth.password.reset` | — | always | Reset your password | `/auth/reset-password?token=TOKEN` | `identity/queue/password-reset-email.processor` |
| 5 | `auth.password.reset_confirmed` | always | always | Your password was reset | `/auth/forgot-password` | `identity/services/auth.service` |
| 6 | `retention.video.deletion_failed` | always | always | Video retention: deletion failed for asset  | `/dashboard/analytics/delivery` | `retention/services/video-retention-deletion.service` |

## Dead links: none remaining

`action-url-routes.spec.ts` resolves all 74 CTAs against the frontend's real
route registry, on the host each entry's `branding` selects. Its
`KNOWN_BROKEN` exemption ledger is now **empty** — it was carrying seven keys.

Every one had the same cause: a **staff** destination under `/dashboard/*`
carried on an `academy`-branded key. `/dashboard/*` is not mounted on an
academy host at all, so those buttons rendered the academy's own CMS 404.
The repair is to brand the key `platform`, because branding picks the **host**,
not merely the logo:

| Key | Was | Now |
|---|---|---|
| `auth.password.reset` | dead | `/auth/reset-password` on the platform host |
| `auth.email.verification` | dead | `/auth/verify-email` on the platform host |
| `roster.student.awaiting_approval` | dead | `/dashboard/academy/:academyId/...`, platform |
| `review.submitted` | dead | `/dashboard/academy/:academyId/...`, platform |
| `provisioning.completed` | dead | `/dashboard`, platform |
| `live_session.recording_available` | dead | `/dashboard/add-ons/...`, platform |
| `live_provider.deauthorized` | dead | `/dashboard/add-ons/...`, platform |

The visible trade for the last three: those emails now render with Atlas
branding rather than the academy's. A working button beats a logo, and all
three are staff-operational mail rather than anything a learner sees.

The exemptions were **deleted** rather than left as stale entries — the spec
fails if a key is listed there and is not in fact broken, so the ledger cannot
rot into a list of things everyone has stopped looking at.

## Email vs in-app — the quick reference

### Emailed but never in the feed (10)

These are all things you act on **outside** the app, or that must reach you
when you cannot get into it at all. An in-app notification about a password
you cannot use to sign in would be a joke.

`auth.email.verification` · `auth.password.reset` · `auth.email.otp` ·
`academy.member.invited` · `academy.learner.invited` ·
`lifecycle.trial.followup_3d` · `lifecycle.trial.followup_14d` ·
`lifecycle.trial.reactivation_45d` · `lifecycle.subscription.followup_7d` ·
`lifecycle.subscription.followup_30d`

(The five lifecycle follow-ups are win-back mail to someone who has already
stopped signing in — a feed entry nobody will open is not a channel.)

### In the feed but never emailed (13)

Operational noise, or things that are only meaningful while you are already
looking at the product.

`course.order.created` · `course.order.expired` · `support.case.status_changed` ·
`live_session.scheduled` · `live_session.rescheduled` · `live_session.cancelled` ·
`live_session.starting_soon` · `live_provider.deauthorized` · `review.moderated` ·
`device.registered` · `device.limit_reached` · `session.taken_over` ·
`announcement.published`

### Digested rather than sent immediately (2)

`roster.student.awaiting_approval` · `review.submitted` — both are staff
queues. A busy academy would generate one email per applicant; the digest is
the point.

## Deliberate silences

Every one of these is a decision with a reason, recorded so nobody "fixes"
it later by adding a message:

| Not sent | Why |
|---|---|
| A learner exception **expiring** (`availableUntil` passing) | Nothing actionable: the window has shut and the learner either used it or did not. The closing date is already printed in all three exception messages. It would be the one message in the family that fires for every learner every term with nothing to do about it — and people who learn to ignore one message ignore its siblings too. |
| A **reviewer's private reason** for an exception | Free text that may record a disability or an illness. It is never placed in `values`, so it cannot reach a template. Asserted by an e2e case. |
| A **score** inside the graded-work email | The email says grading is complete and links to the activity. A percentage in a mailbox is the one part of a grade that leaks usefully to anyone else reading over a shoulder — and it goes stale the moment a re-grade happens. The in-app message does show it. |
| A **generated password**, ever | Staff-created accounts get a one-time setup link instead. See below. |
| A "graded" message for an **auto-scored** quiz submitted by the learner | They are sitting in front of the result. The message exists for grading that happens *later*, by a human. |

## Credentials: what a recipient is ever shown

The rule the whole credential family is built on: **an internal token is not
a user-facing token.** A token may travel inside a link. It may never be the
thing a reader is shown and expected to understand.

| Event | The model | What the reader sees |
|---|---|---|
| `auth.password.reset` | Magic link | A "Reset password" button. The token is inside the href and nowhere else. |
| `auth.email.verification` | Magic link | A "Verify email" button, same rule. |
| `academy.member.invited` / `academy.learner.invited` | Magic link (72h) | A **"Set your password"** button. No password, no token, no bare value. The page it lands on says *Set* your password rather than *Reset* it, because the reader never had one. |
| `auth.email.otp` | Code | Six digits, readable, with the expiry. **No action link at all** — a sign-in code email that invites a click is exactly what a phishing lookalike imitates, and the reader already has the page open. |

`credential-email-contract.spec.ts` asserts all of this structurally
("a six-digit run", "the token appears only inside an href") rather than
against today's wording, so a rewrite survives and a regression does not.

## Staff-created accounts

A Client Owner adding a **Manager**, **Instructor** or **Student** supplies a
password in the create call. Before C8 the new person was told nothing: no
email, no link, no way to learn the account existed. Either the owner relayed
a password out of band, or the account sat unusable.

Now the create call is followed by a setup invitation:

1. A one-time token is minted (72 hours — long enough for a weekend, short
   enough that a forwarded link does not stay live for a month).
2. The email carries a **"Set your password"** CTA and nothing else.
3. The link lands on the real password page with `setup=1`, which changes the
   heading and description to *Set your password*.
4. The person chooses their own password and can then sign in — a learner on
   their **academy** host, staff on the **management** host. This is why the
   two invitations are separate keys: a learner who set a password on the
   management surface would be refused with a 403 when they tried to use it.

An **existing** Atlas user added to a second academy gets no invitation —
they already have a password.

A **Client Owner** never needs this: there is no code path where somebody
else creates a Client Owner account. They self-register and choose their own
password at that moment. Verified by enumerating every user-creation site
(`auth.service.ts` self-registration, and the three academy paths above).

## Graded work

`assessment.quiz.graded` and `assessment.assignment.graded` go to the learner
who did the work, on both channels, at the moment a human finishes grading.

**`exam` is a MODE of a quiz, not a separate entity** (`QuizMode`), so one key
correctly covers both and there is no second key to forget. The learner-facing
product uses one noun — *quiz* — everywhere, so the message does too;
introducing "Exam" only in the notification would make it the single place a
learner meets a word the rest of the product never shows them.

The isolation is structural rather than careful: **neither grading request
carries a learner id at all.** The recipient is read back from the row being
graded (`attempt.studentId`, `submission.studentId`), so there is no field a
caller could tamper with to redirect the message.
`p64-c9-graded-work-isolation.e2e-spec.ts` pins the empty set for a classmate
in the same course, a learner in another academy, and the reviewer who did the
grading — across the outbox, the in-app feed, and the mail that actually
leaves the building.

## Learner exceptions

A `QuizStudentOverride` is an accommodation granted to **one** student on
**one** quiz: more time, more attempts, or a private window. Until W-EXC it
emitted nothing, so the person it existed for was never told — an
accommodation nobody knows about is an accommodation nobody uses.

`assessment.exception.granted` is **one key with two in-app copies**, not two
keys. To the learner this is one event — "you have an exception" — whose only
difference is whether it is usable yet. Two keys would hand them two
preference switches and two dedupe surfaces for one fact. The `scheduled`
flag is decided **once**, by the producer that holds the grant instant, and
both the feed and the email read that same flag; a rule that read the clock
at render time would answer differently on every replay.

`assessment.exception.activated` is emitted by a **sweep** (the
`exception-activation` job on the existing `communications` queue, every five
minutes), not a delayed job: a reviewer can move or delete an exception at any
time, and a job that is lost to a Redis flush is a message nobody notices is
missing. It cannot re-notify because its dedupe key is the *transition
instant*, never the instant of the tick.

## Production state — 25 September 2026

| Setting | Value | Note |
|---|---|---|
| `EMAIL_PROVIDERS` | `brevo` | Brevo is the live sender. |
| Brevo credentials | `BREVO_API_KEY`, `BREVO_WEBHOOK_SECRET`, `EMAIL_FROM_EMAIL` | Present as GitHub secrets; values never appear in logs, docs or source. |
| Resend fallback | **not configured** | Blocked on BL-3 (see below). |
| Stub in production | guarded | A production chain made only of stubs logs an error at boot and shows a warning on the platform communications console. It is deliberately **not** fatal: refusing to boot would take the platform down over an email misconfiguration. With `EMAIL_PROVIDERS=brevo` the chain is not stub. |
| `FLAG_LIFECYCLE_SEQUENCES_MODE` | `dry_run` | The service logs and `continue`s before any emit. Nothing is sent. |
| `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `_ACADEMY` | **`new_device`** | **ON** since 25 Sep 2026, both surfaces, by owner approval. An emailed code is asked for on a device the account has not been seen on before; a trusted device is not re-challenged. |
| `FLAG_VIDEO_RETENTION_MODE` | **`warn_only`** | **ON** since 25 Sep 2026, by owner approval. Warnings W1–W4 are real and go out; **no deletion job is ever enqueued** in this mode. |
| `FLAG_CERTIFICATES_MODE` | `allowlist` (one academy) | Unchanged. |
| `FLAG_QUIZ_ENGINE_V2_MODE`, `FLAG_QUIZ_INTEGRITY_MODE` | `on` | Unchanged. |

All four Communications flags were **absent from both deploy jobs** until
25 September and were therefore unreachable no matter what they were set to.
They are now plumbed through `.github/workflows/deploy.yml`.

### Flag history

Both flags below were off until 25 September 2026 and were enabled that day on
the owner's explicit approval, after being made reachable at all (all four
communications flags were absent from both deploy jobs until earlier the same
day).

- **Email OTP → `new_device`, both surfaces.** The prior reason for holding it
  was that there is no allowlist mode, so it is all-or-nothing per surface, and
  a failure locks owners out of sign-in. `new_device` is the narrowest of the
  two live settings: it challenges only a device the account has not been seen
  on, rather than every sign-in. The approved rollout order in the plan was
  management first, then academies; the owner directed both together.
- **Video retention → `warn_only`.** This is the mode the plan designates for
  the first full cycle (plan §"Rollout", and C6's row in the milestone table):
  warnings are real, and the destructive branch is unreachable. Two independent
  guards keep it that way — `warn_only` refuses to enqueue a deletion job at
  all, and the deletion step additionally requires all four warnings to already
  exist, so a platform that has only ever run `warn_only` **cannot delete
  anything on the day it switches to `on`**; the earliest possible deletion is
  thirty days after the first W1 actually goes out.

  Do not move this to `on` without a decision: `on` permanently deletes hosted
  video bytes. The retention windows themselves are still recorded as *owner to
  confirm*, and BL-2 (real video infrastructure) means deletion has never been
  exercised against a real provider.

## Known blockers

- **BL-3 — RESEND DOMAIN REQUIRED: `send.<your-domain>`.** A DNS-verified
  sending subdomain is needed before Resend can act as the fallback. Note
  that `EMAIL_FROM_EMAIL` is shared by both adapters, so a new address must
  be re-verified at Brevo in the same change window.
- **BL-2** — real video infrastructure.
- **BL-4** — historical course-order expiry residue: a backfill must **not**
  emit "order expired" for old rows.

## How to verify by hand

`docs/COMMUNICATIONS_FEATURE_VERIFICATION_GUIDE.md` walks every event with
the exact steps, the expected subject, and what a failure looks like.
