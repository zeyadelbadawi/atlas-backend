# Plan catalog localization (P54)

**Status: IMPLEMENTED, TESTED, VERIFIED IN REAL CHROME (Arabic dashboard).**

## 1. Root cause

`plans.name` and `plans.description` are single-locale English strings seeded
into the catalog, and `GET /plans` returned them verbatim. The Plans page
rendered `plan.name` directly, so an Arabic dashboard showed "Growth" and "For
growing organizations running multiple academies."

That is a **data** gap, not a UI-translation gap — which is why the fix is in
the `plans` row and not in a string table in the frontend. Plans are catalog
rows Atlas can add to; a fourth plan must become translatable without a
frontend release.

## 2. Where plan text is authoritative

The `plans` table. There is **no write endpoint for plans** —
`PlansController` exposes `GET` only, and rows are created solely by
`prisma/seed.ts` and by test fixtures. So the translation belongs beside the
English it translates.

## 3. Shape — the existing localization architecture, applied

`name_localized` and `description_localized` are nullable JSONB holding the
`{ en, ar }` `LocalizedText` object that **every other piece of bilingual
business content in Atlas already uses** (website CMS entries, inline section
content, SEO fields). The frontend resolves them with the **existing**
`resolveLocalizedText` helper. No second localization mechanism was
introduced.

**Additive, never a replacement.** `name`/`description` are unchanged and stay
authoritative for English and for every non-UI reader (audit-log labels, admin
subscription views, checkout). The new columns are nullable, and
`resolveLocalizedText` already accepts a plain string — so a plan row
predating P54 falls back to its English name rather than rendering blank.

## 4. Data change

Migration `20261002000000_p54_plan_localized_catalog_text`:

- adds both columns;
- backfills the three real plans **by key** (`starter`/`growth`/`enterprise`),
  carrying the English side across from the row itself rather than retyping
  it, so the two locales cannot drift from what they describe;
- is re-runnable, and matches only the keys that exist.

`prisma/seed.ts` sets the same values so a fresh dev database matches.

| key | `ar` name | `ar` description |
|---|---|---|
| `starter` | الأساسية | لأكاديمية واحدة في بداية الطريق. |
| `growth` | النمو | للمؤسسات المتنامية التي تدير عدة أكاديميات. |
| `enterprise` | المؤسسات | نطاق غير محدود للمؤسسات الكبيرة. |

## 5. Defensive read

`toPlanResponse` maps the columns through `toLocalizedText`, which returns
`undefined` for anything that is not a well-formed `{en: string, ar: string}` —
including a blank `ar`, because rendering an empty plan name would be worse
than showing English. A malformed row can never crash a catalog read for every
customer. Covered by `src/plans/dto/plan.contract.spec.ts` (9 cases).

## 6. Frontend

`resolvePlanName` / `resolvePlanDescription` (`features/tenant/utils/plan-text.utils.ts`)
are a two-line adapter over `resolveLocalizedText` that knows where a plan
keeps its text. One helper, used by every dashboard surface that shows a plan
name — Plans comparison, trial dialog, lifecycle panel, tenant dashboard,
subscription page, subscription-required banner — so the `?? plan.name`
fallback cannot be right in five places and wrong in the sixth.

Plan names/descriptions render with `dir="auto"`: business content may be in
either language regardless of the UI language.

## 7. Two raw translation keys fixed at the same time

`PLAN_LIMIT_KEYS` and `PLAN_FEATURE_KEYS` have listed `recordedSessions` and
`liveSessions` since Live Sessions was added, but `tenant.json` never carried
labels for them — so the Plans comparison rendered the literal strings
`common.limits.recordedSessions` and `common.features.liveSessions` in **both**
languages. Labels added in EN and AR.

**This is a label only.** It does not install, enable or publish the Live
Sessions add-on: that row was already being rendered (as a raw key), the add-on
remains `coming_soon`, and the customer navigation stays hidden.

## 8. Numerals — deliberately unchanged

Plan limits still render Latin digits. The Arabic numeral system
(`Intl`+`ar-EG` Arabic-Indic vs Latin) is an **open product decision** recorded
in `ATLAS_HANDOVER.md` §7/§14D, not a defect, and was not unilaterally flipped
here.

## 9. Not covered

The **public** marketing pages (`/pricing`, the home page plan strip) still
render `plan.name` directly. The backend data they consume now carries the
translations, so the change there is one line each — but those are public-site
surfaces with their own locale system, outside this task's stated scope
("the Dashboard Plans page").
