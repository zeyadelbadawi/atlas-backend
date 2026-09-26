# Platform Owner Observability Guide

Audience: the Atlas Platform Owner and whoever operates production.
Companion: `PLATFORM_OWNER_OBSERVABILITY_HANDOVER.md` (implementation record).

> No secret value appears in this document. Secrets are referred to by
> variable NAME only.

---

## 1. What observability means in Atlas

Observability is the ability to answer "is Atlas healthy right now, and if
not, what is wrong and since when?" from real telemetry, without logging into
the server.

- **Probes.** Live checks the backend runs on request, cached for 5 s:
  - database (`SELECT 1`);
  - Redis (`PING` plus `INFO`);
  - every BullMQ queue (job counts and the oldest waiting job);
  - storage (a HEAD on the public bucket);
  - video provider availability;
  - the email provider chain.
- **Metrics.** Time series scraped by Prometheus from `GET /metrics` every
  15 s and kept for 15 days. Examples: HTTP rate, errors and latency;
  dependency up/latency; queue depth; business counters; process stats.
- **Alerts.** Prometheus rules (`ops/alerts/atlas-prometheus-rules.yml`, 24
  rules) evaluated continuously. Firing alerts go to Alertmanager, which
  deduplicates, groups and delivers them to Slack.
- **The Observability Center.** Four Platform Owner pages that read all of the
  above through the backend. The UI is authoritative: Slack is only a
  delivery channel, and everything in Slack is also visible, with more
  detail, in Atlas.

Nothing is simulated. When a source is unreachable, the page says
**Unavailable / Not configured**. It never shows zeros or placeholder data.

## 2. What Prometheus does

Prometheus runs as the internal `prometheus` container (compose profile
`monitoring`, no published port).

- Scrapes `backend:3000/metrics` with a bearer token, plus Alertmanager's own
  metrics.
- Stores 15 days of history (volume `prometheus_data`).
- Evaluates the alert rules.
- Answers the backend's queries through `PROMETHEUS_URL=http://prometheus:9090`.

History in the Alerts Center is reconstructed from Prometheus's built-in
`ALERTS` series, so there is no separate alert database and no migration.

## 3. What Alertmanager does

Alertmanager runs as the internal `alertmanager` container.

- Receives firing alerts from Prometheus.
- Groups them by `alertname` and `severity`.
- Waits 30 s (`group_wait`) to batch.
- Re-notifies every 5 min while a group changes (`group_interval`) and every
  4 h while unchanged (`repeat_interval`).
- Sends a RESOLVED message when an alert clears.

The backend reads current alerts and silences from it via
`ALERTMANAGER_URL=http://alertmanager:9093`.

## 4. What Slack does

Slack receives a copy of each notification in `#atlas-alerts` through a Slack
**Incoming Webhook**: no bot, no OAuth, no API token. Slack cannot change
Atlas state. Acknowledgement and investigation happen in Atlas.

## 5. How metrics flow

```
Atlas backend ──/metrics (Bearer METRICS_SCRAPE_TOKEN)──► Prometheus ──rules──► Alertmanager ──webhook──► Slack #atlas-alerts
      ▲                                                        │                     │
      └──── PROMETHEUS_URL / ALERTMANAGER_URL (read-only) ─────┴─────────────────────┘
      │
      └── /api/v1/platform-observability/* (Platform Owner JWT) ──► Atlas web UI
```

The browser never talks to Prometheus or Alertmanager, and it never sends
PromQL. It asks for a metric **id** from a fixed server-side catalog (38
entries), and the backend runs the matching expression.

## 6. The Platform Owner pages

All four live under **Platform → Observability** in the sidebar.

