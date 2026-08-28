#!/usr/bin/env bash
#
# safe-prisma-migrate-diff.sh — Phase P18 guardrail.
#
# Incident this exists to prevent (documented in full in
# Reports/ARCHITECTURE.md's P18 section): during P17, `prisma migrate diff
# --shadow-database-url "$DATABASE_URL"` was run directly, pointing the
# (disposable-by-design, always-wiped) shadow-database target at the real
# local development database. Prisma faithfully treated it as disposable —
# wiped the `public` schema, replayed migrations to reconstruct structure
# only, and all DATA was lost (recovered from the project's own seed
# script; no production system was ever involved).
#
# `prisma migrate diff --shadow-database-url <url>` is the ONLY Prisma
# subcommand in this project that can silently wipe whatever database
# <url> points at — `migrate dev`/`migrate deploy`/`migrate resolve` do
# not take a shadow-database-url and do not have this failure mode. This
# script is the ONE place that flag is ever constructed — never type
# `--shadow-database-url` directly in a terminal again.
#
# Usage:
#   scripts/safe-prisma-migrate-diff.sh <shadow-db-url> <extra prisma migrate diff args...>
#
# Refuses to run (exit 1, no Prisma command executed) if <shadow-db-url>
# textually matches DATABASE_URL or APP_DATABASE_URL from the loaded
# environment — the exact mistake that caused the incident. This is a
# best-effort string-equality guard, not a guarantee against every
# possible aliasing (e.g. a different hostname resolving to the same
# instance) — the real, durable rule is still: only ever pass a URL to a
# database you personally stood up as disposable for this one diff.
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <shadow-db-url> [additional 'prisma migrate diff' args...]" >&2
  echo "Refuses to run without an explicit shadow-db-url — never defaults to DATABASE_URL." >&2
  exit 1
fi

SHADOW_URL="$1"
shift

# Load .env the same way the Prisma CLI itself does, so this check sees
# the same DATABASE_URL/APP_DATABASE_URL values `npx prisma` would.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -n "${DATABASE_URL:-}" ] && [ "$SHADOW_URL" = "$DATABASE_URL" ]; then
  echo "REFUSING: shadow-database-url is identical to DATABASE_URL (the migration superuser connection)." >&2
  echo "This is exactly the P17 incident. Use a genuinely disposable database instead." >&2
  exit 1
fi

if [ -n "${APP_DATABASE_URL:-}" ] && [ "$SHADOW_URL" = "$APP_DATABASE_URL" ]; then
  echo "REFUSING: shadow-database-url is identical to APP_DATABASE_URL (the application runtime connection)." >&2
  echo "Use a genuinely disposable database instead." >&2
  exit 1
fi

echo "Shadow database URL differs from DATABASE_URL/APP_DATABASE_URL — proceeding." >&2
exec npx prisma migrate diff --shadow-database-url "$SHADOW_URL" "$@"
