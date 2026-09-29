# Content-Security-Policy and browser session storage

Authentication audit **Decision 4**, completed in the production-readiness
pass (29 Sep 2026). Both parts are **done**:

1. **CSP is enforced** on every document Atlas serves (platform, academy
   subdomains, custom domains), with violation reporting kept on.
2. **No credential lives in Web Storage.** The refresh token is an HttpOnly
   `__Host-` cookie; the access token lives only in page memory.

Together they close the token-theft path the audit identified: an injected
script can no longer run (`script-src 'self'`), and even if one did, there is
no refresh token for it to read.

---

## 1. Content-Security-Policy

### 1.1 The policy (enforced)

The frontend `Caddyfile` has a `(csp)` snippet, imported on both site blocks
(the platform domain with its subdomains, and connected custom domains):

```
Reporting-Endpoints: csp-endpoint="/api/v1/security/csp-reports"
Content-Security-Policy:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' data: https://fonts.gstatic.com;
  img-src 'self' data: blob: https:;
  media-src 'self' blob: https:;
  connect-src 'self' https:;
  frame-src 'self' blob: https://www.youtube-nocookie.com https://www.youtube.com;
  worker-src 'self' blob:;
  manifest-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'self';
  report-uri /api/v1/security/csp-reports;
  report-to csp-endpoint
```

The only change from the Report-Only policy is `blob:` in `frame-src`. The
certificate template editor previews the server-rendered PDF in an iframe
through an object URL. The Report-Only policy flagged it, and enforcement
would have blocked it (reproduced in Chromium, then fixed).

`/api/*` responses keep helmet's own (enforcing) API policy.

The backend receives reports at `POST /api/v1/security/csp-reports`
(`src/security-reports/`):

- **Public:** the browser sends no credentials. The global per-IP throttler
  applies.
- **Both formats accepted:** legacy `application/csp-report` and Reporting API
  `application/reports+json`. At most 20 violations are taken per request.
- **Normalised before anything is kept:**
  - blocked resources are reduced to a kind (`inline`, `eval`, `data`, `blob`,
    `self`, `external`) plus an origin;
  - the page is reduced to host and path;
  - no query string, fragment or free text survives.
- **Logged and counted:** `atlas_csp_violations_total{directive, blocked,
  disposition}`, where `disposition` is now `enforce`.
- **Always answers 204.**

Production evidence tooling: `Google verify` with `checks=csp` prints a
normalised histogram of every report in the log window (page host only) plus
the metric. `checks=security` asserts that every document ENFORCES the policy,
still reports, and loads only same-origin scripts, so nothing is injected at
the edge.

### 1.2 How the policy was derived

From the code:
- **Scripts:** the built `index.html` loads exactly one same-origin module
  script. There are no inline `<script>` elements and no `eval` or
  `new Function`.
- **JSON-LD:** the structured-data blocks (`useDocumentSeo`,
  `structured-data.utils`) are `application/ld+json`. Those are data blocks,
  which `script-src` does not govern.
- **Styles:**
  - `src/index.css` `@import`s Google Fonts, hence `fonts.googleapis.com` and
    `fonts.gstatic.com`;
  - `components/ui/chart.tsx` injects a `<style>` element;
  - Radix, sonner and React `style` attributes need inline styles, hence
    `'unsafe-inline'` for **styles only**.
- **Frames:**
  - YouTube lessons use `youtube-nocookie.com`, falling back to
    `youtube.com`;
  - the website builder preview is a same-origin frame.
- **Media and connections:**
  - course media, academy logos and HLS segments come from each environment's
    storage or CDN host;
  - uploads go direct to storage through presigned URLs.

  These hosts are configuration and differ per academy, so `img-src`,
  `media-src` and `connect-src` allow `https:`. These are the loosest
  directives. They are the first to tighten once the reports show the real
  host set; the enforcement step below covers that.
- **Workers:** hls.js may use a `blob:` worker.

### 1.3 Why enforcement is safe (evidence)

- **Bundle:** the built SPA has no inline `<script>`, no `eval` or
  `new Function`, and no third-party script host. The only `<script>` in
  `index.html` is the hashed same-origin module.
- **No native form posts and no plugins.** Google and Zoom sign-in use an XHR
  followed by a top-level navigation, which CSP does not govern.
