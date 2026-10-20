-- ============================================================================
-- Academy address change: the website moves, the old address redirects.
--
-- THE DEFECT. Saving a new Academy Slug changed only `academies.slug`. The
-- public website, email links and invite links all follow the academy's
-- `subdomain_allocations` row, which kept the OLD label, so the new address
-- opened nothing and the old one kept serving. The old label was also free
-- again in `academies.slug` while still held by the allocation, so another
-- academy could pass the availability check and then fail on the unique
-- index.
--
-- Owner decision (20 Oct 2026, "move + old address redirects"): saving a new
-- slug moves the allocation (label + full host) in the same transaction, and
-- the OLD label stays reserved for this academy for good, answering with a
-- 301 to the same path on the academy's canonical host. Nobody else can take
-- an old label. Changing back to one of its own old labels makes it the
-- primary again.
--
-- 1. `subdomain_aliases` — an academy's previous labels. Academy-scoped
--    exactly like `subdomain_allocations` (P11/P21/P21d): FORCE RLS,
--    SELECT/INSERT/UPDATE for a member of the academy inside its
--    organization, SELECT for the Platform Owner, no DELETE policy (an alias
--    is never removed: reclaiming one renames its row to the label being
--    given up). Lowercase CHECK as P63g gave the sibling tables, and the
--    DL-57 reserved-label trigger, so a reserved word can never become an
--    alias either.
--
-- 2. One label namespace across `academies.slug`, `subdomain_allocations.
--    subdomain` and `subdomain_aliases.subdomain`. Each table keeps its own
--    unique index; a BEFORE trigger on all three refuses a NEW label that a
--    DIFFERENT academy holds in any of them, raised as `unique_violation`
--    (constraint `atlas_subdomain_label_taken`) so the API reports it like
--    any other slug collision. Overlap within one academy is allowed (the
--    resolver prefers the allocation), which is what lets a change-back
--    rename rows in any order. The trigger takes a transaction advisory
--    lock on the label first, so two concurrent writers of the same label
--    are serialised and the second sees the first's committed row.
--    SECURITY DEFINER because the question crosses tenants (RLS hides other
--    organizations' rows); it answers nothing but "refused".
--
-- 3. `subdomain_is_taken` (P14, the provisioning/availability check) also
--    counts aliases. New `subdomain_held_by_other(label, academy_id)`, the
--    same boolean-only definer category, for the slug-change and create
--    checks: true when an academy other than the given one holds the label
--    anywhere.
--
-- 4. `resolve_public_hostname` also matches an alias (lowest priority, after
--    a connected custom domain and the live allocation) and reports it in a
--    new `matched_alias` column; the API turns that into a redirect to the
--    canonical host it computes itself (never a host taken from the
--    request). A return-type change requires DROP + CREATE (P63g
--    precedent); the function keeps SECURITY DEFINER, STABLE,
--    `search_path = public, pg_temp` and the default EXECUTE grant it has
--    today (no explicit grant was ever issued on it). Matching rules for
--    custom domains and allocations, the archived/suspended exclusion and
--    the priority between those two are unchanged.
--
-- 5. Backfill for academies the defect already hit (allocation label !=
--    slug): the allocation moves to the slug the owner saved and the old
--    label becomes an alias, exactly what the fixed save does. Skipped (left
--    as it is, for an operator to look at) when the slug is held by another
--    academy's allocation or is a reserved label. Re-runnable.
--
-- 6. `academies.slug_changed_at` — when the slug last changed (NULL until
--    the first change; creation does not count). Owner decision: a slug may
--    change at most once every 60 days, reclaiming an old address included;
--    the API refuses an earlier change and names the date it becomes
--    possible. A column rather than alias timestamps: a move away from a
--    reserved label keeps no alias, and an Academy without an allocation
--    keeps none either, so alias rows cannot date every change. Backfilled
--    academies (5.) keep NULL: when their change happened is not recorded.
--
-- Additive: one table, one column, three triggers, one new function, two
-- function bodies. Rollback: drop the triggers, `atlas_refuse_subdomain_label_held_
-- elsewhere`, `subdomain_held_by_other`, the table and
-- `academies.slug_changed_at`; restore
-- `subdomain_is_taken` from 20260827112450_p14_provisioning_orchestration and
-- `resolve_public_hostname` from 20261007040000_p63g_domain_hardening (then
-- re-apply `search_path = public, pg_temp` as 20261118000300 did).
-- ============================================================================

-- 6. When the slug last changed (the 60-day rule).
ALTER TABLE "academies" ADD COLUMN IF NOT EXISTS "slug_changed_at" TIMESTAMP(3);

-- 1. The alias table.
CREATE TABLE IF NOT EXISTS "subdomain_aliases" (
  "id" TEXT NOT NULL,
  "academy_id" TEXT NOT NULL,
  "subdomain" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "subdomain_aliases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subdomain_aliases_academy_id_fkey"
    FOREIGN KEY ("academy_id") REFERENCES "academies"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "subdomain_aliases_subdomain_lowercase"
    CHECK ("subdomain" = lower("subdomain"))
);
CREATE UNIQUE INDEX IF NOT EXISTS "subdomain_aliases_subdomain_key"
  ON "subdomain_aliases" ("subdomain");
CREATE INDEX IF NOT EXISTS "subdomain_aliases_academy_id_idx"
  ON "subdomain_aliases" ("academy_id");

ALTER TABLE "subdomain_aliases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "subdomain_aliases" FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subdomain_aliases_tenant_select" ON "subdomain_aliases";
CREATE POLICY "subdomain_aliases_tenant_select" ON "subdomain_aliases"
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_aliases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "subdomain_aliases_tenant_insert" ON "subdomain_aliases";
CREATE POLICY "subdomain_aliases_tenant_insert" ON "subdomain_aliases"
  FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_aliases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "subdomain_aliases_tenant_update" ON "subdomain_aliases";
CREATE POLICY "subdomain_aliases_tenant_update" ON "subdomain_aliases"
  FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_aliases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM "academies" a
      WHERE a."id" = "subdomain_aliases"."academy_id"
        AND a."organization_id"::text = current_setting('app.current_organization_id', true)
        AND is_academy_member(a."id", current_setting('app.current_user_id', true))
    )
  );

