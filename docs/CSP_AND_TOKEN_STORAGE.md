# Content-Security-Policy and browser token storage

Authentication audit, **Decision 4**. Two linked concerns:

1. **CSP**: stage a Content-Security-Policy as `Report-Only`, fix what it
   reports, and enforce it only on evidence.
2. **Token storage**: move the session out of `localStorage`. This is a
   scoped follow-up, not part of this release.

CSP comes first because it is the control that makes the current storage
defensible. A token in `localStorage` is only as safe as the guarantee that no
foreign script ever runs on the origin.

---

## 1. Content-Security-Policy

### 1.1 What ships in this release

The frontend `Caddyfile` has a `(csp_report_only)` snippet, imported on both
site blocks (the platform domain with its subdomains, and connected custom
domains). It sends two headers on every document and asset Caddy serves:

```
Reporting-Endpoints: csp-endpoint="/api/v1/security/csp-reports"
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self';
  style-src 'self' 'unsafe-inline' https://fonts.googleapis.com;
  font-src 'self' data: https://fonts.gstatic.com;
  img-src 'self' data: blob: https:;
  media-src 'self' blob: https:;
  connect-src 'self' https:;
  frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com;
  worker-src 'self' blob:;
  manifest-src 'self';
  object-src 'none';
  base-uri 'self';
  form-action 'self';
  frame-ancestors 'self';
  report-uri /api/v1/security/csp-reports;
  report-to csp-endpoint
```

`/api/*` responses keep helmet's own (enforcing) API policy. The two layers
stay separate, for the same reason the other security headers do (see the
Caddyfile header comment).

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
  - no query string, fragment or free text survives, because report URLs can
    carry reset tokens or signed media URLs.
- **Logged and counted:** each violation is logged at warn level and counted in
  `atlas_csp_violations_total{directive, blocked, disposition}`. The labels are
  closed vocabularies, so a hostile reporter cannot grow the series.
- **Always answers 204.**

Tests:
- `src/security-reports/csp-report.util.spec.ts` (parser, redaction, bounds);
- `test/csp-reports.e2e-spec.ts` (CSP-01..04).

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

### 1.3 Browser compatibility assessment

See section 1.5. Summary: **zero violations on 25 page loads**, covering:
- platform public pages, auth pages, signed-in dashboard pages and an academy
  site;
- EN and AR (RTL);
- desktop and mobile widths.

A positive control proves the detector works. Real-browser report delivery
was confirmed end to end for both reporting mechanisms.

### 1.4 Enforcement plan (evidence-gated)

1. **Observe, at least 14 days in production, Report-Only:**
   - watch `atlas_csp_violations_total` and the warn logs;
   - classify every `(directive, blocked)` pair as either *legitimate* (fix the
     page or widen the policy precisely) or *noise* (browser extensions:
     `chrome-extension:` and `moz-extension:` sources, which never reach this
     endpoint as `external`).
2. **Tighten from the evidence:** replace `https:` in `img-src`, `media-src`
   and `connect-src` with the storage/CDN hosts actually observed.
3. **Enforce:** rename the header to `Content-Security-Policy`, keeping
   `report-uri` and `report-to`. Keep a `Report-Only` copy of the next, tighter
   policy running alongside for the following iteration.
4. **Exit criteria for step 3:**
   - 7 consecutive days with zero `script-src*` or `frame-src` reports of kind
     `external`, `inline` or `eval` from real pages;
   - every remaining report class understood and documented.

`script-src 'self'` with no `unsafe-inline` or `unsafe-eval` is the part that
matters for token theft. It can be enforced before the media directives are
tightened.

### 1.5 Assessment evidence

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

## 2. Token storage: follow-up (not in this release)

### 2.1 Today

`src/services/identity/token.service.ts` (frontend) keeps
`{accessToken, refreshToken, expiresAt}` in `localStorage`. The access token
goes in an `Authorization: Bearer` header. `/auth/refresh` takes the refresh
token in its JSON body. The only cookie in use is the httpOnly trusted-device
marker set by `email-otp.controller`.

