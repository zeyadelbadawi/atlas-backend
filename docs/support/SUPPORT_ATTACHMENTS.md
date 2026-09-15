# Support ticket attachments (P53)

**Status: IMPLEMENTED, TESTED (15 real-Postgres e2e), VERIFIED IN REAL CHROME.**

A requester may attach one optional image to a ticket's first message and to
any reply. Text-only tickets and replies are unchanged in every respect.

---

## 1. Why this is not a `MediaAsset`

This was the central design decision, and it went against the obvious answer.
Four independent facts rule `media_assets` out; any one of them alone would:

1. **`media_assets.academy_id` is NOT NULL**, but `support_cases.academy_id` is
   nullable by design — an Organization Owner's billing ticket belongs to no
   single Academy. Attaching an image to such a ticket would mean inventing an
   `academy_id`.
2. **`media_assets` rows ARE the Academy Media Library** (`GET
   academies/:id/media`), readable by every `owner`/`administrator`/`manager`
   of that academy. A support ticket is requester-private:
   `support_cases_requester_select` scopes a case to the one person who filed
   it, deliberately not to their colleagues. Routing ticket screenshots
   through media would publish a private conversation's evidence to the whole
   academy staff — a real privacy regression, not a theoretical one.
3. **Media is quota-counted** against the organization's storage entitlement,
   and support is explicitly reachable while a subscription is inactive
   (`@AllowInactiveSubscription` on `TenantSupportCasesController`: "a customer
   whose subscription lapsed is exactly the customer most likely to need
   support"). A customer who is over quota — or lapsed — must still be able to
   show support what is wrong.
4. **Media bytes are served by the UNAUTHENTICATED public route**
   (`PublicMediaController`), an unguessable-capability URL. That model is
   correct for academy logos; it is not correct for a private ticket.

## 2. What IS reused (so this is not a second media system)

One storage pipeline, a second ownership model over it:

| Reused | From |
|---|---|
| R2 client, bucket and credentials | `MEDIA_STORAGE_PROVIDER` (now exported by `MediaModule`) |
| Magic-byte file-kind detection | `detectFileKind` (`media/utils/file-validation.util.ts`) |
| Size ceiling (`MEDIA_MAX_UPLOAD_BYTES`) | `assertWithinSizeLimit` |
| Data-URL parsing, filename sanitising | `parseDataUrl`, `sanitizeFileName` |
| Base64 client→server transport | the same shape as `UploadMediaAssetPayload` |
| "Atlas serves its own bytes over a relative URL" | `PublicMediaController`'s own rule |
| Frontend size formatting / file predicates | `formatBytes`, `isAcceptedType`, `isWithinSizeLimit` |

`MediaService` itself is deliberately NOT used: every one of its methods
creates an academy-scoped, quota-counted, library-visible `MediaAsset`, which
is exactly what a private ticket attachment must not be.

## 3. Ownership chain and storage key

```
User (requester) → SupportCase → SupportCaseMessage → SupportCaseMessageAttachment
```

Storage key: `support-cases/{caseId}/{uuid}.{ext}` —
`buildSupportAttachmentStorageKey`, in the same module as `buildStorageKey`.
Every part is server-generated from an already-resolved case id plus
`randomUUID()`. No client string (filename, mime type) is ever concatenated
into a key, so `../../` cannot be expressed.

## 4. Authorization — guard decides, RLS independently agrees

`support_case_message_attachments` has `ENABLE` + `FORCE ROW LEVEL SECURITY`
and exactly three policies, each the predicate `support_case_messages` already
uses, resolved one join further out:

| Policy | Who | What |
|---|---|---|
| `..._requester_select` | the person who filed the case | read their own |
| `..._requester_insert` | same, and only onto a `requester` message | write their own |
| `..._platform_select` | `is_platform_owner(...)` | read every attachment |

No UPDATE or DELETE policy for anyone, and no platform INSERT policy: there is
no edit, remove or agent-attach endpoint, so granting either would be a
permission no code path exercises (the same reasoning `support_cases`'
own omitted INSERT policy documents).

**The serving route runs ONE context for both audiences.**
`SupportCasesService.getAttachmentBytes` calls
`runInUserContext(userId)` and lets the database decide which policy applies —
a requester matches the requester policy, a Platform Owner matches the
platform policy, anyone else matches neither. There is deliberately no
`isPlatformOwner` branch in the service: that would be a second authorization
decision that could drift from the policies. The repository read carries no
ownership `WHERE` clause for the same reason.

A row the caller may not read is indistinguishable from one that does not
exist — both are 404, never 403, matching `getMyCase`'s documented rule that a
403 would confirm the id is real.

## 5. Validation

Nothing the client says is trusted. `mimeType`/`sizeBytes` are validated for
shape only; the real kind comes from `detectFileKind`'s magic-byte sniff of the
decoded buffer and the real size from that buffer's length.

- **Images only.** The shared allowlist also covers PDF; support narrows to
  `assetType === 'image'` and refuses anything else.
- The storage write happens BEFORE the transaction that creates the message
  row, so a rejected upload never leaves a half-created ticket and no database
  connection is held across a network round-trip to R2. The trade-off — an
  orphaned object if the transaction then fails — is the same direction
  `MediaService.performUpload` already chose, and the safe one: an unreferenced
  byte range is invisible, whereas a row pointing at bytes that were never
  written is a broken image in a customer's ticket.

## 6. API

| Route | Notes |
|---|---|
| `POST organizations/:id/support-cases` | `attachment?` on the body |
| `POST academies/:id/support-cases` | same |
| `POST support-cases/mine/:caseId/messages` | `attachment?` on the body |
| `GET support-cases/attachments/:attachmentId` | **authenticated**, `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff` |

Message responses carry `attachments: []` (empty for text-only messages and
for every message filed before P53). Each attachment exposes
`{id, fileName, mimeType, sizeBytes, url, createdAt}`; `storageKey` is never
exposed, so the client addresses an attachment by row id and nothing else.

## 7. Frontend

- `SupportAttachmentField` — one component for both surfaces (new-ticket
  dialog, reply composer): pick, preview, remove, replace. The preview is a
  local object URL, so nothing is uploaded until the message is sent and an
  abandoned dialog leaves no orphaned object. Client-side type/size checks are
  **UX, not security** — they save a pointless base64 round-trip; the server
  remains the only authority.
- `SupportAttachmentImage` + `useSupportAttachmentUrl` — fetches the bytes
  through `apiClient` (so the bearer token is attached and the 401-refresh-retry
  interceptor applies) and hands the DOM an object URL, revoked on unmount.
  A plain `<img src>` would carry no credentials and 401.
- Double submission is guarded by the existing pending state.
- EN + AR strings under `support:attachment.*`.

## 8. Agent side

A Platform Owner sees customer attachments on
`PlatformSupportDetailPage` through the same route and the same component;
`..._platform_select` is what grants it. **Agent-side ATTACHING is
deliberately not implemented** in this change — the specified behaviour covers
the requester's flows, and adding it would need a platform INSERT policy and a
second upload surface. It is a clean extension when wanted.

## 9. Tests

`test/p53-support-attachments.e2e-spec.ts` — 15 cases against real Postgres
with FORCE RLS and real object storage (MinIO), including: text-only unchanged;
create and reply with an image; byte-identical round-trip; unauthenticated 401;
**another tenant 404**; **a colleague in the same organization 404**; Platform
Owner 200; non-image bytes refused; real PDF refused; oversized refused;
malformed data URL refused; unknown id 404 and malformed id 400.

`src/features/support/support-attachments.test.tsx` (frontend) — 10 cases
covering the picker's refusals, remove/replace state, and object-URL
revocation on replace and unmount.
