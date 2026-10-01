#!/usr/bin/env bash
# Disposable, isolated stack for the database-backed browser journeys.
#
#   scripts/e2e-local-stack.sh up      # fresh cluster + migrate + seed + fixtures
#   scripts/e2e-local-stack.sh env     # print the env file path (for sourcing)
#   scripts/e2e-local-stack.sh start   # restart services on the existing data (after a reboot)
#   scripts/e2e-local-stack.sh serve   # build + run the API (:3000) and the Vite app (:3001)
#   scripts/e2e-local-stack.sh stop    # stop the API and the app (by port), keep the data
#   scripts/e2e-local-stack.sh down    # stop and DELETE the cluster and data
#
# Everything lives under $E2E_STACK_DIR (default /tmp/atlas-e2e-stack): a
# private PostgreSQL 16 cluster on 127.0.0.1:$E2E_PG_PORT and a private Redis
# on 127.0.0.1:$E2E_REDIS_PORT. Nothing else on the machine is touched, and
# the script refuses to run if any database/Redis URL it would use points
# anywhere but 127.0.0.1 — it cannot reach, migrate or seed production.
# Credentials are throwaway local values generated per stack; the app role
# keeps the dev password its migration creates.
set -euo pipefail

STACK_DIR="${E2E_STACK_DIR:-/tmp/atlas-e2e-stack}"
PG_PORT="${E2E_PG_PORT:-54329}"
REDIS_PORT="${E2E_REDIS_PORT:-63799}"
S3_PORT="${E2E_S3_PORT:-49000}"
# A local S3-compatible store (s3rver, MIT) — the backend creates its buckets
# at boot. Install once outside the repo: npm i --prefix /tmp/atlas-tools s3rver
S3RVER="${E2E_S3RVER:-/tmp/atlas-tools/node_modules/.bin/s3rver}"
PG_BIN="${E2E_PG_BIN:-/usr/lib/postgresql/16/bin}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$STACK_DIR/backend.env"

guard_local() {
  for url in "$@"; do
    case "$url" in
      *@127.0.0.1:*|redis://127.0.0.1:*) ;;
      *) echo "REFUSING: $url is not a 127.0.0.1 URL" >&2; exit 2 ;;
    esac
  done
}

