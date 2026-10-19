#!/usr/bin/env bash
# B0-OPS-08 — object backup of the R2 media buckets into the backup bucket.
# Owner decision DL-47 (19 Oct 2026): payment proofs and protected media
# daily, public media weekly, Redis not backed up (its state rebuilds:
# queues re-sweep, rate limits expire).
#
#   media-backup.sh daily    payment proofs + protected media
#   media-backup.sh weekly   public media
#   media-backup.sh verify   read-only: for each source bucket, objects in the
#                            source vs in its copy; fails if a source object
#                            is missing from the copy. Prints counts only.
#   media-backup.sh restore-test
#                            read-only: reads one copied object per bucket back
#                            from the backup and compares its SHA-256 with the
#                            source object. Prints match yes/no, never a key.
#
# Scheduled by atlas-media-backup-daily.timer / -weekly.timer (systemd, the
# same way as atlas-backup.timer); deployed to /opt/atlas by the Deploy
# workflow next to backup.sh.
#
# HOW IT COPIES. Two credentials, each with the least it needs (an R2 API
# token carries one permission level for all the buckets it names):
#   R2_MEDIA_BACKUP_ACCESS_KEY_ID / R2_MEDIA_BACKUP_SECRET_ACCESS_KEY
#     a token the owner creates: Object Read only, on the three media
#     buckets only. It can read media and cannot change it.
#   R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY
#     the existing database-backup token (backup.sh), which already writes to
#     the backup bucket and cannot reach media.
# Each object the copy does not have yet is streamed from the source to the
# backup bucket (`aws s3 cp ... - | aws s3 cp - ...`), so nothing is written
# to the VPS disk (it filled once, 9 Oct). Object keys are written once by
# the app (uploads get unique keys), so an object already in the copy is not
# copied again.
#
# WHAT A COPY KEEPS. Nothing is ever deleted from the copy: an object deleted
# at the source (a bug, a leaked key, an operator mistake) stays in the copy,
# which is the point of the backup. Nothing is pruned: how long payment
# proofs are kept is a counsel question (moved to B4 with SEC-04/SEC-06); the
# copy grows with the buckets until that is decided.
#
# RESTORE (one object or a whole bucket): read the copy with the backup token
# and write it back with a credential that can write the media bucket (the
# app's media key), e.g. via a local folder:
#   aws s3 sync s3://<backup bucket>/objects/<source>/ ./restore/   (backup token)
#   aws s3 sync ./restore/ s3://<source>/                           (media key)
set -euo pipefail
cd "${MEDIA_BACKUP_DIR:-/opt/atlas}" || { echo "FAIL  cannot enter the app directory" >&2; exit 1; }

MODE="${1:-}"
case "$MODE" in daily | weekly | verify | restore-test) ;; *) echo "usage: media-backup.sh daily|weekly|verify|restore-test" >&2; exit 2 ;; esac

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2- || true; }
R2_BUCKET_=$(env_value R2_BUCKET)
R2_ENDPOINT_=$(env_value R2_ENDPOINT)
R2_PROTECTED_BUCKET_=$(env_value R2_PROTECTED_BUCKET)
BACKUP_BUCKET=$(env_value R2_BACKUP_BUCKET)
BACKUP_ENDPOINT=$(env_value R2_BACKUP_ENDPOINT)
SRC_KEY_ID=$(env_value R2_MEDIA_BACKUP_ACCESS_KEY_ID)
SRC_KEY_SECRET=$(env_value R2_MEDIA_BACKUP_SECRET_ACCESS_KEY)
DST_KEY_ID=$(env_value R2_BACKUP_ACCESS_KEY_ID)
DST_KEY_SECRET=$(env_value R2_BACKUP_SECRET_ACCESS_KEY)
SRC_ENDPOINT="${R2_ENDPOINT_:-}"

# The same names the backend derives (config `media` / PaymentProofStorageService).
PUBLIC_BUCKET="$R2_BUCKET_"
PROTECTED_BUCKET="${R2_PROTECTED_BUCKET_:-${R2_BUCKET_}-protected}"
PROOFS_BUCKET="${R2_BUCKET_}-payment-proofs"

fail() { echo "FAIL  $*" >&2; exit 1; }
[ -n "$R2_BUCKET_" ] || fail "R2_BUCKET is not set in .env"
[ -n "$BACKUP_BUCKET" ] && [ -n "$BACKUP_ENDPOINT" ] || fail "R2_BACKUP_BUCKET / R2_BACKUP_ENDPOINT are not set in .env"
[ -n "$SRC_ENDPOINT" ] || SRC_ENDPOINT="$BACKUP_ENDPOINT"
if [ -z "$SRC_KEY_ID" ] || [ -z "$SRC_KEY_SECRET" ]; then
  fail "R2_MEDIA_BACKUP_ACCESS_KEY_ID / R2_MEDIA_BACKUP_SECRET_ACCESS_KEY are not set in .env (owner: create the read-only media token, see this script's header). Nothing was copied."
