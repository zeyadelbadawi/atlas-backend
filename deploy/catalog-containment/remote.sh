#!/usr/bin/env bash
# B0-CAT-03 / B0-MED-03 — Premium catalog containment, run on the VPS by
# .github/workflows/catalog-containment.yml.
#
# WHAT IT CHANGES (apply): `display_order` of the three Premium plans
# (`premium-starter`, `premium-growth`, `premium-enterprise`) from their
# recorded values 4 / 5 / 6 to 0, and `version` + 1 so a console editor
# holding the old version is told it is stale. Nothing else: no price,
# limit, trial setting, status, other plan, subscription, checkout or
# payment is touched. `display_order = 0` is the catalog's existing
# "not customer-facing" signal (`PlansRepository.CUSTOMER_FACING_WHERE`):
# the plans leave `GET /public/plans`, `GET /public/signup-options`, the
# signed-in plan lists, and signup refuses them
# (`TrialRedemptionService.resolveSignupTrialPlan`). Existing subscriptions
# keep their plan row and renew by key (checkout looks a plan up by key
# and requires only `status = 'active'`).
#
# revert puts 4 / 5 / 6 back, also with `version` + 1.
#
# Modes:
#   dry-run  read-only: prints the rows, subscriptions and checkouts per
#            Premium key, and what apply would change.
#   apply    one transaction; refuses unless all three rows are in the
#            exact recorded before-state; already applied = no-op.
#   revert   one transaction; refuses unless all three rows are at 0.
#
# Not written: an audit_log_entries row. Its actor is a required user FK
# and this is not run as a user; the approval record of the workflow run
# (approver, time, commit) and this script's before/after output are the
# record. The console's plan history will not show this change.
set -uo pipefail
cd "${CATALOG_CONTAINMENT_DIR:-/opt/atlas}"

MODE="${1:-dry-run}"
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
psql_() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -v ON_ERROR_STOP=1 "$@"; }
sql() { psql_ -t -A -F'|' -c "$1"; }

KEYS="'premium-starter','premium-growth','premium-enterprise'"

report() {
  echo "== Premium plans ($1)"
  sql "select key, family, status, display_order, version, pricing->>'currency', pricing->>'amount', trial_eligible from plans where key in ($KEYS) order by key" \
    | while IFS='|' read -r k fam st ord ver cur amt tr; do
        echo "plan $k: family=$fam status=$st displayOrder=$ord version=$ver price=$amt $cur trialEligible=$tr"
      done
  sql "select p.key, s.status, count(*) from tenant_subscriptions s join plans p on p.id = s.plan_id where p.key in ($KEYS) group by p.key, s.status order by p.key, s.status" \
    | while IFS='|' read -r k st n; do echo "subscriptions on $k: $st=$n"; done
  sql "select c.target_key, c.status, count(*) from checkouts c where c.target_type = 'plan_subscription' and c.target_key in ($KEYS) group by c.target_key, c.status order by 1, 2" \
    | while IFS='|' read -r k st n; do echo "checkouts for $k: $st=$n"; done
  echo "customer-facing plans: $(sql "select string_agg(key, ',' order by display_order) from plans where status = 'active' and display_order > 0")"
}

case "$MODE" in
  dry-run)
    report "before; nothing is written"
    echo "== apply would set displayOrder 4/5/6 -> 0 on premium-starter/premium-growth/premium-enterprise (version + 1); nothing else"
    ;;
  apply)
    report "before"
    psql_ -q <<'SQL' || { echo "FAIL  apply refused or failed; the transaction rolled back, nothing changed"; exit 1; }
BEGIN;
DO $$
DECLARE hidden int; expected int;
BEGIN
  SELECT count(*) FILTER (WHERE display_order = 0),
         count(*) FILTER (WHERE (key, display_order) IN (('premium-starter', 4), ('premium-growth', 5), ('premium-enterprise', 6)))
    INTO hidden, expected
    FROM plans WHERE key IN ('premium-starter', 'premium-growth', 'premium-enterprise') AND family = 'premium';
  IF hidden = 3 THEN
    RAISE NOTICE 'already applied: all three Premium plans are hidden; nothing changed';
  ELSIF expected <> 3 THEN
    RAISE EXCEPTION 'before-state differs from the recorded 4/5/6 (hidden=%, matching=%); refusing', hidden, expected;
  ELSE
    UPDATE plans SET display_order = 0, version = version + 1, updated_at = now()
     WHERE key IN ('premium-starter', 'premium-growth', 'premium-enterprise') AND family = 'premium' AND display_order > 0;
  END IF;
END $$;
COMMIT;
SQL
    report "after"
    ;;
  revert)
    report "before"
    psql_ -q <<'SQL' || { echo "FAIL  revert refused or failed; the transaction rolled back, nothing changed"; exit 1; }
BEGIN;
DO $$
DECLARE hidden int;
BEGIN
  SELECT count(*) FILTER (WHERE display_order = 0) INTO hidden
    FROM plans WHERE key IN ('premium-starter', 'premium-growth', 'premium-enterprise') AND family = 'premium';
  IF hidden <> 3 THEN
    RAISE EXCEPTION 'not all three Premium plans are hidden (hidden=%); refusing', hidden;
  END IF;
  UPDATE plans SET display_order = CASE key WHEN 'premium-starter' THEN 4 WHEN 'premium-growth' THEN 5 ELSE 6 END,
                   version = version + 1, updated_at = now()
   WHERE key IN ('premium-starter', 'premium-growth', 'premium-enterprise') AND family = 'premium';
END $$;
COMMIT;
SQL
    report "after"
    ;;
  *) echo "usage: remote.sh dry-run|apply|revert" >&2; exit 2 ;;
esac
