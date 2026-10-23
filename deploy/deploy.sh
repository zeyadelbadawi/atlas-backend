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
#   deploy.sh --frontend-only pull and roll ONLY the Caddy/SPA image (and
#                             the public website renderer when ATLAS_SSR=on);
#                             no migration, no backend recreate (P63g — a
#                             frontend push must never migrate the DB)
#   deploy.sh --rollback      re-pin the images to the digests recorded
#                             by the last successful deploy and roll
#   deploy.sh --check-rollback-record
#                             READ-ONLY: validates .last-good exactly as
#                             --rollback would (same code), confirms every
#                             recorded image is present locally or readable
#                             in the registry, and reports whether it is
#                             what runs now. Pulls, tags, starts, stops and
#                             writes nothing.
#   deploy.sh --rollback --to N   (N = 1..3; also with --check-rollback-record)
#                             B0-OPS-13: use the Nth PREVIOUS record
#                             (.last-good.N) instead, to undo a release that
#                             was healthy but wrong and so already became
#                             .last-good. On success it becomes the record.
#   deploy.sh --pin-frontend <tag>
#                             B0-OPS-13: pin Caddy (and the renderer when
#                             ATLAS_SSR=on) to an earlier frontend image tag,
#                             normally a commit SHA; backend untouched.
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
# The deployment directory. Always /opt/atlas in production; overridable
# only so the deploy test harness (deploy/test/) can run this exact script
# against a throwaway stack.
ATLAS_DIR=${ATLAS_DIR:-/opt/atlas}
cd "$ATLAS_DIR"

MODE="full"
# P64 Phase 1 — a LOOP, not a single `case`: `--with-migrations` has to be
# combinable with `--sync-env` (the backend workflow always passes that
# one), which a single positional arm cannot express. Every previously
# valid invocation still parses to exactly the same MODE.
WITH_MIGRATIONS=0
# B0-OPS-13: `--rollback --to N` / `--check-rollback-record --to N` use the
# Nth previous record (.last-good.N, N = 1..3); `--pin-frontend <tag>` pins
# the frontend (Caddy, and the renderer when ATLAS_SSR=on) to an earlier
# image tag, normally a commit SHA the frontend deploy pushed.
ROLLBACK_TO=0
PIN_TAG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --sync-env) MODE="sync-env" ;;
    --frontend-only) MODE="frontend-only" ;;
    --rollback) MODE="rollback" ;;
    --preflight) MODE="preflight" ;;
    --check-rollback-record) MODE="check-rollback-record" ;;
    --with-migrations) WITH_MIGRATIONS=1 ;;
    --to) ROLLBACK_TO=${2:-}; shift ;;
    --pin-frontend) MODE="pin-frontend"; PIN_TAG=${2:-}; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ROLLBACK_TO" in
  0|1|2|3) ;;
  *) echo "--to takes 1, 2 or 3 (the previous records kept)" >&2; exit 2 ;;
esac
if [ "$ROLLBACK_TO" != 0 ] && [ "$MODE" != rollback ] && [ "$MODE" != check-rollback-record ]; then
  echo "--to is only valid with --rollback or --check-rollback-record" >&2; exit 2
fi
if [ "$MODE" = pin-frontend ] && ! printf '%s' "$PIN_TAG" | grep -Eq '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$'; then
  echo "--pin-frontend needs an image tag (for example the frontend commit SHA)" >&2; exit 2
fi
# The record --rollback / --check-rollback-record read.
if [ "$ROLLBACK_TO" = 0 ]; then RECORD_NAME=.last-good; else RECORD_NAME=.last-good.$ROLLBACK_TO; fi

# --- one deploy at a time on this host (cross-repository) ---
exec 9>"$ATLAS_DIR/.deploy.lock"
if ! flock -w 900 9; then
  echo "==> Another deploy holds the lock (waited 15 min). Aborting." >&2
  exit 1
fi

# --- B0-OPS-06: the backup status directory ---------------------------------
# The backend mounts backups/status read-only. It must exist, owned by the
# deploy user, BEFORE the first compose call of ANY mode: `docker compose run`
# (the identity-key derivation, the image listing) and the rollback path
# create a missing bind-mount source as root, and backup.sh could then never
# write the status file. Creating an empty directory is the only change, and
# a no-op once it exists.
mkdir -p "$ATLAS_DIR/backups/status"

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
# B0-OPS-03 — the superuser DATABASE_URL may live in .env.migrate instead
# of .env, so the long-lived backend (env_file: .env) never holds it. Only
# this script reads it, to pass it explicitly to `prisma migrate deploy`.
# See docs/SUPERUSER_DATABASE_URL_SPLIT.md.
if [ -f .env.migrate ]; then
  set -a; source .env.migrate; set +a
fi

# --- Phase 8: public website server renderer (the `ssr` service) ----------
# ATLAS_SSR=on in .env is the one switch: Caddy reads the same value and
# routes Academy pages to the renderer only when it is on. Off (the
# default) leaves every request on its previous route, and the renderer
# container is stopped. Caddy never depends on the renderer, so a renderer
# that fails to start costs server rendering, never the website.
COMPOSE_PROFILES=${COMPOSE_PROFILES:-}
add_compose_profile() {
  case ",${COMPOSE_PROFILES}," in
    *",$1,"*) ;;
    *) COMPOSE_PROFILES=${COMPOSE_PROFILES:+${COMPOSE_PROFILES},}$1 ;;
  esac
  export COMPOSE_PROFILES
}
SSR_ENABLED=0
if [ "${ATLAS_SSR:-off}" = "on" ]; then
  SSR_ENABLED=1
  add_compose_profile ssr
fi

