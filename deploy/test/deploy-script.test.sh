#!/usr/bin/env bash
# deploy.sh — end-to-end tests against a throwaway Docker stack.
#
# Runs the REAL deploy/deploy.sh and the REAL deploy/docker-compose.prod.yml
# (plus a test override that swaps in small images) in a temporary
# directory, with a local registry standing in for GHCR and Docker Hub, so
# pulls, digests, tag drift, healthchecks and recreation behave exactly as
# on the VPS. Nothing here touches production: no SSH, no remote host.
#
# Covers the 1 Oct 2026 production findings:
#   H1  .last-good records immutable digests of the images actually running,
#       and --rollback pins exactly those digests (it used to record empty
#       values and roll back nothing).
#   H2  a migration deploy never recreates postgres/redis because their
#       mutable tags moved (production had both tags newer than the running
#       containers).
#   H4  caddy and ssr run with an init process: healthchecks leave no
#       zombies, and SIGTERM still stops them gracefully.
#
#   bash deploy/test/deploy-script.test.sh        (needs Docker, ~5 min)
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
REG_PORT=${DEPLOY_TEST_REGISTRY_PORT:-5055}
REG="localhost:${REG_PORT}"
REG_NAME=atlas-deploy-test-registry
export COMPOSE_PROJECT_NAME=atlasdeploytest
export NO_PROXY="localhost,127.0.0.1${NO_PROXY:+,$NO_PROXY}"
export no_proxy="$NO_PROXY"
W=$(mktemp -d)
B=$(mktemp -d) # image build contexts
PASS=0
FAIL=0

ok() { PASS=$((PASS + 1)); echo "ok - $1"; }
not_ok() { FAIL=$((FAIL + 1)); echo "not ok - $1"; }
check() { # check "description" command...
  local description=$1; shift
  if "$@"; then ok "$description"; else not_ok "$description"; fi
}
eq() { [ "$1" = "$2" ] || { echo "    expected: $2" >&2; echo "    actual:   $1" >&2; return 1; }; }
log_has() { grep -qF -- "$2" "$1" || { echo "    '$2' not in $1:" >&2; tail -20 "$1" >&2; return 1; }; }

cleanup() {
  (cd "$W" && docker compose --profile ssr --profile monitoring down -v -t 1 >/dev/null 2>&1) || true
  docker rm -f "$REG_NAME" atlas-deploy-test-noinit atlas-deploy-test-init >/dev/null 2>&1 || true
  rm -rf "$W" "$B"
}
# DEPLOY_TEST_KEEP=1 keeps the stack and logs for inspection.
[ "${DEPLOY_TEST_KEEP:-0}" = 1 ] || trap cleanup EXIT

dc() { (cd "$W" && docker compose "$@"); }
run_deploy() { # run_deploy <logfile> [args...]
  local logfile=$1; shift
  ATLAS_DIR="$W" bash "$W/deploy.sh" "$@" >"$logfile" 2>&1
}
cid() { dc ps -aq "$1"; }
running_image() { docker inspect --format '{{.Image}}' "$(cid "$1")"; }
# The digest the registry serves for repo:tag (what GHCR would report).
registry_digest() {
  curl -fsS -o /dev/null -D - \
    -H 'Accept: application/vnd.oci.image.index.v1+json' \
    -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.list.v2+json' \
    -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
    "http://${REG}/v2/$1/manifests/$2" | tr -d '\r' | awk -F': ' 'tolower($1)=="docker-content-digest"{print $2}'
}
record_value() { sed -n "s/^$1=//p" "$W/.last-good"; }

build_push() { # build_push <name:tag> <context dir> [build args...]
  local ref="$REG/$1" context=$2; shift 2
  docker build -q -t "$ref" "$@" "$context" >/dev/null
  docker push -q "$ref" >/dev/null
}

echo "# setup: registry on $REG, stack in $W"
docker rm -f "$REG_NAME" >/dev/null 2>&1 || true
docker image inspect registry:2 >/dev/null 2>&1 || docker pull -q registry:2 >/dev/null
docker run -d --name "$REG_NAME" -p "${REG_PORT}:5000" registry:2 >/dev/null
for _ in $(seq 1 50); do curl -fsS "http://${REG}/v2/" >/dev/null 2>&1 && break; sleep 0.2; done