| Page | Route | What it shows |
|---|---|---|
| System Health | `/dashboard/platform/observability` (also `/health`) | Overall status (operational / degraded / outage); firing counts by severity; one card per component: API, database, Redis, queues, email, video, storage, Prometheus, Alertmanager. Each card has its status, latency, details and the reason when not healthy. |
| Alerts Center | `/dashboard/platform/observability/alerts` | Active, pending and resolved alerts (15-day history) with filters for status, severity, rule and range. Each row shows severity, summary, start, duration, service and affected tenants. |
| Alert rule detail | `/dashboard/platform/observability/alerts/:ruleName` | The rule's expression, threshold, `for` duration, current values per instance, firing/resolved timeline, and a chart of the expression over the selected range. **This is where Slack "View alert" links open.** |
| System Metrics | `/dashboard/platform/observability/metrics` | Charts per domain from the metric catalog over 1h / 6h / 24h / 7d. A metric Prometheus has never seen is marked "No data yet" rather than drawn as zero. |
| Monitoring & Alert Configuration | `/dashboard/platform/observability/configuration` | Scrape authentication mode, source reachability, all rules with thresholds (read-only: rules change through Git), the Slack channel (configured yes/no, sent/failed in 24 h — **never the URL**), and the synthetic alert control. |

## 7. Metric categories

| Domain | Examples (catalog id) | Source series |
|---|---|---|
| API | `api.requestRate`, `api.errorRate5xx`, `api.errorRate4xx`, `api.latencyP50/P95/P99` | `atlas_http_requests_total`, `atlas_http_request_duration_seconds` (route template, not raw URL) |
| Database | `database.up`, `database.probeLatency` | `atlas_dependency_up/latency_seconds{dependency="database"}` |
| Redis | `redis.up`, `redis.latency`, `redis.memory`, `redis.clients` | `atlas_dependency_*`, `atlas_redis_*` |
| Jobs | `jobs.waiting/active/failed/delayed` | `atlas_queue_jobs{queue,state}`, `atlas_queue_oldest_waiting_seconds` |
| Video | `video.*` | video webhook/processing counters |
| Email | `email.*` | communications dispatch, quota and bounce metrics |
| Learning | `learning.*` | grant refusals, quiz integrity, certificates |
| Commerce | `commerce.*` | checkout, approval, refunds |
| Catalog | `catalog.queryP95` | public catalog query latency |
| Retention | `retention.*` | sweep runs and failures |
| Process | `process.eventLoopLag`, `process.residentMemory`, `process.cpu` | prom-client defaults |
| Alerting | `alerting.notificationsSent`, `alerting.notificationsFailed` | Alertmanager's own metrics |

## 8. Alert categories (rule groups)

| Group | Rules |
|---|---|
| `atlas-platform` | AtlasBackendDown, AtlasApiHighErrorRate, AtlasApiHighLatency, AtlasDependencyDown, AtlasQueueBacklog, AtlasAlertDeliveryFailing, AtlasSyntheticAlert |
| `atlas-communications` | AtlasEmailQuotaHigh, AtlasEmailQuotaCritical, AtlasEmailBounceRate, AtlasEmailDispatcherStalled, AtlasEmailDeadLetters, AtlasAuthOtpFailureSurge, AtlasEmailWebhookSignatureFailures |
| `atlas-learning` | AtlasGrantRefusalSurge, AtlasVideoWebhookSignatureFailures, AtlasQuizIntegrityEventSurge, AtlasCertificateRenderFailures |
| `atlas-commerce` | AtlasCheckoutApprovalBacklog, AtlasCheckoutApprovalSlow, AtlasCheckoutRefundSpike |
| `atlas-catalog` | AtlasPublicCatalogSlow |
| `atlas-retention` | AtlasRetentionSweepFailing, AtlasRetentionSweepSilent |

Every rule carries three annotations:
- `summary` and `description`;
- `threshold`: human-readable, and shown in the UI and Slack;
- `current_value`: the value at evaluation time.

## 9. Severity meanings

- **critical.** Users are, or will shortly be, affected. Act now, e.g. the
  backend is down, 5xx > 5 %, a dependency is down, or the email dispatcher
  has stalled.
- **warning.** Degradation or a trend that becomes critical if ignored.
  Investigate the same working day.
- **info.** A signal worth knowing about (e.g. a quiz integrity event surge).
  There is no immediate action.

## 10. Investigating an alert

