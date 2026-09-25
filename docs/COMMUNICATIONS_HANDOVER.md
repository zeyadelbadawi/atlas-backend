# Atlas Communications — Handover

**Status: closed.** 25 September 2026. Backend `main`, frontend `main`, both
deployed. This document is what the next person needs to operate, extend and
debug the communications system without reading the whole initiative.

Companion documents:

- `docs/COMMUNICATIONS_EMAIL_NOTIFICATION_CATALOG.md` — every one of the 74
  events, what it sends, where its link goes, and what triggers it.
- `docs/COMMUNICATIONS_FEATURE_VERIFICATION_GUIDE.md` — how to test each one
  by hand.
- `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md` — the design
  record and why each decision was made.

---

## 1. The shape of the system

**One canonical send path. There are no others, and adding one is the single
most damaging thing you could do here.**

```
  business service
      │  (inside its own transaction)
      ├─► CommunicationService.emit(tx, { key, recipientUserId, … })
      │       ├─ writes communication_outbox
      │       └─ writes the in-app notification (if inApp !== 'never')
      │
      │  (after the transaction commits)
      └─► CommunicationService.enqueueAfterCommit(outboxId)
              └─► communications queue ─► CommunicationsProcessor
                      └─► CommunicationDispatchService
                              ├─ resolves locale + branding + host
                              ├─ renders the template
                              └─ EmailProviderRegistry → Brevo
```

Five rules that hold everywhere, and that the tests enforce:

1. **`emit` runs inside the caller's transaction.** If the business change
   rolls back, the message goes with it. A notification about something that
   did not happen is worse than a missing one.
2. **`enqueueAfterCommit` runs after.** Enqueuing inside the transaction races
   the worker, which can read the row before it exists.
3. **The catalogue decides everything about a message except its facts.**
   Channels, priority, branding, dedupe, retention, the CTA — all of it lives
   in `communication-catalog.ts`, never at the call site.
4. **ONE queue, ONE `@Processor`.** BullMQ hands a job to whichever worker
   grabs it first, *not* the one that knows the job name. A second processor
   on the `communications` queue silently eats half the outbox.
   `one-worker-per-queue.spec.ts` fails the build if one appears.
5. **The recipient is always server-derived.** Read back from the row the
   event is about — `attempt.studentId`, `submission.studentId`,
   `override.studentId` — never from a request body.

## 2. Branding picks the HOST

This is the single most common source of bugs in this subsystem and it is
worth internalising before touching anything:

| `branding` | Host the link is built on | What exists there |
|---|---|---|
| `'academy'` | the academy's own host | The public-website router owns the **whole** tree. `/dashboard/*` and `/auth/*` do **not** exist; an unmatched path falls into the CMS catch-all, i.e. the academy's own 404. Recovery pages are mounted at the **root**: `/reset-password`, `/verify-email`. |
| `'platform'` | the management host | `/dashboard/*` and `/auth/*` exist. |

So a **staff** destination is almost always `branding: 'platform'`, even when
the event is about one academy. Seven keys got this wrong and produced dead
buttons in real mail; all seven are fixed and the exemption ledger in
`action-url-routes.spec.ts` is now empty.

**Before adding a key, run `action-url-routes.spec.ts`.** It resolves your CTA
against the frontend's real route registry on the host your branding selects,
and it also refuses a learner-audience key that points into `/dashboard`.

## 3. Credentials

**An internal token is not a user-facing token.** A token may travel inside a
link; it may never be the thing a reader is shown and expected to understand.

Production once emailed `Reset token: 9f2c1e…` as body text. Every backend
test passed throughout, because they all asserted a token was *issued* and
none asserted what the message *said*. The broken part was the only part
nobody tested: the words.

`credential-email-contract.spec.ts` now asserts the rendered message —
structurally ("a six-digit run", "the token appears only inside an href")
rather than against today's copy, so a rewrite survives and a regression does
not.

**Never email a generated password.** Staff-created accounts get a one-time
72-hour setup link and the person chooses their own. `AccountSetupService`
reuses `password_reset_tokens` deliberately: "a one-time link that lets you
set a password" is exactly what that table already is — hashed at rest,
single-use, expiring, consumed by an endpoint that is already hardened.
Minting a second credential type would be a second authentication system to
keep correct.

## 4. Operating it

### Providers

| Variable | Value | Notes |
|---|---|---|
| `EMAIL_PROVIDERS` | `brevo` | Comma-separated fallback chain. |
| `BREVO_API_KEY`, `BREVO_WEBHOOK_SECRET`, `EMAIL_FROM_EMAIL` | GitHub secrets | Never printed, logged, or committed. |

Resend is **not** configured — see BL-3.

**Production never silently falls back to the stub.** If a production chain
resolves to stub only, `EmailProviderRegistry` logs an error at boot and the
platform communications console renders the same state as a warning. It is
deliberately *not* fatal: refusing to boot would take the whole platform down
over an email misconfiguration, and a learner who cannot reach their course is
a worse outcome than one who cannot reset a password.

