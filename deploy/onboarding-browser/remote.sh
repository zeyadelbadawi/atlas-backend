#!/usr/bin/env bash
# Atlas — server-side helper for the production onboarding browser journey
# (`Onboarding browser verify`). Run ON the VPS, from /opt/atlas, over the
# restricted deploy identity, fed through stdin like onboarding-verify.sh.
#
#   remote.sh eligible <email>   -> "eligible=yes|no" (trial subject, via the app's own hash)
#   remote.sh otp <email>        -> the latest sign-in code for THAT account only
#   remote.sh state <email>      -> non-personal facts about the signup's atomic state
#   remote.sh final <email>      -> non-personal facts after the onboarding journey
#
# Scope: every read is keyed by the one test address the journey itself just
# registered. The `otp` output is consumed by the runner process and never
# written to the log. Nothing here writes to the database.
set -uo pipefail
cd /opt/atlas

cmd="${1:-}"
email="${2:-}"
# Only the journey's own plus-addressed test mailboxes are accepted.
if ! printf '%s' "$email" | grep -Eq '^[a-z0-9._-]+\+atlas-onb-[a-z0-9-]+@gmail\.com$'; then
  echo "refused: not a journey test address" >&2
  exit 2
fi

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -c "$1"; }
USER_ID_SQL="(select id from users where email='$email')"

case "$cmd" in
  eligible)
    hash=$(docker compose exec -T backend node -e \
      "process.stdout.write(require('./dist/plans/utils/trial-subject.util').trialSubjectHash(process.argv[1]))" "$email")
    if ! printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$'; then echo "eligible=unknown (hash unavailable)"; exit 1; fi
    used=$(sql "select count(*) from trial_redemptions where subject_hash='$hash'")
    if [ "$used" = "0" ]; then echo "eligible=yes"; else echo "eligible=no"; fi
    ;;
  otp)
    sql "select o.values->>'code' from communication_outbox o where o.recipient_user_id=$USER_ID_SQL and o.key='auth.email.otp' order by o.created_at desc limit 1"
    ;;
  state)
    sql "select 'users', count(*) from users where email='$email'"
    sql "select 'organizations_owned', count(*) from organization_memberships where user_id=$USER_ID_SQL and role='owner' and is_primary"
    sql "select 'onboarding_completed_at_null', (o.onboarding_completed_at is null)::text from organizations o join organization_memberships m on m.organization_id=o.id where m.user_id=$USER_ID_SQL and m.role='owner'"
    sql "select 'subscription', s.status || ':' || coalesce(p.key,'-') || ':trial_ends=' || coalesce(to_char(s.trial_ends_at,'YYYY-MM-DD'),'-') from tenant_subscriptions s join plans p on p.id=s.plan_id join organization_memberships m on m.organization_id=s.organization_id where m.user_id=$USER_ID_SQL and m.role='owner'"
    sql "select 'trial_redemptions', count(*) from trial_redemptions r join organization_memberships m on m.organization_id=r.organization_id where m.user_id=$USER_ID_SQL and m.role='owner'"
    sql "select 'audit', string_agg(a.action, ',' order by a.occurred_at) from audit_log_entries a join organization_memberships m on m.organization_id=a.organization_id where m.user_id=$USER_ID_SQL and m.role='owner'"
    sql "select 'outbox', string_agg(o.key || ':' || o.state, ',' order by o.created_at) from communication_outbox o where o.recipient_user_id=$USER_ID_SQL"
    ;;
  final)
    ORG_SQL="(select organization_id from organization_memberships where user_id=$USER_ID_SQL and role='owner' limit 1)"
    sql "select 'onboarding_completed', (onboarding_completed_at is not null)::text from organizations where id=$ORG_SQL"
    sql "select 'academies', count(*) from academies where organization_id=$ORG_SQL and archived_at is null"
    sql "select 'logo_set', (logo_url is not null)::text from academies where organization_id=$ORG_SQL and archived_at is null order by created_at limit 1"
    sql "select 'website', coalesce((select w.status::text from website_configurations w join academies a on a.id=w.academy_id where a.organization_id=$ORG_SQL order by a.created_at limit 1), '-')"
    sql "select 'courses', count(*) from courses c join academies a on a.id=c.academy_id where a.organization_id=$ORG_SQL and c.status<>'archived'"
    sql "select 'completion_audit', string_agg(a.context->>'mode', ',') from audit_log_entries a where a.organization_id=$ORG_SQL and a.action='organization.onboarding.completed'"
    sql "select 'subscription', s.status || ':' || coalesce(p.key,'-') from tenant_subscriptions s join plans p on p.id=s.plan_id where s.organization_id=$ORG_SQL"
    sql "select 'payments', coalesce(string_agg(status::text, ','), '-') from payments where organization_id=$ORG_SQL"
    ;;
  *)
    echo "usage: remote.sh eligible|otp|state|final <email>" >&2
    exit 2
    ;;
esac
