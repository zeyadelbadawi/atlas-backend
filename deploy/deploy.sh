#!/usr/bin/env bash
# Atlas production deploy — run on the VPS as the `deploy` user (invoked
# over SSH by the GitHub Actions workflow). Never invoked with sudo; the
# deploy user's docker-group membership is what grants Docker access.
set -euo pipefail
cd /opt/atlas
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
