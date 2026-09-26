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
