# Atlas production restore drill — function library (B0-OPS-05 / RK-37).
# SOURCE this file from bash (`. restore-drill-lib.sh`); never execute it.
# It writes ONLY to: the three drill resources named below (each carrying the
# label atlas.drill=restore), and files under $ATLAS_DIR/restore-drill/.
# Production is touched only by read-only SQL (prod_ro) and read-only docker,
# df and systemctl queries.
[ -n "${BASH_VERSION:-}" ] || { echo "restore-drill-lib: bash required"; return 1 2>/dev/null || exit 1; }

if [ -z "${DRILL_LIB_LOADED:-}" ]; then
  if [ "${DRILL_TEST_MODE:-0}" = 1 ]; then
    # Local validation only: a disposable fake stack under another directory.
    ATLAS_DIR=${ATLAS_DIR:?DRILL_TEST_MODE needs ATLAS_DIR}
    DRILL_MIN_FREE_MB=${DRILL_MIN_FREE_MB:-2048}
    DRILL_DEADLINE_MIN=${DRILL_DEADLINE_MIN:-90}
    DRILL_READY_TIMEOUT=${DRILL_READY_TIMEOUT:-180}
    DRILL_WATCH_INTERVAL=${DRILL_WATCH_INTERVAL:-10}
    DRILL_GUARD_POLL=${DRILL_GUARD_POLL:-15}
    DRILL_GUARD_STALE=${DRILL_GUARD_STALE:-60}
    DRILL_STOP_MARGIN_MIN=${DRILL_STOP_MARGIN_MIN:-10}
    DRILL_WINDOW_FROM=${DRILL_WINDOW_FROM:-0345}
    DRILL_WINDOW_TO=${DRILL_WINDOW_TO:-0120}
    DRILL_IS_TEST=1
  else
    ATLAS_DIR=/opt/atlas
    DRILL_MIN_FREE_MB=2048
    DRILL_DEADLINE_MIN=90                      # from pre-flight; P3 requires the next backup run after it
    DRILL_READY_TIMEOUT=180
    DRILL_WATCH_INTERVAL=10
    DRILL_GUARD_POLL=15
    DRILL_GUARD_STALE=60
    DRILL_STOP_MARGIN_MIN=10                   # P3: next backup >= deadline + this margin
    DRILL_WINDOW_FROM=0345                     # permitted pre-flight start, host local time (wraps midnight)
    DRILL_WINDOW_TO=0120                       # 01:20 + 90 min deadline + 10 min margin = 03:00 timer
    DRILL_IS_TEST=0
  fi
  readonly ATLAS_DIR DRILL_MIN_FREE_MB DRILL_DEADLINE_MIN DRILL_READY_TIMEOUT DRILL_WATCH_INTERVAL DRILL_GUARD_POLL DRILL_GUARD_STALE
  readonly DRILL_STOP_MARGIN_MIN DRILL_WINDOW_FROM DRILL_WINDOW_TO DRILL_IS_TEST
  # worst-case seconds from the deadline to a stopped container: watcher poll + df timeout + inspect + stop + kill timeouts
  readonly DRILL_STOP_LATENCY_MAX=$(( DRILL_WATCH_INTERVAL + 10 + 20 + 30 + 30 ))
  readonly DRILL_PROD_PROJECT=atlas                         # compose `name:` of the production stack (F6)
  readonly DRILL_PROD_CORE="postgres redis backend caddy"   # production services without a compose profile
  readonly DRILL_CT=atlas-restore-drill
  readonly DRILL_VOL=atlas-restore-drill-data
  readonly DRILL_NET=atlas-restore-drill-net
  readonly DRILL_LABEL=restore                 # value of label key atlas.drill
  readonly DRILL_DB=atlas_restore_test
  readonly DRILL_ROOT="$ATLAS_DIR/restore-drill"
  readonly DRILL_MAX_AGE_MIN=1455              # 24 h 15 min (RPO <= 24 h + timer jitter)
  readonly DRILL_LIB_LOADED=1
fi

# ---------------------------------------------------------------- basics
_ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
_int() { case "${1:-}" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }
_now_hhmm() { # host local time (system zone, not the shell's TZ); a fake clock exists in test mode only
  if [ "$DRILL_IS_TEST" = 1 ] && [ -n "${DRILL_FAKE_HHMM:-}" ]; then printf '%s' "$DRILL_FAKE_HHMM"; else env -u TZ date +%H%M; fi
}
_in_window() { # $1 HHMM -> 0 if inside [DRILL_WINDOW_FROM, DRILL_WINDOW_TO], a window that wraps midnight
  local t=$1
  case "$t" in [0-2][0-9][0-5][0-9]) ;; *) return 1 ;; esac
  [ $((10#$t)) -ge $((10#$DRILL_WINDOW_FROM)) ] || [ $((10#$t)) -le $((10#$DRILL_WINDOW_TO)) ]
}
# every _prisma_migrations row: name | checksum | finished? | rolled back?  (deterministic order, compared as a multiset)
readonly DRILL_MIG_Q="select migration_name || '|' || coalesce(checksum, '') || '|' || (finished_at is not null)::text || '|' || (rolled_back_at is not null)::text from _prisma_migrations order by 1"
env_value() { grep -E "^$1=" "$ATLAS_DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2-; }
_pguser() {
  local u; u=$(env_value POSTGRES_USER)
  case "$u" in ''|*[!A-Za-z0-9_]*) echo "STOP S5: POSTGRES_USER missing or not a plain role name" >&2; return 1 ;; esac
  printf '%s' "$u"
}
_pgdb() {
  local d; d=$(env_value POSTGRES_DB)
  case "$d" in ''|*[!A-Za-z0-9_]*) echo "STOP S5: POSTGRES_DB missing or not a plain name" >&2; return 1 ;; esac
  printf '%s' "$d"
}

# ---------------------------------------------------------------- state (non-secret, survives SSH loss and reboot)
drill_dir() { [ -f "$DRILL_ROOT/current" ] && cat "$DRILL_ROOT/current"; }
st_get() { local d; d=$(drill_dir) || return 1; sed -n "s/^$1=//p" "$d/state" 2>/dev/null | tail -1; }
st_set() {
  local d; d=$(drill_dir)
  [ -n "$d" ] && [ -d "$d" ] || { echo "STOP: no active drill directory (run drill_begin)" >&2; return 1; }
  printf '%s=%s\n' "$1" "$2" >> "$d/state"
}
ev() { local d; d=$(drill_dir) || return 1; printf '%s=%s\n' "$1" "$2" | tee -a "$d/evidence.txt"; }
_need() {
  local k
  for k in "$@"; do
    [ -n "$(st_get "$k")" ] || { echo "STOP: step prerequisite '$k' is not recorded in the state file" >&2; return 1; }
  done
}

drill_begin() {
  ( umask 077; mkdir -p "$DRILL_ROOT" ) || return 1
  local cur; cur=$(drill_dir)
  if [ -n "$cur" ] && [ -d "$cur" ] && ! grep -q '^closed=' "$cur/state" 2>/dev/null; then
    echo "STOP: an unfinished drill exists ($cur). Run drill_status, then drill_cleanup." >&2
    return 1
  fi
  local d; d="$DRILL_ROOT/$(date -u +%Y%m%dT%H%M%SZ)"
  ( umask 077; mkdir -p "$d" && : > "$d/state" && : > "$d/evidence.txt" ) || return 1
  printf '%s\n' "$d" > "$DRILL_ROOT/current"
  st_set started "$(_ts)"
  echo "drill_dir=$d"
}

# ---------------------------------------------------------------- production: read-only SQL only
prod_ro() {
  local u d; u=$(_pguser) && d=$(_pgdb) || return 1
  ( cd "$ATLAS_DIR" && docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
      psql -U "$u" -d "$d" -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate "$@" )
}

# ---------------------------------------------------------------- drill resources: identity checks
_exists() {
  case "$1" in
    container) docker container inspect "$2" >/dev/null 2>&1 ;;
    volume)    docker volume inspect "$2" >/dev/null 2>&1 ;;
    network)   docker network inspect "$2" >/dev/null 2>&1 ;;
    *) return 1 ;;
  esac
}
_label() {
  case "$1" in
    container) docker container inspect -f '{{index .Config.Labels "atlas.drill"}}' "$2" 2>/dev/null ;;
    volume)    docker volume inspect -f '{{index .Labels "atlas.drill"}}' "$2" 2>/dev/null ;;
    network)   docker network inspect -f '{{index .Labels "atlas.drill"}}' "$2" 2>/dev/null ;;
  esac
}
_allowed_name() {
  case "$1:$2" in
    "container:$DRILL_CT"|"volume:$DRILL_VOL"|"network:$DRILL_NET") return 0 ;;
    *) return 1 ;;
  esac
}
drill_guard() {
  [ "$(docker container inspect -f '{{.Name}}|{{index .Config.Labels "atlas.drill"}}|{{.State.Running}}' "$DRILL_CT" 2>/dev/null)" \
    = "/$DRILL_CT|$DRILL_LABEL|true" ] \
    || { echo "STOP S4: $DRILL_CT is not the running, labelled drill container" >&2; return 1; }
}
drill_sql() {
  drill_guard || return 1
  local u; u=$(_pguser) || return 1
  docker exec -i "$DRILL_CT" psql -U "$u" -d "${DRILL_SQL_DB:-$DRILL_DB}" -X -q -A -t \
    -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate "$@"
}

