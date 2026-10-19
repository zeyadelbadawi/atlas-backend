#!/usr/bin/env bash
# B0-WEB-09 — move every Academy website on a retired theme (Themes 2–5, or
# a key no code knows) to Theme 1, run on the VPS by
# .github/workflows/website-theme-retirement.yml. APPROVED by the product
# owner on 19 Oct 2026 ("move the 14 sites on retired themes").
#
# Every mode runs the compiled, reviewed script inside the RUNNING backend
# container (src/scripts/retire-website-themes.ts; its header says exactly
# what it writes: `website_configurations.theme_key` -> 'modern-education'
# and `config_version` + 1, nothing else, with a content fingerprint checked
# before and after the write in the same transaction):
#   docker compose exec -T backend node dist/scripts/retire-website-themes.js ...
#
#   remote.sh dry-run  <run id>              read-only; stores the plan as
#                                            plan-<run id>.json
#   remote.sh apply    <run id> <plan run>   applies exactly plan-<plan run>.json;
#                                            a website that changed since is
#                                            skipped; stores applied-<run id>.json
#   remote.sh rollback <run id> <apply run>  restores each website applied-<apply run>.json
#                                            moved, where it is still on Theme 1
#                                            with the same content; stores
#                                            rolled-back-<run id>.json
#
# The reports name Academies, so they stay on the VPS (0600, under
# $STORE, which backup.sh does not prune); the run log prints counts only.
#
# Not written: an audit_log_entries row. Its actor is a required user FK and
# this is not run as a user; the workflow run's approval record (approver,
# time, commit) and the stored reports are the record, as for Catalog
# containment.
set -euo pipefail
cd "${THEME_RETIREMENT_DIR:-/opt/atlas}" || { echo "FAIL  cannot enter the app directory" >&2; exit 1; }

MODE="${1:-}"
RUN_ID="${2:-}"
REF="${3:-}"
STORE="${THEME_RETIREMENT_STORE:-/opt/atlas/backups/theme-retirement}"
LOCK="${THEME_RETIREMENT_LOCK:-/opt/atlas/.deploy.lock}"
SCRIPT=dist/scripts/retire-website-themes.js
IN_CONTAINER="${THEME_RETIREMENT_TMP:-/tmp/theme-retirement}"

usage() { echo "usage: remote.sh dry-run <run id> | apply <run id> <plan run id> | rollback <run id> <apply run id>" >&2; exit 2; }
is_id() { [[ "$1" =~ ^[0-9]{1,20}$ ]]; }

case "$MODE" in
  dry-run) is_id "$RUN_ID" || usage ;;
  apply | rollback) is_id "$RUN_ID" && is_id "$REF" || usage ;;
  *) usage ;;
esac

backend() { docker compose exec -T backend "$@"; }

# Counts only: the reports carry Academy names and slugs.
summarise() {
  backend node -e '
    const r = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const by = {};
    for (const o of r.outcomes || []) by[o.result] = (by[o.result] || 0) + 1;
    console.log(`mode: ${r.mode}`);
    if (r.summary) console.log(`summary: ${JSON.stringify(r.summary)}`);
    console.log(`outcomes: ${JSON.stringify(by)}`);
    if (r.mode === "dry-run") {
      const status = {};
      for (const e of r.entries || []) status[e.status] = (status[e.status] || 0) + 1;
      console.log(`to move by website status: ${JSON.stringify(status)}`);
    }
    console.log(`in-flight provisioning requests on a retired theme: ${(r.pendingProvisioningRequests || []).length}`);
    if (r.failed) console.log(`FAILED part-way: ${r.failed}`);
  ' "$1"
}

# Copies the container report out to the host store (0600) and removes it
# from the container.
store_report() {
  local from="$1" to="$2"
  ( umask 077; backend cat "$from" > "$to" )
  backend rm -f "$from"
  echo "report stored: $(basename "$to") ($(stat -c %s "$to") bytes, sha256 $(sha256sum "$to" | cut -c1-12))"
}

echo "== Website theme retirement: $MODE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
if [ -z "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "FAIL  the backend container is not running" >&2
  exit 1
fi
if ! backend node -e "process.exit(require('node:fs').existsSync('$SCRIPT') ? 0 : 1)"; then
  echo "FAIL  the running backend image has no $SCRIPT (deploy the release that carries it first)" >&2
  exit 1
fi
mkdir -p "$STORE"
chmod 700 "$STORE"
backend mkdir -p "$IN_CONTAINER"

if [ "$MODE" = dry-run ]; then
  out="$IN_CONTAINER/plan.json"
  backend node "$SCRIPT" --out="$out" >/dev/null
  summarise "$out"
  store_report "$out" "$STORE/plan-$RUN_ID.json"
  echo "To apply exactly this plan: mode=apply, ref_run_id=$RUN_ID"
  exit 0
fi

# ---- apply / rollback --------------------------------------------------------
if [ "$MODE" = apply ]; then
  input="$STORE/plan-$REF.json"; flag="--plan"; out_name="applied-$RUN_ID.json"
else
  input="$STORE/applied-$REF.json"; flag="--rollback"; out_name="rolled-back-$RUN_ID.json"
fi
if [ ! -s "$input" ]; then
  echo "REFUSED  $(basename "$input") is not stored on the VPS (run the $([ "$MODE" = apply ] && echo dry-run || echo apply) first). Nothing was written." >&2
  exit 1
fi
echo "input: $(basename "$input") (sha256 $(sha256sum "$input" | cut -c1-12))"

# deploy.sh's host lock: no deploy from either repository can roll the
# backend mid-run.
exec 9>"$LOCK"
if ! flock -w 600 9; then
  echo "REFUSED  a deploy holds $(basename "$LOCK") (waited 10 min). Nothing was written." >&2
  exit 1
fi

backend sh -c "umask 077; cat > '$IN_CONTAINER/input.json'" < "$input"
out="$IN_CONTAINER/out.json"
rc=0
backend node "$SCRIPT" --apply "$flag=$IN_CONTAINER/input.json" --out="$out" >/dev/null || rc=$?
backend rm -f "$IN_CONTAINER/input.json"
# The script writes its report on failure too (what already moved), so it is
# kept for a rollback either way.
if backend test -s "$out"; then
  summarise "$out"
  store_report "$out" "$STORE/$out_name"
else
  echo "no report was written"
fi
if [ "$rc" != 0 ]; then
  echo "FAIL  the $MODE step failed (exit $rc). Websites already handled stay as listed in $out_name;" >&2
  echo "      mode=rollback with ref_run_id=$RUN_ID undoes the moved ones." >&2
  exit 1
fi
[ "$MODE" = apply ] && echo "To undo: mode=rollback, ref_run_id=$RUN_ID"
exit 0
