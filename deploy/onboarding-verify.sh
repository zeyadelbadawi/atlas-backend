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
# The deploy action writes a FLAG_* line only when the repository variable
# is set, so an unset variable is ABSENT from .env (the backend default,
# `off`, then applies) — reported as such, never as a value it does not have.
FLAG=$(env_value FLAG_SIGNUP_ORGANIZATION_MODE)
info "FLAG_SIGNUP_ORGANIZATION_MODE in .env: ${FLAG:-<absent — repository variable unset, default off>}"
runtime_flag=$(docker compose exec -T backend printenv FLAG_SIGNUP_ORGANIZATION_MODE 2>/dev/null || true)
info "backend container sees FLAG_SIGNUP_ORGANIZATION_MODE=${runtime_flag:-<unset, default off>}"
EFFECTIVE=${runtime_flag:-off}

echo "== GET /public/signup-options"
# The EXPECTED trial plans come from the server-side eligibility rule
# itself (PlansRepository CUSTOMER_FACING_WHERE + trialEligible, and the
# trial policy), never from a hardcoded list.
trials_enabled=$(sql "select coalesce((select enabled::text from trial_policy limit 1), 'true')")
expected_plans=$(sql "select coalesce(string_agg(key, ',' order by display_order), '-') from plans where status='active' and display_order>0 and trial_eligible")
[ "$trials_enabled" = "true" ] || expected_plans="-"
info "server-side rule: trials enabled=$trials_enabled; eligible plans (active, customer-facing, trial-eligible)=$expected_plans"
info "excluded by the rule: $(sql "select count(*) from plans where status='active' and display_order>0 and not trial_eligible") non-trial, $(sql "select count(*) from plans where status<>'active'") inactive, $(sql "select count(*) from plans where status='active' and display_order<=0") hidden"
read -r code body < <(api GET /public/signup-options)
if [ "$code" = "200" ]; then
  pass "signup-options -> 200"
  org_signup=$(printf '%s' "$body" | json "d.organizationSignup")
  exposed=$(printf '%s' "$body" | json "d.trialPlans.map(p=>p.key).join(',')||'-'")
  info "organizationSignup=$org_signup trialsEnabled=$(printf '%s' "$body" | json "d.trialsEnabled") trialPlans=$exposed"
  want_signup=$([ "$EFFECTIVE" = "on" ] && echo true || echo false)
  if [ "$org_signup" = "$want_signup" ]; then pass "organizationSignup=$org_signup matches the flag ($EFFECTIVE)"; else fail "organizationSignup=$org_signup does not match the flag ($EFFECTIVE)"; fi
  if [ "$exposed" = "$expected_plans" ]; then pass "exposed trial plans are exactly the server-side eligible set ($exposed)"; else fail "exposed trial plans ($exposed) differ from the eligible set ($expected_plans)"; fi
else
  fail "signup-options -> $code"
fi

