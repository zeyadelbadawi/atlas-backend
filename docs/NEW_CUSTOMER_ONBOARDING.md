# New Customer Onboarding — Implementation Contract

This is the owner-approved plan (26 Sep 2026), restated as a contract that
both the backend and the frontend implement against. The design reasoning is
in the approved proposal; the Master Plan links here.

No secret value appears in this document.

## 1. Journey

```
Start for Free / pricing card (?plan=<key>)
 → ONE-PAGE signup: name, email, password, confirm, terms, organization name, trial plan
 → ONE action "Create account" → POST /auth/register
   (one DB transaction: user + verification token + organization + owner membership
    + subscription row + trial when the mailbox is eligible;
    organizations.onboarding_completed_at = NULL)
 → Sign in (email pre-filled, "Account created" notice) → OTP (unchanged)
 → /dashboard → owner of a pending organization → /onboarding
 → Plan (only if subscription not trialing/active) → Academy → Branding → Website → First course → Summary
 → Finish (only when required complete) | Finish for now (always) → /dashboard
```

## 2. Feature flag

`FLAG_SIGNUP_ORGANIZATION_MODE` = `off` (default) | `on`. It is a backend
environment flag, synced from the repository variable by the Deploy workflow.

- **`off`:** `POST /auth/register` refuses `organizationName` and `planId`
  (400 `errors.auth.organizationSignupDisabled`), and
  `GET /public/signup-options` reports `organizationSignup: false`. The
  frontend then renders today's signup exactly.
- **Rollback** is setting the flag `off` and redeploying the backend only.

## 3. APIs

### 3.1 `GET /public/signup-options` (no auth)

```ts
interface SignupOptionsResponse {
  organizationSignup: boolean;   // flag on
  trialsEnabled: boolean;        // TrialPolicy.enabled
  trialPlans: PlanResponse[];    // active + customer-facing (displayOrder>0) + trialEligible; [] when !trialsEnabled; existing PlanResponse shape, ordered by displayOrder
}
```

### 3.2 `POST /auth/register` (extended; still 201, empty body, no session)

Adds two optional fields:

- `organizationName?: string`: trimmed, 2–120 characters.
- `planId?: string`: a UUID.

Rules, checked **before any write**:

| Condition | Response |
|---|---|
| Either field present while the flag is `off` | 400 `errors.auth.organizationSignupDisabled` |
| Either field present together with `academyId`, or the request is on an academy host | 400 `errors.auth.signupFieldsNotAllowed` |
| `planId` without `organizationName` | 400 `errors.auth.organizationNameRequired` |
| `planId` present while trials are disabled | 400 `errors.auth.signupTrialsUnavailable` |
| `planId` unknown, not active, not customer-facing, or not trialEligible | 400 `errors.auth.signupPlanUnavailable` |
| Duplicate email (the existing check **and** the P2002 race) | 409 `errors.auth.emailAlreadyRegistered` |

With `organizationName`, one transaction:

1. Creates the user and the verification token.
2. Creates the organization (slug retried with savepoints) with
   `onboarding_completed_at = NULL`.
3. Creates the owner membership (primary) and the audit entry
   `organization.created`.
4. Creates the subscription row (`no_plan`).
5. If `planId` was sent, runs the trial **claim-then-start**:
   1. `claimTrial`, the once-per-mailbox claim (`ON CONFLICT DO NOTHING`);
   2. if granted, `startTrial`, the conditional per-organization update;
   3. on start, the audit entry `subscription.trial.redeemed` and the
      `lifecycle.trial.started` outbox entry.

   If the mailbox already had a trial, no trial is created, the subscription
   stays `no_plan`, and the response is the same 201 (no disclosure).

After commit: the outbox entries are queued, then the verification email is
sent (best effort, as today).

Metric: `atlas_signup_total{mode="organization"|"account",outcome=...}`.

### 3.3 Session user: `organizations[].onboardingPending` (COMPUTED, never stored)

`OrganizationMembershipResponse` gains `onboardingPending: boolean`:

```
onboardingPending = role === 'owner' AND organization.onboarding_completed_at IS NULL
```

It is present on the sign-in and OTP responses, on session refresh, and on
`GET /users/me`. There is no column on `organization_memberships`.