# --- Observability Center: the internal scrape credential -----------------
# Generated ON THE HOST the first time it is missing, appended to .env and
# never printed; it never leaves the VPS. The backend (env_file) and the
# internal Prometheus (a 0444 file in a 0700 dir, see prepare_monitoring)
# are its only consumers.
if [ -z "${METRICS_SCRAPE_TOKEN:-}" ] && [ "$MODE" != "check-rollback-record" ]; then
  echo "==> METRICS_SCRAPE_TOKEN missing — generating it on the host (value never printed)"
  if command -v openssl >/dev/null 2>&1; then
    generated_token=$(openssl rand -hex 32)
  else
    generated_token=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
  fi
  printf '\nMETRICS_SCRAPE_TOKEN=%s\n' "$generated_token" >> .env
  METRICS_SCRAPE_TOKEN=$generated_token
  export METRICS_SCRAPE_TOKEN
  unset generated_token
  ENV_SYNCED=1
fi

# --- W8B: pin the customer-identity key (CUSTOMER_IDENTITY_HMAC_KEY) -------
# Every v2 `subject_hash` in trial_redemptions / paid_gift_redemptions is an
# HMAC under this key. Until it is set, the backend DERIVES it from
# PAYMENT_CREDENTIALS_ENCRYPTION_KEY (src/plans/utils/
# customer-identity-key.util.ts), so rotating the payment key would silently
# re-grant every trial and gift. Pinning freezes it.
#
# The value pinned is the one the backend uses NOW, computed ON THE HOST by
# the backend image's own util (customerIdentityKeyFromEnv()):
#   * a backend is RUNNING: derived INSIDE it (`compose exec`), from the env
#     the live application actually started with, and cross-checked against
#     a derivation from the current .env (`compose run`). If both exist and
#     differ — .env's PAYMENT_CREDENTIALS_ENCRYPTION_KEY changed since the
#     backend started — nothing is pinned: pinning either could reset
#     eligibility, and an operator must decide. If the running backend
#     cannot derive it, nothing is pinned either (never a guess from .env).
#   * no backend running (first deploy): derived from .env in a throwaway
#     container (--no-deps: nothing else starts, no DB is touched).
# Pinning it changes no hash: every existing v2 row still matches. A NEW
# RANDOM KEY MUST NEVER BE USED HERE — it would re-grant every trial and
# gift.
#
#   * Only when .env has no non-empty CUSTOMER_IDENTITY_HMAC_KEY: a present
#     key is never overwritten or rotated.
#   * Only a value matching ^[0-9a-f]{64}$ is written; anything else (an
#     image without the util, an error, empty or extra output) writes
#     nothing, prints a warning and the deploy continues unchanged.
#   * The value is never echoed and xtrace is suspended for the block.
#   * Written atomically (temp copy, size guard, mv), like --sync-env.
#   * ENV_SYNCED=1 forces the backend recreate below so it loads the key.
if ! grep -Eq '^CUSTOMER_IDENTITY_HMAC_KEY=.' .env && [ "$MODE" != "check-rollback-record" ]; then
  case $- in *x*) identity_xtrace=1; set +x ;; *) identity_xtrace=0 ;; esac
  echo "==> CUSTOMER_IDENTITY_HMAC_KEY missing — pinning the currently derived value (value never printed)"
  identity_js='
    const { customerIdentityKeyFromEnv } = require("./dist/plans/utils/customer-identity-key.util.js");
    process.stdout.write(customerIdentityKeyFromEnv().toString("hex"));'
  identity_from_env=$(timeout 180 docker compose run --rm --no-deps -T backend node -e "$identity_js" 2>/dev/null) || identity_from_env=""
  [[ "$identity_from_env" =~ ^[0-9a-f]{64}$ ]] || identity_from_env=""
  pinned_identity_key=""
  identity_refusal="the backend image could not derive it (image without dist/plans/utils/customer-identity-key.util.js, or another error)"
  if [ -n "$(docker compose ps -q backend 2>/dev/null)" ]; then
    identity_running=$(timeout 60 docker compose exec -T backend node -e "$identity_js" 2>/dev/null) || identity_running=""
    if ! [[ "$identity_running" =~ ^[0-9a-f]{64}$ ]]; then
      identity_refusal="the running backend could not derive it (no util in the running image, or another error)"
    elif [ -n "$identity_from_env" ] && [ "$identity_from_env" != "$identity_running" ]; then
      identity_refusal="the running backend and the current .env derive DIFFERENT keys (PAYMENT_CREDENTIALS_ENCRYPTION_KEY changed since the backend started?); pinning either could reset eligibility, an operator must decide"
    else
      pinned_identity_key=$identity_running
      echo "==> Derived inside the running backend$([ -n "$identity_from_env" ] && echo ', and it matches the derivation from .env')"
    fi
    unset identity_running
  elif [ -n "$identity_from_env" ]; then
    pinned_identity_key=$identity_from_env
    echo "==> No running backend: derived from .env (first deploy)"
  fi
  unset identity_js identity_from_env
  if [ -n "$pinned_identity_key" ]; then
    # Drop an empty `CUSTOMER_IDENTITY_HMAC_KEY=` line, if any (a non-empty
    # one never reaches this block), so the key appears exactly once. Every
    # step is checked: a failure here warns and leaves .env as it was.
    identity_tmp=""
    if identity_tmp=$(mktemp "$ATLAS_DIR/.env.identity.XXXXXX") \
      && awk 'index($0, "CUSTOMER_IDENTITY_HMAC_KEY=") != 1' .env > "$identity_tmp" \
      && printf '\nCUSTOMER_IDENTITY_HMAC_KEY=%s\n' "$pinned_identity_key" >> "$identity_tmp" \
      && [ "$(wc -c < "$identity_tmp")" -gt "$(wc -c < .env)" ] \
      && { chmod --reference=.env "$identity_tmp" 2>/dev/null || true; } \
      && mv "$identity_tmp" .env; then
      CUSTOMER_IDENTITY_HMAC_KEY=$pinned_identity_key
      export CUSTOMER_IDENTITY_HMAC_KEY
      ENV_SYNCED=1
      echo "==> CUSTOMER_IDENTITY_HMAC_KEY pinned in .env; the backend will be recreated to load it"
    else
      [ -n "$identity_tmp" ] && rm -f "$identity_tmp"
      echo "WARNING: CUSTOMER_IDENTITY_HMAC_KEY not pinned: .env could not be rewritten safely; .env unchanged." >&2
    fi
    unset identity_tmp
  else
    echo "WARNING: CUSTOMER_IDENTITY_HMAC_KEY not pinned: ${identity_refusal}." >&2
    echo "         .env unchanged; the deploy continues and the next deploy retries." >&2
  fi
  unset pinned_identity_key identity_refusal
  [ "$identity_xtrace" = 1 ] && set -x
  unset identity_xtrace