1. Open the Slack message's **View alert** link. It goes to the rule detail
   page, or open **Alerts Center** and click the rule.
2. Read the **threshold** and **current values** to judge how far over the
   line it is.
3. Use the **timeline** to see whether it is new, flapping, or long-running.
4. Use the **expression chart** to see when it started to rise, and correlate
   it with deploys (GitHub Actions run times).
5. Open **System Health** and look for any component in `down` or `degraded`
   state; its reason says why.
6. Open **System Metrics** in the matching domain (API, Jobs, Email and so on)
   to find the cause, e.g. latency rising with a queue backlog.
7. Fix the cause. The alert resolves by itself once the expression is false;
   Slack receives RESOLVED and the Alerts Center moves it to history.

## 11. Interpreting latency, error and queue metrics

- **Latency p50/p95/p99.** p50 is the typical request, p95 is what 1 in 20
  users experiences, and p99 is the tail. A rising p99 with a flat p50 means
  a few slow routes or lock contention. A rising p50 means everything is
  slow: look at DB probe latency, event-loop lag and CPU.
- **Error rate.**
  - 5xx means Atlas failed. Always investigate.
  - 4xx means clients were refused. It is normal at a low level; a spike
    usually means a broken frontend build, an auth problem or abuse.
- **Queues.**
  - `waiting` rising while `active` stays at 0 means workers are not
    consuming, e.g. a crash or a Redis problem.
  - `failed` rising means jobs are erroring; check the backend logs for that
    queue.
  - Oldest waiting > 15 min is the `AtlasQueueBacklog` threshold.

## 12. How affected tenants are determined

Only from labels **on the alert itself** (`organization_id` / `academy_id`).
The backend resolves those IDs to names in the Platform Owner's own database
context and shows them in the Alerts Center.

Nothing is inferred and nothing is guessed. An alert without tenant labels is
platform-wide, and the UI shows it as such. Tenant names are never sent to
Slack; only the opaque IDs are sent, and only when the alert carries them.

## 13. How Slack notifications work

Each notification contains:

- **Title.** `[Atlas] [FIRING|RESOLVED] <AlertName> (<severity>)`, linked to
  the Atlas rule page.
- **Per alert:**
  - summary and description;
  - current value and threshold;
  - start time (UTC), plus the resolution time and duration when resolved;
  - service, plus organization/academy IDs when the alert carries them.
- **View alert button.** Opens
  `<PLATFORM_WEB_URL>/dashboard/platform/observability/alerts/<AlertName>`.
  The page requires Platform Owner sign-in, so a leaked Slack link reveals
  nothing.

**Delivery and retries.**
- Alertmanager retries a failed send with exponential back-off, but only
  within the current notification cycle (bounded by `group_interval`). It
  tries again at the next cycle; there is no infinite retry loop.
- Failures increment `alertmanager_notifications_failed_total`. The
  `AtlasAlertDeliveryFailing` rule fires on any failure in 30 min. The
  Configuration page shows "failed (24 h)", and the Alerts Center shows
  AtlasAlertDeliveryFailing even though Slack itself is the broken channel.
- Atlas itself is never affected by a Slack outage. The backend does not call
  Slack at all.

## 14. How to configure Slack (and rotate the webhook)

The webhook is one environment variable: **`ALERT_SLACK_WEBHOOK_URL`**. Two
supported places set it; use one of them.

**Option A: GitHub Actions secret (recommended, no server login).**
1. In the `atlas-backend` repository, go to **Settings → Secrets and
   variables → Actions → New repository secret**.
2. Set the name to `ALERT_SLACK_WEBHOOK_URL` and paste the webhook URL as the
   value.
3. Run the **Deploy backend** workflow (push to `main`, or run it manually
   without migrations). The workflow passes the secret to the server over SSH
   stdin (never on a command line, never echoed) and upserts it into
   `/opt/atlas/.env`.

**Option B: directly on the server.** Add a line
`ALERT_SLACK_WEBHOOK_URL=<value>` to `/opt/atlas/.env`, then run
`/opt/atlas/deploy.sh`.

