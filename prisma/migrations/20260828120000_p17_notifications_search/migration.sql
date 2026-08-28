-- CreateEnum
CREATE TYPE "notification_type" AS ENUM ('system', 'account', 'billing', 'security', 'activity', 'announcement');

-- CreateEnum
CREATE TYPE "notification_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" "notification_type" NOT NULL,
    "priority" "notification_priority" NOT NULL,
    "title_key" TEXT NOT NULL,
    "message_key" TEXT NOT NULL,
    "values" JSONB,
    "is_read" BOOLEAN NOT NULL DEFAULT false,
    "action_url" TEXT,
    "action_label_key" TEXT,
    "metadata" JSONB,
    "dedupe_key" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notifications_user_id_is_read_created_at_idx" ON "notifications"("user_id", "is_read", "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "notifications_user_id_dedupe_key_key" ON "notifications"("user_id", "dedupe_key");

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- =============================================================================
-- Phase P17 — Notifications, Email & Search RLS + Full-Text Search
-- =============================================================================
--
-- Part 1: `notifications` RLS — self-scoped SELECT/UPDATE (the same
-- `app.current_user_id`-keyed "self" pattern `quiz_attempts`/
-- `assignment_submissions` already established in P6), but a DELIBERATELY
-- UNRESTRICTED INSERT (`WITH CHECK (true)`) — see schema.prisma's own
-- header comment on this table for the full "the writer always acts on
-- behalf of another user as a trusted server-side side effect" reasoning,
-- mirroring `audit_log_entries`' identical P15 precedent exactly.
-- =============================================================================

ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" FORCE ROW LEVEL SECURITY;

CREATE POLICY "notifications_self_select" ON "notifications"
  FOR SELECT
  USING ("user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "notifications_self_update" ON "notifications"
  FOR UPDATE
  USING ("user_id"::text = current_setting('app.current_user_id', true))
  WITH CHECK ("user_id"::text = current_setting('app.current_user_id', true));

CREATE POLICY "notifications_system_insert" ON "notifications"
  FOR INSERT
  WITH CHECK (true);

-- =============================================================================
-- Part 2: PostgreSQL full-text search (master plan §15) — `GENERATED
-- ALWAYS ... STORED` `tsvector` columns + GIN indexes, maintained
-- automatically by Postgres on every write, no separate index-sync job
-- (master plan §12's own "Search index refresh: N/A at V1 — Postgres FTS
-- needs no separate index job"). Deliberately NOT represented as a Prisma
-- schema field — this codebase's own established precedent
-- (`User`'s own doc comment on why `citext` is application-layer, not
-- `Unsupported(...)`) is that a column only the Prisma Client's typed API
-- needs isn't added to schema.prisma; every one of these columns is
-- queried exclusively via raw SQL (`SearchRepository`), so the same
-- reasoning applies here. Four sources cover three of the four frontend
-- `SearchResultCategory` values: `users` (category `users`),
-- `organizations`/`academies` (category `platform`), `courses` (category
-- `content`) — `announcements`/`blog_posts` are a deliberately deferred
-- follow-up for the `content` category (see `Reports/ARCHITECTURE.md`'s
-- P17 section); the fourth category, `system`, is a small fixed in-memory
-- list with no database source at all, per master plan §15's own
-- description ("a small fixed set of navigable system pages").
-- =============================================================================

ALTER TABLE "users" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("name", '') || ' ' || coalesce("email", ''))) STORED;
CREATE INDEX "users_search_vector_idx" ON "users" USING GIN ("search_vector");

ALTER TABLE "organizations" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("name", ''))) STORED;
CREATE INDEX "organizations_search_vector_idx" ON "organizations" USING GIN ("search_vector");

ALTER TABLE "academies" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("name", ''))) STORED;
CREATE INDEX "academies_search_vector_idx" ON "academies" USING GIN ("search_vector");

ALTER TABLE "courses" ADD COLUMN "search_vector" tsvector
  GENERATED ALWAYS AS (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("description", ''))) STORED;
CREATE INDEX "courses_search_vector_idx" ON "courses" USING GIN ("search_vector");
