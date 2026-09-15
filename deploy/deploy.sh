#!/usr/bin/env bash
# Atlas production deploy — run on the VPS as the `deploy` user (invoked
# over SSH by the GitHub Actions workflow). Never invoked with sudo; the
# deploy user's docker-group membership is what grants Docker access.
set -euo pipefail
cd /opt/atlas

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
if [ "${1:-}" = "--sync-env" ]; then
  ENV_FRAGMENT_B64=$(cat)
  if [ -n "${ENV_FRAGMENT_B64}" ]; then
    echo "==> Syncing CI-managed environment into .env (values never printed)"
    tmp=$(mktemp)
    cp .env "$tmp"
    while IFS= read -r line || [ -n "$line" ]; do
      [ -z "$line" ] && continue
      key=${line%%=*}
      grep -v "^${key}=" "$tmp" > "${tmp}.2" 2>/dev/null || true
      mv "${tmp}.2" "$tmp"
      printf '%s\n' "$line" >> "$tmp"
    done < <(printf '%s' "${ENV_FRAGMENT_B64}" | base64 -d)
    mv "$tmp" .env
    echo "==> Synced $(printf '%s' "${ENV_FRAGMENT_B64}" | base64 -d | grep -c '=') variable(s)"
    ENV_SYNCED=1
  fi
fi

set -a; source .env; set +a

echo "==> Pulling latest images"
docker compose pull

echo "==> Starting postgres + redis first (migrations need a live
    database — --no-deps alone won't start them on a fresh stack)"
docker compose up -d postgres redis
docker compose up --wait postgres redis

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

echo "==> Waiting for backend health"
for i in $(seq 1 30); do
  if docker compose exec -T backend wget -qO- http://localhost:3000/health >/dev/null 2>&1; then
    echo "Backend healthy."
    exit 0
  fi
  sleep 2
done

echo "Backend did not become healthy in time." >&2
docker compose logs --tail=100 backend >&2
exit 1