DROP POLICY IF EXISTS "subdomain_aliases_platform_select" ON "subdomain_aliases";
CREATE POLICY "subdomain_aliases_platform_select" ON "subdomain_aliases"
  FOR SELECT USING (is_platform_owner(current_setting('app.current_user_id', true)));

-- DL-57 — a reserved label can never become an alias.
DROP TRIGGER IF EXISTS subdomain_aliases_reserved_label ON subdomain_aliases;
CREATE TRIGGER subdomain_aliases_reserved_label
  BEFORE INSERT OR UPDATE OF subdomain ON subdomain_aliases
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_reserved_subdomain('subdomain');

-- 5. Backfill (before the namespace triggers exist, with their conditions
--    spelled out, so a surprise row is skipped rather than failing the
--    deploy). Old labels first, while the allocation still names them.
INSERT INTO "subdomain_aliases" ("id", "academy_id", "subdomain", "created_at", "updated_at")
SELECT gen_random_uuid()::text, sa."academy_id", sa."subdomain", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "subdomain_allocations" sa
JOIN "academies" a ON a."id" = sa."academy_id"
WHERE sa."subdomain" <> a."slug"
  AND NOT atlas_is_reserved_subdomain(a."slug")
  AND NOT atlas_is_reserved_subdomain(sa."subdomain")
  AND NOT EXISTS (
    SELECT 1 FROM "subdomain_allocations" other
    WHERE other."subdomain" = a."slug" AND other."academy_id" <> a."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "subdomain_aliases" al WHERE al."subdomain" IN (sa."subdomain", a."slug")
  )
  AND NOT EXISTS (
    SELECT 1 FROM "academies" other
    WHERE other."slug" = sa."subdomain" AND other."id" <> a."id"
  );

UPDATE "subdomain_allocations" sa
SET "subdomain" = a."slug",
    "full_host" = CASE
      WHEN sa."full_host" IS NOT NULL
       AND left(sa."full_host", length(sa."subdomain") + 1) = sa."subdomain" || '.'
        THEN a."slug" || substr(sa."full_host", length(sa."subdomain") + 1)
      ELSE NULL
    END,
    "updated_at" = CURRENT_TIMESTAMP
FROM "academies" a
WHERE a."id" = sa."academy_id"
  AND sa."subdomain" <> a."slug"
  AND NOT atlas_is_reserved_subdomain(a."slug")
  AND NOT EXISTS (
    SELECT 1 FROM "subdomain_allocations" other
    WHERE other."subdomain" = a."slug" AND other."academy_id" <> a."id"
  )
  AND NOT EXISTS (
    SELECT 1 FROM "subdomain_aliases" al
    WHERE al."subdomain" = a."slug" AND al."academy_id" <> a."id"
  );

-- 2. One label namespace across the three tables.
CREATE OR REPLACE FUNCTION atlas_refuse_subdomain_label_held_elsewhere()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  new_label text := to_jsonb(NEW) ->> TG_ARGV[0];
  holder text := to_jsonb(NEW) ->> TG_ARGV[1];
