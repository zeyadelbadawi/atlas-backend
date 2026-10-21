#!/usr/bin/env bash
# Atlas — read-only production performance check (run ON the VPS, from
# /opt/atlas, by the `Performance check` workflow over SSH stdin, or by hand
# with `sudo bash perf-check.sh`).
#
# Changes nothing. The job log of a public repository is public, so it
# prints only non-secret facts: load, memory, disk, container state,
# response times measured on the server itself (bypassing Cloudflare) and
# through Cloudflare, database activity counts, and log line counts. No
# environment value, no credential, no IP address and no SQL text is
# printed: local requests go to 127.0.0.1 through `--resolve`, long-running
# statements are reported by duration and wait state only, logs are only
# counted, and kernel messages have addresses masked.
#
# Every section runs even if an earlier one fails; the exit status is
# non-zero when any required measurement could not be taken.
#
#   perf-check.sh [academy-subdomain]   (default: german-lectruegbbb)
set -uo pipefail
cd /opt/atlas || { echo "FAIL  cannot enter /opt/atlas"; exit 1; }

BASE=atlass.dpdns.org
ACADEMY="${1:-german-lectruegbbb}.${BASE}"
FAILS=0
dc() { docker compose "$@"; }
section() { printf '\n== %s\n' "$*"; }
# A required measurement: runs, and counts a failure without stopping.
need() { "$@" || { echo "FAIL  ($*) exited $?"; FAILS=$((FAILS + 1)); }; }
psql_q() { dc exec -T postgres sh -c "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -Atc \"$1\""; }
times3() { # host path [local] — each request bounded, a timeout is a failure
  local host=$1 path=$2 mode=${3:-} out="" t args=(-s -o /dev/null --max-time 15 -w '%{time_starttransfer}/%{time_total}')
  # The origin serves publicly trusted ACME certificates (Caddy DNS-01), and
  # --resolve keeps the real host name for SNI, so the certificate is verified.
  [ "$mode" = local ] && args+=(--resolve "$host:443:127.0.0.1")
  for _ in 1 2 3; do
    if t=$(curl "${args[@]}" "https://$host$path"); then out+=" $t"; else out+=" FAIL"; FAILS=$((FAILS + 1)); fi
  done
  printf '%-75s%s\n' "$host$path" "$out"
}
# Counts lines matching each pattern in one streaming pass (no log kept in memory).
count_lines() { # label, then awk regexes
  local label=$1; shift
  printf '%s: ' "$label"
  awk -v pats="$(printf '%s\n' "$@")" 'BEGIN { n = split(pats, p, "\n") } { total++; l = tolower($0); for (i = 1; i <= n; i++) if (p[i] != "" && l ~ p[i]) c[i]++ } END { printf "lines=%d", total; for (i = 1; i <= n; i++) if (p[i] != "") printf " %s=%d", p[i], c[i]; print "" }'
}

section "time / uptime / load";  date -u; uptime
section "cpu count";             nproc
section "memory (MB)";           free -m
section "disk";                  df -h / /var/lib/docker 2>/dev/null | sort -u
section "pressure (PSI: share of time tasks waited)"
for r in cpu io memory; do printf '%-7s ' "$r"; head -1 "/proc/pressure/$r" 2>/dev/null || echo n/a; done
section "vmstat 1 s x 5 (wa = waiting on disk, st = CPU taken by the host)"; vmstat 1 5
section "top processes by CPU";  ps -eo pid,comm,%cpu,%mem,etime --sort=-%cpu | head -12
section "zombie processes";      ps -eo stat | grep -c '^Z'
section "containers";            need dc ps --format 'table {{.Service}}\t{{.Status}}'
section "container usage"
docker stats --no-stream --format 'table {{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}\t{{.BlockIO}}'
section "restarts / start time / OOM"
for c in $(dc ps -q); do
  docker inspect -f '{{.Name}} restarts={{.RestartCount}} started={{.State.StartedAt}} oom={{.State.OOMKilled}}' "$c"
done
section "docker disk";           docker system df

section "on the server, bypassing Cloudflare (ttfb/total seconds, 3 runs)"
times3 "$BASE" / local
times3 "$BASE" /pricing local
times3 "$BASE" /api/v1/public/plans local
times3 "$BASE" "/api/v1/public/websites/resolve?hostname=$ACADEMY" local
times3 "docs.$BASE" / local
times3 "dashboard.$BASE" /auth/sign-in local
times3 "$ACADEMY" / local
section "the same through Cloudflare, from the server"
times3 "$BASE" /
times3 "$BASE" /api/v1/public/plans
times3 "docs.$BASE" /
times3 "$ACADEMY" /

section "database: connections by state"
need psql_q "select coalesce(state,'?'), count(*) from pg_stat_activity group by 1 order by 2 desc"
section "database: statements running longer than 2 s (duration, state, wait; never the SQL text)"
need psql_q "select round(extract(epoch from now()-query_start)::numeric,1)||'s '||coalesce(state,'?')||' wait='||coalesce(wait_event_type,'-')||'/'||coalesce(wait_event,'-') from pg_stat_activity where state <> 'idle' and now()-query_start > interval '2 seconds' order by query_start limit 10"
section "database: size and cache hit ratio"
need psql_q "select pg_size_pretty(pg_database_size(current_database())), round(100.0*sum(blks_hit)/nullif(sum(blks_hit)+sum(blks_read),0),2)||'% hit' from pg_stat_database where datname=current_database()"

section "log line counts, last 6 h (text is never printed)"
dc logs --no-color --since 6h backend 2>&1 | count_lines backend 'error|"level":50' 'warn|"level":40' 'slow|timeout|timed out'
dc logs --no-color --since 6h caddy 2>&1 | count_lines caddy '"level":"error"'
section "kernel: out-of-memory kills"
dmesg -T 2>/dev/null | grep -iE 'out of memory|oom-kill|killed process' | tail -5 |
  sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}/x.x.x.x/g' || echo "(dmesg not readable as this user)"
section "scheduled jobs"
systemctl list-timers --all 2>/dev/null | grep -i atlas
section "done"
if [ "$FAILS" -gt 0 ]; then echo "FAIL  $FAILS required measurement(s) missing"; exit 1; fi
echo "PASS  all measurements taken"
