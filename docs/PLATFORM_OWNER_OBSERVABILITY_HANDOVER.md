# Platform Owner Observability Center — Handover

Date: 2026-09-26. Operating guide: `PLATFORM_OWNER_OBSERVABILITY_GUIDE.md`.
No secret values appear in this document.

## 1. Implementation summary

Atlas now has a Platform Owner Observability Center: four pages backed by
live probes, Prometheus and Alertmanager. It has 24 alert rules, delivery
to Slack `#atlas-alerts` through an Incoming Webhook, and a synthetic alert
that exercises the whole path.

No mock or placeholder data exists outside the test fixtures. When a source
is unavailable, the page says so and never renders a zero.

**Before this work:**
- `/metrics` existed, guarded by a Platform Owner JWT or `METRICS_SCRAPE_TOKEN`.
- 17 rules existed in the repo, but nothing in production evaluated them.
- There was no UI and no production Prometheus or Alertmanager.
- `METRICS_SCRAPE_TOKEN` was absent from production.

## 2. Architecture

```
backend /metrics ──(Bearer token, credentials_file)──► prometheus (15d) ──► alertmanager ──(api_url_file)──► Slack
     ▲                                                     │                     │
     └── PROMETHEUS_URL / ALERTMANAGER_URL (internal) ─────┴─────────────────────┘
     └── /api/v1/platform-observability/* (PO JWT) ──► web UI (4 pages)
```

- **Containers.** `prometheus` (`prom/prometheus:v2.53.0`) and `alertmanager`
  (`prom/alertmanager:v0.27.0`) run under compose profile `monitoring`, with
  no published ports and volumes `prometheus_data` / `alertmanager_data`.
- **Enabling monitoring.** `deploy.sh` enables the profile whenever
  `METRICS_SCRAPE_TOKEN` exists, generating the token on the host if it is
  missing. It adds the Slack receiver when `ALERT_SLACK_WEBHOOK_URL` exists
  and sends SIGHUP so both services reload their configs.
- **Alert history** comes from Prometheus `ALERTS`, rebuilt at
  `max(30 s, window/10000)`, so there is no new table and no migration.
- **Metrics** come from a server-side allowlisted catalog of 38 ids. The
  browser never sends PromQL.

## 3. Pages and routes (frontend `src/features/platform-observability/`)

| Page | Route |
|---|---|
| System Health | `/dashboard/platform/observability` → `/health` |
| Alerts Center | `/dashboard/platform/observability/alerts` |
| Alert rule detail (Slack link target) | `/dashboard/platform/observability/alerts/:ruleName` |
| System Metrics | `/dashboard/platform/observability/metrics` |
| Monitoring & Alert Configuration | `/dashboard/platform/observability/configuration` |

**Access.** Every route is wrapped in
`RouteGuard requiredRoles={['platform_owner']}`. The sidebar has an
"Observability" group, shown to Platform Owners only.

**Refresh.** Pages refresh every 30 s (metrics every 60 s). They show "Last
updated" and a stale warning in an `aria-live` region.

**Charts.** Recharts, with a "Show as table" alternative and a mirrored axis
in RTL.

## 4. Backend APIs (`src/observability/platform/`)

Guards: `JwtAuthGuard` + `ManagementSurfaceGuard` + `PlatformOwnerGuard`.
Base path: `/api/v1/platform-observability`.

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | probes (5 s cache) + alert counts |
| GET | `/alerts?status&severity&rule&range` | active (Alertmanager) + pending (rules) + resolved history |
| GET | `/alerts/rules/:ruleName?range` | rule, current values, instances, timeline, expression series; 400 bad name, 404 unknown, 503 Prometheus down |
| GET | `/metrics` | catalog with availability |
| GET | `/metrics/:metricId?range` | series; 404 when not in the catalog |
| GET | `/configuration` | scrape mode, rules, Slack presence and 24 h counts (never a URL), synthetic state |
| POST | `/synthetic-alert` `{minutes: 5..30}` | audited `observability.synthetic_alert.armed` |
| DELETE | `/synthetic-alert` | audited `observability.synthetic_alert.resolved` |