fi

# --- Image identity: what each service runs, as an immutable digest --------
#
# `.last-good` must name images that can be pulled back byte for byte, so
# it records `<repository>@sha256:<digest>` — never a tag, which moves.
#
# The digest comes from the IMAGE the container runs (`.Image`, immutable),
# looked up in that image's RepoDigests for the service's own repository.
# A container object has no RepoDigests at all: the previous
# `docker inspect --format '{{index .RepoDigests 0}}' <container>` always
# failed, the error was discarded, and every record ever written had
# empty BACKEND_IMAGE/CADDY_IMAGE, so `--rollback` re-pinned nothing.

# The image reference the deployed compose file gives a service (its
# `image:`), e.g. ghcr.io/zeyadelbadawi/atlas-backend:latest.
service_image_ref() {
  docker compose config 2>/dev/null | awk -v s="  $1:" '
    $0 == s { found = 1; next }
    found && /^  [^ ]/ { exit }
    found && /^    image:/ { print $2; exit }'
}

# A reference without its tag or digest: registry/path/name.
image_repository() {
  local ref=${1%%@*}
  case "${ref##*/}" in
    *:*) printf '%s\n' "${ref%:*}" ;;
    *) printf '%s\n' "$ref" ;;
  esac
}

# True when $1 is exactly <repository>@sha256:<64 hex>.
is_pinned_digest() {
  printf '%s\n' "$1" | grep -Eq '^[^@[:space:]]+@sha256:[0-9a-f]{64}$'
}

# A reference this host can use for a recorded `<repository>@sha256:<d>`,
# or failure when the image is not here. Docker's containerd image store
# drops the `repository@digest` name once the image's tag moves to a newer
# image, but keeps the image itself, whose ID there IS the manifest digest,
# so it stays addressable as `sha256:<d>`. The classic store keeps the
# name. Rollback, check mode, re-tagging and the prune all go through this,
# so both stores behave the same.
local_image_ref() {
  local id
  if docker image inspect "$1" >/dev/null 2>&1; then
    printf '%s\n' "$1"
    return 0
  fi
  case "$1" in
    *@sha256:*) id="sha256:${1##*@sha256:}" ;;
    *) return 1 ;;
  esac
  docker image inspect "$id" >/dev/null 2>&1 || return 1
  printf '%s\n' "$id"
}

# Prints the immutable `<repository>@sha256:<digest>` of the image the
# service's container is running, or fails (prints nothing).
running_image_digest() {
  local cid ref image_id repository digest
  cid=$(docker compose ps -q "$1" 2>/dev/null) || return 1
  [ -n "$cid" ] || return 1
  ref=$(docker inspect --format '{{.Config.Image}}' "$cid" 2>/dev/null) || return 1
  image_id=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null) || return 1
  [ -n "$ref" ] && [ -n "$image_id" ] || return 1
  repository=$(image_repository "$ref")
  digest=$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image_id" 2>/dev/null \
    | awk -v p="${repository}@sha256:" 'index($0, p) == 1 { print; exit }')
  is_pinned_digest "$digest" || return 1
  printf '%s\n' "$digest"
}

# B0-OPS-13 — keeps the three previous records (.last-good.1 newest …
# .last-good.3 oldest), so a healthy-but-wrong release, which has already
# become .last-good, can still be undone with `--rollback --to 1`. Rotates
# only when the images actually change, so a redeploy of the same images
# does not push real history out.
rotate_last_good() {
  local record="$ATLAS_DIR/.last-good" n
  [ -f "$record" ] || return 0
  if [ "$(sed -n 's/^BACKEND_IMAGE=//p' "$record")|$(sed -n 's/^CADDY_IMAGE=//p' "$record")|$(sed -n 's/^SSR_IMAGE=//p' "$record")" = "$1|$2|$3" ]; then
    return 0
  fi
  for n in 2 1; do
    [ -f "$record.$n" ] && mv -f "$record.$n" "$record.$((n + 1))"
  done
  cp -p "$record" "$record.1"
}