# --- test images ------------------------------------------------------------
mkdir -p "$B/backend" "$B/caddy" "$B/ssr" "$B/idle" "$B/drift"
cat >"$B/backend/Dockerfile" <<'DOCKERFILE'
FROM busybox:1.36
ARG VERSION
ARG MIGRATIONS
ARG HEALTHY=1
RUN mkdir -p /app/prisma/migrations /www \
 && for m in $MIGRATIONS; do mkdir -p "/app/prisma/migrations/$m"; done \
 && if [ "$HEALTHY" = 1 ]; then echo ok > /www/health; fi \
 && echo "$VERSION" > /www/version \
 && printf '#!/bin/sh\necho "FAKE-PRISMA $* (backend %s)"\n' "$VERSION" > /bin/npx \
 && chmod +x /bin/npx
LABEL test.version=$VERSION
CMD ["httpd", "-f", "-p", "3000", "-h", "/www"]
DOCKERFILE
cat >"$B/caddy/Dockerfile" <<'DOCKERFILE'
FROM caddy:2-alpine
ARG VERSION
RUN printf '{\n\tadmin off\n\tlocal_certs\n\tskip_install_trust\n}\nlocalhost {\n\trespond "frontend %s"\n}\n' "$VERSION" > /etc/caddy/Caddyfile
LABEL test.version=$VERSION
DOCKERFILE
cat >"$B/ssr/Dockerfile" <<'DOCKERFILE'
FROM busybox:1.36
ARG VERSION
RUN mkdir -p /www/__ssr && echo ok > /www/__ssr/health
LABEL test.version=$VERSION
CMD ["httpd", "-f", "-p", "3100", "-h", "/www"]
DOCKERFILE
# Stands in for prometheus/alertmanager: ignores the compose `command:` flags.
printf 'FROM busybox:1.36\nENTRYPOINT ["sh", "-c", "exec sleep 2147483647", "--"]\n' >"$B/idle/Dockerfile"

echo "# setup: images"
# Pulled only when missing (Docker Hub rate-limits anonymous pulls).
for base in postgres:16-alpine redis:7-alpine caddy:2-alpine busybox:1.36 registry:2; do
  docker image inspect "$base" >/dev/null 2>&1 || docker pull -q "$base" >/dev/null
done
docker tag postgres:16-alpine "$REG/postgres:16-alpine" && docker push -q "$REG/postgres:16-alpine" >/dev/null
docker tag redis:7-alpine "$REG/redis:7-alpine" && docker push -q "$REG/redis:7-alpine" >/dev/null
build_push atlas-backend:latest "$B/backend" --build-arg VERSION=v1 --build-arg "MIGRATIONS=20260101000000_m1 20260201000000_m2"
build_push atlas-frontend:latest "$B/caddy" --build-arg VERSION=v1
build_push prom:test "$B/idle"
BACKEND_V1=$(registry_digest atlas-backend latest)
CADDY_V1=$(registry_digest atlas-frontend latest)

# --- the deployment directory: real script + real compose + test override ---
cp "$REPO/deploy/deploy.sh" "$W/deploy.sh"
cp "$REPO/deploy/docker-compose.prod.yml" "$W/docker-compose.yml"
cat >"$W/docker-compose.override.yml" <<YAML
services:
  postgres:
    image: ${REG}/postgres:16-alpine
    volumes:
      - ./initdb:/docker-entrypoint-initdb.d:ro
  redis:
    image: ${REG}/redis:7-alpine
  backend:
    image: ${REG}/atlas-backend:latest
  caddy:
    image: ${REG}/atlas-frontend:latest
    ports: !reset []
  ssr:
    image: ${REG}/atlas-frontend-ssr:latest
  prometheus:
    image: ${REG}/prom:test
  alertmanager:
    image: ${REG}/prom:test
YAML
mkdir -p "$W/initdb" "$W/monitoring/secrets"
cat >"$W/initdb/01-prisma.sql" <<'SQL'
CREATE TABLE _prisma_migrations (
  id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL DEFAULT '',
  finished_at timestamptz, migration_name varchar(255) NOT NULL, logs text,
  rolled_back_at timestamptz, started_at timestamptz NOT NULL DEFAULT now(),
  applied_steps_count integer NOT NULL DEFAULT 0);