**What the deploy does with it.**
- `deploy.sh` writes the value to `/opt/atlas/monitoring/secrets/slack_webhook_url`
  (mode 0444, directory 0700).
- It renders `alertmanager.slack.yml` into the live config. The config only
  references the file (`api_url_file`), never the value.
- It sends SIGHUP to Prometheus and Alertmanager so they reload.

**Rotation.**
1. In Slack, create a new Incoming Webhook for `#atlas-alerts`.
2. Update the value using the same method as above.
3. Redeploy.
4. Run a synthetic alert (section 17).
5. Revoke the old webhook in Slack.

No code change is needed.

**To disable Slack**, delete the variable from `/opt/atlas/.env` and redeploy.
Note that the Actions secret only ever *sets* the value: an empty secret
leaves `.env` untouched. Alertmanager then uses the no-delivery receiver, and
alerts remain visible in Atlas.

## 15. Where production secrets live

| Secret | Lives in | Never in |
|---|---|---|
| `ALERT_SLACK_WEBHOOK_URL` | GitHub Actions secret (optional) → `/opt/atlas/.env` → `monitoring/secrets/slack_webhook_url` | Git, docs, frontend, API responses, DB, logs |
| `METRICS_SCRAPE_TOKEN` | `/opt/atlas/.env` (generated on the host by `deploy.sh` if missing) → `monitoring/secrets/metrics_scrape_token` | same |

The API reports only *whether* each is configured.

## 16. How metrics authentication works

`GET /metrics` is guarded by `MetricsAccessGuard`. It accepts exactly one of
these:

1. `Authorization: Bearer <METRICS_SCRAPE_TOKEN>`. The token is compared in
   constant time over SHA-256 digests. This is what Prometheus uses (via
   `credentials_file`).
2. A valid Platform Owner JWT.

Anything else gets 401/403. If the token is missing on the host, `deploy.sh`
generates a 64-hex-character token with `openssl rand`, appends it to `.env`
without printing it, and recreates the backend so it takes effect. The
Configuration page shows the scrape mode as `token` or `platform_owner_only`.

## 17. Testing with a synthetic alert

1. Go to **Monitoring & Alert Configuration → Synthetic alert → Arm**, and
   choose 5–30 minutes.
2. The backend sets a Redis key with that TTL. The gauge
   `atlas_synthetic_alert_armed` becomes 1, and the rule `AtlasSyntheticAlert`
   (warning, label `synthetic="true"`) fires on its next evaluation.
3. Within about 1 minute, the **Alerts Center** shows `AtlasSyntheticAlert`
   as active.
4. Within about 30–60 s after that, `#atlas-alerts` receives
   `[Atlas] [FIRING] AtlasSyntheticAlert (warning)`. Click **View alert**; it
   must open the Atlas rule page.

Arming and resolving are both audited (`observability.synthetic_alert.armed`
/ `.resolved`). The synthetic alert touches no tenant data.

**From GitHub, without signing in.** Run the Actions workflow
**Observability verify** with `synthetic_minutes` = 5.
- It runs `deploy/observability-verify.sh` on the VPS over the deploy SSH
  identity.
- It checks secret presence/shape (never values), `/metrics` protection,
  Prometheus targets and rules, the Alertmanager receiver, and log leakage.
- It arms the same Redis key (TTL-bounded), follows the alert to FIRING in
  Slack, disarms it, and follows it to RESOLVED.
- It writes no audit row, because there is no Platform Owner session.

Use `0` for checks only.

## 18. Verifying resolution

Click **Resolve** (or let the TTL expire). Then check:
- the gauge returns to 0;
- Prometheus clears the alert;
- Alertmanager sends `[Atlas] [RESOLVED] …` to Slack, usually within 5 min
  (`group_interval`);
- the Alerts Center moves the item to **Resolved**, with its duration;
- the rule timeline shows triggered → resolved.

