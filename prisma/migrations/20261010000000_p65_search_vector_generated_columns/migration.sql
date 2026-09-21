-- ============================================================================
-- P65 — Restore full-text search: `search_vector` generated columns + GIN
-- indexes on `users`, `organizations`, `academies`, `courses`.
--
-- WHAT WAS WRONG
--
-- P17 (`20260828120000`) created these four columns and indexes by raw SQL
-- and deliberately left them OUT of `schema.prisma` ("a column only raw
-- SQL reads is not modelled"). Every `prisma migrate dev` diff since then
-- has therefore proposed dropping them — p19's header even warns about it —
-- and p44 (`20260922000000`, Live Sessions) committed that generated DDL
-- unreviewed: it DROPped all four columns and indexes while
-- `src/search/repositories/search.repository.ts` kept querying them. Any
-- database built from the migration chain answers `GET /search` with
-- `42703 column "search_vector" does not exist` — production included, from
-- 13 Sep 2026 until this migration is applied. Nothing between p44 and here
-- touched the columns, so there is no data to reconcile: they are simply
-- absent.
--
-- THE FIX, AND WHY IT CANNOT RECUR
--
-- The columns come back as STORED GENERATED tsvectors, and this time they
-- ARE modelled in `schema.prisma` (`searchVector Unsupported("tsvector")?`
-- plus `@@index([searchVector], type: Gin)` on each of the four models).
-- Prisma cannot read them through the typed client, which is fine — nothing
-- ever did — but it now knows the column and the index exist, so a schema
-- diff is clean and can never again propose the drop that p44 shipped.
-- This is the same fix applied at the root rather than at the symptom.
--
-- WHY STORED GENERATED COLUMNS (not triggers, not query-time to_tsvector)
--
--   * PostgreSQL maintains them on every INSERT/UPDATE of the SOURCE
--     columns only; a write that touches other columns recomputes nothing
--     and — because the indexed value is unchanged — can still be a HOT
--     update that writes no GIN entry. Write amplification is confined to
--     the fields a search actually indexes.
--   * No trigger, no PL/pgSQL function, no application-side sync job:
--     nothing can drift out of step with the row, and nothing exists
--     outside the schema for a future diff to misunderstand.
--   * A query-time `to_tsvector(...)` would be unindexable and O(table)
--     per search — unacceptable for the millions of users and courses
--     Atlas is sized for.
--
-- WEIGHTS. Each vector is built with `setweight` so `ts_rank` prefers a hit
-- in the entity's name/title (A) over its slug/short description (B) over
-- its long description (C). The `english` configuration is kept from P17:
-- it stems English and passes Arabic tokens through untouched, and the
-- query side (`websearch_to_tsquery('english', ...)`) uses the same
-- configuration, which is what makes the two sides match. Every function
-- used here is IMMUTABLE with an explicit regconfig, which PostgreSQL
-- requires for a generated column.
--
-- MIGRATION SAFETY
--
--   * Sized against the real production tables on 21 Sep 2026: 38 users,
--     22 organizations, 20 academies, 10 courses (largest relation 7 MB).
--     `ADD COLUMN ... GENERATED ... STORED` rewrites the table under an
--     ACCESS EXCLUSIVE lock; at this size that is milliseconds. The GIN
--     builds are equally trivial and happen in the same implicit
--     transaction, so either all four tables gain their column AND index
--     or none does — the repository queries all four, and a half-applied
--     state would trade one 42703 for another.
--   * `lock_timeout` is set so this migration FAILS FAST instead of
--     queueing behind a long-running transaction while every later read of
--     `users` (sign-in!) queues behind it. If it does time out, the whole
--     implicit transaction rolls back and nothing is half-applied; mark it
--     rolled back (`prisma migrate resolve --rolled-back
--     20261010000000_p65_search_vector_generated_columns`) and re-run
--     `migrate deploy`. Every statement is idempotent for that reason.
--   * AT SCALE (tens of millions of rows) the same end state must be
--     reached differently — add a plain nullable `tsvector`, maintain it by
--     trigger, backfill in batches, then `CREATE INDEX CONCURRENTLY` in
--     single-statement migrations (this repo's p25 precedent), and only
--     then swap the query. That path is documented here so it is chosen
--     deliberately when the row counts justify it, not improvised.
--   * `ANALYZE` at the end gives the planner statistics for the new
--     columns immediately instead of after the next autovacuum.
--
-- RLS, AND WHY THE RLS-BEARING TABLES ARE SEARCHED THROUGH DEFINER FUNCTIONS
--
-- No policy changes. A generated column is subject to the table's existing
-- policies exactly like every other column.
--
-- But restoring the columns alone would have restored a LATENT scale defect
-- P17 always had. PostgreSQL will only use an index for a user predicate
-- that is evaluated BEFORE the row-security predicates if that predicate's
-- operator is LEAKPROOF, and `tsvector @@ tsquery` (`ts_match_vq`) is not.
-- So on a FORCE-RLS table the `@@` test is pushed below the policies and
-- becomes a plain per-row Filter: the GIN index is never consulted. Measured
-- on a 300,000-course synthetic estate under `atlas_app` (21 Sep 2026): the
-- Platform Owner's cross-tenant course search was a Seq Scan removing
-- 297,731 rows in 1.3 s, with `is_platform_owner()` called once per row,
-- while the very same predicate on `users` (no RLS) was a 5 ms GIN bitmap
-- scan. Tenant-scoped search survived only because `academy_id = ...` IS
-- leakproof and bounded the scan to one organization's courses.
--
-- The fix follows the pattern this schema already relies on for every RLS
-- policy (`is_platform_owner`, `is_academy_member`, `can_access_lesson`):
-- a SECURITY DEFINER function does the part RLS cannot do efficiently and
-- nothing more. `search_*_candidates(...)` re-verifies the caller from the
-- database (Platform Owner flag; or organization membership for a
-- tenant-scoped search), applies the scope EXPLICITLY, runs the GIN-indexed
-- match without per-row policy evaluation, and returns only `(id, rank)`
-- for at most 50 rows. It returns nothing — silently, like RLS itself —
-- for a caller who is not entitled to that scope. `SearchRepository` then
-- SELECTs the visible columns FROM the real table BY THOSE IDS, inside the
-- caller's own tenant/user context, so every row that leaves the database
-- has ALSO passed the table's RLS policies: the guard decides, RLS
-- independently agrees, and the index is finally used. `users` carries no
-- RLS, so it keeps a direct query.
--
-- The functions are STABLE (reads only), pin `search_path`, are revoked
-- from PUBLIC and granted to `atlas_app` only, and cap the limit at 50
-- regardless of what the caller asks for.
-- ============================================================================

SET LOCAL lock_timeout = '10s';

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("email", '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS "users_search_vector_idx"
  ON "users" USING GIN ("search_vector");

ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("slug", '')), 'B')
  ) STORED;