INSERT INTO _prisma_migrations (id, migration_name, finished_at)
VALUES ('1', '20260101000000_m1', now());
-- What deploy.sh's pre-migration counts read.
CREATE TABLE quiz_attempts (id text, quiz_id text, student_id text,
  attempt_number integer, status text, created_at timestamptz DEFAULT now());
SQL
for f in prometheus.yml atlas-prometheus-rules.yml alertmanager.none.yml alertmanager.slack.yml; do
  echo "# test" >"$W/monitoring/$f"
done
cat >"$W/.env" <<'ENV'
POSTGRES_USER=atlas
POSTGRES_PASSWORD=test-password
POSTGRES_DB=atlas
REDIS_PASSWORD=test-redis
DATABASE_URL=postgresql://atlas:test-password@postgres:5432/atlas
CLOUDFLARE_API_TOKEN=test
METRICS_SCRAPE_TOKEN=test-scrape-token
ENV
printf '#!/usr/bin/env bash\necho "STUB-BACKUP verified"\n' >"$W/backup.sh"
# What `prisma migrate deploy` would leave behind (the fake backend image
# only reports that it ran).
mark_applied() {
  dc exec -T postgres psql -U atlas -d atlas -q -c \
    "INSERT INTO _prisma_migrations (id, migration_name, finished_at) VALUES ('$1', '$1', now())"
}

# =============================================================================
echo "# 1. first deploy, one migration pending (--with-migrations)"
check "deploy succeeds" run_deploy "$W/log1" --with-migrations
check "the pending migration was applied after the backup" log_has "$W/log1" "FAKE-PRISMA prisma migrate deploy (backend v1)"
check "the backup ran first" log_has "$W/log1" "STUB-BACKUP verified"
mark_applied 20260201000000_m2
check ".last-good BACKEND_IMAGE is the registry digest of the running backend" \
  eq "$(record_value BACKEND_IMAGE)" "$REG/atlas-backend@$BACKEND_V1"
check ".last-good CADDY_IMAGE is the registry digest of the running caddy" \
  eq "$(record_value CADDY_IMAGE)" "$REG/atlas-frontend@$CADDY_V1"
check ".last-good has no SSR_IMAGE while ATLAS_SSR is off" eq "$(record_value SSR_IMAGE)" ""
check "both recorded images are <repository>@sha256:<64 hex>" \
  bash -c "[ \"\$(grep -cE '^(BACKEND|CADDY)_IMAGE=[^@[:space:]]+@sha256:[0-9a-f]{64}$' '$W/.last-good')\" = 2 ]"
check "the recorded digests can be pulled back" \
  bash -c "docker pull -q '$(record_value BACKEND_IMAGE)' >/dev/null && docker pull -q '$(record_value CADDY_IMAGE)' >/dev/null"

# =============================================================================
echo "# 2. migration deploy while the postgres/redis tags have moved (H2)"
PG_CID=$(cid postgres); RD_CID=$(cid redis)
PG_IMAGE=$(running_image postgres); RD_IMAGE=$(running_image redis)
PG_STARTED=$(docker inspect --format '{{.State.StartedAt}}' "$PG_CID")
printf 'FROM %s/postgres:16-alpine\nLABEL test.drift=1\n' "$REG" >"$B/drift/Dockerfile"
build_push postgres:16-alpine "$B/drift"
printf 'FROM %s/redis:7-alpine\nLABEL test.drift=1\n' "$REG" >"$B/drift/Dockerfile"
build_push redis:7-alpine "$B/drift"
# Production's state: the newer images are already on the host under the tag.
docker pull -q "$REG/postgres:16-alpine" >/dev/null
docker pull -q "$REG/redis:7-alpine" >/dev/null
check "precondition: the postgres tag now names a different image than the container runs" \
  bash -c "[ \"\$(docker image inspect -f '{{.Id}}' '$REG/postgres:16-alpine')\" != '$PG_IMAGE' ]"
build_push atlas-backend:latest "$B/backend" --build-arg VERSION=v2 \
  --build-arg "MIGRATIONS=20260101000000_m1 20260201000000_m2 20260301000000_m3"
