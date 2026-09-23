# Atlas alerting rules (P64 Phase 4 §U)

`atlas-prometheus-rules.yml` holds the Prometheus alerting rules for every
Atlas metric series (Phases 1–4). It is validated in CI/tests by
`src/observability/metrics/alert-rules.spec.ts`, which fails if a rule refers
to a series name the application does not emit — so the rules cannot drift
from `LearningMetricsService`.

## What the application provides

- `GET /metrics` on the API process (outside the `/api/v1` prefix), gated to
  the **platform owner** (401 anonymous, 403 for any other principal). It is
  **not** exposed through the public edge (Caddy only proxies `/api/*`), so a
  scraper must run on the host network or be given a platform-owner token.

## Wiring (infrastructure action — not part of the application deploy)

1. Point a Prometheus instance at the API container on the VPS network
   (`/metrics`, bearer token of a platform-owner service account), scrape
   interval ≥ 30s.
2. Load this file via `rule_files: [ "atlas-prometheus-rules.yml" ]`.
3. Route by the `severity` and `team` labels in Alertmanager to the owner's
   receiver (email/Slack/pager of choice). Receivers and secrets live only on
   the host; nothing here needs an application secret.
4. Fire a synthetic alert once (e.g. temporarily lower a threshold or use
   `amtool alert add`) to confirm routing end to end, and record it in the
   Phase 4 completion record.

Threshold values are first-run defaults; tune them against a week of real
traffic before treating a page as actionable.