## 5. Metrics added

- **HTTP:** `atlas_http_requests_total{method,route,status_class}` and
  `atlas_http_request_duration_seconds{method,route}`. The route is the
  Express template, never the raw URL.
- **Collected at scrape time:**
  - `atlas_dependency_up{dependency}`, `atlas_dependency_latency_seconds`;
  - `atlas_queue_jobs{queue,state}` and `atlas_queue_oldest_waiting_seconds`
    across 15 BullMQ queues;
  - `atlas_redis_used_memory_bytes`, `atlas_redis_connected_clients`;
  - `atlas_synthetic_alert_armed`.
- **Existing domain metrics:** email, video, learning, commerce, catalog and
  retention (unchanged).

## 6. Alert rules (`ops/alerts/atlas-prometheus-rules.yml`, 24)

- 17 pre-existing rules, plus the new group `atlas-platform`:
  - AtlasBackendDown and AtlasApiHighErrorRate (critical);
  - AtlasApiHighLatency (warning);
  - AtlasDependencyDown (critical);
  - AtlasQueueBacklog and AtlasAlertDeliveryFailing (warning);
  - AtlasSyntheticAlert (warning).
- Every rule has `threshold` and `current_value` annotations.
- `promtool check rules` passes: 24 rules found.

## 7. Slack integration

- **Receiver.** `ops/monitoring/alertmanager.slack.yml` reads the webhook
  through `api_url_file` and sets `send_resolved: true`.
- **Message.** The title is `[Atlas] [FIRING|RESOLVED] <rule> (<severity>)`,
  linked to the Atlas rule page. The body carries summary, description,
  current value, threshold, start time, resolved time and duration, service,
  and tenant IDs when the alert has them. A **View alert** button links to the
  rule page.
- **Delivery.** Alertmanager retries with backoff within a cycle, which is
  bounded by `group_interval` (5 m). Verified locally: "retry canceled after
  17 attempts", then a fresh cycle, so there is no infinite loop.
- **Failure visibility.** Failures surface as
  `alertmanager_notifications_failed_total`, the AtlasAlertDeliveryFailing
  rule, and "failed (24 h)" on the Configuration page.
- **Without a webhook** Alertmanager uses `alertmanager.none.yml` (no
  delivery), and alerts remain visible in Atlas.

## 8. Environment variables

| Name | Where | Secret |
|---|---|---|
| `ALERT_SLACK_WEBHOOK_URL` | GitHub Actions secret → synced into `/opt/atlas/.env` by the deploy (empty = untouched) | yes |
| `METRICS_SCRAPE_TOKEN` | `/opt/atlas/.env`; generated on the host by `deploy.sh` if missing | yes |
| `PROMETHEUS_URL`, `ALERTMANAGER_URL` | set by compose from `OBS_*` exported by `deploy.sh` (internal URLs) | no |
| `PLATFORM_WEB_URL` | repository variable; origin used in Slack links | no |

## 9. Production configuration (done)

- **Actions secret.** `ALERT_SLACK_WEBHOOK_URL` was added by the owner. The
  deploy now passes it (by name) through the existing secret-sync fragment
  over SSH stdin.
- **Scrape token.** The first deploy logged `METRICS_SCRAPE_TOKEN missing —
  generating it on the host (value never printed)` and `Monitoring enabled
  with the Slack receiver`.
- **Verify workflow.** `Observability verify` (workflow_dispatch) runs
  `deploy/observability-verify.sh` on the VPS and prints PASS/FAIL only.

## 10. Migrations, permissions, RLS

- **Migrations:** none.
- **Authorization:** Platform Owner only, enforced server-side. The e2e
  authz matrix gives anonymous 401; client owner, manager, instructor and
  learner get 403.
- **RLS:** the observability endpoints read no tenant tables. Tenant
  names for labelled alerts are resolved in the Platform Owner's user context
  (`runInUserContext`), and audit rows are written the same way.

## 11. Tests