# Persists the digests of the application images now running, for
# `--rollback`. Fails closed: if any digest cannot be resolved the previous
# record is kept untouched (an incomplete record is worse than an old one,
# since it would roll back nothing while claiming success).
record_last_good() {
  local backend caddy ssr="" record
  if ! backend=$(running_image_digest backend) || ! caddy=$(running_image_digest caddy); then
    echo "ERROR: could not resolve the running backend/caddy image digests; .last-good was NOT updated." >&2
    return 1
  fi
  if [ "$SSR_ENABLED" = "1" ] && ! ssr=$(running_image_digest ssr); then
    echo "ERROR: could not resolve the running renderer image digest; .last-good was NOT updated." >&2
    return 1
  fi
  record="$ATLAS_DIR/.last-good"
  rotate_last_good "$backend" "$caddy" "$ssr"
  {
    echo "BACKEND_IMAGE=$backend"
    echo "CADDY_IMAGE=$caddy"
    [ -n "$ssr" ] && echo "SSR_IMAGE=$ssr"
    echo "RECORDED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$record.tmp" && mv "$record.tmp" "$record"
  echo "==> Rollback record: backend $backend"
  echo "                     caddy   $caddy"
  [ -n "$ssr" ] && echo "                     ssr     $ssr"
  return 0
}

# After a healthy roll: write the rollback record, or fail the run loudly.
# The new stack IS serving at this point; a non-zero exit only says that
# `--rollback` would still return to the previous record, not to this one.
finish_with_record() {
  if record_last_good; then
    return 0
  fi
  echo "==> The stack is live and healthy, but its rollback record could not be written." >&2
  exit 1
}

# --- B0-OPS-07: disk -----------------------------------------------------------
#
# On 9 Oct 2026 the disk filled with 421 old images (42 GB) and two deploys
# failed until someone ran `docker image prune -a` by hand.
#
# prune_app_images removes APPLICATION images (atlas-backend,
# atlas-frontend, atlas-frontend-ssr, from any registry) that no container
# uses and that `.last-good` does not record. Called only after a healthy
# deploy has written its record, so the rollback digests are always kept on
# the host and `--rollback` still works with the registry unreachable.
# Postgres, Redis and monitoring images are never touched. Best effort: a
# failure to remove an image is reported and never fails the deploy.
#
# 23 Oct 2026: the disk filled again (120 images, 30 GB). Docker's
# containerd image store drops BOTH names of an image once its tag moves to
# a newer one (see local_image_ref), so an old application image has no
# repository left to recognise it by and was never pruned. The deploy now
# keeps a ledger of the image IDs its own application services ran
# (`remember_app_images`): an image with no name is an application image
# only if the ledger says so. Nothing outside the ledger is ever inferred to
# be ours, so Postgres, Redis, monitoring, aws-cli or any image this script
# did not run itself can never be removed by it.
APP_IMAGE_LEDGER="$ATLAS_DIR/.app-images"
# The services whose images the ledger tracks. A fixed list of its own:
# APP_SERVICES (below) is the deploy's selection and is empty until
# resolve_app_services runs, after some of the prunes.
APP_IMAGE_SERVICES="backend caddy ssr"

# Adds the image IDs this host's application containers use, and those the
# rollback records name, to the ledger. Best effort: never fails the deploy.
remember_app_images() {
  local service cid image digest ref record ids=""
  for service in $APP_IMAGE_SERVICES; do
    for cid in $(docker compose ps -aq "$service" 2>/dev/null || true); do
      image=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)
      case "$image" in sha256:*) ids="$ids $image" ;; esac
    done
  done
  for record in "$ATLAS_DIR/.last-good" "$ATLAS_DIR/.last-good.1" "$ATLAS_DIR/.last-good.2" "$ATLAS_DIR/.last-good.3"; do
    [ -f "$record" ] || continue
    for digest in $(sed -n 's/^\(BACKEND\|CADDY\|SSR\)_IMAGE=//p' "$record"); do
      ref=$(local_image_ref "$digest") || continue
      image=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
      case "$image" in sha256:*) ids="$ids $image" ;; esac
    done
  done
  [ -n "$ids" ] || return 0
  { [ -f "$APP_IMAGE_LEDGER" ] && cat "$APP_IMAGE_LEDGER"; printf '%s\n' $ids; } \
    | grep -E '^sha256:[0-9a-f]{64}$' | sort -u > "$APP_IMAGE_LEDGER.tmp" 2>/dev/null \
    && mv "$APP_IMAGE_LEDGER.tmp" "$APP_IMAGE_LEDGER" \
    || { rm -f "$APP_IMAGE_LEDGER.tmp"; echo "WARNING: could not update $APP_IMAGE_LEDGER." >&2; }
  return 0
}

# Whether the ledger names this image ID as one an application service ran.
in_app_ledger() {
  [ -f "$APP_IMAGE_LEDGER" ] && grep -qxF "$1" "$APP_IMAGE_LEDGER"
}

prune_app_images() {
  local keep="" id refs ref repo removed=0 failed=0 digest record
  remember_app_images
  for id in $(docker ps -aq 2>/dev/null); do
    keep="$keep $(docker inspect --format '{{.Image}}' "$id" 2>/dev/null || true)"
  done
  for record in "$ATLAS_DIR/.last-good" "$ATLAS_DIR/.last-good.1" "$ATLAS_DIR/.last-good.2" "$ATLAS_DIR/.last-good.3"; do
    [ -f "$record" ] || continue
    for digest in $(sed -n 's/^\(BACKEND\|CADDY\|SSR\)_IMAGE=//p' "$record"); do
      # A record may name an image this host no longer has: skip it (under
      # `set -e` a failed lookup must never abort the deploy after its record).
      ref=$(local_image_ref "$digest") || continue
      keep="$keep $(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)"
    done
  done
  for id in $(docker image ls -aq --no-trunc 2>/dev/null | sort -u); do
    case " $keep " in *" $id "*) continue ;; esac
    refs=$(docker image inspect --format '{{range .RepoTags}}{{println .}}{{end}}{{range .RepoDigests}}{{println .}}{{end}}' "$id" 2>/dev/null) || continue
    repo=""
    for ref in $refs; do
      case "$(image_repository "$ref")" in
        */atlas-backend|*/atlas-frontend|*/atlas-frontend-ssr|atlas-backend|atlas-frontend|atlas-frontend-ssr)
          repo=$(image_repository "$ref"); break ;;
      esac
    done
    # No name at all left (containerd store): ours only if the ledger says
    # an application service ran it. An image that still carries any other
    # name is never removed through the ledger (`rm -f` would drop that name).
    if [ -z "$repo" ] && [ -z "$refs" ] && in_app_ledger "$id"; then repo="(ledger)"; fi
    [ -n "$repo" ] || continue
    if docker image rm -f "$id" >/dev/null 2>&1; then
      removed=$((removed + 1))
    else
      failed=$((failed + 1))
    fi
  done
  # The ledger keeps only images this host still has, so it never grows.
  # Rewritten only from a successful listing: if Docker cannot answer, the
  # ledger is left as it is rather than emptied.
  local present
  if [ -f "$APP_IMAGE_LEDGER" ] && present=$(docker image ls -aq --no-trunc 2>/dev/null); then
    while IFS= read -r id; do
      if printf '%s\n' "$present" | grep -qxF -- "$id"; then printf '%s\n' "$id"; fi
    done < "$APP_IMAGE_LEDGER" > "$APP_IMAGE_LEDGER.tmp" 2>/dev/null \
      && mv "$APP_IMAGE_LEDGER.tmp" "$APP_IMAGE_LEDGER" \
      || rm -f "$APP_IMAGE_LEDGER.tmp"
  fi
  echo "==> Pruned $removed unused application image(s) (kept: running containers and .last-good)."
  [ "$failed" = 0 ] || echo "WARNING: $failed unused application image(s) could not be removed." >&2
  return 0
}