## 19. Troubleshooting

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Health shows Prometheus/Alertmanager **down** or API **unknown** | monitoring profile not running | `docker compose --profile monitoring ps`; is `METRICS_SCRAPE_TOKEN` in `.env`? Redeploy. |
| Metrics page: every chart "No data yet" | Prometheus cannot scrape | Prometheus target `atlas-backend` is down → token file mismatch; redeploy regenerates the file from `.env`. |
| Configuration says Slack **not configured** | `ALERT_SLACK_WEBHOOK_URL` absent | Section 14. |
| Slack configured but nothing arrives; `failed (24h)` > 0 and `AtlasAlertDeliveryFailing` fires | webhook revoked or invalid, or Slack outage | `docker compose logs alertmanager` shows the HTTP status (never the URL). Rotate the webhook. |
| Alert shows in Atlas but not in Slack, failed = 0 | still inside `group_wait`/`group_interval`, or silenced | Wait 5 min; check silences in the Alerts Center. |
| Rule change not taking effect | Prometheus not reloaded | `deploy.sh` sends SIGHUP; manually: `docker compose kill -s SIGHUP prometheus`. |

## 20. Security considerations

- **Authorization.** Every `/platform-observability/*` endpoint is guarded
  server-side by `JwtAuthGuard` + `ManagementSurfaceGuard` +
  `PlatformOwnerGuard`. Client owners, managers, instructors and learners get
  403; anonymous callers get 401. Tests cover this.
- **No query injection.** The browser sends metric ids and rule names. Metric
  ids must be in the catalog (else 404). Rule names must match
  `^[A-Za-z_][A-Za-z0-9_:]{0,127}$` (else 400), and are used only in PromQL
  label matchers after that validation.
- **No SSRF.** Source URLs come only from server env (zod-validated URLs),
  never from requests.
- **No secret exposure.** The webhook URL and scrape token are never returned,
  logged or rendered. Request logs redact `authorization`. The Slack config
  references a file, not the value.
- **Tenant isolation.** Tenant names are resolved only for IDs present on
  alert labels, inside the Platform Owner's RLS user context. No tenant data
  is sent to Slack beyond opaque IDs carried by the alert itself.
- **Network.** Prometheus and Alertmanager have no published ports and are
  reachable only on the compose network.

## 21. Failure scenarios

| Scenario | Behaviour |
|---|---|
| Prometheus down | Health: Prometheus `down`, API `unknown`. Metrics page: "Unavailable". Rule detail: 503. Alerts Center: current alerts still come from Alertmanager. |
| Alertmanager down | Health: Alertmanager `down`. Alerts Center falls back to Prometheus rule state (firing + pending). Slack stops; there is nothing to deliver it. |
| Slack invalid, revoked, timing out or unreachable | Alertmanager logs the error (not the URL), counts `notifications_failed_total`, and retries with back-off within the cycle. `AtlasAlertDeliveryFailing` fires and shows in Atlas. Atlas is unaffected. |
| Malformed or slow source response | Treated as `unavailable` after a 3 s timeout. Never shown as data. |
| Backend down | `AtlasBackendDown` (critical) fires in Prometheus; Alertmanager still notifies Slack. |
| Redis down | Health: Redis `down`; `AtlasDependencyDown`; queue metrics absent. |

## 22. Production operational procedures

- **After every deploy.** Open System Health: all components should be
  `operational`, and the Configuration page should show Prometheus and
  Alertmanager reachable.
- **Weekly.** Review Alerts Center history for flapping rules, and run a
  synthetic alert to prove the Slack path.
- **Webhook rotation.** Section 14.
- **Scrape-token rotation.**
  1. Remove `METRICS_SCRAPE_TOKEN` from `/opt/atlas/.env`, or set a new value
     of 32+ characters.
  2. Run `deploy.sh`. It regenerates the token, rewrites the file, recreates
     the backend and reloads Prometheus.
- **Changing a threshold.**
  1. Edit `ops/alerts/atlas-prometheus-rules.yml`, keeping the `threshold`
     annotation in sync.
  2. Run `promtool check rules`.
  3. Push to `main`. The deploy copies the file and reloads Prometheus.
- **Pausing noise.** Create an Alertmanager silence. Never delete a rule to
  silence it.