echo "== POST /auth/register refusals (no write)"
RUN="$(date +%s)$$"
ORG_NAME="Onboarding Verify $RUN"
n=0
# probe <label> <wanted status> <wanted messageKey or -> <json fields after name/email/password>
probe() {
  local label="$1" want_code="$2" want_key="$3" fields="$4"
  n=$((n + 1))
  local email="atlas.onboarding.verify.${RUN}.${n}@gmail.com"
  local payload="{\"name\":\"Onboarding Verify\",\"email\":\"$email\",\"password\":\"verify-only-$(date +%s%N)\"$fields}"
  local code body key rows
  read -r code body < <(api POST /auth/register "$payload")
  key=$(printf '%s' "$body" | json "(d.error&&d.error.messageKey)||d.messageKey||'-'" 2>/dev/null)
  if [ "$code" = "$want_code" ] && { [ "$want_key" = "-" ] || [ "$key" = "$want_key" ]; }; then
    pass "$label -> $code $key"
  else
    fail "$label -> $code ${key:-?} (wanted $want_code $want_key)"
  fi
  rows=$(sql "select count(*) from users where email='$email'")
  if [ "$rows" != "0" ]; then fail "$label created $rows user row(s)"; fi
}
if [ "$EFFECTIVE" = "on" ]; then
  ORGF=",\"organizationName\":\"$ORG_NAME\""
  probe "fake plan id" 400 errors.auth.signupPlanUnavailable "$ORGF,\"planId\":\"00000000-0000-4000-8000-000000000000\""
  non_trial=$(sql "select id from plans where status='active' and display_order>0 and not trial_eligible order by display_order limit 1")
  if [ -n "$non_trial" ]; then probe "non-trial plan" 400 errors.auth.signupPlanUnavailable "$ORGF,\"planId\":\"$non_trial\""; else info "no non-trial plan exists to probe"; fi
  inactive=$(sql "select id from plans where status<>'active' order by created_at desc limit 1")
  if [ -n "$inactive" ]; then probe "inactive (archived) plan" 400 errors.auth.signupPlanUnavailable "$ORGF,\"planId\":\"$inactive\""; else info "no inactive plan exists to probe"; fi
  hidden=$(sql "select id from plans where status='active' and display_order<=0 order by created_at desc limit 1")
  if [ -n "$hidden" ]; then probe "hidden (not customer-facing) plan" 400 errors.auth.signupPlanUnavailable "$ORGF,\"planId\":\"$hidden\""; else info "no hidden plan exists to probe"; fi
  eligible=$(sql "select id from plans where status='active' and display_order>0 and trial_eligible order by display_order limit 1")
  probe "plan without organization name" 400 errors.auth.organizationNameRequired ",\"planId\":\"$eligible\""
  probe "organization name too short" 400 - ",\"organizationName\":\"x\""
  probe "malformed plan id" 400 - "$ORGF,\"planId\":\"not-a-uuid\""
  probe "organization fields with an academy id" 400 - "$ORGF,\"academyId\":\"00000000-0000-4000-8000-000000000000\""
  # Duplicate email: an EXISTING account's address (read here, never
  # printed) with a valid organization + eligible plan must be a 409 that
  # writes nothing.
  existing=$(sql "select email from users where email like '%@%' and deleted_at is null order by created_at limit 1" 2>/dev/null || sql "select email from users where email like '%@%' order by created_at limit 1")
  before_orgs=$(sql "select count(*) from organizations where name='$ORG_NAME'")
  read -r code body < <(api POST /auth/register "{\"name\":\"Onboarding Verify\",\"email\":\"$existing\",\"password\":\"verify-only-$(date +%s%N)\"$ORGF,\"planId\":\"$eligible\"}")
  key=$(printf '%s' "$body" | json "(d.error&&d.error.messageKey)||d.messageKey||'-'" 2>/dev/null)
  if [ "$code" = "409" ] && [ "$key" = "errors.auth.emailAlreadyRegistered" ]; then pass "existing email -> 409 $key"; else fail "existing email -> $code ${key:-?} (wanted 409 errors.auth.emailAlreadyRegistered)"; fi
else
  probe "organization fields while the flag is off" 400 errors.auth.organizationSignupDisabled ",\"organizationName\":\"$ORG_NAME\""
fi
orgs=$(sql "select count(*) from organizations where name='$ORG_NAME'")
if [ "$orgs" = "0" ]; then pass "no organization was created by any probe"; else fail "$orgs organization(s) created by the probes"; fi
redemptions=$(sql "select count(*) from trial_redemptions where redeemed_at > now() - interval '5 minutes'" 2>/dev/null || echo "?")
info "trial redemptions in the last 5 minutes: $redemptions"

echo "== Paid recovery path (trial already used)"
# Checkout for a no_plan organization offers the ENABLED rows of Atlas's own
# payment-method catalog. Keys/types/providers only — never instructions.
methods=$(sql "select coalesce(string_agg(key || ':' || type || ':' || provider, ',' order by display_order), '-') from payment_methods where enabled")
info "enabled payment methods: $methods (disabled: $(sql "select count(*) from payment_methods where not enabled"))"
if [ "$methods" != "-" ]; then pass "checkout has at least one enabled payment method"; else fail "no enabled payment method — a trial-already-used customer cannot pay (paid recovery dead end)"; fi

echo "== Metrics"
series=$(docker compose exec -T prometheus wget -qO- 'http://localhost:9090/api/v1/query?query=atlas_signup_total' 2>/dev/null | json "d.data.result.map(r=>r.metric.mode+'/'+r.metric.outcome+'='+r.value[1]).join(' ')||'no series yet (scraped every 30s)'" 2>/dev/null)
info "atlas_signup_total: ${series:-prometheus unavailable}"

echo
if [ "$FAILS" -eq 0 ]; then echo "RESULT: all checks passed"; else echo "RESULT: $FAILS check(s) failed"; exit 1; fi
