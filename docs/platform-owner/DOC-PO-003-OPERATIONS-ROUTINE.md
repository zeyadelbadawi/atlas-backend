# Platform Owner operations routine (DOC-PO-003)

**Records:** B0-SUP-01 (interim routine), B0-OPS-10 (owner routine).
**Status:** interim routine written by Claude under the owner's delegated
ruling (D4 "B"), 14 Oct 2026. It becomes the routine of record once the
owner adopts it; the owner may change the times, the targets and the order.
**Verified against:** `atlas-backend` `cef2920` and `atlas` `6d2940d`
(`main`, 14 Oct 2026). Paths and line numbers in "Where this comes from" are
from those commits.

Run this checklist **twice per business day**: once at the start and once
near the end of the working day, Cairo time. Business days are Sunday to
Thursday, Egyptian public holidays excluded, the same as in
[`PRIVACY_REQUESTS_RUNBOOK.md`](../PRIVACY_REQUESTS_RUNBOOK.md). Also run
steps 1 and 2 before you answer any customer about a payment or a ticket.

Never copy customer data into the log, a ticket, a chat or this repository:
no names, email addresses, phone numbers, bank or wallet details, proof
images or message text. Record ids and counts only.

## Why there is still a manual routine

B0-SUP-01 (merged to `main` on 14 Oct 2026) added in-app and email alerts
for the main Platform Owner queues. The routine still matters, because:

- **Alerts are best effort by design.** They are sent after the customer's
  action has been saved, off the request path, and a failure is logged and
  then dropped. Nothing retries a lost alert. The queue pages are the source
  of truth.
- **Email can be late or missing.** Alert emails go through the same outbox
  and provider allowance as every other email. If the allowance is used up
  or the dispatcher stalls, only the in-app copy arrives.
- **Some queues have no alert at all** (see "What has no alert").
- **Alerts can be switched off.** `FLAG_PLATFORM_OWNER_ALERTS_MODE` turns
  them all off. It is on unless set. The production value has not been
  checked.
- **Delivery has not been checked in a live environment yet.** The staging
  check in B0-SUP-01 (submit a proof and open a ticket, then see the in-app
  and email alert) is still pending.

When the owner has confirmed delivery in production for a few weeks, the
owner may decide to drop the second daily run. Until then, keep both.

## Alerts that exist now

Every alert below goes to every **active** Platform Owner account
(suspended or deleted accounts get nothing), in the notification feed and by
email, and links to the record. Alerts carry no customer personal data:
open the record for that. A repeated alert for the same thing is
suppressed, except where the table says a new one is sent.

| What happened | Alert title (EN) | When a new alert is sent | Opens |
|---|---|---|---|
| An organization uploaded a subscription payment proof (plan or add-on) | "Subscription payment to review" | Per proof: a corrected re-upload alerts again | Payment Review, that payment |
| An organization opened a support case | "New support case" | Once per case | Support, that case |
| The customer replied on a support case | "Customer replied on a support case" | Per reply | Support, that case |
| A new organization was created (self-service signup, or created from the dashboard) | "New organization" | Once per organization | Organizations, that organization |
| A visitor sent the Atlas website contact form | "New contact enquiry" | Once per enquiry | Contact Enquiries |
| A person filed a privacy request (deletion or export) | "New privacy request" (high priority) | Once per request | Privacy requests, that request |
| An academy sent an Atlas service request | "New customer request" (feed only) plus an email to the team inbox set under **Email routing** (every active Platform Owner when none is set) | Once per request | Customer Requests, that request |
| An academy replied on a service request | "Customer replied" (feed of the assignee, or of every Platform Owner while unassigned) plus the routing email | Per reply | Customer Requests, that request |

Monitoring alerts (Prometheus, `ops/alerts/atlas-prometheus-rules.yml`)
that touch these queues:

| Rule | Fires when | Notes |
|---|---|---|
| `AtlasSubscriptionProofWaiting` | The oldest pending subscription proof has waited more than 24 h (for 15 min) | The one alert that does not depend on someone reading the feed |
| `AtlasCheckoutApprovalBacklog` | Over 24 h, more than 20 more course orders reached "pending payment" than were paid | Course orders only. Mixes academy-collected orders (each academy reviews its own) with Atlas-collected ones |
| `AtlasCheckoutApprovalSlow` | p95 time from proof to approval is above 48 h | Course orders only, both review paths |
| `AtlasCheckoutRefundSpike` | More than 5 refunds, and refunds above 25 % of paid orders, over 24 h | Course orders only |
| `AtlasEmailQuotaHigh` / `AtlasEmailQuotaCritical`, `AtlasEmailDispatcherStalled` | Email allowance nearly used up; email queued but not sending | When these fire, alert emails are probably not arriving either |

These rules only reach a person if Prometheus and Alertmanager are wired to
a receiver on the host ([`ops/alerts/README.md`](../../ops/alerts/README.md)).
That wiring has not been checked as part of this routine. Look at
**Observability → Alerts** (step 9) rather than assuming silence means
nothing fired.

## Alerts that are dormant until Atlas Payments launches

Two alerts are built and tested but **cannot fire today**:

