#!/usr/bin/env bash
# Atlas — production observability verification (run ON the VPS, from
# /opt/atlas, by the `Observability verify` workflow over SSH stdin).
#
# Prints PASS/FAIL lines and non-secret facts only. Secret VALUES are never
# printed, never put on a command line (they are fed through stdin / files),
# and only their presence/shape is reported.
#
#   observability-verify.sh [--synthetic MINUTES]
#
# --synthetic arms the SAME Redis key the Platform Owner "Arm synthetic
# alert" button sets (TTL-bounded, tenant-free), so the real path is
# exercised: /metrics gauge → Prometheus rule → Alertmanager → Slack. It is
# armed here without a Platform Owner session, so no audit row is written;
# the audited API path is covered by test/platform-observability.e2e-spec.ts.
set -uo pipefail
cd /opt/atlas
export COMPOSE_PROFILES=monitoring

SYNTHETIC_MINUTES=0
if [ "${1:-}" = "--synthetic" ]; then SYNTHETIC_MINUTES="${2:-5}"; fi

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
info() { echo "INFO  $*"; }

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
dc() { docker compose "$@"; }
prom() { dc exec -T prometheus wget -qO- "http://localhost:9090$1"; }
am() { dc exec -T alertmanager wget -qO- "http://localhost:9093$1"; }
# JSON is evaluated with node inside the backend container (the host may
# have no python3/jq). $1 is a JS expression over `d`.
count_json() { dc exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log($1)})"; }

echo "== Secrets (presence/shape only)"
TOKEN=$(env_value METRICS_SCRAPE_TOKEN)
WEBHOOK=$(env_value ALERT_SLACK_WEBHOOK_URL)
if [ "${#TOKEN}" -ge 32 ]; then pass "METRICS_SCRAPE_TOKEN present (>= 32 chars)"; else fail "METRICS_SCRAPE_TOKEN missing or short"; fi
case "$WEBHOOK" in
  https://hooks.slack.com/services/*) pass "ALERT_SLACK_WEBHOOK_URL present (Slack Incoming Webhook shape)" ;;
  "") fail "ALERT_SLACK_WEBHOOK_URL missing from .env" ;;
  *) fail "ALERT_SLACK_WEBHOOK_URL present but not a hooks.slack.com URL" ;;
esac
for f in metrics_scrape_token slack_webhook_url; do
  p="monitoring/secrets/$f"
  if [ -s "$p" ]; then pass "$p exists (mode $(stat -c %a "$p"))"; else fail "$p missing or empty"; fi
done
if cmp -s <(printf '%s' "$TOKEN") monitoring/secrets/metrics_scrape_token; then pass "scrape-token file matches .env"; else fail "scrape-token file differs from .env"; fi
if cmp -s <(printf '%s' "$WEBHOOK") monitoring/secrets/slack_webhook_url; then pass "webhook file matches .env"; else fail "webhook file differs from .env"; fi
info "secrets dir mode $(stat -c %a monitoring/secrets)"

echo "== Containers"
dc --profile monitoring ps --format '{{.Service}} {{.State}} {{.Status}}' | sed 's/^/INFO  /'

echo "== /metrics protection"
code=$(dc exec -T prometheus sh -c 'wget -S -qO /dev/null http://backend:3000/metrics 2>&1 | awk "/HTTP\//{print \$2; exit}"')
if [ "$code" = "401" ]; then pass "/metrics without credentials -> 401"; else fail "/metrics without credentials -> ${code:-no response}"; fi
code=$(dc exec -T prometheus sh -c 'wget -S -qO /dev/null --header "Authorization: Bearer wrong-token-000000000000000000000000" http://backend:3000/metrics 2>&1 | awk "/HTTP\//{print \$2; exit}"')
if [ "$code" = "401" ] || [ "$code" = "403" ]; then pass "/metrics with a wrong token -> $code"; else fail "/metrics with a wrong token -> ${code:-no response}"; fi

