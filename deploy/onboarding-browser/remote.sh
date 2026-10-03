#!/usr/bin/env bash
# Atlas — server-side helper for the production onboarding browser journey
# (`Onboarding browser verify`). Run ON the VPS, from /opt/atlas, over the
# restricted deploy identity, fed through stdin like onboarding-verify.sh.
#
#   remote.sh eligible <email>   -> "eligible=yes|no" (trial subject, via the app's own hash)
#   remote.sh otp <email>        -> the latest sign-in code for THAT account only, read from the email
#                                   provider's copy of the delivered email (W3: the outbox no longer keeps it)
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
    # W3 (Large-Scale Initiative): the outbox no longer keeps the code. It is
    # removed from communication_outbox.values in the SAME transaction that
    # records the email delivery (and by the hourly prune), so it cannot be
    # read back from the database. The code is read instead from the copy of
    # the delivered email that the email provider already holds (Brevo's or
    # Resend's transactional log), found by the provider message id of the
    # latest sign-in-code email to THIS test account. Nothing new is stored
    # anywhere, and the check now also proves the email was really sent.
    # Prints the six digits only (or nothing; the runner polls).
    row=$(sql "select coalesce(d.provider,''), coalesce(d.provider_message_id,'')
               from communication_outbox o
               join lateral (select x.provider, x.provider_message_id from communication_deliveries x
                             where x.outbox_id=o.id and x.channel='email' and x.provider_message_id is not null
                             order by x.created_at desc limit 1) d on true
               where o.id=(select o2.id from communication_outbox o2 where o2.recipient_user_id=$USER_ID_SQL and o2.key='auth.email.otp' order by o2.created_at desc limit 1)")
    provider="${row%%|*}"; msgid="${row#*|}"
    case "$provider" in brevo|resend) ;; *) exit 0 ;; esac
    printf '%s' "$msgid" | grep -Eq '^<?[A-Za-z0-9._@+=-]+>?$' || exit 0
    docker compose exec -T -e MSG_ID="$msgid" -e MSG_PROVIDER="$provider" backend node -e '
// The code is the only element (HTML) or line (text) that is exactly six
// digits; anything else, or more than one distinct match, prints nothing.
const pick = (body) => {
  const s = String(body || "").replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ");
  const found = new Set([
    ...[...s.matchAll(/>\s*(\d{6})\s*</g)].map((m) => m[1]),
    ...s.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\d{6}$/.test(l)),
  ]);
  if (found.size === 1) process.stdout.write([...found][0] + "\n");
};
const id = String(process.env.MSG_ID || "");
(async () => {
  if (process.env.MSG_PROVIDER === "brevo") {
    const key = process.env.BREVO_API_KEY;
    if (!key) return;
    const h = { headers: { "api-key": key, accept: "application/json" } };
    const list = await (await fetch("https://api.brevo.com/v3/smtp/emails?limit=1&messageId=" + encodeURIComponent(id), h)).json();
    const t = ((list && list.transactionalEmails) || [])[0];
    if (!t) return;
    const one = await (await fetch("https://api.brevo.com/v3/smtp/emails/" + encodeURIComponent(t.uuid), h)).json();
    pick(one && one.body);
  } else if (process.env.MSG_PROVIDER === "resend") {
    const key = process.env.RESEND_API_KEY || process.env.EMAIL_API_KEY;
    if (!key) return;
    const one = await (await fetch("https://api.resend.com/emails/" + encodeURIComponent(id), { headers: { authorization: "Bearer " + key } })).json();
    pick((one && (one.text || one.html)) || "");
  }
})().catch(() => {});
'
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