| Alert | Title (EN) | Why it is dormant |
|---|---|---|
| `platform.course_payment.submitted` | "Course payment to review" | Sent only for a course payment that Atlas collects. An academy-collected (`academy_manual`) payment goes to that academy's owner, never to us |
| `platform.refund.recorded` | "Refund recorded" | Sent only for a refund on an Atlas-collected (`atlas_payments`) payment |

An organization cannot switch learner payments to Atlas Payments: the only
mode a tenant may choose is `unconfigured` (B0-COM-03). So no new
Atlas-collected course payment or refund should exist. Step 8 checks the
queue anyway. If it is ever not empty, treat that as an incident: tell the
owner and engineering the same day.

When the owner launches Atlas Payments, both alerts start firing with no
code change, and step 8 becomes a real review queue.

## What has no alert

- **Tickets opened automatically by academy provisioning.** When creating
  an academy fails repeatedly, the system opens a high-priority support case
  for the customer ("Academy setup for "…" needs attention"). That path does
  not send the "New support case" alert. The ticket's own text tells the
  customer "Our team has been notified", so step 2 and step 7 must catch it.
- **Failed or stalled provisioning requests** with no ticket yet (step 7).
- **Trials ending, subscriptions lapsing, renewals coming due.** These email
  the customer, not us.
- **Payment methods.** Nothing alerts if a subscription payment method is
  disabled or still a placeholder. That check belongs to the payment-method
  runbook (DOC-PO-004, not yet written), not to this routine.

## The routine

Each step names where the queue is in the Platform Owner console. Most items
are in the **Administration** section of the sidebar.

| # | Queue | Where | What to do | Done when |
|---|---|---|---|---|
| 0 | Notification feed | Bell in the header, or `/dashboard/notifications` | Open each unread alert from the tables above and act on it in the step for its queue | No unread Platform Owner alerts left |
| 1 | Subscription payment proofs | **Administration → Payment Review** (`/dashboard/platform/payments`). The list opens on Review = pending ("Awaiting review"). Sort by "Oldest first" | Review each one (checks below), then **Approve payment** or **Reject payment** with a reason the customer can act on | Nothing left awaiting review, or each remaining item has a noted reason |
| 2 | Support cases | **Administration → Support** (`/dashboard/platform/support`). Filter by status "Open"; then look at recently updated cases | Answer new cases and new customer replies. Move what you are working on to "In progress". Look for high-priority provisioning tickets (no alert, see above) | Every open case has a reply or a note from today |
| 3 | Atlas service requests | **Administration → Customer Requests** (`/dashboard/platform/customer-requests`) | Assign new requests, reply, move the status on | No new request is unassigned |
| 4 | Contact enquiries | **Administration → Contact Enquiries** (`/dashboard/platform/contact-submissions`). Filter Status = "New" | Reply by email from the enquiry, then **Mark as read** | No enquiry left as "New" |
| 5 | Privacy requests | **Administration → Privacy requests** (`/dashboard/platform/privacy-requests`) | Follow [`PRIVACY_REQUESTS_RUNBOOK.md`](../PRIVACY_REQUESTS_RUNBOOK.md) and its handling times | Every new request started, or a reason noted |
| 6 | New signups | The "New organization" alerts; the full list is at `/dashboard/platform/organizations` (no sidebar entry; open it from an alert or by URL). Trial and paid counts are under **Subscriptions & Trials** | Nothing to approve. Count new organizations since the last run; look for obvious spam or duplicate test signups, and make sure each new organization's academy setup did not fail (step 7) | Count logged |
| 7 | Academy provisioning | **Administration → Academy Provisioning** (`/dashboard/platform/provisioning`) | Open failed or stalled requests. Check whether an automatic support case was opened, and answer it in step 2 | No failed request without an owner |
| 8 | Course payments and refunds (Atlas-collected) | **Administration → Commerce → Course payments** (`/dashboard/platform/commerce/course-payments`) | Expect it to be empty (see "dormant" above). If anything is there, do not approve it; tell the owner and engineering the same day | Confirmed empty, or escalated |
| 9 | Monitoring alerts | **Administration → Observability → Alerts** (`/dashboard/platform/observability/alerts`) | Note anything that fired since the last run, including `AtlasSubscriptionProofWaiting`. "Alert history unavailable" means it is not known whether anything fired; it does not mean no alerts | Firing alerts noted and owned |
| 10 | Email health | **Administration → Analytics**, Communications tab (`/dashboard/analytics/communications`): providers and remaining allowance, pipeline | If the allowance is nearly used up or the pipeline is stuck, assume alert emails are not arriving: rely on the feed and this routine, postpone broadcasts, tell the owner | Checked |

### Before approving a subscription payment (step 1)

1. Compare the amount, currency, plan, billing cycle and payer reference with
   the receiving account's statement. Approve only money that has arrived.
2. You cannot review your own organization's payment. Another Platform
   Owner must do it.
3. There is no undo for an approval or a rejection: the console offers only
   approve and reject, once. Check twice.
4. A different plan bought while an annual period still has more than 30
   days left is now refused at checkout (B0-BIL-03). If one still reaches
   the queue (for example a checkout opened before that change shipped),
   reject it and point the customer to support.
