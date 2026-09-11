-- Phase 10.6 — self-service account deletion.
--
-- WHY THIS IS ANONYMISATION AND NOT A ROW DELETE. The user-deletion
-- relationship graph was mapped from `information_schema` before this was
-- designed. `users` is referenced by 47 distinct foreign keys, and the
-- ones that matter are ON DELETE RESTRICT:
--
--   audit_log_entries.actor_user_id      organizations.owner_user_id
--   blog_posts.author_id                 announcements.author_id
--   forum_threads.author_id              forum_replies.author_id
--   payment_reviews.reviewed_by          provisioning_requests.requested_by_user_id
--   course_order_refunds.requested_by
--
-- Any user who has ever done anything in Atlas has audit entries, so a
-- hard `DELETE FROM users` would be REFUSED by the database for
-- essentially every real account. Those constraints are not an obstacle
-- to work around — they exist because audit, billing and moderation
-- records must survive, which is also what the privacy policy commits to.
--
-- So deletion here means: the person is removed, the record of what
-- happened is not. Identifying fields are irreversibly replaced, the
-- account can never authenticate again, and rows that must persist keep a
-- valid foreign key pointing at an anonymised subject.

-- `deleted` joins the existing account statuses. Distinct from
-- `suspended`, which is reversible and administrator-driven; a deleted
-- account is neither.
ALTER TYPE "user_account_status" ADD VALUE IF NOT EXISTS 'deleted';

-- When the account was deleted. NULL for every live account.
--
-- Kept as a real timestamp rather than inferred from `status` because
-- support and audit questions are almost always "when", and because a
-- future retention job needs something to sort on.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deleted_at" TIMESTAMP(3);

-- Optional, closed-vocabulary reason and free-text feedback, mirroring
-- the subscription-cancellation shape so both "why did you leave"
-- signals are stored the same way. Never required to delete.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_reason" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "deletion_feedback" TEXT;

CREATE INDEX IF NOT EXISTS "users_deleted_at_idx" ON "users"("deleted_at");

-- NOTE ON THE EMAIL COLUMN. `users.email` is UNIQUE, so anonymisation
-- cannot simply blank it — two deleted accounts would collide. The
-- service writes a per-account opaque value instead, which keeps the
-- constraint satisfied, cannot be reversed to the original address, and
-- cannot be signed in with because the status check refuses first.
--
-- The address is NOT retained anywhere as a result of deletion. The
-- separate `trial_redemptions.subject_hash` still records that a trial
-- was consumed, exactly as the privacy policy states — it is a one-way
-- digest and predates the deletion.