echo "== Prometheus"
if prom /-/ready >/dev/null 2>&1; then pass "Prometheus ready"; else fail "Prometheus not ready"; fi
prom /api/v1/targets | count_json "d.data.activeTargets.map(t=>'TARGET '+t.labels.job+' '+t.health+' '+(t.lastError||'-')).join('\\n')" | sed 's/^/INFO  /'
health=$(prom /api/v1/targets | count_json "(d.data.activeTargets.find(t=>t.labels.job==='atlas-backend')||{}).health||'absent'" 2>/dev/null)
if [ "$health" = "up" ]; then pass "Prometheus scrapes Atlas /metrics with the token (target up)"; else fail "atlas-backend target health: ${health:-absent}"; fi
rules=$(prom '/api/v1/rules?type=alert' | count_json "d.data.groups.reduce((n,g)=>n+g.rules.length,0)")
bad=$(prom '/api/v1/rules?type=alert' | count_json "d.data.groups.flatMap(g=>g.rules).filter(r=>r.health!=='ok').length")
if [ "${rules:-0}" -ge 24 ] && [ "${bad:-1}" = "0" ]; then pass "$rules alert rules loaded, all healthy"; else fail "rules loaded=${rules:-?} unhealthy=${bad:-?}"; fi
series=$(prom '/api/v1/query?query=count(atlas_http_requests_total)' | count_json "d.data.result.length?d.data.result[0].value[1]:0")
info "atlas_http_requests_total series: $series"
prom /api/v1/alerts | count_json "d.data.alerts.map(a=>'ALERT '+a.labels.alertname+' '+a.state+' since '+a.activeAt).join('\\n')||'no alerts pending/firing'" | sed 's/^/INFO  /'

echo "== Alertmanager"
if am /-/ready >/dev/null 2>&1; then pass "Alertmanager ready"; else fail "Alertmanager not ready"; fi
receivers=$(am /api/v2/status | count_json "[...d.config.original.matchAll(/- name: ([\\w-]+)/g)].map(m=>m[1]).join(',')+(d.config.original.includes('slack_configs')?' (slack_configs present)':'')")
if printf '%s' "$receivers" | grep -q atlas-slack; then pass "Slack receiver loaded (receivers: $receivers)"; else fail "Slack receiver not loaded (receivers: $receivers)"; fi
if am /api/v2/status | grep -qF -f <(printf '%s' "$WEBHOOK") 2>/dev/null && [ -n "$WEBHOOK" ]; then fail "webhook value visible in Alertmanager status"; else pass "webhook value not present in Alertmanager status/config"; fi
# "sent" = Slack HTTP requests that succeeded (requests_total - requests_failed);
# alertmanager_notifications_total counts attempts, failures included.
slack_metrics() { am /metrics | awk '/^alertmanager_notification_requests_total\{integration="slack"\}/{t=$2} /^alertmanager_notifications_failed_total\{integration="slack"/{f+=$2} /^alertmanager_notification_requests_failed_total\{integration="slack"\}/{r=$2} END{printf "%d %d %d\n", t-r, f, r}'; }
read -r SENT0 FAILED0 REQFAIL0 < <(slack_metrics)
info "slack since Alertmanager start: delivered_requests=$SENT0 failed_notifications=$FAILED0 failed_requests=$REQFAIL0"

echo "== Atlas API authorization (inside the network)"
code=$(dc exec -T prometheus sh -c 'wget -S -qO /dev/null http://backend:3000/api/v1/platform-observability/health 2>&1 | awk "/HTTP\//{print \$2; exit}"')
if [ "$code" = "401" ]; then pass "/api/v1/platform-observability/health anonymous -> 401"; else fail "observability API anonymous -> ${code:-no response}"; fi

wait_for() { # seconds, description, command...
  local limit=$1 what=$2; shift 2
  local start=$SECONDS
  until "$@"; do
    if [ $((SECONDS - start)) -ge "$limit" ]; then fail "$what (timed out after ${limit}s)"; return 1; fi
    sleep 10
  done
  pass "$what (after $((SECONDS - start))s)"
}
prom_state() { prom /api/v1/alerts | count_json "(d.data.alerts.find(a=>a.labels.alertname==='AtlasSyntheticAlert')||{state:'none'}).state"; }
prom_firing() { [ "$(prom_state)" = firing ]; }
prom_cleared() { [ "$(prom_state)" = none ]; }
am_active() { am '/api/v2/alerts?filter=alertname%3D%22AtlasSyntheticAlert%22' | count_json "d.length" | grep -qv '^0$'; }
sent_more_than() { local s; read -r s _ _ < <(slack_metrics); [ "$s" -gt "$1" ]; }