build_push atlas-frontend:latest "$B/caddy" --build-arg VERSION=v2
BACKEND_V2=$(registry_digest atlas-backend latest)
CADDY_V2=$(registry_digest atlas-frontend latest)
check "migration deploy succeeds" run_deploy "$W/log2" --with-migrations
check "it applied the new migration" log_has "$W/log2" "FAKE-PRISMA prisma migrate deploy (backend v2)"
mark_applied 20260301000000_m3
check "postgres was not recreated (same container)" eq "$(cid postgres)" "$PG_CID"
check "postgres was not restarted" eq "$(docker inspect --format '{{.State.StartedAt}}' "$PG_CID")" "$PG_STARTED"
check "postgres still runs the image it ran before" eq "$(running_image postgres)" "$PG_IMAGE"
check "redis was not recreated (same container)" eq "$(cid redis)" "$RD_CID"
check "redis still runs the image it ran before" eq "$(running_image redis)" "$RD_IMAGE"
check "the drift was reported, not acted on" log_has "$W/log2" "NOTE: postgres runs"
check "postgres/redis images were not pulled by the deploy" \
  bash -c "! grep -qE 'postgres:16-alpine.*Pulled|redis:7-alpine.*Pulled' '$W/log2'"
check "the backend was rolled to v2" eq "$(running_image backend)" "$(docker image inspect -f '{{.Id}}' "$REG/atlas-backend@$BACKEND_V2")"
check ".last-good now records v2" eq "$(record_value BACKEND_IMAGE)|$(record_value CADDY_IMAGE)" \
  "$REG/atlas-backend@$BACKEND_V2|$REG/atlas-frontend@$CADDY_V2"
# Control: the drift was real — the previous flow WOULD have recreated postgres.
dc up -d postgres >/dev/null 2>&1
check "control: a plain 'compose up -d postgres' (the old flow) recreates it" \
  bash -c "[ \"\$(cd '$W' && docker compose ps -aq postgres)\" != '$PG_CID' ]"
dc up -d --wait postgres redis >/dev/null 2>&1

# =============================================================================
echo "# 3. first-deploy bootstrap record, a failed deploy, then --rollback (H1)"
cp "$W/.last-good" "$W/last-good.v2" # what record_last_good wrote after deploy 2
PG_CID=$(cid postgres); BACKEND_CID=$(cid backend); CADDY_CID=$(cid caddy)
started() { docker inspect --format '{{.State.StartedAt}}' "$(cid "$1")"; }
STARTS="$(started backend)|$(started caddy)|$(started postgres)|$(started redis)"
# Production's state: the empty record every previous deploy wrote.
printf 'BACKEND_IMAGE=\nCADDY_IMAGE=\nRECORDED_AT=2026-09-29T02:02:29Z\n' >"$W/.last-good"
check "check mode rejects production's empty record" \
  bash -c "! ATLAS_DIR='$W' bash '$W/deploy.sh' --check-rollback-record >'$W/log3a' 2>&1"
# The bootstrap exactly as the production procedure writes it: the audited
# running digests, written atomically, nothing else touched.
AUDIT_BACKEND="$REG/atlas-backend@$BACKEND_V2"
AUDIT_CADDY="$REG/atlas-frontend@$CADDY_V2"
printf 'BACKEND_IMAGE=%s\nCADDY_IMAGE=%s\nRECORDED_AT=%s\n' \
  "$AUDIT_BACKEND" "$AUDIT_CADDY" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >"$W/.last-good.tmp"
mv "$W/.last-good.tmp" "$W/.last-good"
cp "$W/.last-good" "$W/last-good.bootstrap"
check "the bootstrap record names exactly what record_last_good records" \
  eq "$(grep -v '^RECORDED_AT=' "$W/.last-good")" "$(grep -v '^RECORDED_AT=' "$W/last-good.v2")"
ENV_SUM=$(sha256sum <"$W/.env")
check "check mode accepts the bootstrap record" run_deploy "$W/log3b" --check-rollback-record
check "check mode confirms both recorded images are what runs now" \
  bash -c "[ \"\$(grep -c 'it is what runs now' '$W/log3b')\" = 2 ]"
check "check mode changed nothing: same containers, start times, .env and record" \
  eq "$(cid backend)|$(cid caddy)|$(cid postgres)|$STARTS|$(sha256sum <"$W/.env")|$(sha256sum <"$W/.last-good")" \
  "$BACKEND_CID|$CADDY_CID|$PG_CID|$(started backend)|$(started caddy)|$(started postgres)|$(started redis)|$ENV_SUM|$(sha256sum <"$W/last-good.bootstrap")"
