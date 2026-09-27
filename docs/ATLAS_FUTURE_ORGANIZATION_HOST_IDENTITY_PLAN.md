# Atlas Future Identity & Organization-Host Plan (Plan B)

> **DEFERRED — FUTURE PHASE.** Nothing in this document is approved for implementation. It must not be mixed into the immediate milestone (`docs/ATLAS_LAUNCH_STABILIZATION_PLAN.md`, Plan A).

**Date:** 2026-09-26
**Detailed reference:** `docs/ATLAS_GLOBAL_IDENTITY_PLAN_v3.md` (Plan v3, kept unchanged, with a re-scope banner). Section numbers below (for example "v3 §11") point into that file.
**Precondition:** Plan A is implemented and verified in production. Several items below build directly on Plan A's session-surface lookup and on the academy-scoped `/users/me` projection.

---

## 1. Purpose

Plan B preserves the architecture worked out in Plan v3, sequenced **after** the launch-stabilization milestone. It evolves Atlas into Organization-hosted management with context-bound identity. It keeps the same principles: the host selects the context, the database relationship authorizes, RBAC and RLS are unchanged, and there is one global identity.

## 2. Deferred scope

| Area | Summary | v3 reference |
|---|---|---|
| **Organization management hostnames** | `https://<org-label>.<base>` with `/auth/sign-in`, `/auth/forgot-password`, `/auth/reset-password` and the existing `/dashboard/*`. **No signup on organization hosts.** | §6, §16 |
| **Label namespace** | One shared single-level namespace for Organizations and Academies. Adapt `subdomain_allocations` (nullable `academy_id` + `organization_id` + CHECK). Immutable labels. 90-day release cool-down. Expanded reserved list. | §6 |
| **Host context layer** | `HostContextService` (extends `AcademySurfaceService`); `resolve_host_context()`; `GET /public/host-context`; SPA `organization-management` mode; unknown-host page | §24, §25 |
| **Context-bound sessions** | Sessions and tokens bound to `platform` / `organization:<id>` / `academy:<id>`; host-bound refresh; one equality check in each tenant guard; review of the 8 guard-less management controllers. **Builds on Plan A's server-side surface lookup** and may keep it instead of token claims. | §5, §10, §11 |
| **Organization-level OTP** | `organizations.management_otp_policy` (NULL = platform default, `new_device` in production today); Client Owner-only setting; platform floor | §12 |
| **Context-aware password reset** | The token stores its context; the link goes to the context host from the database; validate and confirm only on the matching host | §13 |
| **Organization signup and onboarding for existing identities** | Mailbox-first, non-enumerating marketing signup (`signup_intents`); existing-account → Client Owner; eligibility (learner, instructor, manager, owner; **Platform Owner excluded** by guard and trigger); multiple organizations with a per-user cap; organization label chosen at signup | §14, plan v2 §9–§14 |
| **Post-signup hand-off** | A single-use, 60 s, audience-bound code from the platform host to the newly created organization host (signup-only issuance) | §14 |
| **Invitations to organization hosts** | Setup links for staff on the organization host (`branding:'organization'`); notify existing identities when they are attached | §15 |
| **Platform host = Platform Owner** | Base-host sign-in for Platform Owners only; "Find my organization" (the email lists organization hosts); a compatibility landing for legacy `/dashboard*` | §18, §29 |
| **Account Center** | Not planned. Per-context profile + a "Where you use Atlas" card on the organization host. | §19 |
| **Academy-side improvements** | Explicit Join instead of silent `sign_in_join`; role-aware academy post-login card for staff; OTP supersede scope per context; TOTP challenge context binding; `trusted_devices` context columns | §7, §12, §17 |
| **Hardening** | CSP on SPA hosts; RLS tightening (`academy_students_self_insert` policy-consistent; `enrollments_self_update` limited to progress fields; owner-row self-delete refused); `Vary: Host` + `no-store` on host-dependent public responses | §21, §26 |
| **Infrastructure** | Caddy `header_up X-Forwarded-Host {host}` after a production probe (LB-HOST); reserved labels `video`, `ssh` (LB-RESERVED, unless it moves into Plan A) | §22, §25 |

## 3. Commercial-launch infrastructure (separate track; required before **real commercial launch**, not for Plan A)

1. **LB-DOMAIN:** move off `atlass.dpdns.org`, a subdomain of the free third-party apex `dpdns.org` on DigitalPlat nameservers (see `docs/ATLAS_PHASE2_FINAL_HANDOVER.md` §J), to an Atlas-owned registrable domain. This covers:
   - the Cloudflare zone and wildcard DNS
   - the edge certificate and the Caddy DNS-01 wildcard
   - the Brevo sender domain
   - `R2_PUBLIC_URL_BASE`
   - the Worker route
   - `VITE_PLATFORM_BASE_DOMAIN` / `PLATFORM_BASE_DOMAIN`
   - `CORS_ALLOWED_ORIGINS`

   Do it **before** the controlled reset and before real customers arrive. Every host, email link and trusted device becomes bound to the domain once it is in use.
2. **LB-PAY:** configure payment methods (the catalogue is empty today).
3. **LB-EMAIL:** measure KI-EMAIL-1 delivery latency (OTP, reset, invites) to the major providers. It is a go/no-go gate.
4. Platform Owner accounts must have TOTP enabled.
5. Rehearse a backup restore.

## 4. Future sequencing (proposed; to be re-planned when Plan B is opened)

1. **Host foundation** (domain move, label namespace, host resolver, SPA mode, `X-Forwarded-Host` hardening).
2. **Context-bound authentication** (organization admission, organization-bound sessions, organization OTP, context-aware reset, invitations).
3. **Dashboard on organization hosts** (the active organization comes from the host; the switcher becomes links; legacy landing; email links retargeted).
4. **Organization signup and onboarding for existing identities** (mailbox-first, eligibility, cap, Platform Owner exclusion, hand-off).
5. **Academy-side improvements and hardening** (explicit Join, CSP, RLS tightening).
6. **Launch gate** (v3 "Production Launch Gate").

Every phase follows v3's per-phase template: objective, backend, frontend, data, security, migration, tests, observability, acceptance, rollback and production verification.

## 5. Future threat model and decisions

- **Threat model:** v3 §27 (38 threats with prevention, detection, test and expected result) still applies.
- **Decisions to take when Plan B opens:** v3 §37 / §H:
  - which domain
  - the shared namespace
  - the organization OTP values and OFF allowance
  - the hand-off
  - immutable labels
  - no Account Center
  - a Platform Owner-only base-host sign-in
  - multiple organizations and the cap
  - a `/sign-up` alias

## R. Controlled production test-data reset (full procedure)

Recommended for the launch sequence after Plan A (see Plan A §10). This is **Option C: keep the platform, delete the tenants.** The full step list is v3 "Production data reset procedure". It requires:
- a verified backup plus a restore test
- an inventory and manifests (R2 keys, Stream ids, Cloudflare custom hostnames)
- a delete order generated from the FK graph
- a maintenance window and BullMQ drain
- external-resource cleanup first
- a single owner-role database transaction with preserved-table assertions
- a Redis cleanup
- verification SQL
- post-reset smoke tests
- a written approval at execution time

**Never an uncontrolled wipe.**

## 6. Why these items were deferred

None of them is required to close D1–D3, to allow cross-Academy learners, or to keep the existing Atlas safe to operate:
- D1 is closed in Plan A **without** context tokens, through a server-side session-surface lookup.
- Cross-Academy learners need **no** schema change.
- The organization-host model changes routes, the dashboard entry point, onboarding and infrastructure. That is the work the immediate milestone must avoid.
