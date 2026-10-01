# Real-user monitoring (RUM) — Core Web Vitals

Status: implemented on `claude/practical-wozniak-pjcdhe`; **off by
default**; not merged, not deployed. Free and self-hosted: the
`web-vitals` library (Apache-2.0, bundled), Atlas's own API, the
Prometheus already in `docker-compose.prod.yml`. No third-party service.

## What it measures and sends

For a **sample** of visits, LCP, INP and CLS, each sent once with its
final value (`src/lib/rum/rum.ts` in the frontend):

| Field | Values |
|---|---|
| `metric` | `LCP` · `INP` · `CLS` |
| `value` | ms (LCP, INP) or unitless (CLS) |
| `route` | a page **template** — one of 13 (`public:home`, `public:courses`, `public:course`, `public:page`, `public:auth`, `public:learn`, `app:dashboard`, `app:learn`, `app:builder`, `app:instructor`, `app:platform`, `app:auth`, `app:other`) |
| `device` | `mobile` (viewport ≤ 767 px) · `desktop` |

Never sent: the URL, path, slug, query, any id, the user, the Academy, a
session or device identifier, the user agent. Nothing is stored in the
browser (no cookie, no localStorage). The backend stores no request and
no IP — only histogram counts.

Opt-outs: a browser sending **Global Privacy Control** or **Do Not
Track** is never sampled (nothing is downloaded or sent). Outside the
sample, the `web-vitals` library is not downloaded at all.

## Ingestion (secured, hostile-input safe)

`POST /api/v1/rum/vitals` — unauthenticated by nature (sent as a page is
left), handled like the CSP report endpoint:

- `RUM_ENABLED` must be exactly `true`, else every sample is dropped
  (runtime kill switch, no redeploy of the frontend needed);
- the global per-IP throttler applies (120 / min);
- `parseVitalsBeacon`: closed vocabularies only (unknown routes fold into
  `app:other`; unknown metrics/devices dropped), at most 3 samples, one
  per metric, values within plausible bounds (≤ 60 s; CLS ≤ 10), extra
  fields ignored;
- always answers 204; nothing is logged per request.

A hostile client can skew numbers within those bounds; it cannot create
metric series or carry data (there is no free-text field).

## Storage, retention, aggregated view

- Histograms on the existing registry: `atlas_rum_lcp_seconds`,
  `atlas_rum_inp_seconds`, `atlas_rum_cls`, labels `route` × `device`
  (26 fixed series each). Scraped by the existing Prometheus.
- **Retention**: Prometheus's own, `--storage.tsdb.retention.time=15d` in
  `deploy/docker-compose.prod.yml`. Nothing else stores RUM data.
- **View**: Platform Owner → Observability → Metrics → "Real-user
  performance": p75 per metric × page type × device for 24 h or 7 days,
  with the sample count behind every figure and the rating in words
  (good / needs improvement / poor against the published thresholds:
  LCP 2.5 s / 4 s, INP 200 ms / 500 ms, CLS 0.1 / 0.25). Fewer than 20
  samples → "too few samples to rate". API:
  `GET /api/v1/platform-observability/web-vitals?range=7d` (Platform
  Owner only).

## Enabling (needs your approval — production configuration)

1. **Disclosure first.** The cookie dialog says today (`legal.json`,
   `dialogBody`): "Atlas uses no analytics, advertising or third-party
   tracking technologies."  RUM is not tracking (no identifiers, no device
   storage), but it is measurement and should be disclosed before it is
   turned on. Suggested sentence for the privacy policy: "We measure page
   speed for a sample of visits — only the type of page, whether the
   screen is phone-sized, and three timing values. No account, address or
   identifier is collected, and browsers that send Global Privacy Control
   or Do Not Track are never measured." (Legal copy is your decision; not
   changed here.)
2. Backend environment: `RUM_ENABLED=true`.
3. Frontend build: `VITE_RUM_SAMPLE_RATE=0.1` (10 % of visits; 0–1).
   Build-time: changing it means a frontend rebuild/deploy.
4. Prometheus must be running (`monitoring` compose profile) and
   scraping the API (already configured for the other metrics).

## Disabling

- Immediately: `RUM_ENABLED=false` (or unset) on the backend and restart
  the API — samples are dropped on arrival.
- Fully: build the frontend with `VITE_RUM_SAMPLE_RATE` unset or `0` —
  no RUM code is downloaded by anyone.
- Existing data ages out with Prometheus retention (15 days).

## Limits (honest)

- Browser support (per the library's README): LCP, INP — Chromium,
  Firefox, Safari; **CLS — Chromium only**. CLS figures describe
  Chromium visits.
- Single-page app: INP and CLS cover the whole visit and are attributed
  to the page the visit **started** on; client-side navigations after
  that are not separately measured (soft-navigation measurement is a
  newer Chromium-only API, not used).
- Sampling and opt-outs mean the figures describe sampled, non-opted-out
  visits, not every visit.
- No effect on LCP when off: neither chunk is in the entry bundle, and
  nothing loads. When on, the RUM module (2.0 KB, 1.07 KB gzip, measured
  in the production build) loads after the first render, and `web-vitals`
  (9.6 KB, 3.6 KB gzip) only for sampled visits. SSR is unchanged.

## Verification

- Backend unit: `src/observability/rum/rum.spec.ts` (parser, kill switch,
  aggregation incl. "not configured" and thin samples).
- Frontend unit: `src/lib/rum/rum.test.ts` (templates, sampling,
  GPC/DNT, payload contains no URL/slug/query),
  `observability-metrics-page.test.tsx` (panel, EN/AR).
- Real browser: `e2e/j10-real-user-monitoring.spec.ts` against the local
  stack with RUM on — LCP, CLS and INP from a Chromium visit recorded by
  the API with only template and device; phone-sized → `mobile`; GPC →
  nothing downloaded or sent; a hostile beacon creates no labels.