### 3.4 `GET /organizations/:id/onboarding`

Guards: JWT + management surface + organization membership + **owner** (the
`tenant.billing.view` permission, which only owners hold). A non-owner or
another organization's ID gets 403.

```ts
type OnboardingStepKey = 'plan' | 'academy' | 'branding' | 'website' | 'course';
type OnboardingStepStatus = 'complete' | 'in_progress' | 'incomplete' | 'blocked' | 'awaiting_confirmation';
interface OnboardingStatusResponse {
  organizationId: string;
  completedAt: string | null;          // organizations.onboarding_completed_at
  pending: boolean;                    // completedAt === null
  requiredComplete: boolean;           // academy AND website complete
  readyLabelAllowed: boolean;          // === requiredComplete ("ready" wording only when true)
  subscription: {
    status: TenantSubscriptionStatus;  // no_plan | trialing | trial_expired | active | ...
    planKey: string | null;            // null while no_plan
    trialEndsAt: string | null;
    trialAvailable: boolean;           // policy enabled AND this org never trialed AND this mailbox never redeemed
  };
  latestSubscriptionPayment: {         // latest payment of a plan_subscription checkout, or null
    id: string; status: PaymentLifecycleStatus; reviewStatus: string;
    failureReason: string | null;   // a message key, e.g. errors.payment.rejectedByReviewer
    reviewNotes: string | null;     // the Platform Owner's review note, shown verbatim when present
    planKey: string;
  } | null;
  academy: { id: string; name: string; slug: string; host: string | null; logoUrl: string | null } | null;
  provisioning: { requestId: string; status: string; currentStepKey: string | null; failed: boolean } | null;
  steps: { key: OnboardingStepKey; requirement: 'prerequisite' | 'required' | 'recommended'; status: OnboardingStepStatus }[];
  nextStep: OnboardingStepKey | 'summary';
}
```

**Step derivation:**

| Step | complete | in_progress / awaiting | incomplete | blocked |
|---|---|---|---|---|
| plan (prerequisite) | status ∈ {trialing, active} | `awaiting_confirmation`: latest subscription payment is non-terminal (created, pending, processing, requires_action, requires_confirmation) | otherwise | never |
| academy (required) | earliest non-archived academy exists and its provisioning request (if any) is `ready` | `in_progress`: provisioning non-terminal | no academy, or provisioning `failed` (`provisioning.failed=true`) | plan not complete |
| branding (recommended) | academy.logoUrl non-null | none | no logo | no academy |
| website (required) | website_configurations.status = 'published' | none | not published | no academy |
| course (recommended) | the academy has ≥1 non-archived course | none | none | no academy |

`nextStep`: the first non-complete step in the order plan, academy, website,
branding, course, where required steps come before recommended ones.
Otherwise `summary`.

### 3.5 `POST /organizations/:id/onboarding/complete`

Body: `{ mode: 'finish' | 'defer' }`. Guards: the same as §3.4.

| Mode | Behaviour |
|---|---|
| `finish` | Requires `requiredComplete`, else 409 `errors.onboarding.requiredIncomplete` |
| `defer` | Always allowed (this is "Finish for now") |

- Sets `onboarding_completed_at = now()` if it is null; idempotent.
- Writes the audit entry `organization.onboarding.completed` with
  `{ mode, requiredComplete }`.
- Increments `atlas_onboarding_completed_total{result="finished"|"deferred"}`.
- Returns `OnboardingStatusResponse`.

## 4. UX semantics

| Action | Where | Effect |
|---|---|---|
| Skip | Branding and Course only | Next step, nothing stored |
| Finish | Summary, enabled only when `requiredComplete` | `complete {mode:'finish'}`; heading "Your academy is ready" |
| Finish for now | Every step, always | `complete {mode:'defer'}`; the dashboard shows "Setup incomplete — N required steps left" while any required item is open |
| Resume | `/onboarding` or the dashboard card | Opens `nextStep` |

- The **"ready" wording is allowed only when `readyLabelAllowed`.**
- **Dashboard card (owners):** shown while any required or recommended step
  is incomplete, regardless of `completedAt`. When `requiredComplete`, the
  owner may hide it for recommended-only items (a per-device, cosmetic
  preference).