5. At renewal, check the organization's student usage against the plan
   being paid for. New paid enrolments are now refused once an organization
   is at its student limit (B0-BIL-05), but orders started before it got
   there are still honoured, so usage can end up above the limit. Do not
   approve a renewal onto a plan whose student limit is below current
   usage: reject it and explain which plan fits.

### Targets (proposal, not published)

These are internal targets for the owner to confirm. They are not promised
anywhere in the product, the emails or the website, and must not be until
the owner decides (B0-CPY-07 rule: publish only what can be kept).

| Queue | Proposed target |
|---|---|
| Subscription payment proof | Reviewed within 1 business day (the `AtlasSubscriptionProofWaiting` rule fires at 24 h) |
| Support case, first response | 1 business day for Academy and Organization plans, 2 business days for Teacher |
| Contact enquiry, service request | First reply within 1 business day |
| Privacy request | As in the privacy runbook |

## What to log

Keep the log outside this repository (it is public). One line per run:

```
<date> <AM|PM> <initials> | proofs: <pending at start>/<approved>/<rejected>, oldest <hours>h | cases: <open>/<answered> | requests: <new>/<answered> | enquiries: <new>/<handled> | privacy: <new> | signups: <count> | provisioning failed: <count> | course payments: <count, expected 0> | alerts fired: <rule names or none> | email: <ok|low allowance|stuck> | escalations: <ids or none>
```

- For a rejection, add the payment id and a one-word reason code (for
  example `amount`, `not-received`, `plan-change`, `usage`). Never the
  customer's name or bank details.
- For an escalation, add the record id and who it went to.
- Once a week, compare the oldest pending proof in Payment Review with the
  log; nothing should be older than the target.

Decisions themselves (approve, reject, status changes, replies) are already
in each console's own history and the audit log. The log records that the
routine ran and what it found.

## If something is wrong

- **A platform page answers 403 (from 24 Oct 2026).** Platform pages need a
  confirmed authenticator app from that date. Follow
  [`TWO_FACTOR_LOCKOUT_RECOVERY.md`](../TWO_FACTOR_LOCKOUT_RECOVERY.md).
- **Alerts stopped arriving.** Check step 10 first (email). If the feed is
  empty too while queues fill up, ask engineering to check
  `FLAG_PLATFORM_OWNER_ALERTS_MODE` and the backend log for "Notifying
  platform owners failed".
- **A queue page shows an error.** Note it in the log, tell engineering, and
  keep going with the other steps.

## Where this comes from

Code (`atlas-backend` unless marked `atlas`):

- Alert service: `src/communications/services/platform-owner-alert.service.ts`
  (after-commit, best effort L1–L27; the flag check L108; active, non-deleted
  Platform Owners only L161–L163; no Platform Owner means no alert L152–L155;
  stops after 3 consecutive failures L85, L229–L235).
- Flag default: `src/config/configuration.ts` L951–L952.
- Catalogue entries (in-app + email, dedupe, link):
  `src/communications/catalog/communication-catalog.ts` L2518
  (contact enquiry), L2542 (subscription proof, per proof), L2560 and L2576
  (support case, per reply), L2594 (new organization), L2612 and L2632
  (course payment and refund, Atlas-collected only), L2650 (privacy request),
  L2670–L2723 (customer requests).
- Triggers: `src/billing/services/payment.service.ts` L267 (`submitProof`),
  L393; `src/platform/services/support-cases.service.ts` L357 (case),
  L498–L516 (customer reply); `src/onboarding/services/signup-organization.service.ts`
  L104; `src/plans/controllers/organizations.controller.ts` L89;
  `src/course-commerce/services/course-order-payments.service.ts` L754–L767
  (not for `academy_manual`); `src/course-commerce/services/course-order-refunds.service.ts`
  L270 (only `atlas_payments`).
- Customer request emails and feed:
  `src/customer-requests/services/customer-request-notifier.service.ts`
  L106–L131.
- Atlas Payments not selectable: `src/billing/services/organization-payment-settings.service.ts`
  L20, L60–L64.
- Provisioning ticket with no alert:
  `src/provisioning/services/provisioning-orchestrator.service.ts` L509–L540.
- Monitoring rules: `ops/alerts/atlas-prometheus-rules.yml` L15–L59, L144–L187.
- Checkout and student-limit rules: `src/billing/services/checkout.service.ts`
  L75–L102; `src/course-commerce/services/course-orders.service.ts` L349–L359.
- Approve and reject only: `src/billing/controllers/platform-payment.controller.ts`
  L58, L67.
- Console locations (`atlas`): `src/app/navigation/navigation.config.ts`
  (Administration section), `src/app/routes/route-paths.ts` L206–L339; the
  Payment Review default filter, `src/features/billing/utils/platform-payment-list.utils.ts`
  L88; the header bell, `src/app/layouts/dashboard/DashboardLayout.tsx` L90.

Tests: unit `src/communications/services/platform-owner-alert.service.spec.ts`;
e2e `test/platform-owner-alerts.e2e-spec.ts`.
