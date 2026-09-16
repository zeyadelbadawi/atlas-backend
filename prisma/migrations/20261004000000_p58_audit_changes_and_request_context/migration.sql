-- P58 — structured before/after and request context on the audit log.
--
-- WHAT WAS MISSING. `audit_log_entries.context` is a small FLAT bag of
-- scalars (its own doc comment says so), and sampling real rows confirms
-- what that produces in practice: `{"status":"resolved"}`,
-- `{"platformDescription":"..."}`, `{"courseId":..,"sectionId":..}` — the
-- NEW value only, with no record of what it replaced, and only on ~55% of
-- rows. "What changed, from what, to what" was therefore not answerable
-- from the audit log at all.
--
-- TWO NEW COLUMNS RATHER THAN WIDENING `context`. `context` keeps its
-- existing flat-scalar contract (every current call site depends on it);
-- `changes` is a separate, explicitly-shaped `{field: {from, to}}` object
-- that the writer REDACTS before persisting, and `request_context` holds
-- the non-identifying request metadata an operational audit needs.
-- Splitting them is what makes redaction enforceable: the writer can scrub
-- one known shape instead of trying to inspect an arbitrary bag.
--
-- BOTH NULLABLE, NO BACKFILL. A historical row genuinely has no recorded
-- diff, and inventing one would be fabricated history. Rows written before
-- this migration stay `NULL` and the UI reports them honestly as having no
-- recorded detail.
ALTER TABLE "audit_log_entries"
  ADD COLUMN IF NOT EXISTS "changes" JSONB,
  ADD COLUMN IF NOT EXISTS "request_context" JSONB;

-- Filtering the audit log by action/target type is the single most common
-- operational query ("show me every plan pricing change"), and neither was
-- indexed: the existing indexes cover `occurred_at`, `organization_id`,
-- `academy_id` and `(target_type, target_id)`. This adds the action axis,
-- ordered by recency so the common "latest N of this action" scan is a
-- straight index read.
CREATE INDEX IF NOT EXISTS "audit_log_entries_action_occurred_at_idx"
  ON "audit_log_entries" ("action", "occurred_at" DESC);

-- The actor axis, for "everything this operator did".
CREATE INDEX IF NOT EXISTS "audit_log_entries_actor_user_id_occurred_at_idx"
  ON "audit_log_entries" ("actor_user_id", "occurred_at" DESC);