build_push atlas-backend:latest "$B/backend" --build-arg VERSION=v3 --build-arg HEALTHY=0 \
  --build-arg "MIGRATIONS=20260101000000_m1 20260201000000_m2 20260301000000_m3"
build_push atlas-frontend:latest "$B/caddy" --build-arg VERSION=v3
check "an unhealthy release fails the deploy" bash -c "! ATLAS_DIR='$W' bash '$W/deploy.sh' >'$W/log3' 2>&1"
check "the failed deploy left the bootstrap record untouched" cmp -s "$W/.last-good" "$W/last-good.bootstrap"
check "rollback from the bootstrap record succeeds" run_deploy "$W/log4" --rollback
check "the backend runs exactly the bootstrapped digest" \
  eq "$(running_image backend)" "$(docker image inspect -f '{{.Id}}' "$AUDIT_BACKEND")"
check "caddy runs exactly the bootstrapped digest" \
  eq "$(running_image caddy)" "$(docker image inspect -f '{{.Id}}' "$AUDIT_CADDY")"
check "rollback verified the running images itself" log_has "$W/log4" "Running images match the record."
check "neither the failed deploy nor the rollback touched postgres" eq "$(cid postgres)" "$PG_CID"

# =============================================================================
echo "# 4. rollback refuses an unusable record and changes nothing; SSR off never touches the renderer"
BACKEND_CID=$(cid backend); CADDY_CID=$(cid caddy)
printf 'BACKEND_IMAGE=\nCADDY_IMAGE=\nRECORDED_AT=2026-09-29T02:02:29Z\n' >"$W/.last-good" # production's record
check "rollback with production's empty record fails" bash -c "! ATLAS_DIR='$W' bash '$W/deploy.sh' --rollback >'$W/log5' 2>&1"
check "it says why" log_has "$W/log5" "the record has no valid backend image digest"
check "nothing was rolled (same backend and caddy containers)" eq "$(cid backend)|$(cid caddy)" "$BACKEND_CID|$CADDY_CID"
printf 'BACKEND_IMAGE=%s\nCADDY_IMAGE=%s\n' "$REG/atlas-frontend@$CADDY_V2" "$REG/atlas-frontend@$CADDY_V2" >"$W/.last-good"
check "rollback refuses a digest from another repository" bash -c "! ATLAS_DIR='$W' bash '$W/deploy.sh' --rollback >'$W/log6' 2>&1"
check "nothing was rolled" eq "$(cid backend)|$(cid caddy)" "$BACKEND_CID|$CADDY_CID"
# SSR off: a recorded renderer digest that exists NOWHERE (the renderer image
# has not even been published yet) must be ignored, never pulled or started.
MISSING_SSR="$REG/atlas-frontend-ssr@sha256:$(printf '0%.0s' $(seq 1 64))"
{ cat "$W/last-good.bootstrap"; echo "SSR_IMAGE=$MISSING_SSR"; } >"$W/.last-good"
check "precondition: no renderer image exists in the registry or on the host" \
  bash -c "! docker manifest inspect --insecure '$REG/atlas-frontend-ssr:latest' >/dev/null 2>&1 && ! docker image inspect '$MISSING_SSR' >/dev/null 2>&1"
check "SSR off: check mode accepts the record and says the renderer is not rollback state" \
  bash -c "ATLAS_DIR='$W' bash '$W/deploy.sh' --check-rollback-record >'$W/log6b' 2>&1 && grep -q 'NOT rollback state while ATLAS_SSR is off' '$W/log6b'"
check "SSR off: rollback succeeds without the renderer image" run_deploy "$W/log6c" --rollback
check "SSR off: rollback never pulled, tagged or started the renderer" \
  bash -c "! grep -qE 'ssr' '$W/log6c' && [ -z \"\$(cd '$W' && docker compose --profile ssr ps -aq ssr)\" ]"
cp "$W/last-good.bootstrap" "$W/.last-good"