# Free space, in MiB, on the filesystem holding Docker's data root (where
# pulls land), falling back to $ATLAS_DIR.
free_space_mb() {
  local root
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)
  [ -n "$root" ] && [ -d "$root" ] || root=$ATLAS_DIR
  df -Pk "$root" | awk 'NR==2 { print int($4 / 1024) }'
}

# Refuses to start pulling below DEPLOY_MIN_FREE_MB (default 2048): a pull
# that fills the disk half way leaves the host worse than a deploy that
# never started. Prunes unused application images once and re-checks before
# giving up. Nothing has changed when it refuses.
DEPLOY_MIN_FREE_MB=${DEPLOY_MIN_FREE_MB:-2048}
require_free_space() {
  local free
  free=$(free_space_mb)
  if [ -z "$free" ]; then
    echo "WARNING: could not measure free disk space; continuing." >&2
    return 0
  fi
  if [ "$free" -lt "$DEPLOY_MIN_FREE_MB" ]; then
    echo "==> Only ${free} MiB free (floor ${DEPLOY_MIN_FREE_MB} MiB); pruning unused application images first"
    prune_app_images
    free=$(free_space_mb)
  fi
  if [ -n "$free" ] && [ "$free" -lt "$DEPLOY_MIN_FREE_MB" ]; then
    echo "==> Refusing to deploy: ${free} MiB free on the Docker filesystem, below the ${DEPLOY_MIN_FREE_MB} MiB floor." >&2
    echo "    Nothing was pulled or changed. Free space (docker system df; old files in $ATLAS_DIR/backups) and deploy again." >&2
    exit 1
  fi
  echo "==> Free disk space: ${free} MiB (floor ${DEPLOY_MIN_FREE_MB} MiB)"
}

# --- P64 Phase 1: pre-migration safety ------------------------------------
#
# All three helpers below are used ONLY when a migration is actually
# pending, so a routine deploy never pays for them.

psql_prod() {
  docker compose exec -T postgres \
    psql -U "${POSTGRES_USER}" -d "${POSTGRES_DB}" -t -A "$@"
}

# Which migrations the image carries that the database has not cleanly
# applied — compared by NAME, never by count.
#
# A count comparison is not a safety check. Two different mistakes cancel
# out: a migration present in the image but unapplied, plus a migration
# recorded in the database but absent from the image, leaves the counts
# equal and the deployment proceeding into a schema it cannot reason
# about. This database currently holds exactly that shape — a row for
# `20260927010000_p49b_live_provider_oauth` that is unfinished and rolled
# back — which a count of "finished" rows silently skips.
#
# So three distinct conditions are detected and each one stops the
# deployment:
#
#   PENDING    a migration in the image with no clean row in the database.
#              Normal, and what `--with-migrations` exists to apply.
#   UNKNOWN    a row in the database naming a migration the image does not
#              contain. The running code is older than the schema, or the
#              database belongs to a different branch. Never safe to
#              migrate into.
#   UNFINISHED a row that never completed or was rolled back. Prisma will
#              refuse to continue past it anyway; failing here says so
#              plainly instead of failing mid-deploy.
#
# Results are written to globals rather than echoed, so the caller can
# report exact names. `set -e` aborts if either side cannot be read, so an
# unreadable database can never be mistaken for "nothing pending".
MIGRATIONS_PENDING=""
MIGRATIONS_UNKNOWN=""
MIGRATIONS_UNFINISHED=""

compare_migration_state() {
  local image_list db_clean_list

  image_list=$(docker compose run --rm --no-deps --entrypoint sh backend \
    -c 'ls -1 /app/prisma/migrations | grep "^[0-9]" | sort' | tr -d '\r')

  # Cleanly applied: finished and not rolled back. Anything else is
  # reported as unfinished below rather than counted as applied.
  db_clean_list=$(psql_prod -c \
    "select migration_name from _prisma_migrations \
     where finished_at is not null and rolled_back_at is null \
     order by migration_name" | tr -d '\r')

  MIGRATIONS_UNFINISHED=$(psql_prod -c \
    "select migration_name from _prisma_migrations \
     where finished_at is null or rolled_back_at is not null \
     order by migration_name" | tr -d '\r')

  MIGRATIONS_PENDING=$(comm -23 \
    <(printf '%s\n' "$image_list" | sed '/^$/d') \
    <(printf '%s\n' "$db_clean_list" | sed '/^$/d'))

  MIGRATIONS_UNKNOWN=$(comm -13 \
    <(printf '%s\n' "$image_list" | sed '/^$/d') \
    <(printf '%s\n' "$db_clean_list" | sed '/^$/d'))
}

# Prints a block naming every migration in a category, for the deploy log
# and for the operator's record.
report_migration_names() {
  local label="$1" names="$2"
  [ -z "$names" ] && return 0
  echo "    ${label}:"
  printf '%s\n' "$names" | sed 's/^/      - /'
}

