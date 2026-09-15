# Live Sessions — Backend Status & Handoff

**State: IMPLEMENTED → VERIFIED → DEFERRED (Coming Soon) → WAITING FOR ZOOM.**
The backend is complete and preserved; customer activation is intentionally
blocked pending external Zoom approvals. The external items are NOT backend
defects.

## 1. Purpose
The Live Sessions (Zoom) backend is fully built and tested, but customers
cannot install, enable, purchase, or use it while deferred. This document is
the backend handoff for re-enabling it after the external Zoom approvals land.

## 2. Current backend state (all present in the repo)
- **Provider abstraction** — `src/live-sessions/providers/` (`ZoomProvider`,
  `live-provider.interface.ts`): meeting create/update/cancel, ZAK, recording
  files, participant reports, webhook signature verification, join signature.
- **OAuth (Atlas-owned General app)** — `zoom-oauth.service.ts`,
  `live-provider-oauth.controller.ts`: owner-only authorize, single-use state,
  encrypted token set, rotation guard, `reconnect_required` lifecycle.
- **Meeting provisioning / publish / reschedule / cancel** —
  `live-session-provisioning.service.ts`.
- **Webhooks** — `live-provider-webhook.controller.ts`: app-level `x-zm-signature`
  HMAC verified before tenant lookup, `endpoint.url_validation` CRC, 5-minute
  replay window, DB-level idempotency; queue processor
  `live-provider-event.processor.ts`.
- **Attendance** — intervals + provider-report reconciliation
  (`live-session-sweep.service.ts`, `attendance.service.ts`).
- **Recordings** — lifecycle + entitlement-backed quota
  (`recording-import.service.ts`, `recording-quota.service.ts`).
- **Notifications** — `live-session-notifications.service.ts`.
- **Deauthorization** — `live-provider-deauthorization.controller.ts`
  (`app_deauthorized`, account_id→academy, actor-less invalidation).
- **Platform Owner Zoom Operations Center** — `src/platform/*platform-zoom*`
  (9 read-only endpoints; unaffected by the deferral — see §4).
- **Access/entitlement gate** — `add-on-access.service.ts` (`describe`),
  `live-session-access.service.ts`.
- **Add-on lifecycle** — `add-ons-lifecycle.controller.ts`.
- **Security/RLS** — `p46`/`p49`/`p50` migrations; Zoom credential encryption
  via `CredentialEncryptionService`.

## 3. Backend verification completed (actual results)
- Unit: **803 tests / 65 suites** pass (`npx jest`).
- Real-PostgreSQL RLS/security e2e: `platform-zoom-operations` **18/18**,
  `live-provider-deauthorization` **9/9**.
- Deferral enforcement unit spec: `add-ons-lifecycle.deferred.spec.ts` **6/6**.
- Typecheck / lint / build: clean.
- Live API (dev): install/enable of `live-sessions` → **403
  `errors.addOns.comingSoon`**; a non-deferred add-on still installs (200);
  customer status endpoint reports `addOn.usable=false, reason="coming_soon"`.

## 4. Current deferred enforcement (the exact code path)
Single source of truth: `src/live-sessions/constants/deferred-add-ons.constants.ts`
→ `DEFERRED_ADD_ON_KEYS = { 'live-sessions' }` + `isAddOnDeferred(key)`.

Three enforcement points consult it; **all customer paths fail closed**:
1. **Use** — `AddOnAccessService.describe` returns
   `{ usable:false, reason:'coming_soon' }` for a deferred key, before any
   subscription/entitlement/installation check. Every customer
   create/publish/join/provision path runs through this (via
   `LiveSessionAccessService`), so it is blocked even for a tenant that
   already holds an installed row.
2. **Install / enable** — `AddOnsLifecycleController.transition` throws
   `ForbiddenException(errors.addOns.comingSoon)` for install/enable of a
   deferred key (disable/uninstall stay allowed so a tenant can back out).
3. **Purchase** — `CheckoutService.createCheckout` refuses to create an
   add-on checkout for a deferred key, and `PaymentApplicationService`
   refuses to activate one (defense-in-depth for any pre-frozen order).

Request flow: customer request → JWT auth → org membership + billing
permission → **deferred check** → blocked (403), or (for use) not-usable.

The catalog surfaces expose `comingSoon` (`GET /add-ons` and
`GET /organizations/:id/add-ons/catalog`) so the store renders "Coming Soon".

## 5. Security preserved (unchanged by the deferral)
JWT authentication, Platform Owner authorization, academy scope, entitlement
enforcement, PostgreSQL RLS (incl. FORCE + platform-select), Zoom credential
encryption, webhook HMAC verification, replay protection, idempotency,
provider identity reconciliation, and student enrollment checks are all
untouched. The deferral only ADDS deny paths; it removes no control.

## 6. External blockers (NOT backend bugs)
- **Anonymous Join Exception** (Meeting SDK external-meeting join) — PENDING
  Zoom review. No approval evidence exists. Fallback documented in the
  frontend `ATLAS_HANDOVER.md` (§15c).
- **Domain validation** for `atlass.dpdns.org` (parent `dpdns.org` is
  third-party controlled) — manual request submitted to the Zoom Developer
  Forum; PENDING.
- **Zoom Marketplace review/publication** — PENDING as applicable.

## 7. Remaining backend work before launch
- **ALREADY COMPLETE:** OAuth, provisioning, webhooks (incl. production CRC),
  deauthorization, attendance, recordings, quota, notifications, ops center,
  RLS/security, deferral enforcement.
- **WAITING FOR ZOOM:** nothing code-side; external approvals only.
- **REQUIRES REAL PRODUCTION VERIFICATION (post-approval):** real customer
  OAuth connect, real meeting provisioning, real webhook delivery, real
  attendance reconciliation, real recording import, real embedded student
  join.
- **OPTIONAL FUTURE:** the Meeting-SDK student-join fallback if the Anonymous
  Join Exception is refused (see frontend handoff); `ZOOM_OAUTH_SCOPES`
  constant cleanup.

## 8. Re-enable / launch checklist (backend)
1. External: Anonymous Join decision resolved; domain validation approved;
   Marketplace review complete.
2. Confirm production `ZOOM_*` env present and correct.
3. Remove `'live-sessions'` from `DEFERRED_ADD_ON_KEYS` (the single switch).
4. Deploy; verify install/enable/purchase now succeed and `describe` reports
   usable for an entitled+installed tenant.
5. Real end-to-end: OAuth connect → meeting create → webhook delivery →
   attendance reconcile → recording import → quota decrement.
6. Security re-check (guards + RLS unchanged). Final launch approval.

## 9. Rollback / disable strategy
The deferred set IS the kill switch. To keep or return the feature to
disabled, ensure `'live-sessions' ∈ DEFERRED_ADD_ON_KEYS` and deploy — every
customer install/enable/purchase/use path fails closed again with no data
change. No separate mechanism was introduced.
