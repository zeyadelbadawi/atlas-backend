-- Who saved a page last, so a save conflict can name them.
--
-- WHY THIS EXISTS. A version check alone can tell an admin that their copy
-- is stale; it cannot tell them WHO moved it on. "This page was changed
-- while you were editing" sends someone hunting through an audit log to
-- find out whether they can safely reload. "Changed by Ahmed" lets them
-- turn round and ask him. The difference is entirely in whether this
-- column exists.
--
-- WHY NOT READ IT FROM PRESENCE. The editing-presence records in Redis
-- answer a different question — who is editing RIGHT NOW — and the person
-- who saved the conflicting version may well have closed the tab already.
-- Presence is deliberately ephemeral; attribution of a save is a fact about
-- the row and belongs on the row.
--
-- WHY NOT THE AUDIT LOG. `audit_log_entries` is platform-owner readable by
-- design; a tenant admin resolving their own edit conflict must not need a
-- platform-scoped read to find out who they are conflicting with.
--
-- NULLABLE, AND `ON DELETE SET NULL`. Every row that exists today predates
-- the column and has no honest value to put in it — a backfill would be
-- inventing attribution. `NULL` means "not recorded", which the UI renders
-- as the neutral "changed while you were editing" wording rather than
-- naming anyone. And deleting a user must never cascade into deleting
-- their Academy's pages, so the reference is cleared rather than followed.
ALTER TABLE "website_pages"
  ADD COLUMN "updated_by_id" TEXT;

ALTER TABLE "website_pages"
  ADD CONSTRAINT "website_pages_updated_by_id_fkey"
  FOREIGN KEY ("updated_by_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