### 2.2 Risk

Any script that runs on the origin can read both tokens and replay them from
anywhere:
- an XSS;
- a compromised dependency;
- an injected third-party script.

The refresh token is the serious part. It lives for 30 days and, until reuse
detection trips, keeps minting sessions. The audit added:
- refresh-token reuse detection (the family is revoked when a rotated token is
  replayed after the 60-second grace);
- surface binding;
- the sid denylist.

These bound the damage but do not stop the theft. Not an exposure today:
- CSRF: nothing authenticates by cookie;
- clickjacking: `X-Frame-Options` and `frame-ancestors`.

### 2.3 Target

A backend-for-frontend (BFF) cookie model on the same origin. It is achievable
because Caddy already serves the SPA and `/api/*` from one origin on every
host, custom domains included.

- **Refresh token:**
  - `__Host-atlas_rt` cookie, `HttpOnly; Secure; SameSite=Strict; Path=/api/v1/auth`;
  - rotated exactly as today;
  - never visible to JavaScript.
- **Access token:** held in memory only, in the http-client module. It is
  re-obtained on page load with a single cookie-authenticated
  `POST /auth/refresh`.
- **CSRF, for the cookie-authenticated routes** (`/auth/refresh`,
  `/auth/sign-out`) only:
  - `SameSite=Strict`;
  - a required custom header (`X-Atlas-CSRF: 1`, which forces a preflight
    cross-origin);
  - an `Origin` allowlist check (reuse `isPlatformOrigin`).
- **Per-host isolation:** a `__Host-` cookie is host-bound, so each academy
  subdomain and custom domain keeps its own session. This matches today's
  per-surface session binding.

### 2.4 Approach (phased, backwards compatible)

1. **Backend dual-mode.** `/auth/refresh` and `/auth/sign-out` accept the
   refresh token from the cookie or the body (cookie wins). Every endpoint that
   issues a session also sets the cookie. That covers:
   - sign-in and its OTP, 2FA and Google completions;
   - registration auto-sign-in;
   - refresh.

   Nothing changes for existing clients.
2. **Frontend.**
   - stop persisting `refreshToken`;
   - keep the access token in memory;
   - bootstrap with a cookie refresh;
   - send `X-Atlas-CSRF`;
   - on the first load after the upgrade, migrate once: use the stored refresh
     token, then delete it.
3. **Backend cutover.** Once the old frontend build is out of circulation
   (after one refresh-token lifetime, 30 days), reject body-supplied refresh
   tokens for browser surfaces.
4. **Clean-up.** Remove `authTokens` from `STORAGE_KEYS` and add a test that
   fails if any token is written to Web Storage.

### 2.5 Compatibility notes

- **Multi-tab:** the in-memory access token is per tab. Each tab refreshes
  independently, and rotation already tolerates concurrent refreshes through
  the 60-second reuse grace. A `BroadcastChannel` can share the access token
  later.
- **Sign-out everywhere:** unchanged (server-side family revocation plus the
  sid denylist).
- **Mobile or non-browser clients** (none today) keep the body mode behind an
  explicit client type.
- **Local development over plain HTTP:** `__Host-` requires `Secure`. Use
  `atlas_rt` without the prefix when `NODE_ENV !== 'production'`, as the
  trusted-device cookie already does.

### 2.6 Rollout and verification

- Behind a flag (`FLAG_AUTH_COOKIE_SESSION`), per environment.
- Verification:
  - Playwright proves no token appears in `localStorage`, `sessionStorage` or
    IndexedDB after sign-in, OTP, 2FA and Google;
  - a cross-origin `POST /auth/refresh` without the header is refused;
  - refresh-reuse and surface-binding e2e suites pass in cookie mode.
- **Rollback:** the flag off returns to body mode. The dual-mode backend makes
  that safe at any point before step 3.