- **Dynamic sources, probed under the exact enforced policy in Chromium, all
  with 0 violations:**
  - certificate PDF preview (`blob:` frame; Chromium's PDF viewer is unaffected
    by `object-src 'none'`);
  - the website builder's `srcdoc` preview with injected styles;
  - hls.js's `blob:` worker;
  - a YouTube embed;
  - a direct-to-storage `PUT`.
- **Page sweep under the enforced policy, 24/24 pages, 0 violations:**
  - platform public pages;
  - Platform Owner dashboard pages (signed in through the cookie session);
  - an academy on a connected custom domain;
  - EN and AR (RTL), desktop and mobile.
- **Production:** zero reports from real traffic while Report-Only ran (the
  window covers the current backend container's logs).

### 1.4 Operating it

- **A new report is a real, blocked request.** Watch
  `atlas_csp_violations_total{disposition="enforce"}` and the warn log. Fix the
  page, or widen the policy precisely; never re-add `unsafe-inline` or
  `unsafe-eval` to `script-src`.
- **Tightening, next iteration:** `img-src`, `media-src` and `connect-src`
  still allow `https:`. Academy media hosts are configuration, so replacing
  `https:` with the observed storage/CDN hosts is safe only once the
  histogram shows the full host set.
- **Browser extensions** (`chrome-extension:` and similar) are noise and are
  never reported as `external`.

### 1.5 Report-Only assessment evidence (28 Sep 2026)

**Setup** (28 Sep 2026):
- the production frontend build (`pnpm build`), served by **Caddy 2.10.2**
  using this repository's `(security_headers)` and `(csp_report_only)`
  snippets verbatim;
- `/api/*` proxied to the built backend on the local test database;
- **Chromium** (Playwright), with a `securitypolicyviolation` listener
  installed before any page script runs.

The production Caddyfile was checked with `caddy adapt` (the Cloudflare DNS
module stripped, since it is not in the stock binary). It adapts cleanly and
emits both headers.

**Page sweep: 25 loads, 0 violations, all HTTP 200, all carrying the
header.**

| Group | Pages |
|---|---|
| Platform, public | `/`, `/features`, `/pricing`, `/blog`, `/auth/sign-in`, `/auth/register`, `/auth/forgot-password`, `/privacy-policy`; sign-in AR at mobile width; register AR |
| Platform, signed in (Platform Owner) | `/dashboard`, `/dashboard/profile`, `/dashboard/settings`, `/dashboard/platform`, `/dashboard/platform/users`, `/dashboard/analytics` (recharts), `/dashboard/platform/observability`, `/dashboard/notifications`, `/dashboard/search`; settings AR at mobile width |
| Academy site (a real connected academy host) | home, courses, sign-in, register; home AR at mobile width |

The signed-in and academy loads were confirmed to render their real content
(the "Platform" heading, and the academy's own name), not a redirect.

**Positive control.** On `/auth/sign-in`, an injected inline `<script>` and an
`ftp:` image were both reported (`script-src-elem inline`, `img-src ftp`).
The inline script still ran, which is correct for Report-Only.

**Delivery, end to end, in a real browser:**
- **Legacy `report-uri`** (a site with no `report-to`): Chromium POSTed
  `application/csp-report`; the backend answered 204 and logged
  `{directive: script-src-elem, blockedKind: inline, documentPath:
  127.0.0.1:8089/auth/sign-in, line: 2}`.
- **Reporting API**, with the production snippet over HTTPS (Caddy internal
  CA): Chromium POSTed `application/reports+json` after its batching delay;
  204, and the same normalised record for `localhost:8443/auth/sign-in`.
  Over plain HTTP the Reporting API does not upload. That is irrelevant in
  production, which is HTTPS-only, and older browsers still fall back to
  `report-uri`.
- **Redaction:** a report whose blocked URL carried `?t=SECRET` was logged as
  origin only, and `SECRET` appears nowhere in the log.

**Not exercised locally** (no suitable fixture data, or an external service);
the production observation window covers these:
- a YouTube lesson;
- HLS playback (hls.js worker);
- direct-to-storage uploads;
- the certificate template editor;
- the website-builder preview;
- live-session (Zoom) pages;
- Cloudflare-injected scripts, if any are enabled on the zone.

These are exactly the directives kept broad (`frame-src`, `worker-src`, and
`https:` for media and connect).

---

## 2. Session storage: HttpOnly cookie (implemented)

### 2.1 The model

- **Refresh token** (30 days, rotating): only in
  `__Host-atlas_session=<opaque>; HttpOnly; Secure; SameSite=Strict; Path=/`.
  - It has no `Domain`, so it is bound to the exact host. Every Atlas host
    (the platform, each academy subdomain, each custom domain) serves the SPA
    and `/api` from one origin behind Caddy, so each host holds its own
    session, matching the per-surface and per-academy binding the refresh rows
    already carry.
  - Plain HTTP (local dev, e2e) uses `atlas_session` without `Secure`.
  - `__Host-` requires `Path=/`.
- **Access token** (15 minutes): returned in the JSON body and kept in the
  page's memory only (`token.service.ts`). A reload re-obtains it with one
  cookie refresh.
- **`localStorage`** holds only a non-secret `atlas:session = '1'` hint, so
  anonymous page loads don't call `/auth/refresh` for nothing.

### 2.2 One place the token leaves the server

`SessionCookieInterceptor` is a global `APP_INTERCEPTOR`. Every endpoint that
mints or rotates a session builds its response through
`AuthService.issueSession`/`refresh`. The interceptor takes `refreshToken` off
any response body and sets the cookie instead:
- for every route, including future ones;
- with no "keep it in the body" mode. A client-selectable switch would let an
  injected script call `/auth/refresh` and read the next token.

### 2.3 CSRF

Only `POST /auth/refresh` and `POST /auth/sign-out` read the cookie. Both
require `assertSameOriginCookieRequest`: the `Origin` header's scheme and
hostname must equal the request's own (`request.protocol`,
`request.hostname`). Those are the trusted-proxy-aware values that every
tenancy decision uses.

- `SameSite=Strict` stops cross-site requests.
- The Origin check also stops cross-origin requests within the site: another
  academy's subdomain addressing this host. `SameSite` alone would allow those,
  and CORS (credentials allowed for platform subdomains) would let such a page
  read the response.
- A missing, opaque (`null`) or malformed Origin is refused.
- Every other route authenticates with the `Authorization: Bearer` access
  token, which a browser never attaches on its own.

### 2.4 Multi-tab and legacy sessions

- **Multi-tab:** each tab holds its own access token. Refreshes are
  single-flight within a tab and serialised across tabs with the Web Locks API
  (`atlas:session-refresh`), with one retry where Locks are unavailable. The
  server's 60-second reuse grace tolerates any remaining race. Verified in a
  real browser: two tabs loading concurrently both stay signed in.
- **Legacy sessions:** a build that predates this change left
  `{accessToken, refreshToken}` in `localStorage` under `atlas:auth-tokens`.
  The first load of the new build reads that refresh token once, deletes it,
  and presents it in the body of `/auth/refresh`; the response sets the
  cookie. Verified in a real browser.
  - Body refresh exists only for that conversion. Tokens minted since the
    change never appear in a body, so every body-carried token is pre-cookie
    and expires within one refresh lifetime (30 days).
  - After that the body path can be deleted outright. This is tracked in the
    audit report as a clean-up, not a risk: a body token is not ambient, so it
    is not CSRF-able.

### 2.5 Deploy order

Backend first, then frontend. A tab still running the old frontend after the
backend switch receives no refresh token in bodies, so it signs out when its
access token lapses (at most 15 minutes). There is no data loss and no
security impact; sign-in works immediately.

### 2.6 Verification

- **Backend e2e** (`test/session-cookie.e2e-spec.ts`, SC-01..06):
  - no token in any body; cookie attributes;
  - rotation;
  - foreign-origin, sibling-subdomain and Origin-less refusal;
  - sign-out by cookie alone;
  - a failed refresh clears the cookie;
  - legacy conversion.
- **Backend unit** (`session-cookie.spec.ts`): the Origin gate against sibling
  academies, look-alike suffixes, scheme downgrade and malformed origins.
- **Frontend unit:**
  - `token-storage.test.ts`: nothing but the hint in Web Storage; legacy
    conversion is one-shot;
  - `session-refresh-singleflight.test.ts`: single-flight, no token from
    script, cross-tab lock.
- **Real browser** (Chromium, over HTTPS with Caddy), 20/20:
  - `__Host-` cookie attributes; no JWT in any storage; `document.cookie`
    cannot see it;
  - reload keeps the session and rotates it;
  - two concurrent tabs;
  - foreign-origin refusal;
  - sign-out;
  - legacy conversion;
  - mobile AR (RTL) restore.
- **Production** (`Launch verify`):
  - sign-in body has no refresh token; cookie attributes;
  - cross-origin and Origin-less refresh refused;
  - same-origin rotation;
  - replay refused and cleared.
