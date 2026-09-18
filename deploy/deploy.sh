#!/usr/bin/env bash
# Atlas production deploy — run on the VPS as the `deploy` user (invoked
# over SSH by the GitHub Actions workflows of BOTH repos). Never invoked
# with sudo; the deploy user's docker-group membership is what grants
# Docker access.
#
# Modes:
#   deploy.sh                 full deploy (pull both images, migrate, roll)
#   deploy.sh --sync-env      full deploy, first upserting the base64 env
#                             fragment read from stdin into /opt/atlas/.env
#   deploy.sh --frontend-only pull and roll ONLY the Caddy/SPA image; no
#                             migration, no backend recreate (P63g — a
#                             frontend push must never migrate the DB)
#   deploy.sh --rollback      re-pin both images to the digests recorded
#                             by the last successful deploy and roll
#
# P63g — SAFETY:
#   * `flock` on /opt/atlas/.deploy.lock serialises every invocation on
#     this host, whichever repository triggered it (three concurrent
#     deploy.sh runs collided on 18 Sep 2026: "removal of container
#     already in progress").
#   * The image digests actually running after a healthy deploy are
#     recorded in /opt/atlas/.last-good so `--rollback` is one command.
#   * Health is gated on BOTH backend (/health) and Caddy (the compose
#     healthcheck on https://localhost/), not the backend alone.
#   * `docker compose up --wait` carries a timeout so a wedged database
#     fails the deploy instead of hanging the Actions job for hours.
set -euo pipefail
cd /opt/atlas

MODE="full"
case "${1:-}" in
  --sync-env) MODE="sync-env" ;;
  --frontend-only) MODE="frontend-only" ;;
  --rollback) MODE="rollback" ;;
  "") ;;
  *) echo "Unknown option: $1" >&2; exit 2 ;;
esac

# --- one deploy at a time on this host (cross-repository) ---
exec 9>/opt/atlas/.deploy.lock
if ! flock -w 900 9; then
  echo "==> Another deploy holds the lock (waited 15 min). Aborting." >&2
  exit 1
fi

# --- P50: propagate CI-managed environment into /opt/atlas/.env ---
#
# The four Zoom production variables (client id/secret, redirect URI,
# webhook secret token) are stored as GitHub Secrets and passed here,
# base64-encoded, on stdin when the deploy workflow invokes this script
# with `--sync-env`. This is the ONE authorized path for those values to
# reach the VPS; nothing is hand-edited and nothing is printed.
#
# SAFE BY CONSTRUCTION:
#   * Only NON-EMPTY values are ever sent (the workflow filters), so an
#     unset secret can never blank out a working value.
#   * The upsert works on a temp copy and atomically replaces .env, so a
#     mid-write failure cannot leave a half-written file.
#   * A key already present is replaced in place, never duplicated.
#   * No value is ever echoed; the script does not run under `set -x`.
#   * With no fragment on stdin the whole block is skipped and the deploy
#     behaves exactly as before.
#   * P63g: the rewritten file is refused if it came out smaller than
#     half the original — a grep failure can never truncate .env.
ENV_SYNCED=0
if [ "$MODE" = "sync-env" ]; then
  ENV_FRAGMENT_B64=$(cat)
  if [ -n "${ENV_FRAGMENT_B64}" ]; then
    echo "==> Syncing CI-managed environment into .env (values never printed)"
    tmp=$(mktemp)
    cp .env "$tmp"
    original_size=$(wc -c < .env)
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      key=${line%%=*}
      # Drop any existing line for this key (prefix match, no regex) — awk
      # always exits 0, so a "no match" can never be mistaken for a failure
      # and an empty output can never be promoted over the real file.
      awk -v k="${key}=" 'index($0, k) != 1' "$tmp" > "${tmp}.2"
      mv "${tmp}.2" "$tmp"
      printf '%s\n' "$line" >> "$tmp"
    done < <(printf '%s' "${ENV_FRAGMENT_B64}" | base64 -d)
    new_size=$(wc -c < "$tmp")
    if [ "$new_size" -lt $((original_size / 2)) ]; then
      echo "==> Refusing to replace .env: rewritten file is suspiciously small." >&2
      rm -f "$tmp"
      exit 1
    fi
    mv "$tmp" .env
    echo "==> Synced $(printf '%s' "${ENV_FRAGMENT_B64}" | base64 -d | grep -c '=') variable(s)"
    ENV_SYNCED=1
  fi
