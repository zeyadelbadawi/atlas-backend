# Atlas Product Quality Master Plan

**Status: ADOPTED — permanent, non-negotiable project rules (owner instruction, 24 September 2026).**
**Scope: every phase, every feature, every workflow and every piece of UI in Atlas — present and future. No phase may opt out.**

This document is a standing companion to `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (the P64 initiative plan) and to every future initiative plan (for example `docs/communications/COMMUNICATIONS_AND_LIFECYCLE_PLAN.md`). Those plans own scope, phases and status; **this plan owns the acceptance criteria that every one of them must satisfy.** It is deliberately separate so that the rules cannot be edited away inside a phase. When a plan and this document disagree, this document wins.

---

## 1. UI quality is a requirement, not a nice-to-have

Any feature with a human-facing workflow MUST have a proper, production-quality UI. A feature is never complete because the backend or API exists.

For every user-facing feature:
- Build the appropriate page, route or component.
- Make it visually polished and consistent with the Atlas design system.
- Use the approved UI/UX skill (Apple Design or UI/UX Pro Max).
- Responsive across desktop, tablet and mobile.
- RTL support where applicable (Arabic).
- **States that must exist where applicable:** loading · empty · error · success · disabled · pending/processing · permission denied · expired/inactive.
- Confirmation flows for destructive or high-impact actions.
- The UI clearly communicates what happened and what the user can do next.

Meaningful functionality is never hidden behind obscure UI or a tiny dashboard card when the product architecture requires a proper page or workflow.

**A backend capability without an appropriate frontend experience is NOT product-complete.**

## 2. Validation and UX are required for everything

Validation must exist at the correct layers:
- client-side validation for immediate feedback;
- server-side validation for security and correctness;
- database constraints where appropriate;
- authorization checks;
- tenant / RLS enforcement where applicable.

Frontend validation is **never** a security boundary.

For every form, input and workflow, validate: required fields · types · ranges · formats · business rules · permissions · ownership / tenant scope · state transitions; handle race conditions where relevant; return actionable errors; display actionable errors in the UI.

The UX explains the problem in language a real user understands. Never expose raw database errors, stack traces, internal exception names, implementation details or confusing technical codes — unless an explicitly technical/admin surface requires them. The user must understand (1) what went wrong, (2) why, when appropriate, and (3) what to do next.

For every workflow, explicitly consider, as applicable:
`SUCCESS · LOADING · EMPTY · ERROR · VALIDATION ERROR · PERMISSION DENIED · EXPIRED · CONFLICT · RATE LIMITED · UNAVAILABLE · RETRY`

## 3. The Platform Owner must have full product control

Every meaningful platform-level capability that requires platform administration MUST have an appropriate Platform Owner management/control surface. Platform functionality is never left backend-only when a Platform Owner needs to configure, monitor, manage, override, audit or control it. The Platform Owner dashboard progressively becomes the central platform-control surface.

For every new platform-level feature, determine whether the Platform Owner needs: configuration · enable/disable controls · limits · defaults · policies · provider configuration · feature flags · retention configuration · notification configuration · security controls · user/tenant controls · monitoring · metrics · reports · audit history · operational actions · overrides · troubleshooting tools. If yes, build the page, section, settings screen, management workflow or operational surface. Backend configuration alone is never sufficient.

## 4. Platform Owner control must be complete

For every new platform-level subsystem, ask: **"How does the Platform Owner control this?"** If there is no clear answer, a management surface is missing and that is a finding.

Typical subsystems: email provider configuration · email delivery status · OTP configuration · subscription/trial policies · entitlement policies · video provider configuration · video retention · notification policies · feature flags · platform limits · usage/quota controls · security policies · abuse/rate-limit policies · monitoring · alerting · reports · audit logs · operational health · tenant-level overrides where intentionally supported.

Never expose dangerous infrastructure secrets in the UI. Platform Owner control means safe, intentional, permissioned configuration; credentials and secrets remain in secret-management infrastructure and the UI shows status and safe settings only.

## 5. Client Owner / Manager / Instructor / Learner / Public surfaces

For every feature, determine which role actually needs to interact with it and provide that role's surface. Consider at minimum: Platform Owner · Client Owner · Manager · Instructor · Learner/Student · Anonymous/Public. Do not force every role into one dashboard; do not grant a role functionality merely because another role has it. Every surface follows the established Atlas authorization model (guard decides; RLS independently agrees). **UI visibility never replaces server-side authorization.**

## 6. Product completeness rule

A feature is COMPLETE only when all applicable layers are complete:

Backend + Authorization + Tenant/RLS isolation + Validation + Frontend UI + UX states + Error handling + Responsive behaviour + Accessibility + RTL where applicable + Tests + Observability where applicable + Documentation + Deployment + Production verification.

If a layer is intentionally not applicable, record why in the owning plan. If a feature has a backend implementation but its required UI, validation, UX or management surface is missing, **do not mark it complete**; classify it honestly as one of:

`BACKEND ONLY · FRONTEND MISSING · UX INCOMPLETE · PLATFORM CONTROL MISSING · VALIDATION INCOMPLETE · PRODUCTION VERIFICATION PENDING · BLOCKED`

## 7. Every plan must track product surfaces

For every phase/feature, the owning plan records, explicitly, including only the relevant roles but making the determination visible:

`Feature → Backend → Platform Owner surface → Client Owner surface → Manager surface → Instructor surface → Learner surface → Public surface → Validation → UX/UI → Authorization → Tests → Production verification`

Template (copy into each plan's phase record):

| Feature | Backend | Platform Owner | Client Owner | Manager | Instructor | Learner | Public | Validation | UX/UI | Authz | Tests | Prod verification | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|

## 8. Before marking any phase complete — product-level review

Answer every applicable question; any NO blocks completion (fix it or document the exact blocker):
- Does the feature actually exist in the UI?
- Can the intended user find it? Understand it? Complete the workflow?
- Are validation errors understandable?
- Are all important states handled?
- Can the Platform Owner control platform-level behaviour where appropriate?
- Are permissions correct? Is tenant isolation correct?
- Is the feature responsive? Is RTL correct where applicable?
- Are tests passing?
- Has production behaviour been verified?

## 9. No "backend complete = product complete"

**BACKEND IMPLEMENTATION IS NOT PRODUCT COMPLETION.** A feature is a product feature only when the appropriate user can use, understand and control it through the intended product experience. Equally, **PLATFORM BACKEND CONTROL IS NOT PLATFORM MANAGEMENT COMPLETION**: if the Platform Owner is expected to manage a capability, the management UI must exist.

---

## 10. Planning gate (mandatory whenever a feature is added to any plan)

A feature counts as planned only after these are answered in writing in its plan:
1. What UI does this require?
2. What validation does this require?
3. What UX states does this require?
4. Which roles interact with it?
5. Does the Platform Owner need control?
6. What management surface is required?
7. What security/authorization rules apply?
8. What tests prove it works?
9. How will production behaviour be verified?

## 11. Enforcement

- Every existing and future initiative plan inherits this document automatically; each plan's Definition of DONE is read as including §1–§9.
- Phase completion records must include the §7 matrix and the §8 review outcome.
- Findings against these rules are classified with the §6 vocabulary — never hidden, never rounded up to COMPLETE.
- This document is amended only by owner instruction, in its own commits, never inside a feature change.

---

## Appendix A — First application: Phase 4 of the P64 plan (classification only; Phase 4 remains OPEN in its own plan)

Assessed 24 September 2026 from the production product audit recorded in `ATLAS_SECURE_LEARNING_MASTER_PLAN.md` (DL-42). This appendix does not change Phase 4's status or blockers; it records how Phase 4 measures against §1–§9.

| Feature | Backend | Platform Owner | Client Owner | Manager | Instructor | Learner | Public | Validation | UX/UI | Authz | Tests | Prod verification | Classification |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Public catalog (`/courses`) | ✓ | n/a | builder section + metadata authoring | same | n/a | same page | ✓ | ✓ bounded query DTO | ✓ EN/AR, states | public read | e2e 11 + J6 | ✓ owner site EN/AR | COMPLETE |
| Course details / CTA / free preview | ✓ | n/a | metadata card; preview flag in builder | same | curriculum edit | ✓ | ✓ | ✓ | ✓ (blocks hide when unauthored, by design) | preview gate answers 404 | e2e 5 + J6 | details ✓; preview playback local J6 + live `isPreview` | COMPLETE; production preview playback PRODUCTION VERIFICATION PENDING (needs a real preview lesson) |
| Reviews (author / moderate / display) | ✓ | n/a | Reviews tab | Reviews tab | Reviews tab | review form | rating block | ✓ sanitised, range | ✓ | enrolled / roles + RLS | e2e 13 + J6 | tab ✓; learner flow local | COMPLETE; learner flow PRODUCTION VERIFICATION PENDING (credential) |
| Student checkout / purchases / refunds | ✓ | payment review (existing) | n/a | n/a | n/a | checkout, purchases | n/a | ✓ | ✓ incl. honest "not available" | buyer-scoped + RLS | e2e 6 + adversarial + J5/J6 | route live; flow local | COMPLETE; PRODUCTION VERIFICATION PENDING (credential) |
| Owner reports (integrity / sharing / quota) | ✓ | n/a | Reports page | Reports page | 403 | n/a | n/a | ✓ window DTO | ✓ EN/AR states | owner/admin/manager + RLS | e2e 7 | ✓ owner dashboard AR | COMPLETE |
| Platform video minutes / provider health | ✓ | dashboard summary + Analytics → Content delivery | — | — | — | — | — | ✓ | ✓ | platform owner + RLS | e2e 2 + 5 | routes live/guarded; chunk served | COMPLETE; signed-in view PRODUCTION VERIFICATION PENDING (credential) |
| Commerce / delivery reporting | ✓ | Analytics → Commerce / Content delivery | — | — | — | — | — | ✓ | ✓ | platform owner + RLS | e2e 5 | routes live/guarded | COMPLETE; same pending |
| Observability metrics + alert rules | ✓ | in-product Analytics; Prometheus rules file | — | — | — | — | — | n/a | — | `/metrics` platform-gated | drift spec | rules committed; receiver wiring OPEN | **PLATFORM CONTROL MISSING** for alert routing (BLOCKED — host secrets) |
| Feature flags (`FLAG_*`; `catalog.v2`/`checkout.student` never created) | env-only | **no flag management UI exists** | — | — | — | — | — | — | — | — | — | — | **PLATFORM CONTROL MISSING** (standing gap for a future phase under §3–§4) |
| Hosted-video intro/trailer (`introVideoAssetId`) | stored only | — | no picker | — | — | — | no playback | — | FRONTEND MISSING | — | — | — | **BLOCKED** (video infrastructure) |
| Range on public media / retention sweeps | ✓ | no retention-configuration UI (constants) | — | — | — | — | ✓ | ✓ | n/a | n/a | unit 10 + e2e 5; sweep unit/e2e | deployed | COMPLETE as a feature; retention configuration **PLATFORM CONTROL MISSING** |