if [ "$SYNTHETIC_MINUTES" -gt 0 ]; then
  echo "== Synthetic alert (${SYNTHETIC_MINUTES} min TTL)"
  REDIS_PASSWORD=$(env_value REDIS_PASSWORD)
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  exp=$(date -u -d "+${SYNTHETIC_MINUTES} min" +%Y-%m-%dT%H:%M:%S.000Z)
  record="{\"armedAt\":\"$now\",\"expiresAt\":\"$exp\",\"armedBy\":\"ops-verify-workflow\"}"
  # AUTH goes over stdin, never argv.
  out=$(printf 'AUTH %s\nSET atlas:observability:synthetic-alert %s PX %d\n' "$REDIS_PASSWORD" "$record" $((SYNTHETIC_MINUTES * 60000)) | dc exec -T redis redis-cli 2>/dev/null | tail -1)
  if [ "$out" = "OK" ]; then pass "synthetic alert armed at $now"; else fail "could not arm synthetic alert"; fi
  wait_for 240 "Prometheus: AtlasSyntheticAlert firing" prom_firing
  wait_for 120 "Alertmanager: AtlasSyntheticAlert active" am_active
  wait_for 180 "Slack: FIRING notification accepted by Slack (successful request count increased)" sent_more_than "$SENT0"
  read -r SENT1 FAILED1 REQFAIL1 < <(slack_metrics)
  if [ "$FAILED1" -eq "$FAILED0" ] && [ "$REQFAIL1" -eq "$REQFAIL0" ]; then pass "no Slack delivery failures during firing"; else fail "Slack failures: failed $FAILED0->$FAILED1 attempts $REQFAIL0->$REQFAIL1"; fi
  info "firing notified at $(date -u +%H:%M:%SZ) — look for '[Atlas] [FIRING] AtlasSyntheticAlert (warning)' in #atlas-alerts"

  printf 'AUTH %s\nDEL atlas:observability:synthetic-alert\n' "$REDIS_PASSWORD" | dc exec -T redis redis-cli >/dev/null 2>&1
  pass "synthetic alert disarmed at $(date -u +%H:%M:%SZ)"
  wait_for 180 "Prometheus: AtlasSyntheticAlert cleared" prom_cleared
  wait_for 420 "Slack: RESOLVED notification accepted by Slack (successful request count increased)" sent_more_than "$SENT1"
  read -r SENT2 FAILED2 REQFAIL2 < <(slack_metrics)
  if [ "$FAILED2" -eq "$FAILED0" ]; then pass "no Slack delivery failures during resolution"; else fail "Slack failures during resolution: $FAILED0->$FAILED2"; fi
  resolved=$(prom '/api/v1/query?query=count_over_time(ALERTS%7Balertname%3D%22AtlasSyntheticAlert%22%2Calertstate%3D%22firing%22%7D%5B30m%5D)' | count_json "d.data.result.length?d.data.result[0].value[1]:0")
  info "ALERTS history samples for the synthetic alert in the last 30m: $resolved (the Alerts Center reads this)"
fi

echo "== Secret leakage in container logs"
logs=$(mktemp); trap 'rm -f "$logs"' EXIT
dc logs --no-color --since 24h backend prometheus alertmanager > "$logs" 2>&1
for name in METRICS_SCRAPE_TOKEN ALERT_SLACK_WEBHOOK_URL; do
  v=$(env_value "$name")
  if [ -z "$v" ]; then continue; fi
  n=$(grep -cF -f <(printf '%s' "$v") "$logs" || true)
  if [ "${n:-0}" = "0" ]; then pass "$name value absent from backend/prometheus/alertmanager logs"; else fail "$name value found in logs ($n lines)"; fi
done
grep -h "Notify attempt failed\|Notify success" "$logs" | tail -3 | cut -c1-300 | sed 's/^/INFO  /'

echo "== Result: $FAILS failure(s)"
[ "$FAILS" -eq 0 ]
