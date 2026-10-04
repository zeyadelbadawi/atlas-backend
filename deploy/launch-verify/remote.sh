#!/usr/bin/env bash
# Atlas — server-side helper for the Launch Stabilization (Plan A + A6)
# production verification (`Launch verify` workflow). Run ON the VPS, from
# /opt/atlas, over the restricted deploy identity, fed through stdin exactly
# like deploy/onboarding-browser/remote.sh.
#
#   remote.sh release                 -> migration/column/legacy-trust facts, backend health, error-log counts
#   remote.sh academies               -> two open academies with a published website: "academy|<id>|<host>|<name>"
#   remote.sh otp <email>             -> the latest sign-in code for THAT account only, read from the email provider's copy
#                                        of the delivered email (consumed by the runner, never logged)
#   remote.sh user <email> <A> <B>    -> non-personal facts about that test account
#   remote.sh metrics                 -> the Plan A security + smart-join series (values only)
#   remote.sh mail                    -> email deliverability facts: sender, Brevo domain/sender/plan, 7-day aggregates
#   remote.sh member-email            -> the latest academy member/learner emails: stored academy name vs the academy
#                                        record, delivery row, and what Brevo actually sent (subject, events, text
#                                        with every link and address redacted)
#
# Nothing here writes to the database. Every per-account read is keyed by a
# test address the verification itself registered.
set -uo pipefail
cd /opt/atlas
export COMPOSE_PROFILES=monitoring

cmd="${1:-}"
email="${2:-}"
if [ -n "$email" ] && ! printf '%s' "$email" | grep -Eq '^[a-z0-9._-]+\+atlas-lsv-[a-z0-9-]+@gmail\.com$'; then
  echo "refused: not a launch-verify test address" >&2
  exit 2
fi
uuid_ok() { printf '%s' "$1" | grep -Eq '^[0-9a-f-]{36}$'; }

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -c "$1"; }
USER_ID_SQL="(select id from users where email='$email')"

