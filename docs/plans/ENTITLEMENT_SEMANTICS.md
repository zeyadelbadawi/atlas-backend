# Entitlement semantics — catalog limits vs granted limits (P61)

**Status: IMPLEMENTED, TESTED AGAINST REAL POSTGRESQL, VERIFIED IN REAL CHROME (EN + AR/RTL).**

This document is the authority on what a customer is entitled to, and when that
changes. It replaces the previous, unwritten rule ("entitlement is whatever the
plan row says right now"), which is what P61 fixed.

---

## 1. Catalog Plan limits

`plans.limits` is a `PlanResourceLimits` JSONB object — the **current advertised
offer**. It is what a prospective customer sees on the Plans page, what a new
purchase is priced and sized against, and the only thing a Platform Owner edits
through `PATCH /platform-plans/:key`.

It is **not**, by itself, any existing customer's entitlement.

## 2. Granted subscription limits

`tenant_subscriptions.granted_limits` is a nullable JSONB column holding the
`PlanResourceLimits` **captured at the moment the entitlement was granted**.

Two different facts now live in two different columns:

| Column | Question it answers |
|---|---|
| `plan_id` | Which plan is this customer on? |
| `granted_limits` | What did that plan give them when they got it? |

Before P61 only the first existed, so a catalog edit rewrote completed purchases
retroactively. The money was already protected — `payments.amount_minor_units`
is frozen on the payment row, and `checkouts.snapshot` freezes the advertised
price — and `granted_limits` is that same protection for the thing the money
bought.

## 3. Existing rows: the nullable fallback

Resolution is one rule, in one function
(`src/plans/utils/granted-limits.util.ts`):

```ts
resolveSubscriptionLimits(subscription) =
  subscription.grantedLimits ?? subscription.plan.limits
```

`NULL` means **"no grant recorded — follow the catalog"**, which is byte-for-byte
how every pre-P61 row already behaved.

**Deliberately not backfilled.** Nothing in this database records what the
catalog held when an older subscription was bought: `plans` stores only current
values, and `checkouts.snapshot` freezes `displayName` and `price`, never limits.
A backfilled number would be a fabricated commercial fact. The migration is
additive and reversible — `DROP COLUMN granted_limits` restores prior behaviour
exactly, because a row with no grant already behaves as if the column were absent.

Every read site goes through the one function, so the write gate, the Usage page,
the recording quota and the add-on check cannot tell a customer different numbers:

| Read site | Purpose |
|---|---|
| `EntitlementEnforcementService.loadActiveEntitlements` | the write gate |
| `TenantSubscriptionService.getUsage` | the customer's Usage page |
| `RecordingQuotaService.resolveLimit` | `recordedSessions` quota |
| `AddOnAccessService` | add-on feature access |

**Features are not snapshotted.** P61 is about purchased CAPACITY. A feature flag
is a capability the platform ships or withdraws, not a quantity someone bought a
specific amount of, and freezing features would strand tenants on removed
implementations. `plan.features` stays live.

## 4. New purchase — the capture

`TenantSubscriptionsRepository.upsertForPlanPurchase` writes `granted_limits`
**in the same statement as `plan_id`**, from the plan row
`PaymentApplicationService.applyCommercialEffect` just resolved. One statement
means the row can never name one plan while holding another's grant — the
atomicity requirement needs no extra machinery.

This is reached only through the real activation path: checkout → payment →
proof → Platform Owner approval. There is no other server-side trigger that
turns a payment into a subscription change.

## 5. Upgrade

An upgrade is a purchase, so it lands on the same path and **re-grants from the
newly purchased plan**. `plan_id` and `granted_limits` move together.

There is no grandfathering across an upgrade: the customer asked for the new
plan and receives exactly it. Existing resources are never deleted or disabled.

*Proof: `P61-GRANT-019`.*

## 6. Downgrade

A downgrade is also a deliberate customer decision, and is treated identically:
the **lower** limits become the new grant.

Grandfathering protects customers from edits they did not ask for — never from
their own choices. What must not happen, and does not, is any existing resource
being removed to fit: the customer keeps every student, course and academy they
had, and Tier 1 (§10) keeps their existing users working.

*Proof: `P61-GRANT-020` — five students preserved across a downgrade to a
two-student plan, a zero-delta enrollment still allowed, a genuinely new one
refused.*

## 7. Trials

A trial is an entitlement grant, so `TenantSubscriptionsRepository.startTrial`
captures `granted_limits` in the same `updateMany` that sets `plan_id` and
`status = 'trialing'`.

Editing the catalog mid-trial therefore does **not** shrink a trial the customer
is actively evaluating — the worst possible moment to move the goalposts.

*Proof: `P61-GRANT-021`.*

## 8. Catalog edits — the behaviour this exists for

> A customer bought a plan allowing 50 students and enrolled 30.
> The Platform Owner later edits that catalog plan to 20.

| | Result |
|---|---|
| `granted_limits` | stays **50** — untouched by the edit |
| `plans.limits` | becomes **20** — for new purchases |
| The existing 30 students | preserved, still enrolled, still able to sign in and learn |
| One of those 30 starting another course | **allowed** (zero-delta, and within 50) |
| Student #31 | **allowed** — 31 ≤ the granted 50 |
| Student #51 | **blocked** — the grant is a real ceiling, not unlimited |
| A NEW customer buying the now-20 plan | granted **20**; their student #21 is blocked |

*Proof: `P61-GRANT-001..008`.*

### Impact preview

`POST /platform-plans/:key/limits/preview` now inspects **only** subscribers with
no recorded grant, because those are the only ones an edit can reach. It returns
`protectedSubscriptions` and `catalogFollowingSubscriptions` alongside `affected`,
and the editor renders *"N subscribers keep the limits they were granted at
purchase and are not affected by this edit."*

Counting protected customers as "affected" would have made the warning claim
something untrue.

## 9. Archive

Unchanged by P61, and verified to stay that way: archiving sets
`status='archived'` and `displayOrder=0`, and **never touches
`tenant_subscriptions`**. Existing subscribers keep their grant and keep working.
Purchase eligibility rules are unchanged — checkout still requires an `active`
plan, so an archived plan cannot be newly bought.

*Proof: `P61-GRANT-016`.*

## 10. Zero-delta enforcement (Tier 1)

`EntitlementEnforcementService.assertWithinLimit` takes an `additionalAmount`.
Callers pass **0** to mean "this write occupies no new unit of the limit" —
`EnrollmentsService` does exactly that when the student is already counted, so a
second or third course costs no extra seat.

That intent used to live only in the arithmetic `used + additional > limit`, and
the arithmetic lost it whenever `used > limit`: `+ 0` stopped mattering and the
already-counted student was refused exactly like a brand-new one.

`used > limit` is not reachable by consuming — consumption is refused at the
boundary. It is reached when the **ceiling moves down**. Refusing zero-cost work
in that state removes something the customer already has.

**The rule now: a call that consumes nothing is never refused for capacity.**
The active-subscription check still runs — an expired or cancelled tenant may not
write however little it consumes — and real consumption is enforced unchanged.

| used | additionalAmount | result |
|---|---|---|
| `== limit` | 0 | allowed |
| `> limit` | 0 | allowed |
| `== limit` | > 0 | blocked |
| `> limit` | > 0 | blocked |
| `< limit` | > 0 | allowed |

*Proof: `entitlement-enforcement.service.spec.ts` (9 unit tests) and
`P61-GRANT-009`/`010` against real PostgreSQL.*

## 11. Concurrency

`assertWithinLimit` and `assertStorageWithinLimit` take
`SELECT 1 FROM tenant_subscriptions WHERE organization_id = $1 FOR UPDATE`
before counting, inside the caller's own transaction.

Counting and inserting in one transaction stops the count going stale between
the two statements, but does **not** stop two concurrent transactions from both
counting "2 of 2 used", both concluding there is room, and both inserting —
READ COMMITTED gives each its own snapshot. A real-database test caught exactly
that: four simultaneous enrollments against a 2-seat allowance produced 3.

This is not a new mechanism. It is the identical serialization point
`RecordingQuotaService.consumeForSession` already takes, on the same row, for the
same check-then-insert shape. Every caller locks the same single row per
organization, so there is no lock-ordering deadlock to reason about.

*Proof: `P61-GRANT-018`.*

## 12. Per-limit-key coverage

The grant is the whole `PlanResourceLimits` object, so every key is covered —
not a students-only special case (`P61-GRANT-012` asserts all eight are present).

| Key | Usage source | Enforced at |
|---|---|---|
| `academies` | live count | academy create (incl. provisioning) |
| `students` | distinct enrollments, status ≠ `unavailable` | enrollment |
| `instructors` | distinct `academy_members` role=instructor | add instructor |
| `staff` | live count | **nowhere — measured but never enforced** |
| `courses` | live count | course create (`P61-GRANT-013`) |
| `generalStorage` | `media_assets` byte sum | 3 upload paths |
| `videoStorage` | `media_assets` byte sum | same 3 paths |
| `recordedSessions` | `live_session_recordings.quota_consumed_at` | `RecordingQuotaService` |

`recordedSessions` keeps its dedicated serialized quota mechanism untouched;
only the ceiling it compares against now resolves through the grant.

---

## Known limitations

- **`staff` is measured and displayed but never enforced** at any write path.
  Pre-existing; unchanged by P61; recorded here so it is not mistaken for a
  P61 regression.
- **Academy provisioning can exceed the `academies` limit under concurrency.**
  Two simultaneous provisioning requests for one organization can each count
  zero and both create, producing 2 academies on a 1-academy plan. Reproduced on
  the **unmodified** pre-P61 codebase, so it is pre-existing and outside P61's
  scope; `entitlement-enforcement.e2e-spec.ts`'s provisioning case is currently
  red because of it. `ProvisioningOrchestratorService.tryAdoptExistingAcademy`
  also treats *any* `ConflictException` as a slug conflict, which means a
  genuine `ENTITLEMENT_LIMIT_REACHED` can be swallowed there. Both deserve their
  own fix.
- **Academy-side student account creation is not entitlement-gated** — only
  enrollment is. Creating student #31 succeeds; enrolling them is what the limit
  decides. Pre-existing.