### Flags

All four communications flags were **absent from both deploy jobs** until
25 September — set to anything, they could not reach the host. They are now
plumbed through `.github/workflows/deploy.yml`.

| Flag | State | Why |
|---|---|---|
| `FLAG_LIFECYCLE_SEQUENCES_MODE` | `dry_run` | The service logs and `continue`s before any emit. Safe to observe; emits nothing. |
| `FLAG_AUTH_EMAIL_OTP_MODE_MANAGEMENT` / `_ACADEMY` | off | **Do not flip this unattended.** There is no allowlist mode, so it is all-or-nothing for a whole surface; the code-entry step cannot be verified without a human reading a real inbox; and a failure locks *every* owner out of sign-in. |
| `FLAG_VIDEO_RETENTION_MODE` | off | The retention windows are recorded as *owner to confirm*. Deleting learners' video on an unconfirmed schedule is not a default to choose for someone. |

### Where to look when mail does not arrive

Go to the platform communications console first, then §I of the verification
guide. In order: is there an outbox row at all? What state is it in? Is the
address suppressed? Is the recipient's category preference off (that settles
as `dispatched` with `last_error = 'preference_off'` and the in-app
notification still appears — that is `in_app_only`, not a bug)? Is the daily
cap reached? Is the key behind a flag that is off?

## 5. Adding an event

1. Add the entry to `COMMUNICATION_CATALOG`. Pick `branding` by **where the
   recipient acts**, not by whose data it is.
2. Add the EN + AR template under `templates/keys/` and register it.
3. Add EN + AR `notifications.json` copy in the frontend if `inApp !== 'never'`.
   `frontend-translation-coverage.spec.ts` fails if you forget either locale.
4. Emit it from the business service, **inside the transaction**, with
   `enqueueAfterCommit` after.
5. Run `action-url-routes.spec.ts` and the catalogue specs.
6. Write the test that would have caught the bug you are most afraid of — then
   **break the fix and watch the test fail.** A guard nobody has seen fail is
   a guard nobody knows works. Every guard added in this initiative was proven
   this way, and the commit messages record which mutation was used.

## 6. What is deliberately absent

These are decisions, not gaps. Each is recorded next to the code so nobody
"fixes" it by adding a message:

- **No exception-expiry notice.** The window shutting carries nothing
  actionable; the closing date is already in all three exception messages; and
  it would be the one message in the family that fires for every learner every
  term with nothing to do about it.
- **No score in the graded-work email.** It links to the activity instead. The
  in-app message does show the score.
- **No reviewer `reason` reaches the learner.** It may record a disability or
  an illness. It never enters `values`, so it cannot reach a template.
- **No "graded" message for an auto-scored quiz the learner just submitted.**
  They are looking at the result. The message exists for grading a human does
  later.
- **No `assessment.exam.graded` key.** `exam` is a *mode* of a quiz, not a
  separate entity; one key covers both.

## 7. Open blockers

- **BL-3 — RESEND DOMAIN REQUIRED: `send.<your-domain>`.** A DNS-verified
  sending subdomain, needed before Resend can act as the fallback. `EMAIL_FROM_EMAIL`
  is shared by both adapters, so a new address must be re-verified at Brevo in
  the same change window.
- **BL-2** — real video infrastructure (outside communications).
- **BL-4** — historical course-order expiry residue: any backfill must **not**
  emit "order expired" for old rows.

## 8. Test inventory

| Suite | What it protects |
|---|---|
| `action-url-routes.spec.ts` | Every CTA resolves on its branding's host; no learner key points into `/dashboard`. Exemption ledger empty. |
| `credential-email-contract.spec.ts` | No credential is ever shown as a bare value. |
| `email-content-contract.spec.ts` | Rendered content of every template, both locales. |
| `frontend-translation-coverage.spec.ts` | Every in-app key and variant has EN + AR copy. |
| `communication-catalog.spec.ts` | Dedupe rules, channel shapes, which keys may never dedupe. |
| `one-worker-per-queue.spec.ts` | Exactly one processor per queue. |
| `p64-c8-member-onboarding.e2e-spec.ts` | Staff-created accounts get a working setup link; existing users do not. |
| `p64-c9-graded-work-isolation.e2e-spec.ts` | Graded work reaches only the learner who did it. |
| `p64-comm-learner-exceptions.e2e-spec.ts` | Exception grant/schedule/activate/revoke, privacy of the reason, isolation. |
| `p64-comm-events*`, `p64-comm-outbox` | Outbox states, dedupe, digest, delivery. |

**Local e2e caution.** A dev backend on this machine shares Postgres and
Redis, so large e2e batches produce contention failures that look like
regressions. Always re-run a failing suite **alone** with
`--runInBand --forceExit` before believing it.
