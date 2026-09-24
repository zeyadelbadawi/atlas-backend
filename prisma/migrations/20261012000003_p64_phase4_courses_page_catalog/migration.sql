-- P64 Phase 4 §E.1 — the Courses page IS the catalog.
--
-- Every academy's `courses` core page was seeded with a single
-- `featuredCourses` section in "latest" mode (template
-- `shared-support-pages.template.ts`), or — for a site generated in
-- minimal mode — with no section at all. On the one page the plan requires
-- search, filters, sort, rating, duration and a preview badge, that gave a
-- single oversized card, or an empty page. The Phase 4 `courseCatalog`
-- section shipped as an opt-in builder block, so no existing site ever
-- received it.
--
-- This upgrades ONLY pages that still carry the untouched seed (exactly one
-- `featuredCourses` section in `latest` mode) or nothing. A page an owner
-- has customised (any other section type, a `selected` mode, more than one
-- block) is left exactly as it is — their authoring wins. A seeded section
-- keeps its id, title and description, so the builder shows the same block
-- in the same place, now of the catalog type, with the catalog's defaults.
-- Data only; no schema change. Idempotent: an upgraded page no longer
-- matches either predicate.

-- 1. The untouched seed: keep id / title / description, change the type.
UPDATE "website_pages"
SET "sections" = jsonb_build_array(
  jsonb_build_object(
    'id',         "sections"->0->>'id',
    'type',       'courseCatalog',
    'config',     jsonb_strip_nulls(jsonb_build_object(
                    'title',             "sections"->0->'config'->'title',
                    'description',       "sections"->0->'config'->'description',
                    'pageSize',          12,
                    'defaultSort',       'newest',
                    'showSearch',        true,
                    'showLevelFilter',   true,
                    'showPricingFilter', true,
                    'showSort',          true
                  )),
    'enabled',    COALESCE(("sections"->0->>'enabled')::boolean, true),
    'visibility', COALESCE("sections"->0->'visibility',
                    '{"desktop": true, "tablet": true, "mobile": true}'::jsonb)
  )
)
WHERE "core_type" = 'courses'
  AND jsonb_typeof("sections") = 'array'
  AND jsonb_array_length("sections") = 1
  AND "sections"->0->>'type' = 'featuredCourses'
  AND "sections"->0->'config'->>'mode' = 'latest';

-- 2. An empty Courses page (minimal-mode generation): give it the catalog.
UPDATE "website_pages"
SET "sections" = jsonb_build_array(
  jsonb_build_object(
    'id',         gen_random_uuid()::text,
    'type',       'courseCatalog',
    'config',     jsonb_build_object(
                    'title',             '{"en": "Our Courses", "ar": "دوراتنا"}'::jsonb,
                    'description',       '{"en": "Explore our full range of courses and find the right one for you.", "ar": "استكشف مجموعتنا الكاملة من الدورات واختر الأنسب لك."}'::jsonb,
                    'pageSize',          12,
                    'defaultSort',       'newest',
                    'showSearch',        true,
                    'showLevelFilter',   true,
                    'showPricingFilter', true,
                    'showSort',          true
                  ),
    'enabled',    true,
    'visibility', '{"desktop": true, "tablet": true, "mobile": true}'::jsonb
  )
)
WHERE "core_type" = 'courses'
  AND jsonb_typeof("sections") = 'array'
  AND jsonb_array_length("sections") = 0;