# ---------------------------------------------------------------- production containers: baseline and comparison (read-only)
_prod_snapshot() { # one line per container of the production compose project, one-off `run` containers excluded
  local ids out
  ids=$(docker ps -aq --filter "label=com.docker.compose.project=$DRILL_PROD_PROJECT" --filter label=com.docker.compose.oneoff=False) || return 1
  [ -n "$ids" ] || return 1
  # shellcheck disable=SC2086
  out=$(docker container inspect -f '{{index .Config.Labels "com.docker.compose.service"}}|{{.State.Status}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{.State.StartedAt}}|{{.ID}}' $ids) || return 1
  sort <<<"$out"
}
_prod_unchanged() { # 0 only if production equals the pre-flight baseline: same containers, state, health, restarts, start time
  local d now; d=$(drill_dir) || return 1
  [ -s "$d/prod.baseline" ] || { echo "no production baseline recorded"; return 1; }
  now=$(_prod_snapshot) || { echo "production containers not found"; return 1; }
  [ "$now" = "$(cat "$d/prod.baseline")" ] && return 0
  diff "$d/prod.baseline" <(printf '%s\n' "$now") | grep '^[<>]' | cut -d'|' -f1-5 | tr '\n' ' '
  return 1
}

# ---------------------------------------------------------------- 1. pre-flight (read-only)
drill_preflight() {
  _need started || return 1
  local fail=0 line svc state health pg be root mem next nexte deadline out snap
  echo "host=$(hostname) user=$(whoami) time_local=$(env -u TZ date) time_utc=$(_ts)"
  # P1 permitted start window (host local time), enforced here rather than left to the operator
  out=$(_now_hhmm)
  if _in_window "$out"; then echo "PASS P1: start ${out:0:2}:${out:2:2} host time is inside the permitted window ${DRILL_WINDOW_FROM:0:2}:${DRILL_WINDOW_FROM:2:2}-${DRILL_WINDOW_TO:0:2}:${DRILL_WINDOW_TO:2:2}"
  else echo "FAIL P1: start ${out:-?} host time is outside the permitted window ${DRILL_WINDOW_FROM:0:2}:${DRILL_WINDOW_FROM:2:2}-${DRILL_WINDOW_TO:0:2}:${DRILL_WINDOW_TO:2:2}"; fail=1; fi
  ev start_host_time "$out"
  # the stop margin must cover the worst-case time from the deadline to a stopped container
  [ $(( DRILL_STOP_MARGIN_MIN * 60 )) -gt "$DRILL_STOP_LATENCY_MAX" ] \
    || { echo "FAIL P3: stop margin ${DRILL_STOP_MARGIN_MIN} min does not exceed the worst-case stop latency ${DRILL_STOP_LATENCY_MAX} s"; fail=1; }
  command -v timedatectl >/dev/null 2>&1 && timedatectl 2>/dev/null | grep -i 'time zone'
  # P2 production containers (stopped ones included): every core service running and healthy; baseline recorded
  if snap=$(_prod_snapshot); then
    printf '%s\n' "$snap" > "$(drill_dir)/prod.baseline"
    for svc in $DRILL_PROD_CORE; do
      [ "$(grep -c "^$svc|running|\(healthy\|none\)|" <<<"$snap")" = 1 ] \
        || { echo "FAIL P2: core service $svc is not exactly one running, healthy container"; fail=1; }
    done
    while IFS='|' read -r svc state health _; do
      case "$state|$health" in
        'running|healthy'|'running|none') ;;
        exited\|*) echo "INFO P2: $svc is exited (recorded in the baseline; it must stay unchanged)" ;;
        *) echo "FAIL P2: $svc state=$state health=$health"; fail=1 ;;
      esac
    done <<<"$snap"
    [ "$fail" = 0 ] && echo "PASS P2: core services running/healthy: $DRILL_PROD_CORE"
  else
    echo "FAIL P2: no containers of compose project '$DRILL_PROD_PROJECT' found"; fail=1
  fi
  # P3 backup service idle; the next timer run is after this drill's hard deadline (the watcher stops the drill by then)
  deadline=$(( $(date +%s) + DRILL_DEADLINE_MIN * 60 ))
  if command -v systemctl >/dev/null 2>&1 && systemctl list-unit-files atlas-backup.timer >/dev/null 2>&1; then
    state=$(systemctl is-active atlas-backup.service 2>/dev/null)
    [ "$state" = inactive ] && echo "PASS P3: atlas-backup.service inactive" || { echo "FAIL P3: atlas-backup.service is '$state'"; fail=1; }
    next=$(systemctl show atlas-backup.timer -p NextElapseUSecRealtime --value 2>/dev/null)
    nexte=""; [ -n "$next" ] && nexte=$(date -d "$next" +%s 2>/dev/null)
    if _int "$nexte" && [ "$nexte" -ge $(( deadline + DRILL_STOP_MARGIN_MIN * 60 )) ]; then
      st_set deadline_epoch "$deadline"; ev deadline_utc "$(date -u -d "@$deadline" +%Y-%m-%dT%H:%M:%SZ)"
      echo "PASS P3: next backup $next is at least ${DRILL_STOP_MARGIN_MIN} min after the drill deadline $(date -u -d "@$deadline" +%H:%MZ) (now + ${DRILL_DEADLINE_MIN} min)"
    else echo "FAIL P3: next backup run '${next:-unknown}' is before the drill deadline (now + ${DRILL_DEADLINE_MIN} min) + ${DRILL_STOP_MARGIN_MIN} min margin, or unknown"; fail=1; fi
  else
    echo "FAIL P3: cannot read atlas-backup.service/timer via systemctl"; fail=1
  fi
  # P4 no deploy or backup process
  out=$(pgrep -fa 'deploy\.sh|backup\.sh' 2>/dev/null)
  [ -z "$out" ] && echo "PASS P4: no deploy.sh/backup.sh process" || { echo "FAIL P4: running: $out"; fail=1; }
  # P5 no drill resource left over
  for line in "container $DRILL_CT" "volume $DRILL_VOL" "network $DRILL_NET"; do
    set -- $line
    if _exists "$1" "$2"; then
      if [ "$(_label "$1" "$2")" = "$DRILL_LABEL" ]; then echo "FAIL P5: labelled leftover $1 $2 (run drill_cleanup)"
      else echo "FAIL P5: UNLABELLED $1 named $2 exists: stop and ask, never remove it"; fi
      fail=1
    fi
  done
  [ "$fail" = 0 ] && echo "PASS P5: no drill resources exist"
  # P6 production images and volume (resolved, never assumed)
  pg=$(cd "$ATLAS_DIR" && docker compose ps -q postgres); be=$(cd "$ATLAS_DIR" && docker compose ps -q backend)
  if [ -n "$pg" ] && [ -n "$be" ]; then
    st_set pg_image "$(docker inspect -f '{{.Image}}' "$pg")"
    st_set be_image "$(docker inspect -f '{{.Image}}' "$be")"
    st_set prod_pg_volume "$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' "$pg")"
    ev prod_pg_version "$(cd "$ATLAS_DIR" && docker compose exec -T postgres postgres --version)"
    ev prod_pg_volume "$(st_get prod_pg_volume)"
    echo "PASS P6: images recorded"
  else
    echo "FAIL P6 (S5): production postgres/backend container not found"; fail=1
  fi
  # P8 memory, CPU, Docker root, log driver, terminal multiplexer
  mem=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  if _int "$mem" && [ "$mem" -ge 2048 ]; then echo "PASS P8: MemAvailable ${mem} MiB"; else echo "FAIL P8: MemAvailable ${mem:-?} MiB < 2048"; fail=1; fi
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  [ -n "$root" ] && [ -d "$root" ] && st_set docker_root "$root" || { echo "FAIL P8: Docker root dir unknown"; fail=1; }
  ev cpus "$(nproc)"; ev docker_root "$root"
  ev docker_log_driver_default "$(docker info --format '{{.LoggingDriver}}' 2>/dev/null)"
  ev cgroup_version "$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)"
  ev multiplexer "$(command -v tmux || command -v screen || echo none)"
  # P9-P12 production role and migration facts (read-only)
  out=$(prod_ro -c "select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, coalesce(array_to_string(rolconfig, ','), '') from pg_roles where rolname = 'atlas_app'")
  st_set prod_app_role "$out"; ev prod_app_role "$out"
  [ "$out" = 'atlas_app|f|f|t|f|f|f|jit=off' ] && echo "PASS P9" || { echo "FAIL P9 (S7 if super/bypassrls): $out"; fail=1; }
  out=$(prod_ro -c "select string_agg(rolname, ',' order by rolname) from pg_roles where (rolsuper or rolbypassrls) and rolname not like 'pg\\_%'")
  ev prod_super_or_bypass "$out"
  [ "$out" = "$(_pguser)" ] && echo "PASS P10" || { echo "FAIL P10: $out"; fail=1; }
  out=$(prod_ro -c "select count(*) from pg_auth_members m join pg_roles r on r.oid = m.member where r.rolname = 'atlas_app'")
  ev prod_app_memberships "$out"
  [ "$out" = 0 ] && echo "PASS P11" || { echo "FAIL P11: atlas_app has $out role memberships (reproduce before restoring)"; fail=1; }
  out=$(prod_ro -c "select count(*) filter (where finished_at is not null and rolled_back_at is null) || '|' || count(*) filter (where finished_at is null or rolled_back_at is not null) || '|' || coalesce(max(migration_name), '') from _prisma_migrations")
  ev prod_migrations "$out"
  case "$out" in *'|0|'*) echo "PASS P12: $out" ;; *) echo "FAIL P12: $out"; fail=1 ;; esac
  # the full production history, row by row, is the V4 baseline
  if prod_ro -c "$DRILL_MIG_Q" | LC_ALL=C sort > "$(drill_dir)/prod.migrations" && [ -s "$(drill_dir)/prod.migrations" ]; then
    ev prod_migrations_rows "$(wc -l < "$(drill_dir)/prod.migrations")"; ev prod_migrations_sha256 "$(sha256sum < "$(drill_dir)/prod.migrations" | cut -c1-64)"
  else echo "FAIL P12: production migration history could not be listed"; fail=1; fi
  # I7 input: encoding / collation of the production database
  out=$(prod_ro -c "select pg_encoding_to_char(encoding) || '|' || datcollate || '|' || datctype || '|' || datlocprovider::text from pg_database where datname = current_database()")
  st_set prod_db_locale "$out"; ev prod_db_locale "$out"
  case "$out" in *'|c') ;; *) echo "FAIL I7-pre: unexpected locale provider: $out"; fail=1 ;; esac
  [ "$DRILL_MIN_FREE_MB" -ge 2048 ] || { echo "FAIL: DRILL_MIN_FREE_MB below 2048"; fail=1; }
  if [ "$fail" = 0 ]; then st_set preflight_ok "$(_ts)"; echo "PREFLIGHT=PASS"; else echo "PREFLIGHT=FAIL"; return 1; fi
}

