#!/usr/bin/env bash
# Atlas — server-side half of the `Customer ledger backfill` workflow
# (.github/workflows/customer-ledger-backfill.yml). Run ON the VPS, from
# /opt/atlas, over the restricted deploy identity, fed through stdin like
# deploy/release-verify/remote.sh.
#
#   remote.sh dry-run   counts what would be recorded; writes nothing
#   remote.sh apply     pre-run state, verified dump of both ledgers,
#                       apply, post-run state
#   remote.sh verify    read-only post-state counts and invariants
#
# APPROVED by the product owner on 4 Oct 2026 for production: trials from
# evidence and prior paying customers (`--gifts`), WITHOUT
# `--include-auto-trial-era` (inferred, not evidence — never passed here).
#
# Every mode runs the compiled script inside the RUNNING backend container,
# so it uses the backend's own env (the superuser DATABASE_URL and the same
# identity key the application uses):
#   docker compose exec -T backend node dist/scripts/backfill-customer-ledgers.js \
#     --gifts --allow-production [--apply | --verify]
#
# SAFETY
#   * apply holds deploy.sh's host lock (/opt/atlas/.deploy.lock), so no
#     deploy from either repository can roll the backend mid-run.
#   * apply refuses unless CUSTOMER_IDENTITY_HMAC_KEY is pinned in .env
#     (deploy.sh pins the derived value) AND the running backend has loaded
#     that same value — so the ledger and the application keep agreeing
#     after any future rotation of PAYMENT_CREDENTIALS_ENCRYPTION_KEY.
#   * apply first takes a data-only pg_dump of trial_redemptions and
#     paid_gift_redemptions to /opt/atlas/backups/ledger-backfill-<UTC>.sql.gz
#     (0600; not pruned by backup.sh, which only prunes atlas-*.sql.gz),
#     checks it is non-empty, gzip-valid and holds both tables, and aborts
#     before writing anything if not.
#   * The script itself: key check against live v2 rows, INSERT ... ON
#     CONFLICT DO NOTHING (skipDuplicates) after a pre-check, idempotent.
#   * Output is counts and yes/no only: never an email, a hash or a key.
#
# RECOVERY (as the migration superuser, POSTGRES_USER; atlas_app has no
# DELETE on these tables). Run from /opt/atlas with `set -a; . ./.env; set +a`.
#
#   (1) Preferred — remove exactly the rows the backfill added, keeping every
#       claim and gift recorded since. Valid when the apply run's PRE-RUN
#       line read "backfill rows (trials, gifts): 0, 0" (no backfill row
#       existed before the first run):
#
#         docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#           -v ON_ERROR_STOP=1 -c "BEGIN;
#             DELETE FROM trial_redemptions     WHERE source = 'backfill';
#             DELETE FROM paid_gift_redemptions WHERE source = 'backfill';
#           COMMIT;"
#
#   (2) Full restore of both ledgers to the moment before the apply, from
#       the dump the apply printed. Any claim or gift recorded AFTER that
#       dump is lost (and its trial/gift becomes claimable again), so
#       prefer (1):
#
#         { echo 'BEGIN;'
#           echo 'TRUNCATE trial_redemptions, paid_gift_redemptions;'
#           gunzip -c backups/ledger-backfill-<UTC>.sql.gz
#           echo 'COMMIT;'
#         } | docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
#               -v ON_ERROR_STOP=1 -q
#
#   Then: remote.sh verify (or the workflow with mode=verify).
set -uo pipefail
cd /opt/atlas

MODE=${1:-}
case "$MODE" in
  dry-run | apply | verify) ;;
  *) echo "usage: remote.sh dry-run|apply|verify" >&2; exit 2 ;;
esac

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
SCRIPT=dist/scripts/backfill-customer-ledgers.js
# --gifts and --allow-production always; --include-auto-trial-era NEVER.
backfill() { docker compose exec -T backend node "$SCRIPT" --gifts --allow-production "$@"; }

echo "== Customer ledger backfill: $MODE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
if grep -Eq '^CUSTOMER_IDENTITY_HMAC_KEY=.' .env; then KEY_IN_ENV=yes; else KEY_IN_ENV=no; fi
echo "CUSTOMER_IDENTITY_HMAC_KEY present in .env: $KEY_IN_ENV"

