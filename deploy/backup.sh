#!/usr/bin/env bash
# Atlas production PostgreSQL backup — Phase 7.
#
# Scheduled via systemd timer (atlas-backup.timer). Dumps the running
# `postgres` compose service to a compressed file, uploads it to a
# dedicated Cloudflare R2 bucket (never the same bucket as media —
# separate blast radius), and prunes local + remote copies past the
# retention window. A VPS failure must not destroy both the database and
# its only backup, hence off-server storage rather than /opt/atlas alone.
set -euo pipefail
cd /opt/atlas
set -a; source .env; set +a

RETENTION_DAYS=14
TIMESTAMP=$(date -u +%Y%m%dT%H%M%SZ)
LOCAL_DIR=/opt/atlas/backups
FILENAME="atlas-${TIMESTAMP}.sql.gz"

mkdir -p "$LOCAL_DIR"

echo "==> Dumping ${POSTGRES_DB}"
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER}" "${POSTGRES_DB}" \
  | gzip > "${LOCAL_DIR}/${FILENAME}"

SIZE=$(stat -c%s "${LOCAL_DIR}/${FILENAME}")
if [ "$SIZE" -lt 1024 ]; then
  echo "Backup file suspiciously small (${SIZE} bytes) — aborting upload, not deleting local copy." >&2
  exit 1
fi
echo "Dump size: ${SIZE} bytes"

# --- P64 Phase 1: readability verification -------------------------------
#
# Size alone only catches an empty dump. Before this backup is allowed to
# stand as the restore point for a migration that rewrites learner data,
# three checks establish that the archive is intact, that pg_dump ran to
# completion rather than dying mid-stream, and that the tables the
# migration touches are actually in it. Each exits non-zero, which is what
# makes `deploy.sh`'s gate fail closed.
#
# DECOMPRESSED ONCE, TO A FILE, AND NOT PIPED INTO grep. The obvious
# `gzip -dc file | grep -q pattern` is wrong under `set -o pipefail`:
# `grep -q` exits the moment it matches, gzip is then killed by SIGPIPE
# and exits 141, and pipefail reports the pipeline as failed. The check
# therefore REJECTS a perfectly good dump — measured on a real 17 MB
# production-shaped dump, five runs out of five — and would have failed
# every migration deploy. A 28 KB schema-only fixture passes, which is
# exactly why this has to be tested at realistic size.
#
# This is NOT a restore test. It proves the file is readable and complete,
# not that a restore into a live cluster succeeds; a true restore drill
# belongs on its own schedule, against a scratch database.
echo "==> Verifying the dump is readable and complete"

if ! gzip -t "${LOCAL_DIR}/${FILENAME}"; then
  echo "Backup failed gzip integrity check — not usable as a restore point." >&2
  exit 1
fi

# `mktemp` in the backups directory, not /tmp: a multi-gigabyte dump must
# not depend on /tmp having room. Removed on every exit path, including
# failure and interruption.
VERIFY_TMP=$(mktemp "${LOCAL_DIR}/.verify-XXXXXX")
trap 'rm -f "${VERIFY_TMP}"' EXIT INT TERM

if ! gzip -dc "${LOCAL_DIR}/${FILENAME}" > "${VERIFY_TMP}"; then
  echo "Backup could not be decompressed in full — not usable as a restore point." >&2
  exit 1
fi

if ! grep -q '^-- PostgreSQL database dump complete' "${VERIFY_TMP}"; then
  echo "Backup is truncated: pg_dump's completion marker is missing." >&2
  exit 1
fi

for table in users enrollments quiz_attempts academy_students; do
  if ! grep -q "CREATE TABLE public.${table}" "${VERIFY_TMP}"; then
    echo "Backup does not contain table '${table}' — refusing to treat it as a restore point." >&2
    exit 1
  fi
done

rm -f "${VERIFY_TMP}"
trap - EXIT INT TERM

echo "Dump verified: archive intact, completion marker present, core tables included."

echo "==> Uploading to R2 backup bucket"
docker run --rm \
  -e AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID}" \
  -e AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY}" \
  -v "${LOCAL_DIR}:/backups:ro" \
  amazon/aws-cli:2.17.61 \
  --endpoint-url "${R2_BACKUP_ENDPOINT}" \
  s3 cp "/backups/${FILENAME}" "s3://${R2_BACKUP_BUCKET}/${FILENAME}"

echo "==> Pruning local backups older than ${RETENTION_DAYS} days"
find "$LOCAL_DIR" -name 'atlas-*.sql.gz' -mtime +${RETENTION_DAYS} -delete

# `grep -v` exits 1 when it filters everything out, which is the NORMAL
# case here: a bucket with nothing older than the retention window emits a
# single `None`, grep drops it, and `set -o pipefail` then failed the whole
# script — AFTER a perfectly good dump had been taken and uploaded.
#
# That was invisible while this only ran from a systemd timer. It stopped
# being invisible when `deploy.sh` began gating migrations on this script's
# exit code: a successful backup reported failure, and the migration was
# correctly refused. Guarding the grep keeps "nothing to prune" from
# meaning "backup failed", and changes nothing when there IS something to
# prune.
echo "==> Pruning remote backups older than ${RETENTION_DAYS} days"
CUTOFF=$(date -u -d "-${RETENTION_DAYS} days" +%Y-%m-%dT%H:%M:%SZ)
docker run --rm \
  -e AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID}" \
  -e AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY}" \
  amazon/aws-cli:2.17.61 \
  --endpoint-url "${R2_BACKUP_ENDPOINT}" \
  s3api list-objects-v2 --bucket "${R2_BACKUP_BUCKET}" \
  --query "Contents[?LastModified<='${CUTOFF}'].Key" --output text \
  | tr '\t' '\n' | { grep -v '^None$' || true; } | while read -r key; do
    [ -n "$key" ] && docker run --rm \
      -e AWS_ACCESS_KEY_ID="${R2_BACKUP_ACCESS_KEY_ID}" \
      -e AWS_SECRET_ACCESS_KEY="${R2_BACKUP_SECRET_ACCESS_KEY}" \
      amazon/aws-cli:2.17.61 \
      --endpoint-url "${R2_BACKUP_ENDPOINT}" \
      s3 rm "s3://${R2_BACKUP_BUCKET}/${key}"
  done

echo "Backup complete: ${FILENAME}"
