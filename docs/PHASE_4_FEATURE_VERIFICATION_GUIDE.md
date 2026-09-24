# Phase 4 — Owner Verification Guide

**Who this is for:** the Atlas owner, not developers.
**What it answers:** "How can I personally open Atlas and verify that the Phase 4 work is actually there?"
**Last verified:** 24 September 2026, in real Chrome against production.

Hosts used below:

- **Platform host (dashboards):** `https://atlass.dpdns.org`
- **Your academy site:** `https://<your-academy-slug>.atlass.dpdns.org` — the address shown on
  *Dashboard → الموقع الإلكتروني (Website) → عنوان موقعك*. For the academy inspected during the
  audit that is `https://ssfsdf3232.atlass.dpdns.org`.
- Dynamic ids: `<academyId>` is in every academy URL in your sidebar (for example
  `/dashboard/academy/78663a3c-…/courses`); `<courseId>` is the id in a course's edit URL.

Every check is marked **Read-only** (changes nothing) or **Writes** (creates or changes data).

---

## Anonymous visitor (the academy website)

### 1. Course catalog page
**Implemented:** the `/courses` page on every academy site is now the catalog — server-paginated,
with search, level and pricing filters, sort, RTL grid, and cards that show level, duration,
lesson count, price, a "Free preview" badge and the rating (when reviews exist). Existing sites were
upgraded by a data migration; sites whose Courses page an owner had customised were left untouched
(add the "Course Catalog" block from the builder's section picker in that case).
**Open:** `https://<your-academy-slug>.atlass.dpdns.org/courses` — **Read-only**
**Do:** type in *Search courses*; change *Level*; change the pricing and sort selectors.
**Proves it works:** the result count (announced under the heading) and the grid change without a
page reload; a course marked Beginner disappears when *Advanced* is chosen; cards show the metadata
you authored (see Client Owner §1). Arabic: `/ar/courses` renders the same grid right-to-left.
**Needs:** at least one published, public course. Level/duration/rating appear only once authored.

### 2. Course details
**Implemented:** single state-aware call to action (*Sign in to enroll* → *Enroll for free* /
*Buy this course* → *Continue Learning*), level and language badges, "What you'll learn",
"Requirements", curriculum with a **Preview** control on free-sample lessons, learner reviews with a
rating summary, related courses.
**Open:** `https://<your-academy-slug>.atlass.dpdns.org/courses/<courseId>` — **Read-only**
**Proves it works:** the badges and lists mirror what you entered in the course editor's *Catalog
details* card; with no reviews the rating block is absent by design (nothing is faked).
**Needs:** authored metadata for the blocks to appear; approved reviews for the rating.

### 3. Free preview (no account needed)
**Implemented:** a lesson marked *Preview* in the course builder is playable by anyone from the
details page; the server answers refused lessons with 404 so the flag cannot be used to enumerate a
paid catalogue.
**Open:** the details page above, expand the section, press **Preview** — **Read-only**
**Proves it works:** a dialog titled *Free preview* plays the sample (a YouTube preview embeds from
`youtube-nocookie.com`). Close with Escape.
**Needs:** one published lesson with *Preview* enabled and content set (YouTube link is the
infrastructure-free option). **Limit:** hosted (uploaded) video previews depend on the video
infrastructure that is not configured (see Known Limitations).

### 4. Registration and sign-in
**Open:** `/sign-up`, `/sign-in`, `/forgot-password` on the academy site — **Writes** (sign-up
creates an account).
**Proves it works:** a new learner lands on the learner dashboard after signing in.

---

## Student / Learner (sign in on the academy site first)

### 5. Paid checkout
**Implemented:** *Buy this course* → order summary → payment method (the academy's enabled manual
methods, now served to learners by `GET /course-orders/:id/payment-methods`) → proof upload →
"submitted for review".
**Open:** details page of a **paid** course → **Buy this course** → `/my/courses/<courseId>/checkout` — **Writes**
**Proves it works:** the method list renders (it was empty for every learner before 24 Sep — that
defect is fixed); after uploading proof the page shows *submitted for review*, and
`/my/purchases` lists the order as *Awaiting review*.
**Needs:** the organisation's payment collection mode set to Atlas Payments and a platform
commission configured; otherwise the page honestly says *Not available for purchase yet*.

### 6. Purchases, refund status
**Open:** `/my/purchases` — **Read-only**. Order status badges (pending payment / paid / refunded).

### 7. Reviews
**Open:** the details page of a course you are enrolled in → *Write a review* — **Writes**
**Proves it works:** after submitting, the form shows *Awaiting review*; nothing appears publicly
until the owner approves it (Client Owner §3).

### 8. Learner dashboard, player, certificates, devices
**Open:** `/my`, `/my/courses`, `/my/courses/<courseId>`, `/my/assessments`, `/my/certificates`,
`/my/devices`, `/my/profile`, `/my/security` — **Read-only**
These are Phase 2/3 surfaces; Phase 4 added the purchases states and preview. Verified end to end
by the real-Chrome journeys J5/J6 (see Known Limitations for why not in production).

---

## Client Owner (platform host, your organisation)

### 1. Catalog metadata authoring
**Open:** `https://atlass.dpdns.org/dashboard/academy/<academyId>/courses/<courseId>` → *Details*
tab → scroll to **تفاصيل الفهرس / Catalog details** — **Writes** on save
**Do:** choose a level, enter a language, one outcome and one requirement per line, save.
**Proves it works:** the public details page (Anonymous §2) shows the badges and lists; the
catalog card (Anonymous §1) shows the level.

### 2. Free preview lesson
**Open:** the same course → *Course builder* → a lesson → enable **Preview**, set content
(e.g. a YouTube link), publish the lesson — **Writes**
**Proves it works:** Anonymous §3.

### 3. Review moderation
**Open:** the same course → **التقييمات / Reviews** tab — **Writes** on approve/reject
**Proves it works:** a pending review appears with approve/reject; after approval it appears on the
public details page with its stars and the rating summary updates.

### 4. Reports
**Open:** `https://atlass.dpdns.org/dashboard/academy/<academyId>/reports` (sidebar **التقارير / Reports**) — **Read-only**
**Do:** change the window (7 / 30 / 90 days).
**Proves it works:** *Integrity* (quiz integrity events), *Sharing* (content-access grants and
refusals, by reason; learners by display name only), *Quota*. With no students the sections show
honest empty states — that is expected, not a missing feature.

### 5. Website builder — Course Catalog block
**Open:** *Website → Pages → Courses → Edit* — **Writes** on save/publish
**Proves it works:** the Courses page contains a **Course Catalog** block (after the migration) with
search/filter/sort toggles and page size; the section picker also lists **دليل الدورات / Course
Catalog** for any custom page.

### 6. Roster, settings, students
**Open:** `…/members` (Team / Students tabs) and `…/settings` — **Read-only**. Phase 1/2 surfaces,
confirmed intact.

---

## Manager

Managers see the same academy pages the owner does for Reports, Reviews moderation and Course
metadata (server-enforced: owner / administrator / manager). **Open:** the Client Owner §1–§4 paths
while signed in as a manager. **Read-only** unless you save.

## Instructor

**Open:** `https://atlass.dpdns.org/dashboard/instructor` and *My teaching courses* — **Read-only**.
Instructors can moderate reviews for courses they are assigned to; they cannot open Reports
(server returns 403).

---

## Platform Owner (platform host)

### 1. Platform dashboard summary
**Open:** `https://atlass.dpdns.org/dashboard/platform` — **Read-only**
**Proves it works:** the seven KPIs plus a compact **Video & delivery** summary card linking to the
detailed page.

### 2. Analytics → Commerce
**Open:** `https://atlass.dpdns.org/dashboard/analytics/commerce` — **Read-only**
**Do:** change the window (7 / 30 / 90 days).
**Proves it works:** orders by status for the window, paid revenue by currency, the *awaiting
review* backlog, approval latency (p50 / p95) and refunds. Values move when a learner buys a
course and you approve the payment.

### 3. Analytics → Content delivery
**Open:** `https://atlass.dpdns.org/dashboard/analytics/delivery` — **Read-only**
**Proves it works:** content grants granted vs refused (and refusals by reason), video minutes per
tier and provider with processing health, and retention ("rows past the retention window still
present" — should trend to zero after each nightly sweep).

### 4. Payment review queue
**Open:** the existing platform payment review pages — **Writes** on approve/reject. Approving a
learner's manual payment is what creates the enrolment (Learner §5).

---

## Phase 4 Verification Matrix

| Feature | Role | URL | Expected UI | Required data | Flag | Verification status |
|---|---|---|---|---|---|---|
| Catalog page | Anonymous | `/courses` (academy site) | search, filters, sort, metadata cards, RTL | ≥1 published public course | none (ungated) | **Production-verified** on `ssfsdf3232.atlass.dpdns.org` after migration `20261012000003` — EN and `/ar` (RTL), controls, live count, lesson-count meta on the card |
| Course details revamp | Anonymous | `/courses/<id>` | state-aware CTA, badges, outcomes, reviews, related | authored metadata | none | Production-verified (owner site, EN + AR) |
| Free preview | Anonymous | details → Preview | dialog plays sample | one published preview lesson | none | Local real-Chrome (J6) + production contract (`isPreview` live) |
| Registration / sign-in | Anonymous | `/sign-up`, `/sign-in` | forms | — | none | Production-verified |
| Student checkout | Learner | `/my/courses/<id>/checkout` | methods → proof → submitted | Atlas Payments + commission | none | Local real-Chrome (J6); production route live and guarded |
| Purchases / refund status | Learner | `/my/purchases` | order badges | an order | none | Local real-Chrome (J5) |
| Review authoring | Learner | details → Write a review | awaiting review | enrolment | none | Local real-Chrome (J6) |
| Catalog metadata | Client Owner | course editor → Details | Catalog details card | — | none | Production-verified (AR) |
| Review moderation | Client Owner / Manager | course editor → Reviews | approve / reject | a pending review | none | Production-verified (tab, empty) |
| Reports | Client Owner / Manager | `…/reports` | integrity / sharing / quota | events | none | Production-verified (AR, empty states) |
| Course Catalog block | Client Owner | Website → Pages | section in Courses page + picker | — | none | Production-verified (picker); page block after migration |
| Platform video summary | Platform Owner | `/dashboard/platform` | summary card | video assets | none | Deployed; needs a Platform Owner session to view |
| Analytics → Commerce | Platform Owner | `/dashboard/analytics/commerce` | orders, revenue, backlog, latency, refunds | orders | none | Deployed (backend run 35963991021, frontend 35964098559); route live and guarded (401), page chunk served; needs a Platform Owner session to view |
| Analytics → Content delivery | Platform Owner | `/dashboard/analytics/delivery` | grants, video, retention | access log | none | Deployed (same runs); route live and guarded (401), page chunk served; needs a Platform Owner session to view |

## Known Limitations / Blockers

- **Platform Owner and learner surfaces could not be opened in production during the audit:** the
  browser held only a Client Owner session, and passwords may not be typed by the assistant.
  Those surfaces are verified by code, e2e, and the real-Chrome journeys J5/J6 run locally against
  the same build. Sign in yourself to view them.
- **Hosted (uploaded) video** — previews, minutes and provider health — depends on video
  infrastructure that is not configured (`FLAG_VIDEO_*`, `BASIC_VIDEO_*`, Cloudflare Stream
  variables are unset). YouTube previews work without it.
- **Alert receiver wiring and a synthetic fired alert** are a host action (Alertmanager secrets).
- **`catalog.v2` / `checkout.student` flags do not exist** — the Phase 4 UI is ungated by
  construction (Master Plan DL-42). The other `FLAG_*` values gate backend behaviour only.
- **Data migration `20261012000003`** upgrades only untouched seeded or empty Courses pages; a
  customised Courses page keeps its content — add the Course Catalog block yourself.