as_pg() {
  # The cluster must not run as root; reuse the postgres system user.
  if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

up() {
  down >/dev/null 2>&1 || true
  mkdir -p "$STACK_DIR/pg" "$STACK_DIR/redis"
  [ "$(id -u)" = 0 ] && chown -R postgres:postgres "$STACK_DIR/pg"
  as_pg "$PG_BIN/initdb" -D "$STACK_DIR/pg" -U atlas --auth=trust -E UTF8 >/dev/null
  as_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$STACK_DIR/pg/server.log" -w start >/dev/null
  psql -h 127.0.0.1 -p "$PG_PORT" -U atlas -d postgres -qc "CREATE DATABASE atlas_e2e" >/dev/null
  mkdir -p "$STACK_DIR/s3"
  nohup "$S3RVER" --address 127.0.0.1 --port "$S3_PORT" --directory "$STACK_DIR/s3" --silent \
    >"$STACK_DIR/s3.log" 2>&1 & echo $! > "$STACK_DIR/s3.pid"
  redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes \
    --dir "$STACK_DIR/redis" --logfile "$STACK_DIR/redis.log" >/dev/null

  local key webhook jwt
  key="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  webhook="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  jwt="$(head -c 48 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  cat > "$ENV_FILE" <<ENV
NODE_ENV=development
PORT=3000
DATABASE_URL=postgresql://atlas@127.0.0.1:$PG_PORT/atlas_e2e
APP_DATABASE_URL=postgresql://atlas_app:atlas_app_dev_password@127.0.0.1:$PG_PORT/atlas_e2e
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
CORS_ALLOWED_ORIGINS=http://localhost:3001
LOG_LEVEL=warn
R2_ENDPOINT=http://127.0.0.1:$S3_PORT
R2_REGION=us-east-1
R2_ACCESS_KEY_ID=S3RVER
R2_SECRET_ACCESS_KEY=S3RVER
R2_BUCKET=atlas-e2e
R2_PUBLIC_URL_BASE=http://127.0.0.1:$S3_PORT/atlas-e2e
R2_FORCE_PATH_STYLE=true
MEDIA_MAX_UPLOAD_BYTES=10485760
PAYMENT_WEBHOOK_SECRET=$webhook
JWT_ACCESS_SECRET=$jwt
EMAIL_DELIVERABILITY_CHECK_ENABLED=false
PAYMENT_CREDENTIALS_ENCRYPTION_KEY=$key
FLAG_QUIZ_ENGINE_V2_MODE=on
FLAG_QUIZ_INTEGRITY_MODE=on
ENV
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  guard_local "$DATABASE_URL" "$APP_DATABASE_URL" "$REDIS_URL"
  cd "$ROOT"
  npx prisma migrate deploy >/dev/null
  npm run -s db:seed >/dev/null
  npm run -s e2e:prepare-journeys >/dev/null
  echo "stack up: $ENV_FILE"
}

start_services() {
  # Idempotent: each service is started only if it is not already up.
  as_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" status >/dev/null 2>&1 ||
    as_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" -o "-p $PG_PORT -k /tmp -c listen_addresses=127.0.0.1" -l "$STACK_DIR/pg/server.log" -w start >/dev/null
  curl -s -o /dev/null "http://127.0.0.1:$S3_PORT/" || {
    nohup "$S3RVER" --address 127.0.0.1 --port "$S3_PORT" --directory "$STACK_DIR/s3" --silent \
      >"$STACK_DIR/s3.log" 2>&1 & echo $! > "$STACK_DIR/s3.pid"
  }
  redis-cli -h 127.0.0.1 -p "$REDIS_PORT" ping >/dev/null 2>&1 ||
    redis-server --port "$REDIS_PORT" --bind 127.0.0.1 --save '' --appendonly no --daemonize yes \
      --dir "$STACK_DIR/redis" --logfile "$STACK_DIR/redis.log" >/dev/null
  echo "services started on existing data"
}

serve() {
  # shellcheck disable=SC1090
  set -a; . "$ENV_FILE"; set +a
  guard_local "$DATABASE_URL" "$APP_DATABASE_URL" "$REDIS_URL"
  cd "$ROOT" && npm run -s build >/dev/null
  nohup node dist/main.js >"$STACK_DIR/backend.log" 2>&1 & echo $! > "$STACK_DIR/backend.pid"
  ( cd "${E2E_FRONTEND_DIR:-$ROOT/../atlas}" && nohup npx vite --port 3001 --strictPort \
      >"$STACK_DIR/frontend.log" 2>&1 & echo $! > "$STACK_DIR/frontend.pid" )
  for _ in $(seq 1 60); do
    curl -sf -o /dev/null http://127.0.0.1:3000/health && curl -sf -o /dev/null http://127.0.0.1:3001/ && { echo "serving: api :3000, app :3001"; return 0; }
    sleep 2
  done
  echo "servers did not become ready; see $STACK_DIR/*.log" >&2; return 1
}

stop_servers() {
  # By port: the pid files hold `npx`, whose child is the real server.
  for port in 3000 3001; do
    pids="$(lsof -t -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
  done
  echo "servers stopped"
}

down() {
  stop_servers >/dev/null 2>&1 || true
  [ -d "$STACK_DIR/pg" ] && as_pg "$PG_BIN/pg_ctl" -D "$STACK_DIR/pg" -m fast stop >/dev/null 2>&1 || true
  [ -f "$STACK_DIR/s3.pid" ] && kill "$(cat "$STACK_DIR/s3.pid")" 2>/dev/null || true
  redis-cli -h 127.0.0.1 -p "$REDIS_PORT" shutdown nosave >/dev/null 2>&1 || true
  rm -rf "$STACK_DIR"
  echo "stack removed"
}

case "${1:-}" in
  up) up ;;
  start) start_services ;;
  serve) serve ;;
  stop) stop_servers ;;
  down) down ;;
  env) echo "$ENV_FILE" ;;
  *) echo "usage: $0 up|start|serve|down|env" >&2; exit 64 ;;
esac
