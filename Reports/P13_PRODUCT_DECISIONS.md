# Atlas P13 — Product Decisions Gate

## Status (updated 2026-08-27)

**P13 implementation is COMPLETE for the scope resolved below.** The
Platform Owner/product owner resolved all five decisions on 2026-08-27
(session instructions, reproduced faithfully in the "2026-08-27
Resolution" subsection under each decision below) and explicitly
authorized implementation to proceed. This file is kept as the historical
record of the original five open questions and their resolutions — see
`Reports/PROGRESS.md`'s P13 entry and `Reports/ARCHITECTURE.md` for what
was actually built against these resolutions.

P13 is architecturally unblocked, and implementation is no longer
pending any of the five decisions below — each has a real, final
resolution.

## Current Architecture Baseline

The following is already finalized and implemented (see `ATLAS_BACKEND_MASTER_PLAN.md` §4.1, §4.2, §5.7, §5.8, ADR-010, ADR-011, and the 2026-08-26 Atlas Subscription Payment addendum to §21 Phase P12):

- Each Organization chooses its own payment collection mode. Two modes exist:
  - `atlas_payments`
  - `organization_gateway`
- `unconfigured` is a real, explicit third state — never a silent default to either real mode. Paid-course checkout (P13) must refuse to proceed and surface a configuration-required state for an `unconfigured` Organization.
- Atlas commission applies only to Payments processed under `atlas_payments` mode. `organization_gateway` mode never carries an Atlas commission — Atlas is not a party to that money path.
- The effective commission rate is resolved exactly once, at the moment a course-order Payment is created, and frozen (snapshotted) onto that Payment. A later change to the global default or an Organization's override never retroactively changes a past Payment's commission.
- All commission and money arithmetic is integer, minor-unit-based — never floating point.
- Rounding is deterministic round-half-up.
- The proportional commission reversal on refund is append-only, ledger-based (a new `revenue_ledger_entries` row of type `commission_reversal`) — the original `sale`/`platform_fee` entries and the Payment's frozen commission snapshot are never mutated.
- Gateway processing fees are currently modeled as separate from, and independent of, Atlas commission. The Organization bears gateway processing fees in the initial model; this is not added to the student-facing price.
- No real external payment gateway has been implemented. `PaymentProviderAdapter` / `PaymentProviderRegistry` exist and are real; `ManualTransferProvider` is the only registered adapter, for both Atlas's own subscription billing (P12) and the (not-yet-built) course-payment flow.
- Atlas's own subscription-payment provider selection (Platform Owner-configurable, `atlas_subscription_payment_provider_config`) is implemented and separate from the Organization-owned course-payment configuration (`organization_gateway_credentials`, `organization_connected_accounts`, etc., §5.8) — the two are never the same table or the same secrets.

## Decision 1 — Full Refund Policy

**Status: OPEN**

What the Master Plan currently says (§23, "Explicit behavior per state"):

> **Refund (full):** New `RevenueLedgerEntry` (type `refund`, negative amount) inserted — the original `sale` entry is never mutated or deleted. `Payment.status` moves to a refunded state (extend `PaymentLifecycleStatus` additively, or track via `CourseOrder.status='refunded'` — recommend the latter to avoid touching the Atlas-billing `PaymentLifecycleStatus` enum's meaning). `Enrollment.status` — see "Enrollment reversal" below.

> **Enrollment reversal after refund:** `SPECIFICATION-UNDEFINED` — the frontend has no concept of "revoke access." Recommended default: a full refund moves `Enrollment.status` to `'unavailable'` rather than deleting the row (preserves history/progress in case of a later dispute reversal); this needs explicit product approval before Phase 13 implements it, since it's a genuine UX/business decision (does a refunded student lose in-progress work visibility?).

- **What is already defined:** the ledger mechanics of a full refund (append-only reversal entry, original `sale` entry never touched) and the recommended `CourseOrder.status='refunded'` tracking approach.
- **What requires product confirmation:** whether a full refund revokes the student's course access (`Enrollment.status` → `'unavailable'`, the recommended default) or leaves access intact; whether the recommended default itself is accepted.
- **What P13 implementation must wait for:** explicit product sign-off on the enrollment-reversal behavior before any full-refund code path is built.

### 2026-08-27 Resolution — RESOLVED

Full refund, **customer-friendly**: a student may request a full refund
within **30 days** of the course purchase (`REFUND_WINDOW_DAYS`,
`src/course-commerce/dto/course-commerce.constants.ts`). Enrollment
reversal IS the confirmed behavior — a successful full refund moves
`Enrollment.status` to `'unavailable'` (never deletes the row, preserving
progress history). Refund is buyer-initiated and self-service (`POST
course-orders/:id/refund`) — no Platform Owner manual-review gate, matching
the "customer-friendly" instruction. Implemented as an explicit
`CourseOrderRefund` row (its own table, its own lifecycle status/type
columns) — never inferred from `CourseOrder.status` alone. Idempotent by
a real database unique constraint (`course_order_refunds.course_order_id
@unique`) — a second refund attempt is structurally impossible, not just
application-checked.

## Decision 2 — Partial Refund Policy

**Status: OPEN**

What the Master Plan currently says (§23, "Explicit behavior per state"):

> **Refund (partial):** `SPECIFICATION-UNDEFINED` — no partial-refund concept exists anywhere in the current frontend `Payment`/`Money` contracts. If approved: a `RevenueLedgerEntry` for the partial amount, `Enrollment` access is **not** revoked for a partial refund (a partial refund is a goodwill/price-adjustment action, not a purchase reversal) — recommended default, needs product sign-off.

- **What is already defined:** nothing is confirmed. A partial-refund concept does not exist anywhere in the frontend contracts today. A recommended default (partial refund does not revoke enrollment) exists but is explicitly marked as a proposal, not a decision.
- **What requires product confirmation:** whether partial refunds are supported at all for course purchases; if so, whether the recommended non-revocation default is accepted.
- **What P13 implementation must wait for:** a real product decision on whether partial refunds exist as a feature, before any schema or ledger entry type for them is built.

### 2026-08-27 Resolution — RESOLVED (deferred, not built)

Partial refunds remain **out of production scope for P13**, confirmed
explicitly. The financial model was built so a future partial-refund
capability is additive, never a redesign: `CourseOrderRefund.refundType`
is a real enum column (currently only `full` is a valid/produced value —
adding `partial` later is an additive enum value, not a schema rewrite);
`CourseOrderRefund.amountMinorUnits` is already a real, independent
money field (not derived/hardcoded from the order total at the type
level, even though today's service always sets it to the full amount);
`revenue_ledger_entries` is already a signed, per-event ledger, so a
future proportional partial reversal is just another row of the existing
`refund`/`commission_reversal` types with a smaller amount — no ledger
redesign. No partial-refund UI, endpoint, or validation branch was built.

## Decision 3 — Atlas Commission Percentage

**Status: OPEN**

- A global/default Atlas commission percentage exists conceptually as a configuration value (`atlas_commission_config.default_commission_basis_points`, Platform-Owner-writable).
- Each Organization's effective commission resolves via: Organization override (`custom` percentage or `exempt`) → else the global default → else unresolved. An Organization can inherit the global default, use a custom percentage, or be exempt (0%, an explicit state distinct from "default happens to be 0").
- The actual global percentage value is deliberately left unset by design (`default_commission_basis_points` is nullable, starts `null`). This document does not invent or assume a number — no percentage (e.g. not 10%) has been chosen anywhere in the codebase or the Master Plan.
- Atlas Payments mode cannot resolve an effective commission — and is therefore not usable for a paid-course transaction — for any Organization until a Platform Owner explicitly sets the global default (or that specific Organization has its own override).
- **What P13 implementation must wait for:** the actual global default commission percentage must be finalized by the product owner before P13 course-order payment logic that depends on a resolved commission can be implemented end-to-end.

Do not choose a percentage. None is recorded here or anywhere else in the repository.

### 2026-08-27 Resolution — RESOLVED (architecture, not a percentage)

The commission model is extended from two tiers to **three**: `Organization
override → Plan-tier commission (new, `plan_commission_settings`) →
Platform default`, resolved by `resolveEffectiveCommission` (`src/billing/
utils/commission-resolution.util.ts`) and exposed for write via
`PlatformCommissionController`'s new `GET/PATCH /platform-commission/plans/:planKey`
endpoints (Platform-Owner-only, mirroring the existing Organization/global
endpoints' exact shape). The plan-tier level lets different subscription
Plans carry different commission rates — e.g. a higher-tier Plan could
carry a lower commission — without inventing a fourth mechanism. Still
true exactly as before: **no percentage is chosen anywhere in code, a
seed script, or this document** — `atlas_commission_config.default_commission_basis_points`
and every `plan_commission_settings` row start and stay absent/null until
a real Platform Owner sets one through the API. Atlas Payments remains
genuinely unusable for an Organization (a real `409
errors.courseOrder.commissionNotConfigured`) until an effective rate
resolves through this three-tier chain — never a silent 0%.

## Decision 4 — Gateway Selection + Gateway Fee Mechanics

**Status: OPEN**

- `PaymentProviderAdapter` and `PaymentProviderRegistry` already exist and are real, implemented architecture (ADR-010, and its 2026-08-26 Atlas Subscription Payment update).
- No external gateway has been implemented. The registry contains exactly one real adapter, `ManualTransferProvider`. No Paymob, Stripe, Tap, Telr, HyperPay, or other gateway code exists anywhere in either repository.
- The architecture intentionally avoids provider-specific branching in core business logic — `PaymentService`/checkout logic depends only on the `PaymentProviderAdapter` interface and `PaymentProviderRegistry`, never on a hardcoded provider name.
- Future providers can be added as adapters: implement `PaymentProviderAdapter` once, register it, and it becomes selectable/configurable through the Platform Owner dashboard — no change to core checkout/payment business logic required (proven for the Atlas-subscription context; the same seam is intended for the future Course Commerce context).
- Gateway processing fees are currently treated as separate from, and independent of, Atlas commission (§4.2). The initial policy is that the Organization bears gateway processing fees, but this is explicitly flagged in the Master Plan (§24) as needing re-confirmation once a specific real gateway's actual fee mechanics are known (e.g. a fee deducted before Atlas ever receives funds vs. invoiced separately).
- **What P13 implementation must wait for:** (a) which real gateway(s), if any, Atlas will actually integrate for Course Commerce, and (b) final confirmation of gateway processing-fee treatment once that gateway's real fee mechanics are known.

Do not choose Paymob, Stripe, Tap, Telr, HyperPay, or any other provider. None is chosen here or anywhere else in the repository.

### 2026-08-27 Resolution — RESOLVED (Atlas Payments mode reuses ManualTransferProvider; Organization-Owned Gateway stays honestly unusable)

For P13's real, shipped scope, Atlas Payments mode is implemented through
the SAME `ManualTransferProvider`/`payment_methods` catalog P12's
Atlas-subscription billing already uses — no second provider, no new
adapter. A student purchasing a paid course under Atlas Payments mode
submits a manual-transfer proof; a Platform Owner reviews/approves it
through a real, tested `/platform-course-order-payments` surface,
exactly mirroring P12's own manual-review flow. Organization-Owned
Gateway mode is real and correctly ROUTED (an Organization's chosen mode
determines its money flow), but since no real external gateway adapter
is registered in `PaymentProviderRegistry` (unchanged from before this
session — still zero real gateways implemented), attempting to create a
course-order Payment under that mode returns a real, honest `409
errors.courseOrder.gatewayNotConfigured` rather than silently falling
back to Atlas Payments or fabricating success. Still true exactly as
before: **no external gateway (Paymob, Stripe, Tap, Telr, HyperPay, or
otherwise) is implemented anywhere.** Gateway fee mechanics remain
unaddressed for the same reason — there is still no real gateway to have
fee mechanics for.

## Decision 5 — Tax / VAT

**Status: OPEN**

- No tax/VAT model currently exists anywhere in the frontend specification — confirmed by the Master Plan (§24): "No mention anywhere in any type file across the entire frontend."
- The Master Plan explicitly instructs: do not implement tax calculation/collection until specified.
- **What P13 implementation must wait for:** an explicit product decision on whether/how tax or VAT applies to course purchases, before any tax-related field, calculation, or collection behavior is implemented.

## P13 Implementation Gate

P13 implementation may begin ONLY after all five decisions above have explicit statuses of RESOLVED.

Once resolved, the next implementation session must reread:
- `ATLAS_BACKEND_MASTER_PLAN.md`
- `Reports/P13_PRODUCT_DECISIONS.md`

and then implement P13 according to the resolved decisions — not according to any assumption made before those decisions existed.

## Explicitly Forbidden Before P13

- Course checkout
- Course orders
- Payment-from-enrollment
- Payouts
- Marketplace settlement
- Refund implementation
- Tax/VAT implementation
- External gateway implementation
