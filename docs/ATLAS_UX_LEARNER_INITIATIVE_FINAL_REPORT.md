# Atlas UX, learner experience and website editor initiative: final report

**Date:** 3 October 2026
**Scope:** Tasks A–I (learner portal theming, My Learn navigation, Finish course, video loading states, course call-to-action, footer attribution, Visual Identity, one-step publish, unsaved-changes guard).
**Status:** All nine tasks are merged to `main` in both repositories and deployed to production, and the read-only production verification passed.

| Repository | Pull request | Merge commit on `main` | Deployed |
|---|---|---|---|
| Frontend `zeyadelbadawi/atlas` | [atlas#16](https://github.com/zeyadelbadawi/atlas/pull/16), 14 commits | `af83043` | Yes, Deploy run 37110206706 |
| Backend `zeyadelbadawi/atlas-backend` | [atlas-backend#24](https://github.com/zeyadelbadawi/atlas-backend/pull/24), 5 commits | `3a09f6a` | Yes, Deploy run 37108969904 |

The backend was merged and deployed first, then the frontend. This release contains **no database migrations**; the deploy's migration job was skipped as designed.

---

## 1. Status by task

Legend for the status columns:
- **Impl**: implemented.
- **Unit**: unit or integration tests.
- **Browser**: exercised in a real browser against the real local stack and database.
- **Prod**: verified in production.

| Task | What changed | Impl | Unit | Browser | Prod |
|---|---|---|---|---|---|
| **A. Theme-aware learner portal** | Theme 1's brand mapping now sets the generic tokens (background, card, popover, muted, secondary, accent, border, input, success, warning, destructive) from the Academy palette. My Learn, courses, outline, player, quiz, assignment and completion follow the brand in EN, AR (RTL), on a phone and with the OS in dark mode. Text lessons no longer invert to light-on-light. | ✅ | ✅ | ✅ J24 | Deploy only, see §6 |
| **B. My Learn navigation** | "My Learn" sits in every Academy header and in the mobile nav. Signed-out visitors go to sign-in with `returnTo=/my`. Signed-in learners get a name menu (My Learn, My Courses, Overview, Profile/Settings, Sign out); it is keyboard and touch friendly, closes on Escape or an outside click, and works in RTL. | ✅ | ✅ | ✅ J22 | Deploy only, see §6 |
| **C. Finish course** | "Finish course" replaces the dead Next on whichever activity finishes the course, whatever its type. Completion is idempotent and guarded against double clicks. The new `/my/courses/:id/complete` page re-reads the server's verdict and shows either "completed" or exactly what is missing. A certificate link appears only when one is issued and ready; while one is being issued, the page polls for at most 2 minutes. | ✅ | ✅ | ✅ J23 | Deploy only |
| **D. Video loading indicator** | Hosted video shows loading, buffering (only after 300 ms, so no flicker), slow with Retry after 15 s, and error with Retry. YouTube uses the frame's `load` event plus origin- and source-checked `onReady`/`onError`, and a refused video is explained. Timers and listeners are cleaned up. | ✅ | ✅ | ✅ J25 (provider bytes stubbed) | Deploy only |
| **E. Start / Continue / Completed** | One backend rule, `deriveLearningState`, is exposed as `learningState` and drives the course page, Theme 1 details, My Courses and Overview, with no per-course requests. | ✅ | ✅ | ✅ J23, J6 | Deploy only |
| **F. Footer attribution** | "Powered by Atlas" sits on the copyright line instead of its own row. | ✅ | ✅ | ✅ pixel baselines | Deploy only |
| **G. Visual Identity** | One page and one save. `PUT /academies/:id/visual-identity` saves name, logo, favicon and palette in one transaction; when the site is published it also writes the published snapshot's brand. Public hostname caches, including custom domains, are dropped after commit. Stale edits are refused. Redundant approve buttons are removed, while onboarding keeps its own. | ✅ | ✅ (7 backend e2e) | ✅ J21 | Deploy only |
| **H. Publish in one step** | "Publish page" saves and publishes, pinned to the version the editor saw (`expectedVersion`). Settings saves carry `expectedUpdatedAt`. A conflict dialog replaces silent overwrites, and draft save is kept. | ✅ | ✅ (backend concurrency e2e) | ✅ J17, J12 | Deploy only |
| **I. Unsaved-changes guard** | "Save and leave" really saves, and there are no prompts after a successful save. | ✅ | ✅ | ✅ J21 | Deploy only |

No load or performance testing was done, so this report makes no capacity claims.

---

## 2. Root causes

- **A:** The portal's dashboard-origin components (cards, inputs, badges, tabs) read generic tokens that the Academy website scope left on fixed neutrals. Text lessons used `dark:prose-invert`, which turned them light-on-light when the visitor's OS was dark.
- **B:** The Academy header had no entry point into the learner area.
- **C:** The last activity offered only a disabled Next, and a quiz, assignment or live session left until last had no ending at all.
- **D:** The player had no readiness model. A video that could not play looked identical to a slow one, and there was no retry.
- **E:** The call-to-action was inferred from enrolment alone, so "Continue Learning" appeared before anything had been opened.
- **F:** The attribution occupied a dedicated footer row.
- **G:** Branding was split across two pages with separate approve and save actions. Save could run before logo analysis finished, which caused a real race and a stale preview. The public site kept serving cached colours, and custom-domain caches were not dropped because `domain_connection` is invisible in the tenant-only database context; this is fixed by using the user-scoped context.
- **H:** Publishing could publish a newer draft than the one the editor reviewed, and settings saves could overwrite newer work.
- **I:** "Save and leave" navigated away without saving, and prompts appeared even after a successful save.

### Additional defects found during browser verification, and fixed

- A lesson opened via `/my/courses/:id/activities/:lessonId` rendered a generic activity card instead of the lesson player. It now redirects to the lesson's own path, showing a skeleton meanwhile.
- axe found a critical issue: the My Courses filter tabs pointed `aria-controls` at a missing panel. The list is now the selected tab's panel.
- axe found a serious issue: locked curriculum rows used `opacity-70`, taking muted text below 4.5:1. They now use `text-muted-foreground`.
- Theme 1 input borders were at 1.24:1 against the page, which fails WCAG 1.4.11. They now come from the palette, at 3.01:1 on the reviewed baseline.

---

## 3. Tests and verification

All local runs were against the disposable local stack (PostgreSQL, Redis, S3-compatible store, API and Vite) with a freshly seeded database.

### Frontend
- Lint, typecheck, `vitest` (188 files, 1875 tests): pass.
- SPA build and SSR build: pass. `test:ssr`: 67/67.
- Theme checks run by CI (axe WCAG 2.x AA in EN/AR at 390 and 1440 px, Themes 2–5 retirement, identity, palette injection, logo-home): 553/553.
- Pixel baselines: 472 of 503 screenshots changed. Every diff was reviewed before re-recording on the pinned Chromium, and the re-run passed 503/503. The only changes are:
  - the My Learn header item (B);
  - the inline attribution (F);
  - the 390 px bottom-nav band;
  - Theme 1 borders and inputs from the palette (A).

### Backend
- `jest --ci`: 4114 tests pass locally.
- Targeted e2e:
  - `concurrent-editing.e2e-spec.ts`: pinned publish and stale settings;
  - `visual-identity.e2e-spec.ts`: 7 tests (live on save, coming soon, invalidation, `logo:null`, atomicity, stale handling, tenant isolation);
  - `learning-progress.e2e-spec.ts`: Start, Continue and Completed, plus counts.

### Browser journeys (Playwright, Chromium, real stack and database)
- **New journeys:**
  - J21 Visual Identity;
  - J22 My Learn navigation;
  - J23 Start → Continue → Finish course → completion → Completed, including the failed-final-quiz path;
  - J24 every learner page in EN, AR, phone and OS-dark: brand-derived tokens, a primary control's real fill, light surfaces, no overflow and axe clean, across 36 page visits;
  - J25 video loading, slow, error and ready, for hosted and YouTube video.
- **Full suite, clean database:** 127 tests; 122 passed, 4 skipped, 1 failed.
  - The failure was J6, which still asserted the pre-task-E "Continue Learning" for a course the learner had not opened yet. The assertion was updated to "Start course", and J6 then passed 7/7.
  - The 4 skips are the J10 real-user-monitoring journeys, which only run when the stack starts with RUM enabled. This skip predates this work.
- **Existing journeys updated to the new specification:**
  - J6 expects "Start course" for a course with no progress (task E).
  - J7, J8 and J12 save through the button's stable `website-save-page` test id, because the button reads "Save draft" while the site is live (task H).
  - J17 was updated for the Visual Identity changes.
  - J21's cleanup now restores the seed's exact brand.
- **Stubbed in J25:** the hosted-video bytes and the YouTube embed. Neither provider pipeline is reachable from the build sandbox. The app, API, lesson grant, `<video>` element and its events, and the iframe postMessage protocol are all real.
- **Test-harness note:** after roughly 15 full Vite dev-server loads (about 1.5k module requests each) in a single tab, Chromium refuses that renderer's requests with `ERR_INSUFFICIENT_RESOURCES`. Long journeys therefore open a fresh tab per test or visit. This is a dev-server artefact, not an application defect.

### CI on GitHub

| Workflow | Head | Result |
|---|---|---|
| Frontend CI (PR) | `843ff8a` | ✅ lint, unit, builds and SSR tests; theme checks |
| Frontend CI (`main`) | `af83043` | ✅ both jobs |
| Frontend Deploy | `af83043` | ✅ image builds and VPS deploy |
| Backend CI (PR) | `69c3afc` | ✅ lint, typecheck, migrations, unit and build; 3 DB e2e shards, each run twice |
| Backend CI (`main`) | `3a09f6a` | ✅ same jobs |
| Backend Deploy | `3a09f6a` | ✅ build and deploy; the migration job was skipped (no migrations) |

---

## 4. Regression, security and scalability review

- **Concurrency:**
  - Page publish is pinned to the version the editor saw.
  - Configuration and Visual Identity saves compare `expectedUpdatedAt` under a row lock (`lockForPublish`) and return `409 stale_resource_version` with `currentUpdatedAt`.
  - The UI shows a conflict dialog or toast instead of silently overwriting.
- **Tenant isolation:**
  - Cache invalidation is scoped to the academy's own hostnames.
  - Custom domains are resolved in the user-scoped tenant context.
  - e2e tests confirm that one academy cannot affect another.
- **Requests:**
  - `learningState` is derived from rows each endpoint already loads, so there is no N+1.
  - `getForCourse` loads progress for that one course only.
- **Bounded work:**
  - The completion page polls for a certificate at most 24 times, 5 s apart (2 minutes).
  - Video timers and listeners are released on unmount and source change.
  - Buffering is shown only after 300 ms.
- **Security:**
  - YouTube postMessage events are accepted only from YouTube origins and from the player's own frame.
  - Logo and favicon inputs reuse the existing validators.
  - No secrets were added to code, tests or logs.
  - CodeRabbit's architecture review rated security risk Low.
- **Legacy themes:** the token mapping change applies to Theme 1 only. Themes 2–5 keep their base mapping, and the retirement checks pass.

---

## 5. Deployment timeline (UTC, 3 Oct 2026)

| Time | Event |
|---|---|
| 05:22 | GitHub Actions stopped starting jobs: "recent account payments have failed or your spending limit needs to be increased". Merges and deploys were held rather than merging around red required checks. |
| before 07:48 | Both repositories were made public by the owner, so standard GitHub-hosted runners became free for them. |
| 07:48 | Frontend CI re-run started and executed (12 steps per job). |
| 07:58 | Backend PR merged as `3a09f6a`. |
| 08:19 | Backend deployed; the backend container restarted. |
| 08:20 | Frontend PR merged as `af83043`, after the backend deploy passed. |
| 09:02 | Frontend and renderer deployed; the containers restarted. |
| 09:04 | Release verify, read-only: 0 failing checks. |

---

## 6. Production verification (read-only)

The build sandbox cannot reach `atlass.dpdns.org`; its egress policy blocks it. Verification therefore ran through the repository's existing **Release verify** workflow (run 37111782149) on GitHub's runners, with `rum_visits=0` so that it wrote nothing to production. Result: **0 failing checks**.

**Server checks**, over the restricted deploy identity, reading state only:
- All expected migrations are applied, with no unfinished or rolled-back rows.
- Backend `/health` returns 200; backend, Caddy and SSR are all healthy.
- Container start times match the two deploys.
- There were 0 backend error lines in the last 30 minutes.
- All 27 published sites have a published snapshot, with 0 pages carrying unpublished changes.
- Course progress item counts are consistent.
- The storage buckets are reachable.
- The payment-method configuration state is as expected.

**Runner checks**, anonymous requests and real Chromium:
- **App host:** returns 200; the app shell revalidates and hashed assets are immutable.
- **Both published Academy hosts:**
  - EN and AR return 200 and are server-rendered;
  - the server titles are the Academy's own, with `dir` set to `ltr`/`rtl` as appropriate;
  - there are no uncaught page errors and exactly one favicon link.

**What was not verified in production, and why:**
- **Public header and footer:** both published Academy sites currently show their "Coming soon" page, which has no header or footer. The new My Learn item (B) and the inline attribution (F) are therefore not visible on any live public page yet.
- **Signed-in flows:** the learner features (A, C, D, E) and owner features (G, H, I) need a signed-in account. Production verification had to stay read-only and could not create learners, accounts, enrolments or other records, so these were verified only on the local stack (section 3).
- **Recommended follow-up:** open My Learn with an existing test learner, and the Visual Identity page as an Academy owner, on production.

---

## 7. Open items and recommendations

1. **GitHub billing:** the payment or spending-limit problem behind the Actions block still exists. Making the repositories public worked around it for standard runners. If either repository becomes private again, or a paid Actions feature is used, jobs will stop again until billing is fixed (Settings → Billing & plans).
2. **Production smoke test with real accounts:** as described in §6.
3. **Workflow maintenance:** GitHub warns that the Node.js 20 based actions (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/upload-artifact@v4`) are being forced onto Node.js 24, and that `ubuntu-latest` moves to Ubuntu 26 from 19 October 2026. Neither affected this release; both are worth scheduling.
4. **RUM journeys (J10):** these still need a stack started with RUM enabled to run locally.
5. **Hosted video end to end:** J25 stubs the provider bytes. A run against a real hosted-video lesson on staging or production would close that gap.

---

## 8. Commit reference

**Frontend (`atlas`), merged in `af83043`:**
- `de1d87c` F footer attribution.
- `45bbb69` I unsaved-changes guard.
- `55e433d` H publish in one step.
- `5505d31` G Visual Identity.
- `2a7b1d7` and `ae18c0b` B My Learn.
- `c1c9dab` D video states.
- `442c813` E course CTA.
- `62a0285` C Finish course.
- `016bed7` A themed portal, J23/J24.
- `a4541c1` J25 and the lesson-route redirect.
- `8f6c16b` pixel baselines.
- `a822d99` J7/J8/J12 save button test id.
- `843ff8a` J6 Start course.

**Backend (`atlas-backend`), merged in `3a09f6a`:**
- `363ef20` pinned page publish.
- `e2d6e27` stale settings refusal.
- `b7c7612` one Save Visual Identity.
- `da7233e` learning state.
- `69c3afc` tab counts.