BEGIN
  IF new_label IS NULL THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND new_label IS NOT DISTINCT FROM (to_jsonb(OLD) ->> TG_ARGV[0]) THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('atlas:subdomain-label:' || new_label, 0));
  IF EXISTS (SELECT 1 FROM "academies" WHERE "slug" = new_label AND "id" <> holder)
     OR EXISTS (SELECT 1 FROM "subdomain_allocations"
                WHERE "subdomain" = new_label AND "academy_id" <> holder)
     OR EXISTS (SELECT 1 FROM "subdomain_aliases"
                WHERE "subdomain" = new_label AND "academy_id" <> holder) THEN
    RAISE EXCEPTION 'subdomain label "%" is held by another academy', new_label
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'atlas_subdomain_label_taken';
  END IF;
  RETURN NEW;
END
$fn$;
REVOKE ALL ON FUNCTION atlas_refuse_subdomain_label_held_elsewhere() FROM PUBLIC;

DROP TRIGGER IF EXISTS academies_subdomain_label_unique ON academies;
CREATE TRIGGER academies_subdomain_label_unique
  BEFORE INSERT OR UPDATE OF slug ON academies
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_subdomain_label_held_elsewhere('slug', 'id');

DROP TRIGGER IF EXISTS subdomain_allocations_label_unique ON subdomain_allocations;
CREATE TRIGGER subdomain_allocations_label_unique
  BEFORE INSERT OR UPDATE OF subdomain ON subdomain_allocations
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_subdomain_label_held_elsewhere('subdomain', 'academy_id');

DROP TRIGGER IF EXISTS subdomain_aliases_label_unique ON subdomain_aliases;
CREATE TRIGGER subdomain_aliases_label_unique
  BEFORE INSERT OR UPDATE OF subdomain ON subdomain_aliases
  FOR EACH ROW EXECUTE FUNCTION atlas_refuse_subdomain_label_held_elsewhere('subdomain', 'academy_id');

-- 3. Availability checks count aliases.
CREATE OR REPLACE FUNCTION subdomain_is_taken(p_subdomain text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS(SELECT 1 FROM "subdomain_allocations" WHERE "subdomain" = p_subdomain)
      OR EXISTS(SELECT 1 FROM "subdomain_aliases" WHERE "subdomain" = p_subdomain);
$$;

CREATE OR REPLACE FUNCTION subdomain_held_by_other(p_subdomain text, p_academy_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS(SELECT 1 FROM "academies"
                 WHERE "slug" = p_subdomain AND "id" IS DISTINCT FROM p_academy_id)
      OR EXISTS(SELECT 1 FROM "subdomain_allocations"
                 WHERE "subdomain" = p_subdomain AND "academy_id" IS DISTINCT FROM p_academy_id)
      OR EXISTS(SELECT 1 FROM "subdomain_aliases"
                 WHERE "subdomain" = p_subdomain AND "academy_id" IS DISTINCT FROM p_academy_id);
$$;

-- 4. The public resolver also answers for an old label.
DROP FUNCTION IF EXISTS resolve_public_hostname(text, text);
CREATE FUNCTION resolve_public_hostname(p_hostname text, p_subdomain_label text)
RETURNS TABLE(
  academy_id text,
  organization_id text,
  academy_name text,
  academy_slug text,
  academy_logo_url text,
  custom_hostname text,
  subdomain text,
  subdomain_full_host text,
  matched_alias boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT
    a."id",
    a."organization_id",
    a."name",
    a."slug",
    a."logo_url",
    (SELECT dc2."hostname" FROM "domain_connections" dc2
       WHERE dc2."academy_id" = a."id"
         AND dc2."status" = 'connected'
         AND dc2."https_reachable" IS DISTINCT FROM false) AS custom_hostname,
    (SELECT sa2."subdomain" FROM "subdomain_allocations" sa2
       WHERE sa2."academy_id" = a."id" AND sa2."status" = 'assigned') AS subdomain,
    (SELECT sa3."full_host" FROM "subdomain_allocations" sa3
       WHERE sa3."academy_id" = a."id" AND sa3."status" = 'assigned') AS subdomain_full_host,
    matched.priority = 3 AS matched_alias
  FROM (
    SELECT dc."academy_id" AS academy_id, 1 AS priority
    FROM "domain_connections" dc
    WHERE dc."hostname" = p_hostname AND dc."status" = 'connected'
    UNION ALL
    SELECT sa."academy_id" AS academy_id, 2 AS priority
    FROM "subdomain_allocations" sa
    WHERE p_subdomain_label IS NOT NULL
      AND sa."subdomain" = p_subdomain_label
      AND sa."status" = 'assigned'
    UNION ALL
    SELECT al."academy_id" AS academy_id, 3 AS priority
    FROM "subdomain_aliases" al
    WHERE p_subdomain_label IS NOT NULL
      AND al."subdomain" = p_subdomain_label
  ) matched
  JOIN "academies" a ON a."id" = matched.academy_id
  WHERE a."status" NOT IN ('archived', 'suspended')
  ORDER BY matched.priority
  LIMIT 1;
$$;
