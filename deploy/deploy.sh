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
#   deploy.sh --preflight     P64 Phase 1 — take a VERIFIED backup and
#                             record the pre-migration counts, then stop.
#                             Rolls nothing, migrates nothing; this is how
#                             an operator sizes the migration window.
#   deploy.sh --with-migrations
#                             combines with the above; the ONLY way a
#                             pending migration is ever applied. Without
#                             it a deploy that carries pending migrations
#                             aborts before touching the schema.
#
# P64 Phase 1 — WHY THE MIGRATION GATE EXISTS:
#   Until now a push to `main` migrated production as a side effect of
#   deploying, with no backup tied to the change and no chance to measure
#   what the migration would rewrite. The Phase 1 migration renumbers
#   `quiz_attempts.attempt_number` and closes stale in-progress attempts
#   as failed — learner-visible data with no code-level undo, since
#   `--rollback` re-pins images and never reverts a migration. So a
#   pending migration now REQUIRES `--with-migrations`, and applying one
#   always runs a verified backup and records the counts first. A deploy
#   carrying no pending migration is completely unaffected: the gate
#   costs nothing and does nothing.
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
# P64 Phase 1 — a LOOP, not a single `case`: `--with-migrations` has to be
# combinable with `--sync-env` (the backend workflow always passes that
# one), which a single positional arm cannot express. Every previously
# valid invocation still parses to exactly the same MODE.
WITH_MIGRATIONS=0
for arg in "$@"; do
  case "$arg" in
    --sync-env) MODE="sync-env" ;;
    --frontend-only) MODE="frontend-only" ;;
    --rollback) MODE="rollback" ;;
    --preflight) MODE="preflight" ;;
    --with-migrations) WITH_MIGRATIONS=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

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

# Persist the currently running application image digests for rollback.
record_last_good() {
  {
    echo "BACKEND_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' "$(docker compose ps -q backend)" 2>/dev/null || true)"
    echo "CADDY_IMAGE=$(docker inspect --format='{{index .RepoDigests 0}}' "$(docker compose ps -q caddy)" 2>/dev/null || true)"
    echo "RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > /opt/atlas/.last-good.tmp && mv /opt/atlas/.last-good.tmp /opt/atlas/.last-good
}

# --- P64 Phase 1: pre-migration safety ------------------------------------
#
# All three helpers below are used ONLY when a migration is actually
# pending, so a routine deploy never pays for them.

psql_prod() {
  docker compose exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -A "$@"
}

# How many migrations the image carries that the database has not applied.
# Deliberately a count comparison rather than parsing `prisma migrate
# status`: the text and exit codes of that command are version-dependent,
# and this is the fact we actually need. `set -e` aborts if either side
# cannot be read, so an unreadable database can never be mistaken for
# "nothing pending".
pending_migration_count() {
  local in_image applied
  in_image=$(docker compose run --rm --no-deps --entrypoint sh backend \
    -c 'ls -1 /app/prisma/migrations | grep -c "^[0-9]"' | tr -d '\r')
  applied=$(psql_prod -c \
    "select count(*) from _prisma_migrations where finished_at is not null" | tr -d '\r')
  echo $(( in_image - applied ))
}

# The counts the master plan requires before the migration runs. These are
# the migration's OWN predicates, so each number is a dry run of exactly
# what it will rewrite — not an approximation. Written to a timestamped
# evidence file that the operator returns with the deployment record.
record_precheck_counts() {
  local dir=/opt/atlas/migration-evidence
  mkdir -p "$dir"
  local out="$dir/precheck-$(date -u +%Y%m%dT%H%M%SZ).txt"
  {
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    psql_prod -F= -c "
      WITH ordered AS (
        SELECT id, attempt_number,
               ROW_NUMBER() OVER (PARTITION BY quiz_id, student_id
                                  ORDER BY created_at, id) AS rn
        FROM quiz_attempts
      )
      SELECT 'rows_to_renumber', count(*) FROM ordered WHERE attempt_number <> rn
      UNION ALL
      SELECT 'duplicate_number_groups', count(*) FROM (
        SELECT quiz_id, student_id, attempt_number FROM quiz_attempts
        GROUP BY 1,2,3 HAVING count(*) > 1) d
      UNION ALL
      SELECT 'attempts_to_close', count(*) FROM (
        SELECT id, ROW_NUMBER() OVER (PARTITION BY quiz_id, student_id
                                      ORDER BY created_at DESC, id DESC) AS rn
        FROM quiz_attempts WHERE status = 'in_progress') o WHERE rn > 1
      UNION ALL
      SELECT 'in_progress_total', count(*)
        FROM quiz_attempts WHERE status = 'in_progress'"
  } > "$out"
  echo "==> Pre-migration counts recorded in $out"
  cat "$out"
}

# Wait for both the backend endpoint and Caddy container to become healthy.
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

# --- P64 Phase 1: the migration gate -------------------------------------
#
# Positioned HERE on purpose: the database is up (so the check can read
# it) and the stack has NOT been rolled yet (line below), so every exit
# path out of this block leaves the previously running containers serving
# traffic untouched.
PENDING=$(pending_migration_count)
if [ "$PENDING" -gt 0 ] || [ "$MODE" = "preflight" ]; then
  if [ "$MODE" != "preflight" ] && [ "$WITH_MIGRATIONS" != "1" ]; then
    echo "==> ${PENDING} migration(s) pending and migrations are NOT authorized." >&2
    echo "    Nothing was migrated and nothing was rolled; the running stack is untouched." >&2
    echo "    To apply them: dispatch the Deploy workflow with apply_migrations=true," >&2
    echo "    which additionally requires approval of the protected production" >&2
    echo "    environment, or run: deploy.sh --with-migrations" >&2
    exit 1
  fi

  echo "==> ${PENDING} migration(s) pending — taking a verified backup first"
  # Fails closed: `backup.sh` exits non-zero on a truncated, unreadable or
  # incomplete dump, and `set -e` aborts here, BEFORE any schema change.
  bash /opt/atlas/backup.sh
  record_precheck_counts
else
  echo "==> No pending migrations; skipping backup and pre-migration counts"
fi

if [ "$MODE" = "preflight" ]; then
  echo "==> Preflight complete. Nothing was migrated, nothing was rolled."
  exit 0
fi

if [ "$PENDING" -gt 0 ]; then
  echo "==> Running database migrations (one-off, against the superuser
      connection Prisma CLI needs for DDL — the app itself always connects
      as atlas_app, never this)"
  docker compose run --rm --no-deps \
    -e DATABASE_URL="${DATABASE_URL}" \
    backend npx prisma migrate deploy
fi

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