# The counts the master plan requires before the migration runs. These are
# the migration's OWN predicates, so each number is a dry run of exactly
# what it will rewrite — not an approximation. Written to a timestamped
# evidence file that the operator returns with the deployment record.
record_precheck_counts() {
  local dir="$ATLAS_DIR/migration-evidence"
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

# The renderer's own health. A warning, never a failed deploy: while it is
# unhealthy Caddy serves the single-page app, exactly as with ATLAS_SSR=off.
check_ssr() {
  if [ "$SSR_ENABLED" != "1" ]; then
    # Switched off: make sure no renderer keeps running unrouted.
    docker compose --profile ssr stop ssr >/dev/null 2>&1 || true
    return 0
  fi
  echo "==> Waiting for the public website renderer (non-fatal)"
  for i in $(seq 1 20); do
    status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(docker compose ps -q ssr)" 2>/dev/null || echo none)
    if [ "$status" = "healthy" ]; then
      echo "Renderer healthy."
      return 0
    fi
    sleep 3
  done
  echo "WARNING: the renderer is not healthy; Academy pages are served by the single-page app until it is." >&2
  docker compose logs --tail=40 ssr >&2 || true
  return 0
}

# --- Stateful services: never recreated by a deploy ------------------------
#
# postgres and redis run from mutable tags (postgres:16-alpine,
# redis:7-alpine). Compose recreates a container whenever its tag resolves
# to a different image than the one it runs, so a deploy used to restart
# the database and the cache — before the migration gate and before the
# backup — merely because an upstream tag had moved. Production showed
# exactly that drift on 1 Oct 2026 (both tags newer than the running
# containers).
#
# So a deploy never pulls their images and starts them with
# `--no-recreate`: an existing container keeps the image it runs, and a
# missing one (a fresh host) is created from the tag as before. Changing
# the database or cache image is an explicit operator action, never a side
# effect of shipping application code.
STATEFUL_SERVICES="postgres redis"

# The services this deploy pulls and rolls: every service compose would
# start under the active profiles, except the stateful ones. Resolved into
# APP_SERVICES (one name per word) and never empty — an empty list would
# make `docker compose pull`/`up` act on EVERY service, postgres included.
APP_SERVICES=""
resolve_app_services() {
  APP_SERVICES=$(docker compose config --services | grep -Fvx -e postgres -e redis | tr '\n' ' ')
  if [ -z "${APP_SERVICES// /}" ]; then
    echo "==> Refusing to continue: no application services resolved from the compose file." >&2
    exit 1
  fi
}

# Logs (never acts on) a stateful service whose tag has moved past the
# image its container runs.
report_stateful_drift() {
  local service cid running tagged ref
  for service in $STATEFUL_SERVICES; do
    cid=$(docker compose ps -aq "$service" 2>/dev/null || true)
    [ -n "$cid" ] || continue
    ref=$(service_image_ref "$service")
    running=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)
    tagged=$(docker image inspect --format '{{.Id}}' "$ref" 2>/dev/null || true)
    if [ -n "$tagged" ] && [ "$running" != "$tagged" ]; then
      echo "    NOTE: $service runs $running; $ref now names $tagged."
      echo "          Kept as running. Upgrading $service is a separate, explicit operation."
    fi
  done
}

# One value from the rollback record. The record is parsed, never sourced.
last_good_value() {
  sed -n "s/^$1=//p" "$ATLAS_DIR/$RECORD_NAME" | tail -1
}

# Re-points a service's compose image reference at a recorded digest, and
# proves the reference now resolves to exactly that image.
pin_service_image() {
  local service=$1 digest=$2 ref source
  ref=$(service_image_ref "$service")
  if [ -z "$ref" ]; then
    echo "==> Refusing to roll back: no image reference for '$service' in the compose file." >&2
    exit 1
  fi
  source=$(local_image_ref "$digest") || source=$digest
  docker tag "$source" "$ref"
  if [ "$(docker image inspect --format '{{.Id}}' "$ref")" != "$(docker image inspect --format '{{.Id}}' "$source")" ]; then
    echo "==> Refusing to continue: $ref does not resolve to $digest after re-tagging." >&2
    exit 1
  fi
  echo "    $service: $ref -> $digest"
}

# Reads and validates the WHOLE rollback record before anything is touched
# (a rollback that silently skips an image is the failure this replaces).
# Sets BACKEND_IMAGE, CADDY_IMAGE, SSR_IMAGE, RECORDED_AT and
# rollback_services — the services whose images are rollback state:
# backend and caddy always; ssr only while ATLAS_SSR=on. Shared by
# --rollback and --check-rollback-record, so the check proves exactly what
# the rollback would accept. Exits non-zero, having changed nothing.
validate_rollback_record() {
  local pair service digest
  if [ ! -f "$ATLAS_DIR/$RECORD_NAME" ]; then
    echo "==> No $RECORD_NAME record exists; nothing to roll back to." >&2
    exit 1
  fi
  BACKEND_IMAGE=$(last_good_value BACKEND_IMAGE)
  CADDY_IMAGE=$(last_good_value CADDY_IMAGE)
  SSR_IMAGE=$(last_good_value SSR_IMAGE)
  RECORDED_AT=$(last_good_value RECORDED_AT)
  rollback_services="backend caddy"
  for pair in "backend:$BACKEND_IMAGE" "caddy:$CADDY_IMAGE"; do
    if ! is_pinned_digest "${pair#*:}"; then
      echo "==> Refusing to roll back: the record has no valid ${pair%%:*} image digest." >&2
      echo "    Nothing was pulled and nothing was rolled." >&2
      exit 1
    fi
  done
  if [ "$SSR_ENABLED" = "1" ]; then
    if ! is_pinned_digest "$SSR_IMAGE"; then
      echo "==> Refusing to roll back: ATLAS_SSR=on but the record has no renderer image" >&2
      echo "    (it predates server rendering). Set ATLAS_SSR=off in .env and roll back again." >&2
      exit 1
    fi
    rollback_services="ssr $rollback_services"
  fi
  for service in $rollback_services; do
    digest=$(recorded_digest "$service")
    if [ "$(image_repository "$digest")" != "$(image_repository "$(service_image_ref "$service")")" ]; then
      echo "==> Refusing to roll back: the recorded $service image is not from the repository the compose file uses." >&2
      exit 1
    fi
  done
}

# The recorded digest for a rollback service (after validate_rollback_record).
recorded_digest() {
  case "$1" in
    backend) printf '%s\n' "$BACKEND_IMAGE" ;;
    caddy) printf '%s\n' "$CADDY_IMAGE" ;;
    ssr) printf '%s\n' "$SSR_IMAGE" ;;
  esac
}

