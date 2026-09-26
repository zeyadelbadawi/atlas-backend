#!/usr/bin/env bash
# Atlas — production verification of New Customer Onboarding
# (docs/NEW_CUSTOMER_ONBOARDING.md). Run ON the VPS, from /opt/atlas, by the
# `Onboarding verify` workflow over SSH stdin.
#
# Prints PASS/FAIL lines and non-secret facts only: counts, flag values,
# plan keys, message keys. No credential, token or personal data is read
# or printed.
#
# It writes NOTHING. The one request that could create rows — the
# register probe — is sent only in a shape the server refuses BEFORE any
# write (flag off: organization fields refused; flag on: a random,
# non-existent plan id refused), and the script then asserts that no user
# row exists for the probe address.
set -uo pipefail
cd /opt/atlas
export COMPOSE_PROFILES=monitoring

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
info() { echo "INFO  $*"; }

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -c "$1"; }
# HTTP from inside the backend container, to the app itself. Prints
# "<status> <body>"; the body is JSON the node snippet reduces to facts.
api() {
  docker compose exec -T backend node -e "
    const [method, path, body] = process.argv.slice(1);
    fetch('http://localhost:3000/api/v1' + path, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body || undefined,
    }).then(async (r) => console.log(r.status + ' ' + (await r.text())))
      .catch((e) => console.log('000 ' + e.message));
  " "$@"
}
json() { docker compose exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log($1)})"; }

echo "== Migration"
applied=$(sql "select count(*) from _prisma_migrations where migration_name='20261017000000_onboarding_completed_at' and finished_at is not null and rolled_back_at is null")
if [ "$applied" = "1" ]; then pass "migration 20261017000000_onboarding_completed_at applied"; else fail "migration not applied (count=$applied)"; fi
default=$(sql "select column_default from information_schema.columns where table_name='organizations' and column_name='onboarding_completed_at'")
if [ "$default" = "CURRENT_TIMESTAMP" ]; then pass "organizations.onboarding_completed_at exists, default CURRENT_TIMESTAMP"; else fail "column default: ${default:-absent}"; fi
total=$(sql "select count(*) from organizations")
pending=$(sql "select count(*) from organizations where onboarding_completed_at is null")
info "organizations: $total total, $pending with onboarding pending"
secdef=$(sql "select prosecdef from pg_proc where proname='complete_organization_onboarding'")
if [ "$secdef" = "t" ]; then pass "complete_organization_onboarding is SECURITY DEFINER"; else fail "definer function: ${secdef:-absent}"; fi
app_exec=$(sql "select has_function_privilege('atlas_app','complete_organization_onboarding(text)','execute')")
public_exec=$(sql "select exists(select 1 from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.proname='complete_organization_onboarding' and a.grantee=0 and a.privilege_type='EXECUTE')")
if [ "$app_exec" = "t" ] && [ "$public_exec" = "f" ]; then pass "EXECUTE granted to atlas_app, not to PUBLIC"; else fail "grants: atlas_app=$app_exec public=$public_exec"; fi
update_policies=$(sql "select count(*) from pg_policies where tablename='organizations' and cmd in ('UPDATE','ALL')")
info "UPDATE/ALL policies on organizations: $update_policies (the feature adds none)"

echo "== Flag"
FLAG=$(env_value FLAG_SIGNUP_ORGANIZATION_MODE)
FLAG=${FLAG:-off}
info "FLAG_SIGNUP_ORGANIZATION_MODE=$FLAG (.env)"
runtime_flag=$(docker compose exec -T backend printenv FLAG_SIGNUP_ORGANIZATION_MODE 2>/dev/null || true)
info "backend container sees FLAG_SIGNUP_ORGANIZATION_MODE=${runtime_flag:-<unset, default off>}"
EFFECTIVE=${runtime_flag:-off}

echo "== GET /public/signup-options"
read -r code body < <(api GET /public/signup-options)
if [ "$code" = "200" ]; then
  pass "signup-options -> 200"
  facts=$(printf '%s' "$body" | json "'organizationSignup='+d.organizationSignup+' trialsEnabled='+d.trialsEnabled+' trialPlans='+(d.trialPlans.map(p=>p.key).join(',')||'-')")
  info "$facts"
  expected="organizationSignup=$([ "$EFFECTIVE" = "on" ] && echo true || echo false)"
  case "$facts" in "$expected "*) pass "organizationSignup matches the flag ($EFFECTIVE)" ;; *) fail "organizationSignup does not match the flag ($EFFECTIVE)" ;; esac
else
  fail "signup-options -> $code"
fi

echo "== POST /auth/register refusal (no write)"
PROBE="atlas.onboarding.verify.$(date +%s)@gmail.com"
if [ "$EFFECTIVE" = "on" ]; then
  # A well-formed but non-existent plan id: refused as unavailable.
  payload="{\"name\":\"Onboarding Verify\",\"email\":\"$PROBE\",\"password\":\"verify-only-$(date +%s%N)\",\"organizationName\":\"Onboarding Verify\",\"planId\":\"00000000-0000-4000-8000-000000000000\"}"
  want="errors.auth.signupPlanUnavailable"
else
  payload="{\"name\":\"Onboarding Verify\",\"email\":\"$PROBE\",\"password\":\"verify-only-$(date +%s%N)\",\"organizationName\":\"Onboarding Verify\"}"
  want="errors.auth.organizationSignupDisabled"
fi
read -r code body < <(api POST /auth/register "$payload")
key=$(printf '%s' "$body" | json "d.messageKey||(d.error&&d.error.messageKey)||JSON.stringify(d).slice(0,120)" 2>/dev/null)
if [ "$code" = "400" ] && [ "$key" = "$want" ]; then pass "register with organization fields -> 400 $want"; else fail "register probe -> $code ${key:-?} (wanted 400 $want)"; fi
rows=$(sql "select count(*) from users where email='$PROBE'")
if [ "$rows" = "0" ]; then pass "the refused probe created no user row"; else fail "probe created $rows user row(s)"; fi

echo "== Metrics"
series=$(docker compose exec -T prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=atlas_signup_total' 2>/dev/null | json "d.data.result.map(r=>r.metric.mode+'/'+r.metric.outcome+'='+r.value[1]).join(' ')||'no series yet (scraped every 30s)'" 2>/dev/null)
info "atlas_signup_total: ${series:-prometheus unavailable}"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed"; else echo "RESULT: $FAILS check(s) failed"; exit 1; fi