fi
if [ -z "$DST_KEY_ID" ] || [ -z "$DST_KEY_SECRET" ]; then
  fail "R2_BACKUP_ACCESS_KEY_ID / R2_BACKUP_SECRET_ACCESS_KEY are not set in .env. Nothing was copied."
fi

# src_: read-only media token on the media endpoint. dst_: database-backup
# token on the backup endpoint (-i so a stream can be piped into it).
src_() {
  docker run --rm -e AWS_ACCESS_KEY_ID="$SRC_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$SRC_KEY_SECRET" \
    -e AWS_DEFAULT_REGION=auto amazon/aws-cli:2.17.61 --endpoint-url "$SRC_ENDPOINT" "$@"
}
dst_() {
  docker run --rm -i -e AWS_ACCESS_KEY_ID="$DST_KEY_ID" -e AWS_SECRET_ACCESS_KEY="$DST_KEY_SECRET" \
    -e AWS_DEFAULT_REGION=auto amazon/aws-cli:2.17.61 --endpoint-url "$BACKUP_ENDPOINT" "$@"
}
copy_prefix() { echo "s3://${BACKUP_BUCKET}/objects/$1/"; }
# Object keys only (never printed): the 4th column of `s3 ls --recursive`.
# Object keys, one per line, sorted (never printed). $1 = src_ or dst_,
# $2 = bucket, $3 = optional prefix. `list-objects-v2` exits 0 on an empty
# bucket (it prints "None"), so a failure here is a real access error.
keys() {
  "$1" s3api list-objects-v2 --bucket "$2" ${3:+--prefix "$3"} --query 'Contents[].[Key]' --output text </dev/null \
    | awk '$0 != "None" && $0 != ""' | sort
}

# One run at a time (a weekly run can overlap a slow daily one).
exec 9>"${MEDIA_BACKUP_LOCK:-/opt/atlas/.media-backup.lock}"
flock -n 9 || fail "another media backup is running"

echo "== Media backup: $MODE ($(date -u +%Y-%m-%dT%H:%M:%SZ))"
case "$MODE" in
  daily) SOURCES="$PROOFS_BUCKET $PROTECTED_BUCKET" ;;
  weekly) SOURCES="$PUBLIC_BUCKET" ;;
  verify | restore-test) SOURCES="$PROOFS_BUCKET $PROTECTED_BUCKET $PUBLIC_BUCKET" ;;
esac

rc=0
for src in $SOURCES; do
  dest=$(copy_prefix "$src")
  tmp=$(mktemp -d)
  if ! keys src_ "$src" > "$tmp/src"; then
    echo "FAIL  cannot list the source bucket ($src)"; rc=1; rm -rf "$tmp"; continue
  fi
  if ! keys dst_ "$BACKUP_BUCKET" "objects/$src/" | sed "s#^objects/$src/##" > "$tmp/dst"; then
    echo "FAIL  cannot list the backup copy of $src"; rc=1; rm -rf "$tmp"; continue
  fi
  comm -23 "$tmp/src" "$tmp/dst" > "$tmp/missing"
  missing=$(grep -c . "$tmp/missing" || true)
  case "$MODE" in
    verify)
      echo "bucket=$src source=$(grep -c . "$tmp/src" || true) copy=$(grep -c . "$tmp/dst" || true) missing_from_copy=$missing"
      [ "$missing" = 0 ] || rc=1 ;;
    restore-test)
      key=$(comm -12 "$tmp/src" "$tmp/dst" | awk 'NR == 1')
      if [ -z "$key" ]; then
        echo "bucket=$src restore_test=skipped (no copied object yet)"
      else
        a=$(dst_ s3 cp "${dest}${key}" - </dev/null | sha256sum | cut -d' ' -f1)
        b=$(src_ s3 cp "s3://$src/$key" - | sha256sum | cut -d' ' -f1)
        if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "bucket=$src restore_test=match"
        else echo "bucket=$src restore_test=MISMATCH"; rc=1; fi
      fi ;;
    *)
      copied=0; failed=0
      while IFS= read -r key; do
        [ -n "$key" ] || continue
        if src_ s3 cp "s3://$src/$key" - | dst_ s3 cp - "${dest}${key}" --only-show-errors; then
          copied=$((copied + 1))
        else
          failed=$((failed + 1))
        fi
      done < "$tmp/missing"
      # Counts only: the log stays free of object keys.
      echo "bucket=$src new_objects=$missing copied=$copied failed=$failed already_in_copy=$(grep -c . "$tmp/dst" || true)"
      [ "$failed" = 0 ] || rc=1 ;;
  esac
  rm -rf "$tmp"
done
[ "$rc" = 0 ] && echo "== Result: ok" || echo "== Result: FAILED"
exit "$rc"
