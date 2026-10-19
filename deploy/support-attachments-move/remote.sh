#!/usr/bin/env bash
# B0-SEC-10 — move support-ticket images stored before the fix from the
# public media bucket to the protected bucket, run on the VPS by
# .github/workflows/support-attachments-move.yml.
#
# Every mode runs the compiled, reviewed script inside the RUNNING backend
# container, with the credentials the backend already holds
# (src/scripts/move-support-attachments.ts):
#   remote.sh plan       read-only: objects under support-cases/ in each bucket
#   remote.sh apply      copy each to the protected bucket, confirm the copy,
#                        then delete the public one
#   remote.sh rollback   copy the protected ones back to the public bucket
#                        (only before rolling the code back to a release that
#                        reads the public bucket). Deletes nothing.
#
# The log prints counts only, never an object key (a key names a support case).
set -euo pipefail
cd "${SUPPORT_MOVE_DIR:-/opt/atlas}" || { echo "FAIL  cannot enter the app directory" >&2; exit 1; }

MODE="${1:-}"
SCRIPT=dist/scripts/move-support-attachments.js
case "$MODE" in
  plan) FLAG="" ;;
  apply) FLAG="--apply" ;;
  rollback) FLAG="--rollback" ;;
  *) echo "usage: remote.sh plan|apply|rollback" >&2; exit 2 ;;
esac

backend() { docker compose exec -T backend "$@"; }

echo "== Support attachments move: $MODE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
if [ -z "$(docker compose ps -q backend 2>/dev/null)" ]; then
  echo "FAIL  the backend container is not running" >&2
  exit 1
fi
if ! backend node -e "process.exit(require('node:fs').existsSync('$SCRIPT') ? 0 : 1)"; then
  echo "FAIL  the running backend image has no $SCRIPT (deploy the release that carries it first)" >&2
  exit 1
fi
# shellcheck disable=SC2086 # FLAG is empty or one fixed word
backend node "$SCRIPT" $FLAG