if [ -z "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "FAIL  the backend container is not running" >&2
  exit 1
fi
if ! docker compose exec -T backend node -e "process.exit(require('node:fs').existsSync('$SCRIPT') ? 0 : 1)"; then
  echo "FAIL  the running backend image has no $SCRIPT (deploy the release that carries it first)" >&2
  exit 1
fi

# Whether the RUNNING backend loaded exactly the .env value. Compared as
# SHA-256 fingerprints inside this shell; neither the key nor a fingerprint
# is printed.
KEY_LOADED=no
if [ "$KEY_IN_ENV" = yes ]; then
  file_fp=$(env_value CUSTOMER_IDENTITY_HMAC_KEY | tr -d '\r\n' | sha256sum | cut -d' ' -f1)
  running_fp=$(docker compose exec -T backend node -e \
    'process.stdout.write(require("node:crypto").createHash("sha256").update(process.env.CUSTOMER_IDENTITY_HMAC_KEY || "").digest("hex"))' 2>/dev/null)
  [ -n "$running_fp" ] && [ "$running_fp" = "$file_fp" ] && KEY_LOADED=yes
  unset file_fp running_fp
fi
echo "running backend loaded the pinned key: $KEY_LOADED"

case "$MODE" in
  dry-run)
    backfill
    exit $?
    ;;
  verify)
    backfill --verify
    exit $?
    ;;
esac

# ---- apply -----------------------------------------------------------------
# deploy.sh's host lock: the workflow's concurrency group only covers this
# repository, so the frontend repository's deploys are excluded here.
exec 9>/opt/atlas/.deploy.lock
if ! flock -w 600 9; then
  echo "REFUSED  a deploy holds /opt/atlas/.deploy.lock (waited 10 min). Nothing was written." >&2
  exit 1
fi
if [ "$KEY_IN_ENV" != yes ]; then
  echo "REFUSED  CUSTOMER_IDENTITY_HMAC_KEY is not pinned in .env. Deploy first (deploy.sh pins" >&2
  echo "         the derived value), then re-run. Nothing was written." >&2
  exit 1
fi
if [ "$KEY_LOADED" != yes ]; then
  echo "REFUSED  the running backend has not loaded the pinned CUSTOMER_IDENTITY_HMAC_KEY" >&2
  echo "         (recreate it: docker compose up -d --force-recreate --no-deps backend). Nothing was written." >&2
  exit 1
fi

echo "== Pre-run state (the 'backfill rows' line is the pre-run count of source='backfill' rows)"
if ! backfill --verify; then
  echo "REFUSED  the pre-run check failed (key check or invariant). Nothing was written." >&2
  exit 1
fi

echo "== Data-only dump of trial_redemptions + paid_gift_redemptions"
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
mkdir -p /opt/atlas/backups
DUMP="/opt/atlas/backups/ledger-backfill-$(date -u +%Y%m%dT%H%M%SZ).sql.gz"
( umask 077
  docker compose exec -T postgres pg_dump -U "$PGUSER_" -d "$PGDB_" --data-only \
    --table=public.trial_redemptions --table=public.paid_gift_redemptions \
    | gzip > "$DUMP" )
dump_rc=$?
tables=$(gunzip -c "$DUMP" 2>/dev/null | grep -cE '^COPY public\.(trial_redemptions|paid_gift_redemptions) ')
if [ "$dump_rc" != 0 ] || [ ! -s "$DUMP" ] || ! gzip -t "$DUMP" 2>/dev/null || [ "$tables" != 2 ]; then
  rm -f "$DUMP" # never leave a broken file that looks like a backup
  echo "REFUSED  the dump failed verification (rc=$dump_rc, tables=$tables). Nothing was written." >&2
  exit 1
fi
echo "dump: $(basename "$DUMP") ($(stat -c %s "$DUMP") bytes, gzip OK, 2 tables)"

echo "== Apply"
if ! backfill --apply; then
  echo "FAIL  the apply step failed. Inspect with mode=verify; recovery is in this script's header" >&2
  echo "      (dump: $(basename "$DUMP"))." >&2
  exit 1
fi

echo "== Post-run verify"
backfill --verify
