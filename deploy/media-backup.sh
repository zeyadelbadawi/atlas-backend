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
# HOW IT COPIES. A server-side copy inside the R2 account
# (`aws s3 sync s3://<source> s3://<backup bucket>/objects/<source>/`):
# nothing passes through the VPS disk, which filled once (9 Oct). It needs
# ONE dedicated R2 API token, created by the owner:
#   R2_MEDIA_BACKUP_ACCESS_KEY_ID / R2_MEDIA_BACKUP_SECRET_ACCESS_KEY
#   Object Read on the three media buckets, Object Read & Write on the backup
#   bucket, nothing else.
# Not the media credential (the running app's key cannot then also reach the
# backups) and not the database-backup credential (it cannot read media).
#
# WHAT A COPY KEEPS. `sync` without `--delete`: an object deleted at the
# source (a bug, a leaked key, an operator mistake) stays in the copy, which
# is the point of the backup. Nothing is pruned: how long payment proofs are
# kept is a counsel question (moved to B4 with SEC-04/SEC-06); the copy grows
# with the buckets until that is decided.
#
# RESTORE (one object or a whole bucket), with the same token:
#   aws s3 sync s3://<backup bucket>/objects/<source>/ s3://<source>/ [--exclude/--include ...]
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
KEY_ID=$(env_value R2_MEDIA_BACKUP_ACCESS_KEY_ID)
KEY_SECRET=$(env_value R2_MEDIA_BACKUP_SECRET_ACCESS_KEY)

# The same names the backend derives (config `media` / PaymentProofStorageService).
PUBLIC_BUCKET="$R2_BUCKET_"
PROTECTED_BUCKET="${R2_PROTECTED_BUCKET_:-${R2_BUCKET_}-protected}"
PROOFS_BUCKET="${R2_BUCKET_}-payment-proofs"

fail() { echo "FAIL  $*" >&2; exit 1; }
[ -n "$R2_BUCKET_" ] || fail "R2_BUCKET is not set in .env"
[ -n "$BACKUP_BUCKET" ] && [ -n "$BACKUP_ENDPOINT" ] || fail "R2_BACKUP_BUCKET / R2_BACKUP_ENDPOINT are not set in .env"
if [ -z "$KEY_ID" ] || [ -z "$KEY_SECRET" ]; then
  fail "R2_MEDIA_BACKUP_ACCESS_KEY_ID / R2_MEDIA_BACKUP_SECRET_ACCESS_KEY are not set in .env (owner: create the backup token, see this script's header). Nothing was copied."
fi
# A server-side copy only works inside one R2 account.
if [ -n "$R2_ENDPOINT_" ] && [ "$R2_ENDPOINT_" != "$BACKUP_ENDPOINT" ]; then
  fail "the media and backup buckets are on different endpoints; a server-side copy needs one R2 account. Nothing was copied."
fi

aws_() {
  docker run --rm -e AWS_ACCESS_KEY_ID="$KEY_ID" -e AWS_SECRET_ACCESS_KEY="$KEY_SECRET" \
    -e AWS_DEFAULT_REGION=auto amazon/aws-cli:2.17.61 --endpoint-url "$BACKUP_ENDPOINT" "$@"
}
copy_prefix() { echo "s3://${BACKUP_BUCKET}/objects/$1/"; }
# Object keys only (never printed): the 4th column of `s3 ls --recursive`.
keys() { aws_ s3 ls --recursive "$1" | awk '{ $1=$2=$3=""; sub(/^ +/, ""); print }' | sort; }

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
  if [ "$MODE" = restore-test ]; then
    # An empty or missing copy lists nothing (and `aws s3 ls` exits 1 then).
    key=$( (keys "$dest" || true) | sed "s#^objects/$src/##" | awk 'NR == 1')
    if [ -z "$key" ]; then echo "bucket=$src restore_test=skipped (no copied object yet)"; continue; fi
    a=$(aws_ s3 cp "${dest}${key}" - | sha256sum | cut -d' ' -f1)
    b=$(aws_ s3 cp "s3://$src/$key" - | sha256sum | cut -d' ' -f1)
    if [ -n "$a" ] && [ "$a" = "$b" ]; then echo "bucket=$src restore_test=match"; else echo "bucket=$src restore_test=MISMATCH"; rc=1; fi
  elif [ "$MODE" = verify ]; then
    tmp=$(mktemp -d)
    keys "s3://$src/" > "$tmp/src" || { echo "FAIL  cannot list the source bucket ($src)"; rc=1; rm -rf "$tmp"; continue; }
    keys "$dest" | sed "s#^objects/$src/##" > "$tmp/dst" || true
    missing=$(comm -23 "$tmp/src" "$tmp/dst" | grep -c . || true)
    echo "bucket=$src source=$(grep -c . "$tmp/src" || true) copy=$(grep -c . "$tmp/dst" || true) missing_from_copy=$missing"
    [ "$missing" = 0 ] || rc=1
    rm -rf "$tmp"
  else
    echo "-- $src -> backup/objects/$src/"
    # --only-show-errors: the log stays free of object keys.
    if aws_ s3 sync "s3://$src/" "$dest" --only-show-errors; then
      echo "copied: $src"
    else
      echo "FAIL  copy of $src failed"; rc=1
    fi
  fi
done
[ "$rc" = 0 ] && echo "== Result: ok" || echo "== Result: FAILED"
exit "$rc"
