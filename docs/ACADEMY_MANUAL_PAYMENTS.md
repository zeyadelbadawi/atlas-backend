# Academy Manual Payments

Academies accept course payments with their **own** manual methods (bank
transfer, InstaPay, mobile wallet). The learner pays the academy directly,
uploads a proof, and the **Client Owner** (organization owner) approves or
rejects it. An approval grants access through the existing enrollment
path; a rejection tells the learner why, and they can pay again.

## Scope decision: per academy, not per organization

The master plan (§4.1) keeps the *payment collection mode* (who collects:
Atlas Payments vs the organization's own gateway) at organization level, and
recorded "academy-level payment autonomy" as not needed. That decision was
about **who collects the money**. This feature is about **where the money
goes and what the learner is shown**, and that is per academy:

- an academy is its own storefront: its own subdomain, brand, language,
  **currency** (`academies.currency`) and learners (`academy_students`);
- course orders and payments already record the academy being paid
  (`course_orders.academy_id`, `payments.payee_academy_id`), proofs are
  stored under `academies/{id}/…`, and enrollments are per academy;
- the business case is per academy: Academy A takes Bank + InstaPay,
  Academy B a wallet only, Academy C InstaPay + wallet; one organization can
  own all three;
- tenant isolation is unchanged: each method row also carries
  `organization_id`, so RLS isolates at the organization boundary exactly as
  `course_orders` does.

Only one model is implemented. The organization-level mode is untouched.

## How the two settings combine

| Academy has ≥ 1 enabled method? | Result |
|---|---|
| yes | Learners of that academy pay the academy with its methods; the Client Owner reviews. No Atlas commission, no revenue-ledger entry (`payment_collection_mode_snapshot = 'academy_manual'`). Applies whatever the organization's mode is, including `unconfigured`. |
| no | Exactly the previous behaviour: the organization's mode decides (Atlas Payments → platform methods, Platform Owner review; `unconfigured` → no checkout). |

## Data model (additive)

- `academy_payment_methods` — `academy_id`, `organization_id`, `type`
  (`manual_bank_transfer` / `manual_instapay` / `manual_wallet_transfer`;
  `gateway` refused by CHECK), `enabled`, `instructions` (JSON, the shared
  `ManualPaymentInstructions` shape, normalised server-side by
  `billing/utils/manual-payment-instructions.util.ts`, the same rules as the
  platform catalog), `display_order`, `updated_by_user_id`. Unique per
  `(academy_id, type)`. Never deleted — disabled.
- `payments.academy_payment_method_id` (nullable, SET NULL) and
  `provider = 'academy_manual'`; the learner-facing instructions are frozen in
  `payments.instructions_snapshot`.
- `payment_proofs.payer_reference` (nullable) — the transfer reference.
- `provisioning_requests.requested_payment_methods` (nullable JSON) — the
  methods chosen in the academy setup form.
- `payment_collection_mode` enum value `academy_manual` — snapshot only,
  never an organization setting (the settings DTO lists the three settable
  modes).

Migrations: `20261105000000_mp_payment_collection_mode_academy_manual`,
`20261105000100_mp_academy_payment_methods` (each with a Recovery section).

## Lifecycle (server-side only)

| State | `payments.status` | `payments.review_status` | Order | Access |
|---|---|---|---|---|
| Awaiting proof | `pending` | `not_required` | `pending_payment` | no |
| Pending review | `pending` | `pending` | `pending_payment` | no |
| Approved | `succeeded` | `approved` | `paid` | yes (enrollment `accessSource: 'order'`) |
| Rejected | `failed` | `rejected` (+ `review_notes` = reason) | `pending_payment`, reopened | no |
| Superseded / expired | `cancelled` / order `expired` | `not_required` | — | no |

Transitions are made by the server only: create payment → submit proof →
approve or reject. `claimPendingReview` is one conditional UPDATE
(`… WHERE review_status = 'pending'`), so two decisions on one payment
(double click, two owners, approve racing reject) produce exactly one
winner; the loser gets 409 `errors.payment.notPendingReview`.

Order windows: choosing an academy method extends the order to
`ACADEMY_MANUAL_PAYMENT_WINDOW_HOURS` (72h) — a transfer happens outside
Atlas; a rejection reopens it for another 72h. An order with a proof under
review is never expired (expiry is evaluated after the review check, under
the order lock).

One open payment per order: the order row is locked (`FOR UPDATE`); a payment
under review blocks another (409 `errors.courseOrder.paymentUnderReview`);
choosing the same method again returns the same payment; switching methods
cancels the proof-less one.

## API

Client Owner (`JwtAuthGuard`, `ManagementSurfaceGuard`, `AcademyScopeGuard`,
then `assertCanViewAcademyFinance` — organization owner only):

- `GET academies/:id/payment-methods`
- `PUT academies/:id/payment-methods/{bank-transfer|instapay|wallet}` —
  `{ enabled?, instructions? }`
- `GET academies/:id/course-payments` — `reviewStatus`, `methodType`,
  `from`, `to`, `search`, `sortBy` (`createdAt`/`amount`); returns `counts`
- `GET academies/:id/course-payments/:paymentId`
- `GET academies/:id/course-payments/:paymentId/proof/file` (streamed,
  `Cache-Control: private, no-store`)
- `POST academies/:id/course-payments/:paymentId/approve` — `{ notes? }`
- `POST academies/:id/course-payments/:paymentId/reject` — `{ reason? }`

Learner (self-scoped by session):

- `GET course-orders/:id/payment-methods` — the academy's enabled methods
  (`key = academy_<type>`), or the previous behaviour.
- `POST course-orders/:id/payments` — `{ methodKey }`; amount and currency
  from the order snapshot.
- `PATCH course-orders/:id/payments/:pid/proof` — `{ fileName, fileData,
  note?, payerReference? }`; PNG/JPEG/PDF by magic bytes, 10 MB.
- `GET course-payments?academyId=` — "My payments".
- `GET course-orders[/:id]` carry `paidToAcademy`; `POST course-orders/:id/refund`
  answers 409 `errors.courseOrder.refundContactAcademy` for such an order.

Provisioning: `POST organizations/:id/provisioning-requests` accepts
`paymentMethods: { bankTransfer?, instapay?, wallet? }` (typed, validated at
create); the worker's `academy` step saves them enabled (insert-if-absent,
audited, never fails the step).