if [ "$MODE" = "check-rollback-record" ]; then
  validate_rollback_record
  echo "==> $RECORD_NAME is valid for --rollback$( [ "$ROLLBACK_TO" = 0 ] || echo " --to $ROLLBACK_TO") (recorded ${RECORDED_AT:-unknown}; ATLAS_SSR=${ATLAS_SSR:-off})"
  check_failed=0
  for service in $rollback_services; do
    digest=$(recorded_digest "$service")
    if local_image_ref "$digest" >/dev/null; then
      where="present on this host"
    elif docker manifest inspect "$digest" >/dev/null 2>&1; then
      where="not on this host, readable in the registry"
    else
      where="NOT AVAILABLE (neither on this host nor readable in the registry)"
      check_failed=1
    fi
    running=$(running_image_digest "$service" || true)
    if [ "$running" = "$digest" ]; then now="it is what runs now"; else now="runs now: ${running:-unknown}"; fi
    echo "    $service: $digest"
    echo "      $where; $now"
  done
  if [ "$SSR_ENABLED" != "1" ] && [ -n "$SSR_IMAGE" ]; then
    echo "    ssr: recorded but NOT rollback state while ATLAS_SSR is off (never pulled or started)"
  fi
  if [ "$check_failed" = 1 ]; then
    echo "==> A recorded image cannot be obtained; --rollback would fail before changing anything." >&2
    exit 1
  fi
  exit 0
fi

if [ "$MODE" = "rollback" ]; then
  validate_rollback_record

  echo "==> Rolling back to the images recorded at ${RECORDED_AT:-unknown}"
  # Every image is obtained before any container changes, so a missing
  # digest leaves the running stack exactly as it was. A digest already on
  # the host is immutable content and is used as is: a rollback must not
  # depend on the registry being reachable.
  rollback_digests="$BACKEND_IMAGE $CADDY_IMAGE"
  [ "$SSR_ENABLED" = "1" ] && rollback_digests="$rollback_digests $SSR_IMAGE"
  for digest in $rollback_digests; do
    if local_image_ref "$digest" >/dev/null; then
      echo "    $digest: present on this host"
    else
      docker pull -q "$digest" >/dev/null
      echo "    $digest: pulled"
    fi
  done
  pin_service_image backend "$BACKEND_IMAGE"
  pin_service_image caddy "$CADDY_IMAGE"
  if [ "$SSR_ENABLED" = "1" ]; then
    pin_service_image ssr "$SSR_IMAGE"
    docker compose up -d --no-deps ssr
  fi
  docker compose up -d --no-deps backend caddy

  # Prove the containers now run exactly the recorded images.
  for service in $rollback_services; do
    want=$(recorded_digest "$service")
    have=$(running_image_digest "$service" || true)
    if [ "$have" != "$want" ]; then
      echo "==> Rollback did not take effect: $service runs ${have:-an unknown image}, expected $want." >&2
      exit 1
    fi
  done
  echo "==> Running images match the record."
  if wait_healthy; then
    check_ssr
    # B0-OPS-13: rolling back to an OLDER record makes it the current one
    # (the release rolled away from becomes .last-good.1), so a later plain
    # --rollback does not return to the release just undone.
    if [ "$ROLLBACK_TO" != 0 ]; then
      finish_with_record
    fi
    exit 0
  fi
  exit 1
fi

# --- B0-OPS-13: pin the frontend to an earlier image tag ----------------------
# For a release that is healthy but wrong (copy, CSP, academy rendering):
# the frontend deploy pushes every image under its commit SHA as well as
# :latest, so `--pin-frontend <sha>` brings that release back without a
# revert-and-rebuild cycle. Caddy, and the renderer when ATLAS_SSR=on, move
# together (they must come from the same build). The backend is not touched.
# On a healthy result the record is rewritten (the previous one is kept as
# .last-good.1). The next normal frontend deploy returns to :latest.
if [ "$MODE" = "pin-frontend" ]; then
  require_free_space
  pin_services="caddy"
  [ "$SSR_ENABLED" = "1" ] && pin_services="ssr caddy"
  echo "==> Pinning the frontend to tag $PIN_TAG"
  for service in $pin_services; do
    current_ref=$(service_image_ref "$service")
    if [ -z "$current_ref" ]; then
      echo "==> Refusing to pin: no image reference for '$service' in the compose file." >&2
      exit 1
    fi
    pinned_ref="$(image_repository "$current_ref"):$PIN_TAG"
    # Obtain every image before changing anything, like --rollback.
    if ! docker image inspect "$pinned_ref" >/dev/null 2>&1 && ! docker pull -q "$pinned_ref" >/dev/null; then
      echo "==> Refusing to pin: $pinned_ref is neither on this host nor in the registry. Nothing was changed." >&2
      exit 1
    fi
  done
  for service in $pin_services; do
    pin_service_image "$service" "$(image_repository "$(service_image_ref "$service")"):$PIN_TAG"
  done
  if [ "$SSR_ENABLED" = "1" ]; then
    docker compose up -d --no-deps ssr
  fi
  docker compose up -d --no-deps caddy
  if wait_healthy; then
    check_ssr
    finish_with_record
    prune_app_images
    echo "==> Frontend pinned to $PIN_TAG; record written (the previous one is .last-good.1)."
    exit 0
  fi
  echo "==> The pinned frontend failed health checks. Roll back with: deploy.sh --rollback" >&2
  exit 1
fi

if [ "$MODE" = "frontend-only" ]; then
  require_free_space
  echo "==> Frontend-only deploy: pulling the Caddy/SPA image"
  docker compose pull caddy
  if [ "$SSR_ENABLED" = "1" ]; then
    # The renderer first: during the few seconds between the two, pages it
    # renders reference chunks the old Caddy image lacks, and Caddy fetches
    # those from the renderer's own build.
    docker compose pull ssr
    docker compose up -d --no-deps ssr
  fi
  echo "==> Rolling Caddy only (no migration, backend untouched)"
  docker compose up -d --no-deps caddy
  if wait_healthy; then
    check_ssr
    finish_with_record
    prune_app_images
    exit 0
  fi
  exit 1
fi

require_free_space
echo "==> Pulling the application images (postgres/redis are never pulled here)"
resolve_app_services
docker compose pull $APP_SERVICES