# =============================================================================
echo "# 5. ATLAS_SSR=on: renderer digest recorded; init and memory limit applied (H1, H3, H4)"
build_push atlas-frontend-ssr:latest "$B/ssr" --build-arg VERSION=v1
SSR_V1=$(registry_digest atlas-frontend-ssr latest)
echo "ATLAS_SSR=on" >>"$W/.env"
build_push atlas-backend:latest "$B/backend" --build-arg VERSION=v4 \
  --build-arg "MIGRATIONS=20260101000000_m1 20260201000000_m2 20260301000000_m3"
check "deploy with the renderer succeeds" run_deploy "$W/log7"
check ".last-good SSR_IMAGE is the registry digest of the running renderer" \
  eq "$(record_value SSR_IMAGE)" "$REG/atlas-frontend-ssr@$SSR_V1"
check "caddy runs with an init process" eq "$(docker inspect -f '{{.HostConfig.Init}}' "$(cid caddy)")" "true"
check "ssr runs with an init process" eq "$(docker inspect -f '{{.HostConfig.Init}}' "$(cid ssr)")" "true"
check "ssr has the 384 MiB memory limit" eq "$(docker inspect -f '{{.HostConfig.Memory}}' "$(cid ssr)")" "402653184"
check "ssr caps the V8 heap below the limit" \
  bash -c "docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' '$(cid ssr)' | grep -qx 'NODE_OPTIONS=--max-old-space-size=256'"
check "caddy is healthy behind its healthcheck" eq "$(docker inspect -f '{{.State.Health.Status}}' "$(cid caddy)")" "healthy"
check "ssr is healthy behind its healthcheck" eq "$(docker inspect -f '{{.State.Health.Status}}' "$(cid ssr)")" "healthy"
check "monitoring is still reloaded with ssr on (COMPOSE_PROFILES=ssr,monitoring)" \
  log_has "$W/log7" "Reloading Prometheus/Alertmanager configuration"
check "SSR on: check mode lists the renderer as rollback state" \
  bash -c "ATLAS_DIR='$W' bash '$W/deploy.sh' --check-rollback-record >'$W/log7b' 2>&1 && grep -q '    ssr: $REG/atlas-frontend-ssr@$SSR_V1' '$W/log7b'"
sed -i '/^SSR_IMAGE=/d' "$W/.last-good"
check "rollback refuses a record without a renderer while ATLAS_SSR=on" \
  bash -c "! ATLAS_DIR='$W' bash '$W/deploy.sh' --rollback >'$W/log8' 2>&1 && grep -q 'predates server rendering' '$W/log8'"

# =============================================================================
echo "# 6. init reaps the healthcheck's orphans; SIGTERM still stops gracefully (H4)"
# The caddy healthcheck runs `wget https://…`; BusyBox wget forks an
# ssl_client helper that outlives it and is re-parented to PID 1.
zombies_after_probes() { # zombies_after_probes <container>
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    docker exec "$1" wget -qO- --no-check-certificate https://localhost/ >/dev/null 2>&1 || true
  done
  sleep 1
  docker exec "$1" sh -c "ps -o stat= | grep -c '^Z' || true"
}
docker run -d --name atlas-deploy-test-noinit "$REG/atlas-frontend:latest" >/dev/null
docker run -d --init --name atlas-deploy-test-init "$REG/atlas-frontend:latest" >/dev/null
sleep 3
NOINIT_Z=$(zombies_after_probes atlas-deploy-test-noinit)
INIT_Z=$(zombies_after_probes atlas-deploy-test-init)
check "control: without init, 10 https probes leave zombies (found $NOINIT_Z)" bash -c "[ '$NOINIT_Z' -gt 0 ]"
check "with init, 10 https probes leave no zombie" eq "$INIT_Z" "0"
check "the deployed caddy (init: true) has no zombie after 10 probes" eq "$(zombies_after_probes "$(cid caddy)")" "0"
for c in atlas-deploy-test-init atlas-deploy-test-noinit; do
  start=$(date +%s)
  docker stop -t 10 "$c" >/dev/null
  took=$(( $(date +%s) - start ))
  code=$(docker inspect -f '{{.State.ExitCode}}' "$c")
  check "$c: SIGTERM stops caddy gracefully (exit $code in ${took}s, no SIGKILL)" bash -c "[ '$code' = 0 ] && [ '$took' -lt 10 ]"
done

echo
echo "# $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]