# ---------------------------------------------------------------- 2. backup selection and validation (file is only read)
_scan_dump() { # $1 file, $2 out dir -> dump_scan.txt, dump_rowcounts.txt; returns zcat status
  local f=$1 o=$2
  ( set -o pipefail
    zcat "$f" | LC_ALL=C awk -v rc="$o/dump_rowcounts.txt" '
      { bytes += length($0) + 1 }
      inb { if ($0 == "\\.") { print t, n > rc; inb = 0 } else n++; next }
      /^COPY / { t = $2; n = 0; inb = 1; copies++; next }
      /^-- PostgreSQL database dump complete$/ { marker++ }
      /^-- Dumped from database version / { from = $0; sub(/^-- Dumped from database version /, "", from) }
      /^CREATE TABLE / { tables++ }
      /^\\/ { if ($1 == "\\restrict" || $1 == "\\unrestrict") restricts++; else bad_meta++ }
      /^(CREATE|DROP) DATABASE/ || /^(CREATE|ALTER|DROP) ROLE/ { bad_sql++ }
      /OWNER TO / { o = $0; sub(/.*OWNER TO /, "", o); sub(/;.*/, "", o); owners[o]++ }
      END {
        printf "bytes=%d\nmarker=%d\ncopies=%d\ncreate_tables=%d\nbad_meta=%d\nbad_sql=%d\nrestrict_lines=%d\nunterminated_copy=%d\nfrom=%s\n",
          bytes, marker, copies, tables, bad_meta, bad_sql, restricts, inb, from
        for (k in owners) printf "owner=%s\n", k
      }' > "$o/dump_scan.txt" )
}
_dump_ok() { # $1 drill dir, $2 owner role -> 0 only if every content rule holds
  local v t; v=$(cat "$1/dump_scan.txt" 2>/dev/null) || return 1
  grep -qx 'marker=1' <<<"$v" && grep -qx 'bad_meta=0' <<<"$v" && grep -qx 'bad_sql=0' <<<"$v" \
    && grep -qx 'unterminated_copy=0' <<<"$v" && [ "$(grep -c '^owner=' <<<"$v")" = 1 ] \
    && grep -qx "owner=$2" <<<"$v" && grep -q '^from=16\.' <<<"$v" \
    && [ "$(sed -n 's/^copies=//p' <<<"$v")" = "$(sed -n 's/^create_tables=//p' <<<"$v")" ] || return 1
  for t in users enrollments quiz_attempts academy_students; do
    grep -q "^public\.$t " "$1/dump_rowcounts.txt" || return 1
  done
}
drill_select_backup() {
  _need preflight_ok || return 1
  local d f name ts epoch age_min ok=0 tries=0 u v
  d=$(drill_dir); u=$(_pguser) || return 1
  for f in $(ls -t "$ATLAS_DIR"/backups/atlas-*.sql.gz 2>/dev/null | head -3); do
    tries=$((tries + 1)); rm -f "$d/dump_scan.txt" "$d/dump_rowcounts.txt"
    name=$(basename "$f"); ts=${name#atlas-}; ts=${ts%.sql.gz}
    case "$ts" in [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
      *) echo "REJECT $name: unexpected file name"; continue ;; esac
    epoch=$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2} ${ts:9:2}:${ts:11:2}:${ts:13:2}" +%s 2>/dev/null)
    _int "$epoch" || { echo "REJECT $name: timestamp not parseable"; continue; }
    age_min=$(( ( $(date -u +%s) - epoch ) / 60 ))
    if [ "$age_min" -gt "$DRILL_MAX_AGE_MIN" ] || [ "$age_min" -lt 0 ]; then
      echo "REJECT $name: age ${age_min} min outside 0..${DRILL_MAX_AGE_MIN}"; break   # older files are older still
    fi
    gzip -t "$f" 2>/dev/null || { echo "REJECT $name: gzip -t failed"; continue; }
    _scan_dump "$f" "$d" || { echo "REJECT $name: decompression/scan failed"; continue; }
    if _dump_ok "$d" "$u"; then ok=1; break; fi
    echo "REJECT $name: content rules failed:"; sed 's/^/    /' "$d/dump_scan.txt"
  done
  if [ "$ok" != 1 ]; then echo "BACKUP=FAIL (S3): no valid backup within ${DRILL_MAX_AGE_MIN} min among the newest $tries"; return 1; fi
  st_set backup_file "$f"; st_set backup_ts "$ts"; st_set backup_age_min "$age_min"
  st_set dump_bytes "$(sed -n 's/^bytes=//p' "$d/dump_scan.txt")"
  st_set dump_copies "$(sed -n 's/^copies=//p' "$d/dump_scan.txt")"
  ev backup_file "$name"; ev backup_utc "$ts"; ev backup_age_min "$age_min"
  ev backup_compressed_bytes "$(stat -c %s "$f")"; ev backup_mtime "$(stat -c %y "$f")"
  sed 's/^/dump_/' "$d/dump_scan.txt" | tee -a "$d/evidence.txt"
  [ "$tries" -gt 1 ] && ev newer_backup_files_rejected "$((tries - 1))"
  st_set backup_ok "$(_ts)"; echo "BACKUP=PASS"
}

# ---------------------------------------------------------------- 3. disk (fail closed)
drill_disk_check() {
  _need backup_ok docker_root || return 1
  local root U L free u_mb l_mb need
  root=$(st_get docker_root); U=$(st_get dump_bytes)
  L=$(prod_ro -c "select pg_database_size(current_database())")
  free=$(df -Pk "$root" 2>/dev/null | awk 'NR==2 { print int($4 / 1024) }')
  for v in "$U" "$L" "$free"; do _int "$v" || { echo "DISK=FAIL (S2/S5): a size could not be measured (dump='$U' live='$L' free='$free')"; return 1; }; done
  u_mb=$(( (U + 1048575) / 1048576 )); l_mb=$(( (L + 1048575) / 1048576 ))
  need=$(( (3 * u_mb > 2 * l_mb ? 3 * u_mb : 2 * l_mb) + DRILL_MIN_FREE_MB ))
  ev disk_free_mb "$free"; ev dump_uncompressed_mb "$u_mb"; ev live_db_mb "$l_mb"; ev disk_need_mb "$need"
  [ "$free" -ge "$need" ] || { echo "DISK=FAIL (S2): free ${free} MiB < need ${need} MiB"; return 1; }
  st_set disk_ok "$(_ts)"; echo "DISK=PASS"
}

# ---------------------------------------------------------------- 4. disk watcher (detached; survives SSH loss)
_drill_stop_ct() { # $1 drill dir, $2 container name, $3 reason: stops it only if name AND label verify, by full id
  local d=$1 ct=$2 id
  id=$(timeout 20 docker container inspect -f '{{.Id}}|{{.Name}}|{{index .Config.Labels "atlas.drill"}}' "$ct" 2>/dev/null)
  case "$id" in
    *"|/$ct|restore")
      id=${id%%|*}
      if timeout 30 docker stop -t 10 "$id" >> "$d/watch.log" 2>&1 || timeout 30 docker kill "$id" >> "$d/watch.log" 2>&1; then
        echo "$(date -u +%T) stopped $ct ($3)" >> "$d/watch.log"
      else echo "$(date -u +%T) FAILED to stop $ct ($3)" >> "$d/watch.log"; return 1; fi ;;
    *) echo "$(date -u +%T) $ct absent or not labelled atlas.drill=restore: nothing stopped" >> "$d/watch.log" ;;
  esac
}
_drill_watch_loop() {
  local d=$1 root=$2 min=$3 end=$4 ct=$5 interval=${6:-10} free reason
  echo "$$" > "$d/watch.pid"
  while :; do
    if [ -f "$d/watch.stop" ]; then echo "$(date -u +%T) stop requested; watcher exits" >> "$d/watch.log"; break; fi
    free=$(timeout 10 df -Pk "$root" 2>/dev/null | awk 'NR==2 { print int($4 / 1024) }')
    reason=""
    case "$free" in ''|*[!0-9]*) reason="disk monitoring failed (df $root)" ;; *) [ "$free" -lt "$min" ] && reason="free ${free} MiB < ${min} MiB" ;; esac
    [ "$(date +%s)" -ge "$end" ] && reason="${reason:+$reason; }deadline reached ($(date -u -d "@$end" +%H:%M:%SZ))"
    date +%s > "$d/watch.heartbeat.tmp" && mv -f "$d/watch.heartbeat.tmp" "$d/watch.heartbeat"   # atomic: readers never see an empty file
    if [ -n "$reason" ]; then
      echo "$(date -u +%T) TRIGGER: $reason" >> "$d/watch.log"
      _drill_stop_ct "$d" "$ct" "watcher"
      echo "$reason" > "$d/watch.triggered"
      break
    fi
    echo "$(date -u +%T) free=${free}MiB" >> "$d/watch.log"
    sleep "$interval"
  done
  rm -f "$d/watch.pid"
}
drill_watch_start() {
  _need disk_ok docker_root deadline_epoch || return 1
  local d root end; d=$(drill_dir); root=$(st_get docker_root); end=$(st_get deadline_epoch)
  _int "$end" && [ "$end" -gt "$(date +%s)" ] || { echo "WATCH=FAIL: the drill deadline has passed; drill_cleanup, then a new drill"; return 1; }
  if drill_watch_ok quiet; then echo "WATCH=PASS (already running, pid $(cat "$d/watch.pid"))"; return 0; fi
  rm -f "$d/watch.stop" "$d/watch.triggered"
  setsid nohup bash -c "$(declare -f _drill_stop_ct _drill_watch_loop); _drill_watch_loop \"\$@\"" _ \
    "$d" "$root" "$DRILL_MIN_FREE_MB" "$end" "$DRILL_CT" "$DRILL_WATCH_INTERVAL" \
    > /dev/null 2>&1 < /dev/null &
  sleep 3
  drill_watch_ok || { echo "WATCH=FAIL: watcher did not start"; return 1; }
  st_set watch_started "$(_ts)"; echo "WATCH=PASS (pid $(cat "$d/watch.pid"), floor ${DRILL_MIN_FREE_MB} MiB, deadline $(date -u -d "@$end" +%H:%MZ))"
}
drill_watch_ok() {
  local d pid hb; d=$(drill_dir) || return 1
  [ -f "$d/watch.triggered" ] && { [ "${1:-}" = quiet ] || echo "WATCH: triggered: $(cat "$d/watch.triggered")"; return 1; }
  pid=$(cat "$d/watch.pid" 2>/dev/null); hb=$(cat "$d/watch.heartbeat" 2>/dev/null)
  _int "$pid" && kill -0 "$pid" 2>/dev/null && grep -q _drill_watch_loop "/proc/$pid/cmdline" 2>/dev/null \
    && _int "$hb" && [ $(( $(date +%s) - hb )) -le 30 ] \
    || { [ "${1:-}" = quiet ] || echo "WATCH: not running or heartbeat stale"; return 1; }
}