case "$cmd" in
  release)
    sql "select 'migration', coalesce((select case when finished_at is not null and rolled_back_at is null then 'applied' else 'unfinished' end from _prisma_migrations where migration_name='20261018000000_trusted_device_academy_scope'), 'absent')"
    sql "select 'column', coalesce((select data_type from information_schema.columns where table_name='trusted_devices' and column_name='academy_id'), 'absent')"
    sql "select 'index', count(*) from pg_indexes where indexname='trusted_devices_user_id_surface_academy_id_revoked_at_idx'"
    sql "select 'pending_or_failed_migrations', count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null"
    sql "select 'legacy_academy_trust_live', count(*) from trusted_devices where surface='academy' and academy_id is null and revoked_at is null and expires_at > now()"
    sql "select 'management_trust_live', count(*) from trusted_devices where surface='management' and revoked_at is null and expires_at > now()"
    health=$(docker compose exec -T backend node -e "fetch('http://localhost:3000/health').then(async r=>console.log(r.status+' '+(await r.text()).slice(0,300))).catch(e=>console.log('000 '+e.message))")
    echo "health|$health"
    echo "backend_started|$(docker inspect -f '{{.State.StartedAt}}' "$(docker compose ps -q backend)" 2>/dev/null)"
    echo "backend_image|$(docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q backend)" 2>/dev/null)"
    logs=$(docker compose logs --no-color --since 30m backend 2>/dev/null)
    echo "log_error_lines_30m|$(printf '%s\n' "$logs" | grep -c '"level":50')"
    echo "log_fatal_lines_30m|$(printf '%s\n' "$logs" | grep -c '"level":60')"
    echo "log_startup_complete|$(printf '%s\n' "$logs" | grep -c 'Nest application successfully started')"
    ;;
  academies)
    # Two academies in DIFFERENT organizations, open registration, published
    # website, an assigned subdomain, an organization with a live subscription.
    sql "select 'academy', a.id, coalesce(s.full_host, s.subdomain || '.' || (select base_domain from platform_domain_configuration where configured limit 1)), replace(a.name, '|', ' ')
         from academies a
         join subdomain_allocations s on s.academy_id=a.id and s.status='assigned'
         join website_configurations w on w.academy_id=a.id and w.status='published'
         join tenant_subscriptions t on t.organization_id=a.organization_id and t.status in ('active','trialing')
         where a.archived_at is null and a.status not in ('archived','suspended') and a.registration_policy='open'
           and a.id in (select distinct on (a2.organization_id) a2.id from academies a2 where a2.archived_at is null order by a2.organization_id, a2.created_at)
         order by a.created_at desc limit 2"
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
  user)
    A="${3:-}"; B="${4:-}"
    if ! uuid_ok "$A" || ! uuid_ok "$B"; then echo "refused: academy ids" >&2; exit 2; fi
    sql "select 'users', count(*) from users where email='$email'"
    sql "select 'status', coalesce((select status::text from users where email='$email'), '-')"
    sql "select 'learner_rows', count(*) from academy_students where user_id=$USER_ID_SQL"
    sql "select 'learner_A', coalesce((select status::text from academy_students where user_id=$USER_ID_SQL and academy_id='$A'), '-')"
    sql "select 'learner_B', coalesce((select status::text from academy_students where user_id=$USER_ID_SQL and academy_id='$B'), '-')"
    sql "select 'org_memberships', count(*) from organization_memberships where user_id=$USER_ID_SQL"
    sql "select 'trust_A_live', count(*) from trusted_devices where user_id=$USER_ID_SQL and surface='academy' and academy_id='$A' and revoked_at is null"
    sql "select 'trust_B_live', count(*) from trusted_devices where user_id=$USER_ID_SQL and surface='academy' and academy_id='$B' and revoked_at is null"
    sql "select 'trust_live_total', count(*) from trusted_devices where user_id=$USER_ID_SQL and revoked_at is null"
    sql "select 'trust_null_academy', count(*) from trusted_devices where user_id=$USER_ID_SQL and surface='academy' and academy_id is null"
    sql "select 'otp_outbox', count(*) from communication_outbox where recipient_user_id=$USER_ID_SQL and key='auth.email.otp'"
    sql "select 'joined_notice', count(*) from communication_outbox where recipient_user_id=$USER_ID_SQL and key='account.academy.joined'"
    sql "select 'revocation_audit', coalesce(string_agg(context->>'trigger' || ':' || (context->>'sessionsRevoked'), ',' order by occurred_at), '-') from audit_log_entries where actor_user_id=$USER_ID_SQL and action='auth.sessions.revoked'"
    sql "select 'otp_context_mismatch_audit', count(*) from audit_log_entries where actor_user_id=$USER_ID_SQL and action in ('auth.otp.failed','auth.otp.locked_out') and context->>'reason'='context_mismatch'"
    ;;
  metrics)
    q() {
      docker compose exec -T prometheus wget -qO- "http://localhost:9090/api/v1/query?query=$1" 2>/dev/null \
        | docker compose exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const d=JSON.parse(s);console.log(d.data.result.map(r=>Object.values(r.metric).join('/')+'='+r.value[1]).join(' ')||'none')}catch{console.log('unavailable')}})"
    }
    echo "surface_denied|$(q 'sum%20by%20(reason)%20(atlas_auth_surface_denied_total)')"
    echo "sessions_revoked|$(q 'sum%20by%20(trigger)%20(atlas_auth_sessions_revoked_total)')"
    echo "academy_join|$(q 'sum%20by%20(result)%20(atlas_academy_join_total)')"
    echo "member_lookup|$(q 'sum%20by%20(result)%20(atlas_member_lookup_total)')"
    ;;
  mail)
    # Email deliverability facts (read-only). Prints the platform sender and
    # aggregate numbers only — never a recipient address, a key or content.
    echo "provider_chain|$(env_value EMAIL_PROVIDERS || true) (legacy EMAIL_PROVIDER=$(env_value EMAIL_PROVIDER))"
    echo "from|$(env_value EMAIL_FROM_EMAIL | grep -E '^no-reply@|^noreply@' || echo 'other (not printed)')"
    echo "from_name|$(env_value EMAIL_FROM_NAME)"
    echo "reply_to_configured|$([ -n "$(env_value EMAIL_REPLY_TO)" ] && echo yes || echo no)"
    docker compose exec -T backend node -e '