CREATE INDEX IF NOT EXISTS "organizations_search_vector_idx"
  ON "organizations" USING GIN ("search_vector");

ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("name", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("slug", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS "academies_search_vector_idx"
  ON "academies" USING GIN ("search_vector");

ALTER TABLE "courses" ADD COLUMN IF NOT EXISTS "search_vector" tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
    setweight(to_tsvector('english', coalesce("short_description", '')), 'B') ||
    setweight(to_tsvector('english', coalesce("description", '')), 'C')
  ) STORED;
CREATE INDEX IF NOT EXISTS "courses_search_vector_idx"
  ON "courses" USING GIN ("search_vector");

ANALYZE "users";
ANALYZE "organizations";
ANALYZE "academies";
ANALYZE "courses";

-- ---------------------------------------------------------------------------
-- Candidate generators (see the header for why these exist)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION search_organizations_candidates(
  p_caller_user_id text,
  p_query text,
  p_limit integer
)
RETURNS TABLE("id" text, "rank" real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT o."id", ts_rank(o."search_vector", q.tsq)
  FROM "organizations" o,
       (SELECT websearch_to_tsquery('english', coalesce(p_query, '')) AS tsq) q
  WHERE is_platform_owner(p_caller_user_id)
    AND o."search_vector" @@ q.tsq
  ORDER BY 2 DESC, o."created_at" DESC, o."id"
  LIMIT GREATEST(LEAST(coalesce(p_limit, 0), 50), 0);
$$;
REVOKE ALL ON FUNCTION search_organizations_candidates(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_organizations_candidates(text, text, integer) TO "atlas_app";

CREATE OR REPLACE FUNCTION search_academies_candidates(
  p_caller_user_id text,
  p_query text,
  p_limit integer
)
RETURNS TABLE("id" text, "rank" real)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT a."id", ts_rank(a."search_vector", q.tsq)
  FROM "academies" a,
       (SELECT websearch_to_tsquery('english', coalesce(p_query, '')) AS tsq) q
  WHERE is_platform_owner(p_caller_user_id)
    AND a."search_vector" @@ q.tsq
  ORDER BY 2 DESC, a."created_at" DESC, a."id"
  LIMIT GREATEST(LEAST(coalesce(p_limit, 0), 50), 0);
$$;
REVOKE ALL ON FUNCTION search_academies_candidates(text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_academies_candidates(text, text, integer) TO "atlas_app";

-- Published courses only. `p_organization_id` NULL = the Platform Owner's
-- cross-tenant search; otherwise the caller must hold a membership in that
-- organization (or be the Platform Owner). Two separate statements rather
-- than one `(p_organization_id IS NULL OR ...)` predicate so each scope
-- gets its own plan: the tenant branch is driven from
-- `academies_organization_id_status_idx` → `courses(academy_id)` and stays
-- proportional to that organization's courses; the platform branch is a
-- GIN bitmap scan over every published course.
CREATE OR REPLACE FUNCTION search_courses_candidates(
  p_caller_user_id text,
  p_organization_id text,
  p_query text,
  p_limit integer
)
RETURNS TABLE("id" text, "rank" real)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit integer := GREATEST(LEAST(coalesce(p_limit, 0), 50), 0);
  v_tsq tsquery := websearch_to_tsquery('english', coalesce(p_query, ''));
BEGIN
  IF p_caller_user_id IS NULL OR p_caller_user_id = '' OR v_limit = 0 THEN
    RETURN;
  END IF;

  IF p_organization_id IS NULL THEN
    IF NOT is_platform_owner(p_caller_user_id) THEN
      RETURN;
    END IF;
    RETURN QUERY
      SELECT c."id", ts_rank(c."search_vector", v_tsq)
      FROM "courses" c
      WHERE c."status" = 'published'
        AND c."search_vector" @@ v_tsq
      ORDER BY 2 DESC, c."created_at" DESC, c."id"
      LIMIT v_limit;
    RETURN;
  END IF;

  IF NOT (
    is_platform_owner(p_caller_user_id)
    OR EXISTS (
      SELECT 1 FROM "organization_memberships" om
      WHERE om."organization_id" = p_organization_id
        AND om."user_id" = p_caller_user_id
    )
  ) THEN
    RETURN;
  END IF;

  RETURN QUERY
    SELECT c."id", ts_rank(c."search_vector", v_tsq)
    FROM "courses" c
    WHERE c."status" = 'published'
      AND c."academy_id" IN (
        SELECT a."id" FROM "academies" a WHERE a."organization_id" = p_organization_id
      )
      AND c."search_vector" @@ v_tsq
    ORDER BY 2 DESC, c."created_at" DESC, c."id"
    LIMIT v_limit;
END;
$$;
REVOKE ALL ON FUNCTION search_courses_candidates(text, text, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION search_courses_candidates(text, text, text, integer) TO "atlas_app";