## Security

- RLS: `academy_payment_methods_tenant_*` (organization rows; insert/update
  require the academy to belong to the organization),
  `academy_payment_methods_buyer_select` (enabled rows, any signed-in user —
  the details the academy publishes at checkout). Review policies admit only
  `academy_manual` payments of the current organization, through SECURITY
  DEFINER helpers (`is_academy_manual_payment_of_organization`,
  `is_academy_manual_course_order`) that avoid policy recursion:
  `payments_tenant_academy_manual_update`,
  `course_orders_tenant_academy_manual_update`,
  `payment_proofs_tenant_academy_manual_select`,
  `payment_reviews_tenant_academy_manual_select|insert`
  (`reviewed_by = app.current_user_id`). Atlas-collected rows remain
  unchangeable from a tenant context.
- Every query also filters by academy and provider (RLS is never the only
  check). The Platform Owner's review queue excludes `academy_manual`
  payments and refuses to review them.
- The client never sends an amount, an academy, a learner, a status or a
  provider; `forbidNonWhitelisted` refuses extra keys.
- Proofs live in the private bucket and are only streamed after the same
  checks as the detail.

## Communications

| Key | To | In-app | Email | Dedupe |
|---|---|---|---|---|
| `academy.payment.submitted` | Client Owner(s) | always | always | per proof |
| `course.payment.approved` | learner | always | always | per payment |
| `course.payment.rejected` | learner (with the reason) | always | always | per payment |

All are written in the same transaction as the state change (outbox), handed
to the queue after commit, retried by the dispatcher (6 attempts), and
recorded in `communication_deliveries`. The learner's existing
`course.order.proof_submitted` receipt is unchanged.

## Audit

`academy.payment_method.saved`, `academy.course_payment.proof_submitted`,
`academy.course_payment.approved`, `academy.course_payment.rejected` —
academy scope, visible to the tenant, never carrying account details.

## Tests

- `test/academy-manual-payments.e2e-spec.ts` — configuration, isolation,
  checkout, approve/reject, emails (rendered and sent), race, RLS, Platform
  queue exclusion, refund.
- `test/academy-manual-payments-provisioning.e2e-spec.ts` — setup form.
- Frontend Vitest suites and Playwright `e2e/j42-academy-manual-payments.spec.ts`
  (approve, reject + pay again, cross-tenant, axe/RTL/phone).

## Known limitations

- Refunds of direct-to-academy payments are handled between the learner and
  the academy outside Atlas (no self-service refund, no academy-side refund
  action yet).
- One method per type per academy (e.g. one bank account).
- Amounts in emails use two decimals, like every existing course email.
- A failed proof upload can leave an object in the private bucket without a
  row (pre-existing behaviour of the shared proof upload).
