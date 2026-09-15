# Unified Ordered Curriculum inside Units (P52)

## What it is
A course **Unit** (`course_sections`) composes its existing content —
lessons, quizzes, assignments and (future) live sessions — into **one
ordered sequence**. Authors add existing quizzes/assignments to a unit,
place all types in one list, reorder freely, and students receive that exact
published order as a single list.

## Architecture decision (no polymorphic table)
Each content type keeps its own entity/table and identity. The single
sequence is a **shared per-unit ordinal**: `course_lessons.order`,
`quizzes.order`, `assignments.order`, `live_sessions.order` all live in ONE
integer space per section. A reorder rewrites that ordinal contiguously
across whatever types the caller lists. No generic "activity" table was
introduced; lessons stay lessons, quizzes stay quizzes, etc.

- Migration `20260930000000_p52_unit_curriculum_order`: adds `order` to
  `quizzes`/`assignments` (lessons/live-sessions already had it), a
  `SET NULL` FK from those tables to `course_sections` (deleting a unit
  detaches — never deletes — a quiz/assignment), and a deterministic,
  lossless backfill of the shared ordinal for content already in a unit.

## API (authoring, academy-scoped, `JwtAuthGuard + AcademyScopeGuard`)
- `GET  academies/:id/courses/:courseId/available-content` — course-level
  quizzes/assignments and where each currently sits.
- `GET  .../sections/:sectionId/items` — the unit's unified ordered list.
- `POST .../sections/:sectionId/items/attach` `{type,itemId}` — attach an
  existing quiz/assignment (appends to the unit).
- `POST .../sections/:sectionId/items/detach` `{type,itemId}` — detach (back
  to course-level).
- `PATCH .../sections/:sectionId/items/order` `{orderedIds}` — rewrite the
  shared ordinal from the full, explicit ordering (UUIDs disambiguate type).

Writes run in `runInTenantAndUserContext(organizationId, userId)` so the
tenant (section/lesson) RLS policies AND the per-user author
(quiz/assignment) RLS policies are BOTH satisfied — neither is weakened. The
ownership chain (item → section → course → academy) is verified in code.

## Student read
`GET courses/:id/sections` now returns, per section, an `items` array: the
unified, ORDERED, PUBLISHED lessons+quizzes+assignments (draft excluded).
Live sessions are intentionally excluded (the feature is deferred/Coming
Soon). `lessons` is retained for backward compatibility. The frontend
`CurriculumNav` renders `items` as one mixed list.

## Live Sessions
Deferred/Coming Soon is unchanged: no publish/enable/install path is touched,
no Zoom code changed. Live sessions are read into the author sequence only if
one already exists, and never surfaced to students.