# ---------------------------------------------------------------- 5. isolated drill environment
drill_create() {
  _need preflight_ok backup_ok disk_ok pg_image prod_db_locale || return 1
  drill_watch_ok || { echo "STOP: start the disk watcher first (drill_watch_start)"; return 1; }
  local r u img loc enc col ctyp ok=0 running v
  for r in "container $DRILL_CT" "volume $DRILL_VOL" "network $DRILL_NET"; do
    set -- $r; _exists "$1" "$2" && { echo "STOP: $1 $2 already exists; run drill_status / drill_cleanup"; return 1; }
  done
  u=$(_pguser) || return 1; img=$(st_get pg_image); loc=$(st_get prod_db_locale)
  IFS='|' read -r enc col ctyp _ <<<"$loc"
  for v in "$enc" "$col" "$ctyp"; do
    case "$v" in ''|*[!A-Za-z0-9_.@-]*) echo "STOP: unexpected encoding/locale token '$v'"; return 1 ;; esac
  done
  st_set create_started "$(_ts)"
  docker network create --internal --label atlas.drill="$DRILL_LABEL" "$DRILL_NET" > /dev/null || { echo "CREATE=FAIL: network"; return 1; }
  docker volume create --label atlas.drill="$DRILL_LABEL" "$DRILL_VOL" > /dev/null || { echo "CREATE=FAIL: volume"; return 1; }
  ( set +x
    POSTGRES_PASSWORD=$(head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n') \
    docker run -d --name "$DRILL_CT" --label atlas.drill="$DRILL_LABEL" \
      --network "$DRILL_NET" --cpus 1 --memory 1g --restart no \
      --log-driver json-file --log-opt max-size=10m \
      -e POSTGRES_USER="$u" -e POSTGRES_PASSWORD -e POSTGRES_DB=postgres \
      -v "$DRILL_VOL":/var/lib/postgresql/data \
      "$img" \
      -c max_parallel_maintenance_workers=0 -c max_parallel_workers_per_gather=0 \
      -c log_min_messages=fatal -c log_min_error_statement=panic -c log_error_verbosity=terse > /dev/null
  ) || { echo "CREATE=FAIL: docker run (resources created so far stay labelled; run drill_cleanup)"; return 1; }
  # bounded readiness: init finished AND server accepting connections, container never exited
  for _ in $(seq 1 "$(( DRILL_READY_TIMEOUT / 2 ))"); do
    running=$(docker container inspect -f '{{.State.Running}}|{{.State.ExitCode}}' "$DRILL_CT" 2>/dev/null)
    case "$running" in true\|*) ;; *) echo "CREATE=FAIL: drill container is not running ($running); run drill_cleanup"; return 1 ;; esac
    if [ "$(docker logs "$DRILL_CT" 2>&1 | grep -c 'PostgreSQL init process complete')" -ge 1 ] \
       && docker exec "$DRILL_CT" pg_isready -U "$u" -d postgres -q 2>/dev/null; then ok=1; break; fi
    sleep 2
  done
  [ "$ok" = 1 ] || { echo "CREATE=FAIL: not ready within ${DRILL_READY_TIMEOUT}s; run drill_cleanup"; return 1; }
  DRILL_SQL_DB=postgres drill_sql -c "CREATE DATABASE $DRILL_DB TEMPLATE template0 ENCODING '$enc' LC_COLLATE '$col' LC_CTYPE '$ctyp'" \
    || { echo "CREATE=FAIL: scratch database"; return 1; }
  st_set created "$(_ts)"
  drill_isolation_check
}
drill_isolation_check() {
  local fail=0 out prodvol
  prodvol=$(st_get prod_pg_volume)
  out=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' "$DRILL_CT" 2>/dev/null)
  [ "$out" = "$DRILL_NET " ] && echo "PASS I1: networks=$out" || { echo "FAIL I1: networks=$out"; fail=1; }
  out=$(docker network inspect -f '{{.Internal}}|{{index .Labels "atlas.drill"}}' "$DRILL_NET" 2>/dev/null)
  [ "$out" = "true|$DRILL_LABEL" ] && echo "PASS I2: internal network" || { echo "FAIL I2: $out"; fail=1; }
  out=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$DRILL_NET" 2>/dev/null)
  [ "$out" = "$DRILL_CT " ] && echo "PASS I3: only $DRILL_CT attached" || { echo "FAIL I3: attached=$out"; fail=1; }
  out=$(docker inspect -f '{{json .HostConfig.PortBindings}}|{{range .Mounts}}{{.Name}} {{end}}|{{.HostConfig.RestartPolicy.Name}}|{{.HostConfig.LogConfig.Type}}|{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}' "$DRILL_CT" 2>/dev/null)
  [ "$out" = "{}|$DRILL_VOL |no|json-file|1000000000|1073741824" ] && echo "PASS I4: no ports, mount, restart, log driver, limits ($out)" || { echo "FAIL I4: $out"; fail=1; }
  case " $(docker inspect -f '{{range .Mounts}}{{.Name}} {{end}}' "$DRILL_CT") " in *" ${prodvol:-<none>} "*) echo "FAIL I4b: production volume mounted"; fail=1 ;; *) echo "PASS I4b: production volume (${prodvol:-unresolved}) not mounted" ;; esac
  out=$(_cg_limits); ev drill_cgroup_limits "$out"
  case "$out" in
    'v2|1073741824|100000 100000'|'v1|1073741824|100000 100000') echo "PASS I4c: 1 CPU / 1 GiB enforced by the kernel ($out)" ;;
    *) echo "FAIL I4c: limits not enforced as requested ($out)"; fail=1 ;;
  esac
  out=$(drill_sql -c "select current_database() || '|' || (select count(*) from pg_class where relnamespace = 'public'::regnamespace)")
  [ "$out" = "$DRILL_DB|0" ] && echo "PASS I5: empty $DRILL_DB" || { echo "FAIL I5: $out"; fail=1; }
  if out=$(_prod_unchanged); then echo "PASS I6: production containers unchanged since pre-flight"; else echo "FAIL I6: production changed: $out"; fail=1; fi
  out=$(drill_sql -c "select pg_encoding_to_char(encoding) || '|' || datcollate || '|' || datctype || '|' || datlocprovider::text from pg_database where datname = current_database()")
  [ "$out" = "$(st_get prod_db_locale)" ] && echo "PASS I7: encoding/collation $out" || { echo "FAIL I7: drill=$out prod=$(st_get prod_db_locale)"; fail=1; }
  ev isolation "$([ "$fail" = 0 ] && echo PASS || echo FAIL)"
  [ "$fail" = 0 ] && st_set isolation_ok "$(_ts)"
  return "$fail"
}
_cg_limits() { # the limits the kernel applies, as seen inside the drill container (cgroup v2 or v1)
  drill_guard 2> /dev/null || return 1
  # shellcheck disable=SC2016
  docker exec "$DRILL_CT" sh -c 'if [ -f /sys/fs/cgroup/memory.max ]; then echo "v2|$(cat /sys/fs/cgroup/memory.max)|$(cat /sys/fs/cgroup/cpu.max)"; else echo "v1|$(cat /sys/fs/cgroup/memory/memory.limit_in_bytes)|$(cat /sys/fs/cgroup/cpu/cpu.cfs_quota_us) $(cat /sys/fs/cgroup/cpu/cpu.cfs_period_us)"; fi' 2> /dev/null
}