fi

set -a; source .env; set +a

record_last_good() {
  {
    echo "BACKEND_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' "$(docker compose ps -q backend)" 2>/dev/null || true)"
    echo "CADDY_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' "$(docker compose ps -q caddy)" 2>/dev/null || true)"
    echo "RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > /opt/atlas/.last-good.tmp && mv /opt/atlas/.last-good.tmp /opt/atlas/.last-good
}

wait_healthy() {
  echo "==> Waiting for backend health"
  local ok=0
  for i in $(seq 1 30); do
    if docker compose exec -T backend wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
      ok=1; break
    fi
    sleep 2
  done
  if [ "$ok" != "1" ]; then
    echo "Backend did not become healthy in time." >&2
    docker compose logs --tail=100 backend >&2
    return 1
  fi
  echo "Backend healthy."
  echo "==> Waiting for Caddy health (TLS + SPA)"
  ok=0
  for i in $(seq 1 30); do
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(docker compose ps -q caddy)" 2>/dev/null || echo none)
    if [ "$status" = "healthy" ] || [ "$status" = "none" ]; then
      ok=1; break
    fi
    sleep 3
  done
  if [ "$ok" != "1" ]; then
    echo "Caddy did not become healthy in time." >&2
    docker compose logs --tail=60 caddy >&2
    return 1
  fi
  echo "Caddy healthy."
  # End-to-end: the platform answers over HTTPS through the real stack.
  if ! docker compose exec -T caddy wget -qO- --no-check-certificate "https://localhost/" >/dev/null 2>&1; then
    echo "The platform document did not load through Caddy." >&2
    return 1
  fi
  return 0
}

if [ "$MODE" = "rollback" ]; then
  if [ ! -f /opt/atlas/.last-good ]; then
    echo "==> No .last-good record exists; nothing to roll back to." >&2
    exit 1
  fi
  # shellcheck disable=SC1091
  source /opt/atlas/.last-good
  echo "==> Rolling back to the images recorded at ${RECORDED_AT:-unknown}"
  [ -n "${BACKEND_IMAGE:-}" ] && docker pull "$BACKEND_IMAGE" && docker tag "$BACKEND_IMAGE" ghcr.io/zeyadelbadawi/atlas-backend:latest
  [ -n "${CADDY_IMAGE:-}" ] && docker pull "$CADDY_IMAGE" && docker tag "$CADDY_IMAGE" ghcr.io/zeyadelbadawi/atlas-frontend:latest
  docker compose up -d --no-deps backend caddy
  wait_healthy && exit 0
  exit 1
fi

if [ "$MODE" = "frontend-only" ]; then
  echo "==> Frontend-only deploy: pulling the Caddy/SPA image"
  docker compose pull caddy
  echo "==> Rolling Caddy only (no migration, backend untouched)"
  docker compose up -d --no-deps caddy
  if wait_healthy; then
    record_last_good
    exit 0
  fi
  exit 1
fi

echo "==> Pulling latest images"
docker compose pull

echo "==> Starting postgres + redis first (migrations need a live
    database — --no-deps alone won't start them on a fresh stack)"
docker compose up -d postgres redis
docker compose up --wait --wait-timeout 180 postgres redis

echo "==> Running database migrations (one-off, against the superuser
    connection Prisma CLI needs for DDL — the app itself always connects
    as atlas_app, never this)"
docker compose run --rm --no-deps \
  -e DATABASE_URL="${DATABASE_URL}" \
  backend npx prisma migrate deploy

echo "==> Starting/updating the stack"
docker compose up -d --remove-orphans

# Docker Compose does not reliably recreate a container when only the
# CONTENTS of its env_file change (the service config and image are
# unchanged), so a freshly-synced secret would sit in .env unread until
# the next image change. When we actually rewrote .env above, force the
# app container to be recreated so it picks the new value up. Scoped to
# `backend` with --no-deps so postgres/redis are never bounced.
if [ "${ENV_SYNCED:-0}" = "1" ]; then
  echo "==> Env changed — force-recreating backend to load it"
  docker compose up -d --force-recreate --no-deps backend
fi

if wait_healthy; then
  record_last_good
  echo "==> Deploy complete; last-good digests recorded (use --rollback to revert)."
  exit 0
fi
echo "==> Deploy failed health checks. Previous images remain available via --rollback." >&2
exit 1