- **Plan step, trial already used:** the existing paid path:
  1. `CheckoutPage` (`/dashboard/tenant/billing/checkout/plan/:planKey`);
  2. `POST /organizations/:id/checkouts`;
  3. `POST /organizations/:id/payments`;
  4. `PATCH /organizations/:id/payments/:paymentId/proof`;
  5. Platform Owner `POST /payments/:id/approve` activates the plan.

  While the payment is non-terminal the step shows "awaiting confirmation";
  a rejected or failed payment shows the reason and a resubmit action.

## 5. Persistence

The **only** new persisted field is `organizations.onboarding_completed_at`
(`TIMESTAMPTZ`, default `now()`), so every existing organization and every
legacy creation path counts as already onboarded. The signup path inserts
`NULL` explicitly.

**Writing it.** `organizations` has **no UPDATE policy** for `atlas_app`,
and this feature adds none: an owner UPDATE policy would expose every
column.

- The one permitted write goes through the `SECURITY DEFINER` function
  `complete_organization_onboarding(organization_id)`, added in the same
  migration.
- It re-checks the caller's session (organization context equals the target,
  and the user holds an `owner` membership).
- It can only move `NULL` to `now()`, and returns 0 or 1.
- `EXECUTE` is granted to `atlas_app` only.
- Proven in `test/new-customer-onboarding.e2e-spec.ts` (RLS case).

The legacy `localStorage` wizard (`useOnboardingProgress`) is deleted, and
`/dashboard/academy/:id/onboarding` redirects.

## 6. Rollout and rollback

| Step | State (26 Sep 2026) |
|---|---|
| Backend code (`6f5de80`, `7c38a6a`, `9826b57`) on `main` | Deployed |
| Migration `20261017000000_onboarding_completed_at` | Applied in production through the gated `apply_migrations` run, owner-approved (Deploy run 36239402027; pre-migration backup taken) |
| Frontend (`0cb5d6d` merged as `0c0b553`, fixes `8a8dd56`) on `main` | Deployed (Deploy run 36242299025) |
| `FLAG_SIGNUP_ORGANIZATION_MODE` | **`on`** since 26 Sep 2026 ~13:45 UTC — repository variable created by the owner; backend redeployed without migrations (Deploy run 36245801235); the running container reports `on` (Onboarding verify run 36246237835) |
| Enable | Done: repository variable `FLAG_SIGNUP_ORGANIZATION_MODE=on` + a Deploy dispatch with `apply_migrations=false`. The deploy fallback stays `off`: a missing variable means off |
| Rollback | Set the variable to `off` (or delete it) and redeploy the backend. The frontend needs no change: it follows `GET /public/signup-options`. Organizations already created stay valid; their owners keep the onboarding shell until they finish or defer |

The deploy action writes a `FLAG_*` line into `/opt/atlas/.env` only when
the repository variable is non-empty, so an unset variable means the backend
default (`off`).

## 7. Verification

### Production — `Onboarding verify`

`Onboarding verify` (`.github/workflows/onboarding-verify.yml`,
workflow_dispatch) runs `deploy/onboarding-verify.sh` on the VPS over the
restricted deploy identity. It prints PASS/FAIL and non-secret facts only,
and writes nothing: its one register request is a shape the server refuses
before any write, and it then asserts that no user row exists for the probe
address.

Run 36242994451 (26 Sep 2026, flag unset → `off`): **all checks passed.**

- Migration applied; `onboarding_completed_at` default `CURRENT_TIMESTAMP`.
- 46 organizations, **0** pending onboarding (existing organizations count
  as onboarded).
- `complete_organization_onboarding` is `SECURITY DEFINER`; `EXECUTE` is
  granted to `atlas_app`, not to PUBLIC; `organizations` still has no
  UPDATE policy.
- `GET /public/signup-options` → 200, `organizationSignup=false`,
  `trialsEnabled=true`, trial plans `starter, growth, premium-starter,
  premium-growth`.
- `POST /auth/register` with `organizationName` → 400
  `errors.auth.organizationSignupDisabled`, and no user row was created.

This run is also the **flag-off rollback verification**: with the flag off,
the organization fields are refused server-side and the signup options tell
the frontend to render the legacy form.