# ---------------------------------------------------------------- 6. roles first
drill_roles() {
  _need isolation_ok prod_app_role || return 1
  DRILL_SQL_DB=postgres drill_sql <<'SQL' || return 1
CREATE ROLE "atlas_app" LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
ALTER ROLE "atlas_app" SET jit = off;
SQL
  local out; out=$(drill_sql -c "select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreatedb, rolcreaterole, rolreplication, coalesce(array_to_string(rolconfig, ','), '') from pg_roles where rolname = 'atlas_app'")
  ev drill_app_role "$out"
  [ "$out" = "$(st_get prod_app_role)" ] || { echo "ROLES=FAIL (S7): drill=$out prod=$(st_get prod_app_role)"; return 1; }
  st_set roles_ok "$(_ts)"; echo "ROLES=PASS"
}

# ---------------------------------------------------------------- 7. restore (once per drill; never resumed)
drill_restore() {
  _need roles_ok backup_file || return 1
  [ -z "$(st_get restore_started)" ] || { echo "STOP: a restore was already started in this drill ($(st_get restore_started)); results of an interrupted restore are never trusted: run drill_cleanup and begin a new drill"; return 1; }
  drill_guard || return 1
  drill_watch_ok || { echo "STOP: disk watcher not healthy"; return 1; }
  local d f u n t0 t1 ps errl guard
  d=$(drill_dir); f=$(st_get backup_file); u=$(_pguser) || return 1
  n=$(drill_sql -c "select count(*) from pg_class c join pg_namespace s on s.oid = c.relnamespace where s.nspname not in ('pg_catalog', 'information_schema', 'pg_toast')")
  [ "$n" = 0 ] || { echo "STOP: $DRILL_DB is not empty ($n relations)"; return 1; }
  st_set restore_started "$(_ts)"
  # restore guard: if the watcher dies or stalls during the restore (monitoring failed), stop the drill container
  rm -f "$d/restore.guard.fired"; : > "$d/restore.guard"
  ( while [ -f "$d/restore.guard" ]; do
      sleep "$DRILL_GUARD_POLL"
      hb=$(cat "$d/watch.heartbeat" 2> /dev/null)
      if [ -f "$d/restore.guard" ] && { ! _int "$hb" || [ $(( $(date +%s) - hb )) -gt "$DRILL_GUARD_STALE" ]; }; then
        : > "$d/restore.guard.fired"
        echo "$(date -u +%T) RESTORE GUARD: watcher heartbeat stale or missing (disk monitoring failed)" >> "$d/watch.log"
        _drill_stop_ct "$d" "$DRILL_CT" "restore guard"; break
      fi
    done ) < /dev/null > /dev/null 2>&1 &
  guard=$!
  t0=$(date +%s)
  zcat "$f" | docker exec -i "$DRILL_CT" psql -U "$u" -d "$DRILL_DB" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=sqlstate --single-transaction \
    > "$d/restore.out" 2> "$d/restore.err"
  ps="${PIPESTATUS[0]} ${PIPESTATUS[1]}"
  rm -f "$d/restore.guard"
  # a guard that fired is never interrupted: wait until its stop has completed (bounded by the stop timeouts)
  if [ -f "$d/restore.guard.fired" ]; then wait "$guard" 2> /dev/null; else kill "$guard" 2> /dev/null; wait "$guard" 2> /dev/null; fi
  t1=$(date +%s); errl=$(wc -l < "$d/restore.err")
  st_set restore_finished "$(_ts)"
  ev restore_exit "zcat=${ps% *} psql=${ps#* }"; ev restore_seconds "$((t1 - t0))"; ev restore_err_lines "$errl"
  [ "$errl" = 0 ] || ev restore_err_first_line "$(head -1 "$d/restore.err" | cut -c1-120)"
  if [ -f "$d/restore.guard.fired" ]; then ev restore_guard_fired yes; echo "RESTORE=FAIL (S2): disk monitoring failed during the restore"; return 1; fi
  drill_watch_ok quiet || { ev restore_watcher_healthy_at_end no; echo "RESTORE=FAIL (S2): the disk watcher was not healthy at the end of the restore"; return 1; }
  if [ "$ps" != "0 0" ] || [ "$errl" != 0 ]; then echo "RESTORE=FAIL (S6)"; return 1; fi
  drill_rowcounts || { echo "RESTORE=FAIL: row counts differ from the dump (partial or altered restore)"; return 1; }
  st_set restore_ok "$(_ts)"; echo "RESTORE=PASS"
}
drill_rowcounts() { # every table in the dump, exact
  local d q got tables mism
  d=$(drill_dir)
  [ -s "$d/dump_rowcounts.txt" ] || { echo "ROWCOUNTS=FAIL: no dump row counts"; return 1; }
  q=$(awk '{ lit = $1; gsub(/\047/, "\047\047", lit); printf "%sselect \047%s\047, count(*) from %s", (NR > 1 ? " union all " : ""), lit, $1 }' "$d/dump_rowcounts.txt")
  got=$(drill_sql -F ' ' -c "$q") || { echo "ROWCOUNTS=FAIL: count query failed"; return 1; }
  awk 'NR == FNR { r[$1] = $2; next } { s = ($1 in r) ? (r[$1] == $2 ? "OK" : "MISMATCH") : "MISSING"; print $1, "dump=" $2, "restored=" (($1 in r) ? r[$1] : "-"), s }' \
    <(printf '%s\n' "$got") "$d/dump_rowcounts.txt" > "$d/rowcounts.txt"
  tables=$(wc -l < "$d/rowcounts.txt"); mism=$(grep -vc ' OK$' "$d/rowcounts.txt")
  ev rowcount_tables "$tables"; ev rowcount_not_ok "$mism"
  [ "$mism" = 0 ] && [ "$tables" = "$(st_get dump_copies)" ] || { grep -v ' OK$' "$d/rowcounts.txt" | cut -d' ' -f1,4 | head -20; return 1; }
}

