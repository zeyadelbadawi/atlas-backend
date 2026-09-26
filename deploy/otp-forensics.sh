#!/usr/bin/env bash
# Atlas — read-only forensic trace of the sign-in code (OTP) email path for
# ONE address, run ON the VPS by the `OTP forensics` workflow over the
# restricted deploy identity (stdin, like onboarding-verify.sh).
#
#   otp-forensics.sh <email>
#
# Prints ids, states, timestamps, provider message ids and delivery statuses.
# Addresses are redacted (abc***@domain). It NEVER prints a code, a code
# hash, a token, a password, a template value or a secret, and writes nothing.
set -uo pipefail
cd /opt/atlas

email=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | tr -d ' ')
if ! printf '%s' "$email" | grep -Eq '^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$'; then
  echo "usage: otp-forensics.sh <email>" >&2; exit 2
fi
env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F' | ' -c "$1"; }
# SQL expression that redacts an address column.
red() { echo "(left(split_part($1,'@',1),3) || '***@' || split_part($1,'@',2))"; }
section() { echo; echo "== $*"; }

section "Target"
echo "address (redacted): $(printf '%s' "$email" | sed -E 's/^(.{0,3})[^@]*@/\1***@/')"
echo "domain MX (as seen from the server): $(docker compose exec -T backend node -e "require('dns').promises.resolveMx(process.argv[1]).then(r=>console.log(r.sort((a,b)=>a.priority-b.priority).map(x=>x.exchange).join(',')||'-')).catch(e=>console.log('lookup failed: '+e.code))" "${email#*@}")"

section "A/B. User rows for this address (exact, case-insensitive)"
sql "select id, $(red email) as email, (lower(email)=lower('$email')) as exact, email_verified_at is not null as verified, deleted_at is not null as deleted, to_char(created_at,'YYYY-MM-DD HH24:MI:SS') as created from users where lower(email)=lower('$email')"
UID_SQL="(select id from users where lower(email)=lower('$email') limit 1)"

section "Organizations / memberships"
sql "select m.organization_id, m.role, m.is_primary, (o.onboarding_completed_at is null) as onboarding_pending, t.status as subscription from organization_memberships m join organizations o on o.id=m.organization_id left join tenant_subscriptions t on t.organization_id=o.id where m.user_id=$UID_SQL"

section "Trial eligibility (the app's own trial subject hash)"
hash=$(docker compose exec -T backend node -e "process.stdout.write(require('./dist/plans/utils/trial-subject.util').trialSubjectHash(process.argv[1]))" "$email")
if printf '%s' "$hash" | grep -Eq '^[0-9a-f]{64}$'; then
  echo "trial redemptions for this mailbox: $(sql "select count(*) from trial_redemptions where subject_hash='$hash'")"
else
  echo "trial subject hash unavailable"
fi

section "C. Sign-in challenges (auth_email_challenges) for this user, newest first"
sql "select id, surface, attempts, resends, to_char(created_at,'MM-DD HH24:MI:SS') created, to_char(expires_at,'HH24:MI:SS') expires, coalesce(to_char(consumed_at,'HH24:MI:SS'),'-') consumed from auth_email_challenges where user_id=$UID_SQL order by created_at desc limit 10"

section "D/E. Outbox rows addressed to this user (recipient_user_id), newest first"
sql "select o.id, o.key, o.state, o.attempts, coalesce(o.last_error,'-') last_error, to_char(o.created_at,'MM-DD HH24:MI:SS') created, coalesce(to_char(o.dispatched_at,'HH24:MI:SS'),'-') dispatched, coalesce(o.entity_type||':'||o.entity_id,'-') entity from communication_outbox o where o.recipient_user_id=$UID_SQL order by o.created_at desc limit 15"

section "F/G/H. Deliveries for those rows (provider message id + provider-reported status)"
sql "select d.outbox_id, d.channel, coalesce(d.provider,'-') provider, coalesce(d.provider_message_id,'-') message_id, d.status, coalesce(d.error_code,'-') error, d.attempts, coalesce(to_char(d.sent_at,'MM-DD HH24:MI:SS'),'-') sent, to_char(d.updated_at,'MM-DD HH24:MI:SS') updated from communication_deliveries d join communication_outbox o on o.id=d.outbox_id where o.recipient_user_id=$UID_SQL order by d.created_at desc limit 15"

section "Suppression list entry for this address (the app's own hash)"
shash=$(docker compose exec -T backend node -e "process.stdout.write(require('./dist/communications/services/suppression.service').hashEmail(process.argv[1]))" "$email")
if [ -n "$shash" ]; then
  sql "select reason, source, to_char(created_at,'YYYY-MM-DD HH24:MI') created, coalesce(to_char(expires_at,'YYYY-MM-DD HH24:MI'),'never') expires from communication_suppressions where email_hash='$shash'" | sed 's/^/suppressed: /'
  echo "(no line above = not suppressed)"
fi

section "Every sign-in code email in the last 12 hours — who it went to (redacted)"
sql "select to_char(o.created_at,'MM-DD HH24:MI:SS') created, $(red u.email) as recipient, o.state, coalesce(d.status::text,'-') delivery, coalesce(d.provider_message_id,'-') message_id from communication_outbox o join users u on u.id=o.recipient_user_id left join communication_deliveries d on d.outbox_id=o.id and d.channel='email' where o.key='auth.email.otp' and o.created_at > now() - interval '12 hours' order by o.created_at"

section "Email provider configuration (names only, never values)"
echo "EMAIL_PROVIDERS=$(env_value EMAIL_PROVIDERS)"
from=$(env_value EMAIL_FROM_EMAIL); echo "sender configured: $([ -n "$from" ] && printf '%s' "$from" | sed -E 's/^(.{0,3})[^@]*@/\1***@/' || echo '-')"
echo "sender equals target: $([ "$(printf '%s' "$from" | tr 'A-Z' 'a-z')" = "$email" ] && echo yes || echo no)"

section "G/H. Brevo's own event log for this user's messages (provider-side evidence)"
ids=$(sql "select string_agg(d.provider_message_id, ' ') from communication_deliveries d join communication_outbox o on o.id=d.outbox_id where o.recipient_user_id=$UID_SQL and d.provider='brevo' and d.provider_message_id is not null")
docker compose exec -T backend node -e "
const red = (e) => String(e || '-').replace(/^(.{0,3})[^@]*@/, '\$1***@');
const key = process.env.BREVO_API_KEY;
if (!key) { console.log('BREVO_API_KEY not configured'); process.exit(0); }
(async () => {
  for (const id of process.argv.slice(1)) {
    const r = await fetch('https://api.brevo.com/v3/smtp/statistics/events?limit=20&messageId=' + encodeURIComponent(id), { headers: { 'api-key': key, accept: 'application/json' } });
    if (!r.ok) { console.log(id, '-> Brevo API', r.status); continue; }
    const body = await r.json();
    for (const e of (body.events || [])) console.log([id, e.event, 'to=' + red(e.email), 'from=' + red(e.from), e.reason || '-', e.date].join(' | '));
    if (!(body.events || []).length) console.log(id, '-> no events returned');
  }
})().catch((e) => console.log('Brevo events lookup failed:', e.message));
" $ids

section "Brevo account: senders and sending-domain authentication"
docker compose exec -T backend node -e "
const red = (e) => String(e || '-').replace(/^(.{0,3})[^@]*@/, '\$1***@');
const key = process.env.BREVO_API_KEY;
if (!key) { console.log('BREVO_API_KEY not configured'); process.exit(0); }
const get = (p) => fetch('https://api.brevo.com/v3' + p, { headers: { 'api-key': key, accept: 'application/json' } }).then(async (r) => (r.ok ? r.json() : { error: r.status }));
(async () => {
  const s = await get('/senders');
  for (const x of (s.senders || [])) console.log('sender', red(x.email), 'active=' + x.active);
  if (s.error) console.log('senders -> Brevo API', s.error);
  const d = await get('/senders/domains');
  for (const x of (d.domains || [])) console.log('domain', x.domain_name, 'authenticated=' + x.authenticated, 'verified=' + x.verified);
  if (!(d.domains || []).length) console.log('no sending domain registered in Brevo');
})().catch((e) => console.log('Brevo account lookup failed:', e.message));
"

section "Platform DNS zone (Cloudflare) — current SPF/DMARC/DKIM-looking TXT records"
docker compose exec -T backend node -e "
const t = process.env.CLOUDFLARE_API_TOKEN, z = process.env.CLOUDFLARE_ZONE_ID;
if (!t || !z) { console.log('Cloudflare token/zone not configured'); process.exit(0); }
const get = (p) => fetch('https://api.cloudflare.com/client/v4' + p, { headers: { authorization: 'Bearer ' + t } }).then((r) => r.json());
(async () => {
  const v = await get('/user/tokens/verify');
  console.log('token status:', v.result ? v.result.status : 'unknown');
  const zone = await get('/zones/' + z);
  console.log('zone:', zone.result ? zone.result.name : 'unreadable');
  const recs = await get('/zones/' + z + '/dns_records?type=TXT&per_page=100');
  if (!recs.success) { console.log('TXT records unreadable with this token'); return; }
  const rel = recs.result.filter((r) => /spf1|DMARC1|DKIM|brevo|sendinblue/i.test(r.content) || /_dmarc|_domainkey/.test(r.name));
  for (const r of rel) console.log('TXT', r.name, '=>', r.content.slice(0, 60));
  if (!rel.length) console.log('no SPF/DMARC/DKIM TXT records in the zone');
})().catch((e) => console.log('Cloudflare lookup failed:', e.message));
"
