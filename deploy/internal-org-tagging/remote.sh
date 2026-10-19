#!/usr/bin/env bash
# B0-CAT-01 / B0-ANL-04 — tag the test organizations as internal
# (`organization_platform_flags.is_internal = true`), run on the VPS by
# .github/workflows/internal-org-tagging.yml. APPROVED by the product owner
# on 19 Oct 2026 ("tagging the test organizations"), on the owner's
# statement of the same day that every organization in production is test
# data: the plan is every organization that exists when the dry run runs,
# and nothing created after it.
#
# WHAT IT CHANGES (apply): for each planned organization that still exists
# and is not tagged, one `organization_platform_flags` row with
# `is_internal = true` (inserted, or flipped from false). Nothing else.
# `updated_by_user_id` stays NULL: this is not run as a user, and the
# Platform Owner account is not used (DL-29). Effect: MRR and the active /
# unpaid-active counts on the platform dashboard exclude these
# organizations (ANL-04), exactly as the console switch does.
#
#   remote.sh dry-run <run id>                read-only; stores the planned
#                                             ids as plan-<run id>.txt
#   remote.sh apply   <run id> <plan run id>  one transaction; stores the ids
#                                             it changed as applied-<run id>.txt
#   remote.sh revert  <run id> <apply run id> one transaction; sets
#                                             is_internal back to false for
#                                             exactly those ids, where still true
#
# Organization ids stay on the VPS (0600, under $STORE); the run log prints
# counts only.
#
# Not written: an audit_log_entries row (`organization.internal_flag_changed`
# needs an actor user and this is not run as one). The workflow run's
# approval record and the stored id lists are the record, as for Catalog
# containment.
set -euo pipefail
cd "${INTERNAL_TAGGING_DIR:-/opt/atlas}" || { echo "FAIL  cannot enter the app directory" >&2; exit 1; }

MODE="${1:-}"
RUN_ID="${2:-}"
REF="${3:-}"
STORE="${INTERNAL_TAGGING_STORE:-/opt/atlas/backups/internal-org-tagging}"

usage() { echo "usage: remote.sh dry-run <run id> | apply <run id> <plan run id> | revert <run id> <apply run id>" >&2; exit 2; }
is_id() { [[ "$1" =~ ^[0-9]{1,20}$ ]]; }
case "$MODE" in
  dry-run) is_id "$RUN_ID" || usage ;;
  apply | revert) is_id "$RUN_ID" && is_id "$REF" || usage ;;
  *) usage ;;
esac

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
psql_() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -v ON_ERROR_STOP=1 "$@"; }
sql() { psql_ -t -A -F'|' -c "$1"; }

report() {
  echo "== Organizations ($1)"
  sql "select o.status, count(*), count(*) filter (where f.is_internal) from organizations o left join organization_platform_flags f on f.organization_id = o.id group by o.status order by o.status" \
    | while IFS='|' read -r st n tagged; do echo "organizations: status=$st count=$n tagged internal=$tagged"; done
}

# Feeds one id per line from $1 into a temp table `ids`, then runs $2, all in
# one transaction; prints what $2 selects.
with_ids() {
  { echo 'BEGIN;'
    echo 'CREATE TEMP TABLE ids (id text PRIMARY KEY) ON COMMIT DROP;'
    echo 'COPY ids FROM STDIN;'
    cat "$1"
    echo '\.'
    echo "$2"
    echo 'COMMIT;'
  } | psql_ -q -t -A
}

echo "== Internal organization tagging: $MODE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
mkdir -p "$STORE"
chmod 700 "$STORE"

case "$MODE" in
  dry-run)
    report "now; nothing is written"
    plan="$STORE/plan-$RUN_ID.txt"
    ( umask 077; sql "select id from organizations order by id" > "$plan" )
    n=$(grep -c . "$plan" || true)
    already=$(sql "select count(*) from organization_platform_flags where is_internal")
    echo "planned: $n organizations (every organization now); already tagged: $already"
    echo "plan stored: $(basename "$plan") (sha256 $(sha256sum "$plan" | cut -c1-12))"
    echo "To apply exactly this plan: mode=apply, ref_run_id=$RUN_ID"
    ;;
  apply)
    plan="$STORE/plan-$REF.txt"
    [ -s "$plan" ] || { echo "REFUSED  $(basename "$plan") is not stored on the VPS (run the dry run first). Nothing was written." >&2; exit 1; }
    echo "plan: $(basename "$plan") (sha256 $(sha256sum "$plan" | cut -c1-12), $(grep -c . "$plan") ids)"
    report "before"
    applied="$STORE/applied-$RUN_ID.txt"
    # RETURNING lists exactly the rows this run changed: an organization
    # already tagged is left alone (the conflict update's WHERE), one deleted
    # since the dry run is not in the join.
    ( umask 077
      with_ids "$plan" "
        INSERT INTO organization_platform_flags (organization_id, is_internal, updated_by_user_id, updated_at)
        SELECT o.id, true, NULL, now() FROM organizations o JOIN ids ON ids.id = o.id
        ON CONFLICT (organization_id) DO UPDATE
          SET is_internal = true, updated_by_user_id = NULL, updated_at = now()
          WHERE organization_platform_flags.is_internal = false
        RETURNING organization_id;" > "$applied.tmp" ) \
      || { rm -f "$applied.tmp"; echo "FAIL  apply failed; the transaction rolled back, nothing changed" >&2; exit 1; }
    mv "$applied.tmp" "$applied"
    echo "tagged now: $(grep -c . "$applied" || true) organizations"
    echo "applied stored: $(basename "$applied") (sha256 $(sha256sum "$applied" | cut -c1-12))"
    report "after"
    echo "To undo: mode=revert, ref_run_id=$RUN_ID"
    ;;
  revert)
    applied="$STORE/applied-$REF.txt"
    [ -f "$applied" ] || { echo "REFUSED  $(basename "$applied") is not stored on the VPS. Nothing was written." >&2; exit 1; }
    report "before"
    reverted="$STORE/reverted-$RUN_ID.txt"
    # Back to the default (false) for exactly the ids that apply changed and
    # that are still tagged; the rows stay, as `false` (the same as no row).
    ( umask 077
      with_ids "$applied" "
        UPDATE organization_platform_flags f
           SET is_internal = false, updated_by_user_id = NULL, updated_at = now()
          FROM ids WHERE f.organization_id = ids.id AND f.is_internal
        RETURNING f.organization_id;" > "$reverted.tmp" ) \
      || { rm -f "$reverted.tmp"; echo "FAIL  revert failed; the transaction rolled back, nothing changed" >&2; exit 1; }
    mv "$reverted.tmp" "$reverted"
    echo "untagged now: $(grep -c . "$reverted" || true) organizations"
    report "after"
    ;;
esac
