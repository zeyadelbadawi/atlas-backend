-- P53 — image attachments on support-ticket messages.
--
-- WHY A DEDICATED TABLE AND NOT `media_assets`. Four independent reasons,
-- each verified against the existing schema/policies before this was
-- written; any one of them alone would rule `media_assets` out:
--
--   1. `media_assets.academy_id` is NOT NULL, but `support_cases.academy_id`
--      IS nullable by design — an Organization Owner's billing ticket has
--      no single Academy (see that column's own comment). Attaching an
--      image to such a ticket would require inventing an academy_id.
--   2. `media_assets` rows ARE the Academy Media Library
--      (`GET academies/:id/media`), readable by every owner/administrator/
--      manager of that academy. A support ticket is requester-private:
--      `support_cases_requester_select` scopes a case to the ONE person who
--      filed it, deliberately not to their colleagues. Routing ticket
--      screenshots through `media_assets` would publish a private
--      conversation's evidence to the whole academy staff.
--   3. Media is quota-counted against the organization's storage
--      entitlement. Support is explicitly reachable while a subscription is
--      inactive (`@AllowInactiveSubscription` on the tenant support
--      controller, "a customer whose subscription lapsed is exactly the
--      customer most likely to need support"). A customer who is over quota
--      — or lapsed — must still be able to show support what is wrong.
--   4. Media bytes are served by the UNAUTHENTICATED public media route
--      (an unguessable-capability URL, the model academy logos need).
--      Ticket attachments are served instead by an authenticated route
--      whose authorization is these policies.
--
-- What IS reused, deliberately, so this is not a second media system: the
-- same R2 bucket and `MediaStorageProvider`, the same magic-byte
-- `detectFileKind` allowlist, the same `assertWithinSizeLimit` ceiling
-- (`MEDIA_MAX_UPLOAD_BYTES`), the same base64 data-URL transport, and the
-- same "Atlas serves its own bytes over a relative URL" principle.

CREATE TABLE "support_case_message_attachments" (
  "id"          TEXT NOT NULL,
  "message_id"  TEXT NOT NULL,
  "file_name"   TEXT NOT NULL,
  -- `support-cases/{caseId}/{uuid}.{ext}` — generated entirely server-side
  -- from a verified case id plus `randomUUID()`, exactly like
  -- `buildStorageKey`'s academy form. No client string ever reaches a key.
  "storage_key" TEXT NOT NULL,
  "mime_type"   TEXT NOT NULL,
  "size_bytes"  BIGINT NOT NULL,
  "created_at"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "support_case_message_attachments_pkey" PRIMARY KEY ("id")
);

-- Cascade matches `support_case_messages.case_id`'s own cascade from
-- `support_cases`: deleting a ticket takes its thread, and its thread takes
-- its attachments. No orphan rows, and no second lifecycle to reason about.
ALTER TABLE "support_case_message_attachments"
  ADD CONSTRAINT "support_case_message_attachments_message_id_fkey"
  FOREIGN KEY ("message_id") REFERENCES "support_case_messages"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "support_case_message_attachments_message_id_idx"
  ON "support_case_message_attachments" ("message_id");

ALTER TABLE "support_case_message_attachments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "support_case_message_attachments" FORCE ROW LEVEL SECURITY;

-- The policies below are the EXACT predicates `support_case_messages`
-- already uses, resolved one join further out (attachment -> message ->
-- case). They are deliberately not new rules: an attachment must be
-- readable by exactly the people who can already read the message it hangs
-- off, and by nobody else. "Guard decides, RLS independently agrees."

-- A requester reads attachments only on messages inside a case THEY filed.
-- Mirrors `support_case_messages_requester_select`.
CREATE POLICY "support_case_message_attachments_requester_select"
  ON "support_case_message_attachments"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1
      FROM "support_case_messages" scm
      JOIN "support_cases" sc ON sc."id" = scm."case_id"
      WHERE scm."id" = "support_case_message_attachments"."message_id"
        AND sc."requester_user_id"::text = current_setting('app.current_user_id', true)
    )
  );

-- And writes one only onto their OWN message in their OWN case. The
-- `author_role = 'requester'` half is inherited from the message the
-- attachment must already belong to: a tenant connection can only ever
-- have inserted a `requester` message in the first place
-- (`support_case_messages_requester_insert`), so an attachment can never
-- be hung off a fabricated agent reply.
CREATE POLICY "support_case_message_attachments_requester_insert"
  ON "support_case_message_attachments"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM "support_case_messages" scm
      JOIN "support_cases" sc ON sc."id" = scm."case_id"
      WHERE scm."id" = "support_case_message_attachments"."message_id"
        AND sc."requester_user_id"::text = current_setting('app.current_user_id', true)
        AND scm."author_role" = 'requester'::"support_case_message_author_role"
    )
  );

-- Platform Owners read every attachment, the same way they already read
-- every case and message. Mirrors `support_case_messages_platform_select`.
CREATE POLICY "support_case_message_attachments_platform_select"
  ON "support_case_message_attachments"
  FOR SELECT
  USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- No INSERT policy for the platform side, deliberately, and no UPDATE or
-- DELETE policy for anyone: agent-side attaching is not implemented in this
-- change, and an attachment is immutable evidence in a conversation — there
-- is no edit or remove endpoint, so granting either would be a permission
-- no code path exercises. Matches `support_cases_platform_select`'s own
-- documented reasoning for omitting an INSERT policy it did not need.