With the flag `on`, the same workflow checks `organizationSignup=true` and
sends a register request with a random, non-existent plan id, which must be
refused with `errors.auth.signupPlanUnavailable` and create no row.

### Automated tests

| Suite | Result |
|---|---|
| `test/new-customer-onboarding.e2e-spec.ts` | 24/24 |
| Targeted backend regression (suites touching signup, organizations, plans, trials and billing) | 140/140 e2e, 451 unit |
| Full backend e2e | All pass except `p63-domain-operations` (4 failures, identical on the pre-feature baseline `768d122`; pre-existing and unrelated) |
| Frontend vitest | 1110/1110 |
| Frontend typecheck | 34-error baseline, unchanged; none in touched files |
| All 124 migrations on a fresh database | Apply cleanly, including the definer function and its grants |

The onboarding e2e covers: signup options; the atomic happy path (user,
organization with `onboarding_completed_at = NULL`, owner membership,
trialing subscription, redemption, audit, outbox, `onboardingPending` on the
session); legacy signup; every refusal with no rows written; trials
disabled; flag off; the academy surface; five concurrent signups for one
email (one 201, four 409); an injected failure rolling everything back; a
plus-addressed trial-used mailbox getting `no_plan` and going through
checkout → payment → proof → reject → approve; legacy organizations not
pending; multiple organizations; completion semantics (finish refused while
required steps are open, defer, idempotent single audit, finish once the
academy and published website exist); trial expiry; authorization (manager, instructor, learner,
other organization's owner → 403, anonymous → 401); and a direct RLS test of the
definer function (non-owner, wrong organization context → refused).

### Browser journeys (local real stack, real OTP)

Chromium against a local backend with the flag `on` and OTP `new_device`;
the OTP code was read from the local communications outbox.

| Journey | Result |
|---|---|
| A. Start for Free → one-page signup → sign in → OTP → Academy → Branding → Website → First course → Summary "Your academy is ready" → Finish → Dashboard (EN, desktop) | Pass; database confirmed logo, published site, course, completion, trialing `premium-growth`, audit `mode: finish` |
| Same journey, Arabic desktop | Pass: RTL, no overflow, no raw keys |
| Same journey, EN mobile (390 px) and AR mobile | Pass after the mobile overflow fix |
| Finish for now → "Setup incomplete — 1 required step left" → new browser → dashboard card → Continue setup resumes at Website → skip course → Finish | Pass |
| Trial already used (plus-address) → Plan step → existing checkout → proof → Back to setup → awaiting confirmation → Platform Owner rejects (reason shown, "Submit a new payment") → resubmit → approve → wizard advances to Academy | 11/11; subscription `active: growth`, 0 redemptions |
| Existing owner and manager are not routed into onboarding; manager is redirected away from `/onboarding` | Pass |

Defects found by these journeys and fixed before deploy: provisioning wording
on the Academy submit button; missing Required tag in the step rail; missing
`no_plan` / `trial_expired` translations (raw key shown on checkout);
`returnTo` not carried to the payment page; stale onboarding status after
returning from checkout; horizontal page overflow of the shell on mobile;
the mobile step rail not keeping the current step in view.

### Security review

- The signup fields are never an authorization input: the organization is
  created for the user being registered, and the plan is re-resolved inside
  the transaction (active, customer-facing, trial-eligible) — a forged or
  ineligible id is refused before any write.
- Both trial-abuse guards are unchanged and still decisive: the
  once-per-mailbox claim (plus-address canonicalization) and the
  per-organization conditional start.
- Onboarding reads run in the owner's tenant + user RLS context; the only
  write goes through the definer function, which re-checks the owner
  membership and can only move NULL → now().
- The onboarding API is owner-only (403 for other roles and other
  organizations); no new UPDATE policy on `organizations`.
- Emails go through the existing communications outbox; no new mail path,
  no token in any response, log or document.

### Production — flag ON (26 Sep 2026)

**`Onboarding verify`** (runs 36246237835, 36247423268, 36247509421):

- The backend container sees `FLAG_SIGNUP_ORGANIZATION_MODE=on`.
- `GET /public/signup-options`: `organizationSignup=true`; the exposed
  trial plans equal the set computed from the server-side rule (active,
  customer-facing, trial-eligible, policy enabled) —
  `starter, growth, premium-starter, premium-growth`; 2 non-trial plans
  excluded. Production has no inactive or hidden plan to probe (those
  refusals are covered by the e2e suite and the local run).
- Refused with nothing written (no user, no organization): fake plan id,
  non-trial plan, plan without organization name, name too short,
  malformed plan id, organization fields with an academy id, and an
  existing email (409).
- Organizations created by the one-page signup: 5 (2 `trialing`, 3
  `no_plan`); every trialing one has its trial redemption — the atomic
  claim + start holds in production. `atlas_signup_total`:
  `trial_started=1, no_trial=2, rejected_plan=2, conflict=1` since the
  last backend restart.
- **FAIL — the payment-method catalog is empty** (0 rows). See §8.

**`Onboarding browser verify`** (run 36246839200) — real Chromium from a
GitHub runner against production, sign-in codes read server-side for the
journey's own account only, never logged:

| Check | A — EN desktop | B — AR mobile |
|---|---|---|
| Landing "Start for Free" link → signup | PASS ("Get started") | PASS ("ابدأ الآن") |
| One page: name, email, password, confirm, organization name | PASS | PASS |
| Trial plans offered = server-eligible set (by key) | PASS | PASS |
| Exactly one primary action, "Create Account" | PASS | PASS ("إنشاء حساب") |
| No organization or plan page between signup and sign-in | PASS | PASS |
| Atomic state: user + organization + primary owner membership + subscription, `onboarding_completed_at IS NULL`, `organization.created` audited | PASS | PASS |
| Sign-in: email pre-filled, "Account created" notice | PASS | PASS |
| OTP challenge (new device), then first page `/onboarding` | PASS | PASS |
| Rail: Academy/Website Required, Branding/First course Recommended | PASS | — |
| Layout: correct `dir`, no overflow, no raw keys (every screen reached) | PASS | PASS (RTL) |
| Trial granted | **not reachable** — the mailbox had already redeemed a trial (`eligible=no` before signup), so `no_plan` and the Plan step, exactly as the anti-abuse rule requires | PASS — no second trial, 0 redemptions |
| Plan step offers paid plans → existing checkout | PASS (landed on Plan) | PASS |
| Checkout offers a payment method | — | **FAIL** — catalog empty |

Not yet verified **in production** (verified locally, end to end, with the
same script — both journeys all-PASS): Academy → Branding → Website →
First course → Summary → Finish → Dashboard, Finish disabled while a
required step is open, refresh persistence, Finish for now → dashboard
card, and the payment → awaiting confirmation step.

## 8. Known limitations

- **Production payment-method catalog is empty** (configuration gap,
  pre-existing, not caused by this feature). `payment_methods` has no write
  endpoint by design and is filled by the seed, which carries fake fixture
  details and was never applied to production. Until real methods exist,
  no `no_plan` or `trial_expired` organization can pay: checkout shows its
  "no payment methods" empty state and the Plan step's "Contact support".
  Needs the owner's real bank/wallet transfer details.
- **Production trial-path browser journey** needs a Gmail mailbox that has
  never redeemed an Atlas trial (Gmail ignores dots and `+tags`, so the
  owner's usual mailbox cannot be reused).
- On the payment details page, "Back to setup" is shown with the payment;
  if the payment fails to load, the page shows the standard error state
  without it (the owner can still use the dashboard setup card).
- Hiding the dashboard card for recommended-only items is a per-device
  preference, by design (§4).
- `p63-domain-operations` e2e has 4 pre-existing failures unrelated to this
  feature.

## 9. Remaining work

1. **Owner data:** real payment-method details (bank transfer and/or
   wallet: display name, account name, bank/wallet provider, account
   number/IBAN or wallet number, instructions). Added through a reviewed
   data migration applied by the gated `apply_migrations` run. Then
   `Onboarding verify` must show at least one enabled method.
2. **Owner input:** a Gmail local part that has never been used for an
   Atlas trial; then dispatch `Onboarding browser verify` with it
   (journeys `A,B`) to complete the production trial path through Finish.
3. Test organizations left by run 36246839200 ("Atlas Onboarding Verify
   A/B", `no_plan`, pending setup) are clearly named verification data.