# ---------------------------------------------------------------- 8. verification (read-only on production; drill writes are rolled back)
drill_verify() {
  _need restore_ok || return 1
  _gate start || { echo "VERIFY=FAIL (S2)"; return 1; }
  local d fail=0 out p q inv pubc org aacad
  d=$(drill_dir)
  ev V1_version "$(drill_sql -c 'select version()' | cut -c1-40)"
  ev V4_image_migration_dirs "$(docker run --rm --network none --entrypoint sh "$(st_get be_image)" -c 'ls -d prisma/migrations/*/ | wc -l' 2>/dev/null)"
  _check_migrations || fail=1
  _gate V4 || { echo "VERIFY=FAIL (S2)"; return 1; }
  inv="select 'a_tables', count(*)::text from pg_tables where schemaname in ('public','atlas_migration_backups')
union all select 'b_indexes', count(*)::text from pg_indexes where schemaname in ('public','atlas_migration_backups')
union all select 'c_constraints_' || contype::text, count(*)::text from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname in ('public','atlas_migration_backups') group by contype
union all select 'd_not_valid_constraints', count(*)::text from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public' and not c.convalidated
union all select 'e_functions', count(*)::text from pg_proc where pronamespace = 'public'::regnamespace
union all select 'f_security_definer_functions', count(*)::text from pg_proc where pronamespace = 'public'::regnamespace and prosecdef
union all select 'g_triggers', count(*)::text from pg_trigger t join pg_class c on c.oid = t.tgrelid where c.relnamespace = 'public'::regnamespace and not t.tgisinternal
union all select 'h_sequences', count(*)::text from pg_sequences where schemaname = 'public'
union all select 'i_enums', count(*)::text from pg_type where typnamespace = 'public'::regnamespace and typtype = 'e'
union all select 'j_rls_enabled_tables', count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity
union all select 'k_rls_forced_tables', count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relforcerowsecurity
union all select 'l_policies', count(*)::text from pg_policies
union all select 'm_atlas_app_table_grants', count(*)::text from information_schema.role_table_grants where grantee = 'atlas_app'
union all select 'n_atlas_app_routine_grants', count(*)::text from information_schema.role_routine_grants where grantee = 'atlas_app'
union all select 'o_default_acls', count(*)::text from pg_default_acl
union all select 'p_rls_enabled_not_forced', count(*)::text from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relrowsecurity and not relforcerowsecurity
order by 1"
  prod_ro -c "$inv" > "$d/inventory.prod" && drill_sql -c "$inv" > "$d/inventory.drill" \
    && [ -s "$d/inventory.prod" ] && [ -s "$d/inventory.drill" ] && diff "$d/inventory.prod" "$d/inventory.drill" > /dev/null \
    && ev V2_inventory MATCH || { ev V2_inventory DIFFERENT; diff "$d/inventory.prod" "$d/inventory.drill"; fail=1; }
  _gate V2 || { echo "VERIFY=FAIL (S2)"; return 1; }
  # V3a schema text, CHECK lines excluded (PostgreSQL re-normalizes CHECK text on restore) ...
  _schema_text || { echo "FAIL V3a"; fail=1; }
  _gate V3a || { echo "VERIFY=FAIL (S2)"; return 1; }
  # V3b ... and every production CHECK compared semantically inside a rolled-back drill transaction
  _check_semantics || { echo "FAIL V3b"; fail=1; }
  _gate V3b || { echo "VERIFY=FAIL (S2)"; return 1; }
  out=$(drill_sql -c "select coalesce(string_agg(rolname, ','), '') from pg_roles where (rolsuper or rolbypassrls) and rolname not like 'pg\\_%'")
  ev V5_drill_super_or_bypass "$out"; [ "$out" = "$(_pguser)" ] || { echo "FAIL V5a: $out"; fail=1; }
  out=$(drill_sql -c "select count(*) from pg_class c join pg_roles r on r.oid = c.relowner where r.rolname = 'atlas_app'")
  ev V5_app_owned_objects "$out"; [ "$out" = 0 ] || { echo "FAIL V5b"; fail=1; }
  _gate V5 || { echo "VERIFY=FAIL (S2)"; return 1; }
  out=$(drill_sql <<'SQL'
BEGIN;
SET LOCAL ROLE atlas_app;
SELECT 'no_context', (SELECT count(*) FROM users), (SELECT count(*) FROM organizations), (SELECT count(*) FROM academies),
       (SELECT count(*) FROM academy_students), (SELECT count(*) FROM enrollments), (SELECT count(*) FROM payments),
       (SELECT count(*) FROM audit_log_entries);
ROLLBACK;
SQL
)
  ev V7 "$out"; [ "$out" = 'no_context|0|0|0|0|0|0|0' ] || { echo "FAIL V7"; fail=1; }
  _gate V7 || { echo "VERIFY=FAIL (S2)"; return 1; }
  pubc=$(drill_sql -c "select count(*) from courses where status = 'published' and visibility = 'public'")
  out=$(drill_sql -v pub="$pubc" <<'SQL'
BEGIN;
SET LOCAL ROLE atlas_app;
SELECT (SELECT count(*) FROM courses) = :pub, (SELECT count(*) FROM courses WHERE NOT (status = 'published' AND visibility = 'public'));
ROLLBACK;
SQL
)
  ev V8 "$out"; [ "$out" = 't|0' ] || { echo "FAIL V8"; fail=1; }
  _gate V8 || { echo "VERIFY=FAIL (S2)"; return 1; }
  org=$(drill_sql -c "select o.id from organizations o where exists (select 1 from academies a where a.organization_id = o.id) and exists (select 1 from academies a where a.organization_id <> o.id) order by o.created_at limit 1")
  if [ -z "$org" ]; then ev V9 INCONCLUSIVE; fail=1
  else
    aacad=$(drill_sql -v org="$org" <<'SQL'
SELECT count(*) FROM academies WHERE organization_id = :'org';
SQL
)
    out=$(drill_sql -v org="$org" <<'SQL'
BEGIN;
SET LOCAL "app.current_organization_id" = :'org';
SET LOCAL ROLE atlas_app;
SELECT 'org_ctx', (SELECT count(*) FROM organizations), (SELECT count(*) FROM organizations WHERE id <> :'org'),
       (SELECT count(*) FROM academies WHERE organization_id <> :'org'), (SELECT count(*) FROM academies WHERE organization_id = :'org');
ROLLBACK;
SQL
)
    ev V9 "$out (expected org_ctx|1|0|0|$aacad)"; [ "$out" = "org_ctx|1|0|0|$aacad" ] || { echo "FAIL V9"; fail=1; }
  fi
  ev V10_rowcounts "$(st_get_ev rowcount_not_ok) not ok of $(st_get_ev rowcount_tables) tables"
  out=$(drill_sql -c "select (select count(*) from academies a left join organizations o on o.id = a.organization_id where o.id is null) || '|' || (select count(*) from academy_students s left join academies a on a.id = s.academy_id where a.id is null)")
  ev V11 "$out"; [ "$out" = '0|0' ] || { echo "FAIL V11"; fail=1; }
  _gate V11 || { echo "VERIFY=FAIL (S2)"; return 1; }
  if out=$(_prod_unchanged); then ev V12_prod_unchanged yes; else ev V12_prod_unchanged no; echo "FAIL V12: production changed during the drill: $out"; fail=1; fi
  ev V13_rpo_min "$(st_get backup_age_min)"
  ev V13_rto_restore_seconds "$(st_get_ev restore_seconds)"
  _gate final || { echo "VERIFY=FAIL (S2)"; return 1; }
  if [ "$fail" = 0 ]; then st_set verify_ok "$(_ts)"; echo "VERIFY=PASS"; else echo "VERIFY=FAIL (S7)"; return 1; fi
}
st_get_ev() { local d; d=$(drill_dir) || return 1; sed -n "s/^$1=//p" "$d/evidence.txt" 2>/dev/null | tail -1; }
_check_migrations() { # V4: every _prisma_migrations row of the restored copy equals production's at pre-flight
  local d p r miss extra chg unf; d=$(drill_dir); p="$d/prod.migrations"; r="$d/drill.migrations"
  [ -s "$p" ] || { ev V4_history NO_BASELINE; echo "FAIL V4: no production migration history recorded at pre-flight"; return 1; }
  drill_sql -c "$DRILL_MIG_Q" | LC_ALL=C sort > "$r" && [ -s "$r" ] || { ev V4_history UNREADABLE; echo "FAIL V4: restored migration history unreadable"; return 1; }
  miss=$(LC_ALL=C comm -23 "$p" "$r" | wc -l); extra=$(LC_ALL=C comm -13 "$p" "$r" | wc -l)
  chg=$(LC_ALL=C comm -12 <(LC_ALL=C comm -23 "$p" "$r" | cut -d'|' -f1 | LC_ALL=C sort -u) <(LC_ALL=C comm -13 "$p" "$r" | cut -d'|' -f1 | LC_ALL=C sort -u) | wc -l)
  unf=$(grep -c -v '|true|false$' "$r")
  ev V4_prod_rows "$(wc -l < "$p")"; ev V4_drill_rows "$(wc -l < "$r")"
  ev V4_only_in_prod "$miss"; ev V4_only_in_drill "$extra"; ev V4_changed_names "$chg"; ev V4_drill_unfinished_or_rolled_back "$unf"
  ev V4_drill_sha256 "$(sha256sum < "$r" | cut -c1-64)"
  if [ "$miss" = 0 ] && [ "$extra" = 0 ] && [ "$unf" = 0 ] && cmp -s "$p" "$r"; then ev V4_history MATCH; return 0; fi
  ev V4_history DIFFERENT
  echo "FAIL V4: migration history differs from production at pre-flight (only_in_prod=$miss only_in_drill=$extra changed_names=$chg unfinished_or_rolled_back=$unf)"
  return 1
}
_norm_schema() { grep -vE '^(--|\\restrict|\\unrestrict)' | sed '/^$/d'; }
_schema_text() {
  local d u p ndiff cdiff; d=$(drill_dir); u=$(_pguser) || return 1; p=$(_pgdb) || return 1
  ( set -o pipefail
    cd "$ATLAS_DIR" && docker compose exec -T -e PGOPTIONS='-c default_transaction_read_only=on' postgres \
      pg_dump --lock-wait-timeout=5s -U "$u" -d "$p" --schema-only | _norm_schema > "$d/schema.prod.sql" ) || { echo "schema dump (production) failed"; return 1; }
  drill_guard || return 1
  ( set -o pipefail; docker exec "$DRILL_CT" pg_dump -U "$u" -d "$DRILL_DB" --schema-only | _norm_schema > "$d/schema.drill.sql" ) || { echo "schema dump (drill) failed"; return 1; }
  [ -s "$d/schema.prod.sql" ] && [ -s "$d/schema.drill.sql" ] || { echo "empty schema dump"; return 1; }
  diff "$d/schema.prod.sql" "$d/schema.drill.sql" > "$d/schema.diff"
  ndiff=$(grep -E '^[<>]' "$d/schema.diff" | grep -vcE 'CONSTRAINT [a-z0-9_]+ CHECK')
  cdiff=$(grep -E '^[<>]' "$d/schema.diff" | grep -cE 'CONSTRAINT [a-z0-9_]+ CHECK')
  ev V3a_non_check_diff_lines "$ndiff"; ev V3a_check_text_diff_lines "$cdiff"
  [ "$ndiff" = 0 ]
}
_check_semantics() {
  local d gen out; d=$(drill_dir)
  gen=$(prod_ro -c "select format(E'ALTER TABLE %I.%I ADD CONSTRAINT %I %s NOT VALID;\nINSERT INTO pg_temp.zz_cmp VALUES (%L, %L, %L, %L);',
      n.nspname, c.relname, 'zzcmp_' || substr(md5(co.conname), 1, 24),
      regexp_replace(pg_get_constraintdef(co.oid), ' NOT VALID\$', ''),
      n.nspname, c.relname, co.conname, 'zzcmp_' || substr(md5(co.conname), 1, 24))
    from pg_constraint co join pg_class c on c.oid = co.conrelid join pg_namespace n on n.oid = c.relnamespace
    where co.contype = 'c' and n.nspname in ('public', 'atlas_migration_backups') order by n.nspname, c.relname, co.conname") \
    || { echo "could not read production CHECK definitions"; return 1; }
  out=$( { printf 'BEGIN;\nCREATE TEMP TABLE zz_cmp (nsp text, rel text, conname text, tmpname text);\n'
           printf '%s\n' "$gen"
           printf "SELECT count(*) || '|' || count(*) FILTER (WHERE o.oid IS NULL) || '|' || count(*) FILTER (WHERE o.oid IS NOT NULL AND regexp_replace(pg_get_constraintdef(o.oid), ' NOT VALID\$', '') IS DISTINCT FROM regexp_replace(pg_get_constraintdef(t.oid), ' NOT VALID\$', ''))\n"
           printf "FROM pg_temp.zz_cmp z JOIN pg_namespace n ON n.nspname = z.nsp JOIN pg_class c ON c.relnamespace = n.oid AND c.relname = z.rel\n"
           printf "LEFT JOIN pg_constraint o ON o.conrelid = c.oid AND o.conname = z.conname LEFT JOIN pg_constraint t ON t.conrelid = c.oid AND t.conname = z.tmpname;\n"
           printf 'ROLLBACK;\n'; } | drill_sql ) || { echo "CHECK comparison transaction failed"; return 1; }
  ev V3b_check_semantics "total|missing_in_drill|different = $out"
  case "$out" in *'|0|0') [ "${out%%|*}" = "$(grep '^c_constraints_c|' "$d/inventory.drill" | cut -d'|' -f2)" ] ;; *) return 1 ;; esac
}