const key = process.env.BREVO_API_KEY;
if (!key) { console.log("brevo|not configured"); process.exit(0); }
const from = String(process.env.EMAIL_FROM_EMAIL || "");
const domain = from.split("@")[1] || "";
const get = async (p) => { const r = await fetch("https://api.brevo.com/v3" + p, { headers: { "api-key": key, accept: "application/json" } }); try { return { status: r.status, json: await r.json() }; } catch { return { status: r.status, json: null }; } };
(async () => {
  const acct = await get("/account");
  const plans = ((acct.json && acct.json.plan) || []).map((x) => x.type + (x.creditsType ? "/" + x.creditsType : "")).join(",");
  console.log("brevo_plan|" + (plans || "-") + "|relay=" + !!(acct.json && acct.json.relay && acct.json.relay.enabled));
  const d = await get("/senders/domains/" + encodeURIComponent(domain));
  console.log("brevo_domain|" + domain + "|verified=" + (d.json && d.json.verified) + "|authenticated=" + (d.json && d.json.authenticated));
  for (const [label, r] of Object.entries((d.json && d.json.dns_records) || {})) console.log("brevo_record_" + label + "|status=" + (r && r.status));
  const senders = ((await get("/senders")).json || {}).senders || [];
  const s = senders.find((x) => String(x.email).toLowerCase() === from.toLowerCase());
  console.log("brevo_sender|" + (s ? "present active=" + s.active + " ips=" + ((s.ips || []).length ? "dedicated" : "shared") : "NOT FOUND"));
  const agg = (await get("/smtp/statistics/aggregatedReport?days=7")).json || {};
  console.log("brevo_7d|requests=" + agg.requests + " delivered=" + agg.delivered + " hardBounces=" + agg.hardBounces + " softBounces=" + agg.softBounces + " blocked=" + agg.blocked + " spamReports=" + agg.spamReports + " invalid=" + agg.invalid + " opens=" + agg.uniqueOpens + " clicks=" + agg.uniqueClicks);
  for (const tag of ["key:academy.member.invited", "key:academy.member.added", "key:academy.learner.invited", "key:academy.learner.added"]) {
    const ev = (await get("/smtp/statistics/events?days=7&limit=100&tags=" + encodeURIComponent(tag))).json || {};
    const counts = {};
    for (const e of ev.events || []) counts[e.event] = (counts[e.event] || 0) + 1;
    console.log("brevo_events_" + tag.replace("key:", "") + "|" + (Object.entries(counts).map(([k, v]) => k + "=" + v).join(" ") || "none"));
  }
})().catch((e) => console.log("brevo|error " + e.message));
'
    ;;
  member-email)
    # Read-only. Never prints a recipient address, the setup token or a link:
    # only the academy name / role from the stored values, the academy's
    # authoritative name, the delivery row, and Brevo's copy of the message
    # with every URL and email address redacted.
    sql "select 'row', o.id, o.key, o.locale, o.state, o.created_at, replace(coalesce(o.values->>'academyName','<missing>'),'|',' '), coalesce(o.values->>'role','-'), replace(coalesce(a.name,'<no academy>'),'|',' '), (o.values->>'academyName') = a.name,
                coalesce(d.provider,'-'), coalesce(d.status::text,'-'), coalesce(d.template_version,'-'), coalesce(d.sent_at::text,'-'), coalesce(d.provider_message_id,'-')
         from communication_outbox o
         left join academies a on a.id=o.academy_id
         left join lateral (select * from communication_deliveries x where x.outbox_id=o.id and x.channel='email' order by x.created_at desc limit 1) d on true
         where o.key in ('academy.member.invited','academy.member.added','academy.learner.invited','academy.learner.added')
           and o.created_at > now() - interval '48 hours'
         order by o.created_at desc limit 5"
    ids=$(sql "select string_agg(d.provider_message_id, ' ' order by d.created_at desc) from (select o.id from communication_outbox o where o.key in ('academy.member.invited','academy.member.added','academy.learner.invited','academy.learner.added') and o.created_at > now() - interval '48 hours' order by o.created_at desc limit 5) o join communication_deliveries d on d.outbox_id=o.id and d.provider_message_id is not null")
    safe=""
    for id in $ids; do printf '%s' "$id" | grep -Eq '^<?[A-Za-z0-9._@+=-]+>?$' && safe="$safe $id"; done
    docker compose exec -T -e MSG_IDS="$safe" backend node -e '
const key = process.env.BREVO_API_KEY;
if (!key) { console.log("brevo|not configured"); process.exit(0); }
const get = async (p) => { const r = await fetch("https://api.brevo.com/v3" + p, { headers: { "api-key": key, accept: "application/json" } }); try { return { status: r.status, json: await r.json() }; } catch { return { status: r.status, json: null }; } };
const redact = (s) => String(s || "")
  .replace(/<(style|script)[\s\S]*?<\/\1>/gi, " ")
  .replace(/<[^>]+>/g, " ")
  .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#39;|&rsquo;/g, "\x27").replace(/&quot;/g, "\"")
  .replace(/https?:\/\/\S+/g, "<link>")
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "<address>")
  .replace(/\s+/g, " ").trim();
(async () => {
  const ids = String(process.env.MSG_IDS || "").trim().split(/\s+/).filter(Boolean);
  if (!ids.length) { console.log("brevo_msg|none"); return; }
  let n = 0;
  for (const id of ids) {
    n += 1;
    const list = (await get("/smtp/emails?limit=5&messageId=" + encodeURIComponent(id))).json || {};
    const t = (list.transactionalEmails || [])[0];
    if (!t) { console.log("brevo_msg_" + n + "|" + id + "|not found in Brevo logs"); continue; }
    const detail = await get("/smtp/emails/" + encodeURIComponent(t.uuid));
    const one = detail.json || {};
    if (detail.status !== 200) console.log("brevo_note|message " + n + " detail answered HTTP " + detail.status);
    const events = (one.events || []).map((e) => e.name).join(",") || "-";
    console.log("brevo_msg_" + n + "|" + id + "|date=" + (one.date || t.date) + "|events=" + events + "|tags=" + (t.tags || []).join(","));
    const evs = ((await get("/smtp/statistics/events?days=7&limit=20&messageId=" + encodeURIComponent(id))).json || {}).events || [];
    for (const e of evs.filter((x) => x.reason)) console.log("brevo_reason_" + n + "|" + e.event + " " + e.date + " " + redact(e.reason).replace(/\|/g, " ").slice(0, 300));
    console.log("brevo_subject_" + n + "|" + String(one.subject || t.subject || "").replace(/\|/g, " "));
    console.log("brevo_text_" + n + "|" + redact(one.body).replace(/\|/g, " ").slice(0, 1200));
  }
})().catch((e) => console.log("brevo|error " + e.message));
'
    ;;
  *)
    echo "usage: remote.sh release|academies|otp|user|metrics|mail|member-email" >&2
    exit 2
    ;;
esac