echo "==> Starting postgres + redis first (migrations need a live
    database — --no-deps alone won't start them on a fresh stack)"
report_stateful_drift
docker compose up -d --no-recreate --wait --wait-timeout 180 $STATEFUL_SERVICES

# --- P64 Phase 1: the migration gate -------------------------------------
#
# Positioned HERE on purpose: the database is up (so the check can read
# it) and the stack has NOT been rolled yet (line below), so every exit
# path out of this block leaves the previously running containers serving
# traffic untouched.
compare_migration_state
PENDING=$(printf '%s\n' "$MIGRATIONS_PENDING" | sed '/^$/d' | wc -l | tr -d ' ')

# FAIL CLOSED on a schema this deployment cannot prove it understands.
# Neither condition is something `--with-migrations` may override: an
# unknown or unfinished migration means the database is not in a state
# `prisma migrate deploy` should be pointed at, whoever approved it.
if [ -n "$MIGRATIONS_UNKNOWN" ] || [ -n "$MIGRATIONS_UNFINISHED" ]; then
  echo "==> Refusing to continue: image and database migration state cannot be proven compatible." >&2
  report_migration_names "recorded in the database but absent from this image" "$MIGRATIONS_UNKNOWN" >&2
  report_migration_names "never finished or rolled back" "$MIGRATIONS_UNFINISHED" >&2
  echo "    Nothing was migrated and nothing was rolled; the running stack is untouched." >&2
  echo "    Resolve the database's migration history before deploying." >&2
  exit 1
fi

if [ "$PENDING" -gt 0 ] || [ "$MODE" = "preflight" ]; then
  if [ "$MODE" != "preflight" ] && [ "$WITH_MIGRATIONS" != "1" ]; then
    echo "==> ${PENDING} migration(s) pending and migrations are NOT authorized." >&2
    report_migration_names "pending" "$MIGRATIONS_PENDING" >&2
    echo "    Nothing was migrated and nothing was rolled; the running stack is untouched." >&2
    echo "    To apply them: dispatch the Deploy workflow with apply_migrations=true," >&2
    echo "    which additionally requires approval of the protected production" >&2
    echo "    environment (that approval is what releases the migration SSH key)." >&2
    exit 1
  fi

  echo "==> ${PENDING} migration(s) pending — taking a verified backup first"
  report_migration_names "pending" "$MIGRATIONS_PENDING"
  # Fails closed: `backup.sh` exits non-zero on a truncated, unreadable or
  # incomplete dump, and `set -e` aborts here, BEFORE any schema change.
  bash "$ATLAS_DIR/backup.sh"
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

# --- Observability Center: Prometheus + Alertmanager ----------------------
# Enabled whenever the scrape credential exists (it is generated above). The
# Slack receiver is added ONLY when ALERT_SLACK_WEBHOOK_URL is in .env;
# without it Alertmanager still evaluates and exposes alerts to the Platform
# Owner Alerts Center, it just delivers them nowhere else. Secret values are
# written to files (0444 inside a 0700 dir) and never echoed; only variable
# NAMES appear in this output.
MONITORING_ENABLED=0
prepare_monitoring() {
  local mon="$ATLAS_DIR/monitoring"
  local sec="$mon/secrets"
  if [ -z "${METRICS_SCRAPE_TOKEN:-}" ]; then
    echo "==> Monitoring NOT enabled: METRICS_SCRAPE_TOKEN is not set"
    return 0
  fi
  install -d -m 700 "$sec"
  # The files are left 0444, so restore the owner's write bit before
  # rewriting them. Rewrite IN PLACE (same inode): the running containers
  # bind-mount these files, and a replaced inode would stay invisible to them.
  chmod u+w "$sec/metrics_scrape_token" "$sec/slack_webhook_url" 2>/dev/null || true
  ( umask 022
    printf '%s' "$METRICS_SCRAPE_TOKEN" > "$sec/metrics_scrape_token"
    printf '%s' "${ALERT_SLACK_WEBHOOK_URL:-}" > "$sec/slack_webhook_url" )
  chmod 444 "$sec/metrics_scrape_token" "$sec/slack_webhook_url"
  if [ -n "${ALERT_SLACK_WEBHOOK_URL:-}" ]; then
    # PLATFORM_WEB_URL is a public origin, not a secret.
    sed "s#__ATLAS_WEB_URL__#${PLATFORM_WEB_URL:-https://atlass.dpdns.org}#g" \
      "$mon/alertmanager.slack.yml" > "$mon/alertmanager.yml"
    echo "==> Monitoring enabled with the Slack receiver"
  else
    cp "$mon/alertmanager.none.yml" "$mon/alertmanager.yml"
    echo "==> Monitoring enabled WITHOUT Slack: ALERT_SLACK_WEBHOOK_URL is not set"
  fi
  add_compose_profile monitoring
  MONITORING_ENABLED=1
  export OBS_PROMETHEUS_URL=http://prometheus:9090
  export OBS_ALERTMANAGER_URL=http://alertmanager:9093
}
prepare_monitoring

echo "==> Starting/updating the stack (postgres/redis kept as they are)"
# `--no-deps` keeps compose from converging postgres/redis through
# `depends_on`; the listed services still start in dependency order
# (backend healthy before caddy).
resolve_app_services
docker compose up -d --remove-orphans --no-deps $APP_SERVICES

# Prometheus/Alertmanager bind-mount their config files, so a changed rule
# file, Slack template or webhook (none → Slack) does not recreate them.
# SIGHUP makes both re-read their configuration in place.
if [ "$MONITORING_ENABLED" = "1" ]; then
  echo "==> Reloading Prometheus/Alertmanager configuration (SIGHUP)"
  docker compose kill -s SIGHUP prometheus alertmanager >/dev/null 2>&1 || true
fi

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
  check_ssr
  finish_with_record
  prune_app_images
  echo "==> Deploy complete; last-good digests recorded (use --rollback to revert)."
  exit 0
fi
echo "==> Deploy failed health checks. Previous images remain available via --rollback." >&2
exit 1