# ---------------------------------------------------------------- optional O1 / O2
drill_o1_r2() { # list the selected backup in R2; credentials passed by NAME, never on argv
  _need backup_file || return 1
  local f; f=$(st_get backup_file)
  docker image inspect amazon/aws-cli:2.17.61 > /dev/null 2>&1 || { echo "O1: aws-cli image not present locally; not pulled"; return 1; }
  ( set +x; set -a; . "$ATLAS_DIR/.env"; set +a
    AWS_ACCESS_KEY_ID="$R2_BACKUP_ACCESS_KEY_ID" AWS_SECRET_ACCESS_KEY="$R2_BACKUP_SECRET_ACCESS_KEY" \
      docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY amazon/aws-cli:2.17.61 \
      --endpoint-url "$R2_BACKUP_ENDPOINT" s3 ls "s3://$R2_BACKUP_BUCKET/$(basename "$f")" ) | tee -a "$(drill_dir)/evidence.txt"
  echo "local_bytes=$(stat -c %s "$f")"
}
drill_o2_migrate_status() { # prisma migrate status from the production backend image, drill network only (optional; V4 never depends on it)
  _need restore_ok be_image || return 1
  _gate O2 || return 1
  local u img; u=$(_pguser) || return 1; img=$(st_get be_image)
  ( set +x
    pw=$(docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$DRILL_CT" | sed -n 's/^POSTGRES_PASSWORD=//p')
    DATABASE_URL="postgresql://$u:$pw@$DRILL_CT:5432/$DRILL_DB" CHECKPOINT_DISABLE=1 \
      docker run --rm --network "$DRILL_NET" --label atlas.drill="$DRILL_LABEL" -e DATABASE_URL -e CHECKPOINT_DISABLE \
      "$img" npx prisma migrate status 2>&1 | grep -E 'migrations? found|up to date|not yet been applied|failed|Error' )
}

# ---------------------------------------------------------------- status, cleanup
# ---------------------------------------------------------------- post-restore gate: monitoring + deadline (fail closed)
_drill_live() { # prints the reason and returns 1 if any post-restore step must not run or continue
  local dl; dl=$(st_get deadline_epoch)
  _int "$dl" || { echo "no drill deadline recorded"; return 1; }
  [ "$(date +%s)" -lt "$dl" ] || { echo "the drill deadline $(date -u -d "@$dl" +%H:%M:%SZ) has passed"; return 1; }
  drill_watch_ok quiet || { echo "the disk watcher is not healthy (monitoring lost)"; return 1; }
  drill_guard 2> /dev/null || { echo "the drill container is not the running, labelled drill container"; return 1; }
}
_gate() { # $1 step name: on failure, stop the drill container (verified), record it, and fail the step
  local why d; why=$(_drill_live) && return 0
  d=$(drill_dir); ev gate_failed "$1: $why"
  echo "$(date -u +%T) GATE ($1): $why" >> "$d/watch.log"
  _drill_stop_ct "$d" "$DRILL_CT" "gate $1"
  echo "STOP ($1): $why. Nothing after this point counts; run drill_cleanup"
  return 1
}

drill_status() {
  local d r; d=$(drill_dir)
  echo "drill_dir=${d:-none}"
  [ -n "$d" ] && [ -f "$d/state" ] && sed 's/^/  state: /' "$d/state"
  for r in "container $DRILL_CT" "volume $DRILL_VOL" "network $DRILL_NET"; do
    set -- $r
    if _exists "$1" "$2"; then echo "  $1 $2: present label=$(_label "$1" "$2")$([ "$1" = container ] && echo " running=$(docker container inspect -f '{{.State.Running}}' "$2")")"
    else echo "  $1 $2: absent"; fi
  done
  [ -n "$d" ] && _int "$(st_get deadline_epoch)" && echo "  deadline: $(date -u -d "@$(st_get deadline_epoch)" +%Y-%m-%dT%H:%M:%SZ)$([ "$(date +%s)" -ge "$(st_get deadline_epoch)" ] && echo ' (PASSED)')"
  drill_watch_ok quiet && echo "  watcher: running" || echo "  watcher: not running$([ -n "$d" ] && [ -f "$d/watch.triggered" ] && echo " (triggered: $(cat "$d/watch.triggered"))")"
  if [ -n "$d" ] && [ -n "$(st_get restore_started)" ] && [ -z "$(st_get restore_ok)" ]; then
    echo "  NEXT: restore was started but did not pass -> drill_cleanup, then drill_begin (a new drill)"
  elif [ -n "$d" ] && [ -n "$(st_get closed)" ]; then echo "  NEXT: drill closed"
  elif _exists container "$DRILL_CT" && ! drill_guard 2> /dev/null; then echo "  NEXT: drill container not running (reboot/stop) -> drill_cleanup, then a new drill"
  fi
}
_rm_if_ours() { # kind name -> removes only an allow-listed name that carries atlas.drill=restore
  local kind=$1 name=$2 id
  _allowed_name "$kind" "$name" || { echo "REFUSED: '$name' is not an allow-listed drill $kind name"; return 1; }
  _exists "$kind" "$name" || { echo "absent: $kind $name (nothing to do)"; return 0; }
  [ "$(_label "$kind" "$name")" = "$DRILL_LABEL" ] || { echo "REFUSED: $kind $name exists WITHOUT label atlas.drill=$DRILL_LABEL: not removed, stop and ask"; return 1; }
  case "$kind" in
    container)
      id=$(docker container inspect -f '{{.Id}}|{{.Name}}' "$name") || return 1
      [ "${id#*|}" = "/$name" ] || { echo "REFUSED: container name mismatch (${id#*|})"; return 1; }
      docker rm -f "${id%%|*}" > /dev/null && echo "removed: container $name" ;;
    volume)
      docker volume rm "$name" > /dev/null && echo "removed: volume $name" ;;
    network)
      id=$(docker network inspect -f '{{.Id}}' "$name") || return 1
      docker network rm "$id" > /dev/null && echo "removed: network $name" ;;
  esac
}
drill_cleanup() {
  local rc=0 d pid
  d=$(drill_dir)
  # 1. stop the watcher (only our own process, identified by pid file + cmdline)
  if [ -n "$d" ] && [ -d "$d" ]; then
    touch "$d/watch.stop"
    for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do pid=$(cat "$d/watch.pid" 2>/dev/null); [ -z "$pid" ] && break; kill -0 "$pid" 2>/dev/null || break; sleep 1; done
    pid=$(cat "$d/watch.pid" 2>/dev/null)
    if _int "$pid" && kill -0 "$pid" 2>/dev/null && grep -q _drill_watch_loop "/proc/$pid/cmdline" 2>/dev/null; then kill "$pid"; fi
  fi
  # 2. drill resources, container first (a volume or network in use cannot be removed)
  _rm_if_ours container "$DRILL_CT" || rc=1
  _rm_if_ours volume "$DRILL_VOL" || rc=1
  _rm_if_ours network "$DRILL_NET" || rc=1
  # 3. derived files that are not evidence, in EVERY drill directory (a resumed session may differ)
  case "$DRILL_ROOT" in /*/restore-drill) ;; *) echo "REFUSED: unexpected DRILL_ROOT"; return 1 ;; esac
  find "$DRILL_ROOT" -mindepth 2 -maxdepth 2 -type f \
    \( -name schema.prod.sql -o -name schema.drill.sql -o -name schema.diff -o -name restore.out -o -name restore.err -o -name restore.guard -o -name restore.guard.fired \) \
    -print -delete
  # 4. verify
  echo "labelled containers=$(docker ps -aq --filter label=atlas.drill=$DRILL_LABEL | wc -l) volumes=$(docker volume ls -q --filter label=atlas.drill=$DRILL_LABEL | wc -l) networks=$(docker network ls -q --filter label=atlas.drill=$DRILL_LABEL | wc -l)"
  # 5. production compared with the pre-flight baseline (report only; it never changes what cleanup removes)
  if [ -n "$d" ] && [ -s "$d/prod.baseline" ]; then
    local out
    if out=$(_prod_unchanged); then ev prod_unchanged_at_cleanup yes
    else ev prod_unchanged_at_cleanup no; echo "WARNING: production containers changed since pre-flight: $out"; fi
  fi
  if [ "$rc" = 0 ] && [ -n "$d" ] && [ -d "$d" ]; then st_set closed "$(_ts)"; fi
  [ "$rc" = 0 ] && echo "CLEANUP=PASS" || echo "CLEANUP=INCOMPLETE (a resource was refused; see above)"
  return "$rc"
}