| Suite | Result |
|---|---|
| Backend `src/observability` unit (incl. catalog ids ⊆ emitted metrics, rules ↔ services) | 53/53 |
| `test/platform-observability.e2e-spec.ts` (authz matrix, honest outage, malformed/timeout source, normalisation, no-webhook exposure, synthetic + audit) | 6/6 |
| `metrics-scrape-auth` + `p64-phase4-observability` e2e | 5/5 |
| Frontend `src/features/platform-observability` (7 files) | 52/52 |
| Frontend full vitest | 1018/1018 (1 vitest worker RPC timeout, no failing test) |
| Frontend typecheck | 34 errors (unchanged pre-existing baseline; none in new files) |
| promtool / amtool | 24 rules valid; configs valid |

## 12. End-to-end verification

**Local (real Prometheus v2.53 + Alertmanager v0.27 + Slack-format receiver).**
- **Arm → FIRING → View-alert link.** Arming led to Prometheus firing, then
  Alertmanager active, then Slack `[FIRING]` with a link to
  `/dashboard/platform/observability/alerts/AtlasSyntheticAlert`. Atlas
  showed the alert active.
- **Resolve → RESOLVED.** Resolving produced `[RESOLVED]`, and Atlas showed
  the resolved history and timeline.
- **Failure mode.** With the webhook unreachable, the log showed the URL as
  `<redacted>`, retries were bounded, AtlasAlertDeliveryFailing fired, and
  Atlas health stayed operational.
- **Secret checks.** Neither secret appeared in the app or Alertmanager logs,
  and the built frontend bundle contains neither secret.

**Browser (Chromium via Playwright, local stack).**
- All five routes rendered in EN and AR at 1440 and 390 px widths.
- `dir=rtl` was applied in Arabic.
- There was no horizontal overflow, no raw i18n keys and no unnamed buttons.

## 13. Production verification

See section 16 for the live status of each item.

## 14. Deployment SHAs

| Repo | Commit | What |
|---|---|---|
| atlas-backend | `1607e41` | Observability Center backend, monitoring stack, Slack wiring (deploy run 186 ✅) |
| atlas-backend | `a9a22e9` | Verify workflow; Slack counts (deploy run 187 ❌: secret-file permission, fixed below) |
| atlas-backend | `709bf34` | Exact alert history; 0 % error rate (run 188 cancelled, superseded) |
| atlas-backend | `d7e458b` | Deploy fix: rewrite the 0444 secret files in place |
| atlas | `174cfd9` / merge `6c72bb0` | Four pages, EN/AR (frontend deploy run 119 ✅) |

## 15. Known limitations

- **Rule text is English only.** Rule summaries and descriptions are
  Prometheus annotations, so they stay English in the Arabic UI. The page
  chrome is translated.
- **Rules are read-only in the UI.** Changing thresholds is a Git change,
  by design.
- **History limits.** History is limited to Prometheus retention (15 days).
  Over the 15-day window the resolution is about 2 minutes.
- **Detection delay.** AtlasAlertDeliveryFailing fires on
  `notifications_failed_total`, which increments when a delivery cycle
  gives up (up to 5 min), plus its 5 min `for`. The whole path therefore
  takes about 10 min.
- **No audit row from ops.** A synthetic alert armed by the ops workflow
  writes no audit row, because there is no Platform Owner session. The UI
  path does write one.
- **"Armed by" shows an ID.** The Configuration page shows the arming user's
  id, not their name.

## 16. Remaining human-only actions

See the final report for the current state; any item still open is listed
there.

## 17. Rollback

- **Application.** `deploy.sh --rollback` re-pins the previous images.
- **Monitoring off.** Remove `METRICS_SCRAPE_TOKEN` from `.env` so the
  profile is disabled, then run
  `docker compose --profile monitoring stop prometheus alertmanager`. The
  backend keeps working, and the pages show sources as unavailable.
- **Slack off.** Remove `ALERT_SLACK_WEBHOOK_URL` from `.env` and redeploy.
  Also delete the Actions secret, or it is synced back.
