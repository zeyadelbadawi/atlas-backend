#!/usr/bin/env bash
# Atlas — server-side facts for the Google Identity production verification
# (`Google verify` workflow, docs/GOOGLE_AUTH_PRODUCTION_CLOSEOUT.md). Run ON
# the VPS, from /opt/atlas, over the restricted deploy identity, fed through
# stdin exactly like deploy/launch-verify/remote.sh.
#
#   remote.sh config               -> what the RUNNING backend received: mode, academies, redirect URI,
#                                     whether the client id/secret are present (never their values),
#                                     that no fake-provider override is set, migration + tables
#   remote.sh academy <uuid>       -> fresh facts about one academy (name, slug, host, status, policy, website)
#   remote.sh hosts                -> every academy host (subdomain + connected custom domains), for probes
#   remote.sh data                 -> flow retention, identity integrity, session auth_method, audit/outbox counts
#   remote.sh logs <hours>         -> callback log lines and every way a credential could have leaked into logs
#   remote.sh metrics              -> atlas_google_auth_total by stage/result (Prometheus)
#   remote.sh backup               -> the latest database backup: name, age, size, gzip integrity
#   remote.sh user <email> <local> -> non-secret facts about ONE test account of the owner's own mailbox
#
# Nothing here writes. No value of a secret, code, token or handoff is ever printed.
set -uo pipefail
# LOCAL_DB_URL: a local dry run of the SQL facts only (never set on the VPS).
if [ -z "${LOCAL_DB_URL:-}" ]; then cd /opt/atlas; fi
export COMPOSE_PROFILES=monitoring

cmd="${1:-}"
env_value() { grep -E "^$1=" .env 2>/dev/null | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() {
  if [ -n "${LOCAL_DB_URL:-}" ]; then psql "$LOCAL_DB_URL" -t -A -F'|' -c "$1"; return; fi
  docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -c "$1"
}
uuid_ok() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; }

case "$cmd" in
  config)
    # The CONTAINER's environment, i.e. what the process actually runs with.
    docker compose exec -T backend node -e '
      const e = process.env;
      const id = e.GOOGLE_OAUTH_CLIENT_ID || "";
      const secret = e.GOOGLE_OAUTH_CLIENT_SECRET || "";
      console.log("node_env|" + (e.NODE_ENV || ""));
      console.log("platform_base_domain|" + (e.PLATFORM_BASE_DOMAIN || ""));
      console.log("mode|" + (e.FLAG_AUTH_GOOGLE_MODE || "(unset → off)"));
      console.log("academy_ids|" + (e.FLAG_AUTH_GOOGLE_ACADEMY_IDS || ""));
      console.log("redirect_uri|" + (e.GOOGLE_OAUTH_REDIRECT_URI || ""));
      console.log("client_id_present|" + (id.length > 0));
      console.log("client_id_shape_ok|" + /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/.test(id));
      console.log("client_secret_present|" + (secret.length > 0));
      console.log("client_secret_length|" + secret.length);
      const overrides = ["GOOGLE_OIDC_ISSUER","GOOGLE_OIDC_AUTHORIZATION_ENDPOINT","GOOGLE_OIDC_TOKEN_ENDPOINT","GOOGLE_OIDC_JWKS_URI"].filter(k => e[k]);
      console.log("fake_provider_overrides|" + (overrides.join(",") || "none"));
    '
    # The same three in .env (presence only) — proves the deploy sync wrote them.
    for k in GOOGLE_OAUTH_CLIENT_ID GOOGLE_OAUTH_CLIENT_SECRET GOOGLE_OAUTH_REDIRECT_URI FLAG_AUTH_GOOGLE_MODE FLAG_AUTH_GOOGLE_ACADEMY_IDS; do
      if grep -qE "^$k=.+" .env; then echo "dotenv_$k|present"; else echo "dotenv_$k|absent"; fi
    done
    sql "select 'migration', coalesce((select case when finished_at is not null and rolled_back_at is null then 'applied' else 'unfinished' end from _prisma_migrations where migration_name='20261019000000_google_identity_foundation'), 'absent')"
    sql "select 'pending_or_failed_migrations', count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null"
    sql "select 'tables', string_agg(table_name, ',' order by table_name) from information_schema.tables where table_name in ('user_auth_identities','auth_oauth_flows')"
    sql "select 'refresh_tokens_auth_method', coalesce((select udt_name from information_schema.columns where table_name='refresh_tokens' and column_name='auth_method'),'absent')"
    sql "select 'flows_force_rls', relforcerowsecurity from pg_class where relname='auth_oauth_flows'"
    health=$(docker compose exec -T backend node -e "fetch('http://localhost:3000/health').then(async r=>console.log(r.status+' '+(await r.text()).slice(0,200))).catch(e=>console.log('000 '+e.message))")
    echo "health|$health"
    echo "backend_image|$(docker inspect -f '{{.Config.Image}}' "$(docker compose ps -q backend)" 2>/dev/null)"
    echo "backend_started|$(docker inspect -f '{{.State.StartedAt}}' "$(docker compose ps -q backend)" 2>/dev/null)"
    logs=$(docker compose logs --no-color --since 30m backend 2>/dev/null)
    echo "log_error_lines_30m|$(printf '%s\n' "$logs" | grep -c '"level":50')"
    echo "log_fatal_lines_30m|$(printf '%s\n' "$logs" | grep -c '"level":60')"
    ;;
  academy)
    id="${2:-}"
    uuid_ok "$id" || { echo "refused: not a uuid" >&2; exit 2; }
    sql "select 'academy', a.id, replace(a.name,'|',' '), a.slug, a.status, coalesce(a.archived_at::text,'-'), a.registration_policy, a.organization_id is not null
         from academies a where a.id='$id'"
    sql "select 'subdomain', s.status, coalesce(s.full_host, s.subdomain || '.' || (select base_domain from platform_domain_configuration where configured limit 1))
         from subdomain_allocations s where s.academy_id='$id'"
    sql "select 'custom_domain', d.status, d.hostname from domain_connections d where d.academy_id='$id'"
    sql "select 'website', w.status from website_configurations w where w.academy_id='$id'"
    sql "select 'subscription', t.status from academies a join tenant_subscriptions t on t.organization_id=a.organization_id where a.id='$id'"
    sql "select 'learners', count(*) from academy_students where academy_id='$id'"
    ;;
  hosts)
    sql "select 'host', a.id, replace(a.name,'|',' '), a.registration_policy, coalesce(s.full_host, s.subdomain || '.' || (select base_domain from platform_domain_configuration where configured limit 1))
         from academies a join subdomain_allocations s on s.academy_id=a.id and s.status='assigned'
         join website_configurations w on w.academy_id=a.id and w.status='published'
         where a.archived_at is null and a.status not in ('archived','suspended') order by a.created_at limit 20"
    sql "select 'custom', d.academy_id, d.hostname from domain_connections d where d.status='connected' order by d.created_at limit 20"
    ;;
  data)
    sql "select 'flows_total', count(*) from auth_oauth_flows"
    sql "select 'flows_past_retention', count(*) from auth_oauth_flows where expires_at < now() - interval '24 hours'"
    sql "select 'flows_oldest', coalesce(min(created_at)::text,'-') from auth_oauth_flows"
    sql "select 'flows_24h', intent||'/'||surface||'/'||(case when completed_at is not null then 'completed' when callback_at is not null then 'called_back' else 'started' end), count(*) from auth_oauth_flows where created_at > now() - interval '24 hours' group by 2 order by 2"
    sql "select 'identities', count(*) from user_auth_identities"
    sql "select 'identity_dup_subjects', count(*) from (select provider, provider_subject from user_auth_identities group by 1,2 having count(*)>1) x"
    sql "select 'identity_dup_users', count(*) from (select user_id, provider from user_auth_identities group by 1,2 having count(*)>1) x"
    sql "select 'identity_orphans', count(*) from user_auth_identities i left join users u on u.id=i.user_id where u.id is null"
    # Deletion removes the identity; suspension keeps it (sign-in is refused by status).
    sql "select 'identity_on_deleted', count(*) from user_auth_identities i join users u on u.id=i.user_id where u.status='deleted'"
    sql "select 'duplicate_user_emails', count(*) from (select lower(email) from users group by 1 having count(*)>1) x"
    sql "select 'sessions_24h', coalesce(auth_method::text,'null')||'/'||surface, count(*) from refresh_tokens where created_at > now() - interval '24 hours' group by 2 order by 2"
    sql "select 'audit', action, count(*) from audit_log_entries where action like 'auth.identity.%' group by action order by action"
    sql "select 'outbox', key, count(*) from communication_outbox where key like 'auth.identity.%' group by key order by key"
    ;;
  logs)
    hours="${2:-24}"
    printf '%s' "$hours" | grep -Eq '^[0-9]{1,3}$' || { echo "refused: hours" >&2; exit 2; }
    logs=$(docker compose logs --no-color --since "${hours}h" backend 2>/dev/null)
    cb=$(printf '%s\n' "$logs" | grep 'auth/google/callback')
    echo "callback_lines|$(printf '%s\n' "$cb" | grep -c 'auth/google/callback')"
    echo "callback_lines_redacted|$(printf '%s\n' "$cb" | grep -c 'code=\[REDACTED\]')"
    # A code/state value that is NOT the censor, anywhere in a callback line.
    echo "callback_raw_code_or_state|$(printf '%s\n' "$cb" | grep -Ec '(code|state)=[^[&" ]' )"
    echo "callback_raw_query_json|$(printf '%s\n' "$cb" | grep -Ec '"(code|state)":"[^[]')"
    # Credentials that must never appear in any line.
    echo "client_secret_shaped|$(printf '%s\n' "$logs" | grep -c 'GOCSPX-')"
    echo "jwt_shaped|$(printf '%s\n' "$logs" | grep -Ec 'eyJ[A-Za-z0-9_-]{20,}\.eyJ')"
    echo "google_access_token_shaped|$(printf '%s\n' "$logs" | grep -Ec 'ya29\.[A-Za-z0-9_-]{10,}')"
    echo "handoff_or_pending_body|$(printf '%s\n' "$logs" | grep -Ec '"(handoff|pending|setupToken)":"[^[]')"
    secret=$(env_value GOOGLE_OAUTH_CLIENT_SECRET)
    if [ -n "$secret" ]; then echo "client_secret_literal|$(printf '%s\n' "$logs" | grep -cF -- "$secret")"; else echo "client_secret_literal|n/a"; fi
    echo "google_warn_lines|$(printf '%s\n' "$logs" | grep -c 'Google sign-in callback failed.')"
    echo "google_retention_sweep_failures|$(printf '%s\n' "$logs" | grep -c 'Google flow retention sweep failed')"
    ;;
  metrics)
    q() {
      docker compose exec -T prometheus wget -qO- "http://localhost:9090/api/v1/query?query=$1" 2>/dev/null \
        | docker compose exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{try{const d=JSON.parse(s);console.log(d.data.result.map(r=>Object.values(r.metric).join('/')+'='+r.value[1]).join(' ')||'none')}catch{console.log('unavailable')}})"
    }
    echo "google_auth_total|$(q 'sum%20by%20(stage%2Cresult)%20(atlas_google_auth_total)')"
    echo "google_rules_loaded|$(docker compose exec -T prometheus wget -qO- 'http://localhost:9090/api/v1/rules' 2>/dev/null | grep -o 'AtlasGoogle[A-Za-z]*' | sort -u | tr '\n' ',')"
    ;;
  backup)
    latest=$(ls -1t /opt/atlas/backups/atlas-*.sql.gz 2>/dev/null | head -1)
    if [ -z "$latest" ]; then echo "backup|none"; exit 0; fi
    echo "backup_file|$(basename "$latest")"
    echo "backup_mtime|$(date -u -r "$latest" +%Y-%m-%dT%H:%M:%SZ)"
    echo "backup_age_hours|$(( ( $(date +%s) - $(stat -c %Y "$latest") ) / 3600 ))"
    echo "backup_bytes|$(stat -c %s "$latest")"
    if gzip -t "$latest" 2>/dev/null; then echo "backup_gzip|ok"; else echo "backup_gzip|FAILED"; fi
    echo "backup_has_users_table|$(gzip -dc "$latest" 2>/dev/null | grep -m1 -c 'CREATE TABLE public.users')"
    echo "backup_count|$(ls -1 /opt/atlas/backups/atlas-*.sql.gz 2>/dev/null | wc -l)"
    ;;
  user)
    email="${2:-}"
    local_part="${3:-}"
    printf '%s' "$local_part" | grep -Eq '^[a-z0-9._-]+$' || { echo "refused: mailbox" >&2; exit 2; }
    printf '%s' "$email" | grep -Eq "^${local_part//./\\.}(\+[a-z0-9._-]+)?@gmail\.com$" \
      || { echo "refused: not the owner's own mailbox" >&2; exit 2; }
    U="(select id from users where lower(email)=lower('$email'))"
    sql "select 'user', count(*), coalesce(max(status::text),'-'), coalesce(bool_or(password_hash not like 'nopassword:%'),false), coalesce(bool_or(email_verified_at is not null),false) from users where lower(email)=lower('$email')"
    sql "select 'google_identities', count(*), coalesce(max(linked_at)::text,'-'), coalesce(max(last_used_at)::text,'-') from user_auth_identities where user_id=$U"
    sql "select 'learner_of', academy_id, status, source from academy_students where user_id=$U order by joined_at"
    sql "select 'member_of', academy_id, role from academy_members where user_id=$U order by academy_id"
    sql "select 'org_member', count(*) from organization_memberships where user_id=$U"
    sql "select 'sessions_48h', surface, coalesce(academy_id,'-'), coalesce(auth_method::text,'null'), count(*), max(created_at) from refresh_tokens where user_id=$U and created_at > now() - interval '48 hours' group by 2,3,4 order by 6"
    sql "select 'trusted_devices', surface, coalesce(academy_id,'-'), count(*) from trusted_devices where user_id=$U and revoked_at is null and expires_at > now() group by 2,3"
    sql "select 'totp', count(*) from user_two_factor where user_id=$U and confirmed_at is not null"
    sql "select 'audit', action, count(*), max(occurred_at) from audit_log_entries where actor_user_id=$U and action like 'auth.identity.%' group by action"
    sql "select 'outbox', key, count(*), max(created_at) from communication_outbox where recipient_user_id=$U and key like 'auth.identity.%' group by key"
    ;;
  *)
    echo "usage: remote.sh config|academy <uuid>|hosts|data|logs <hours>|metrics|backup|user <email> <mailbox>" >&2
    exit 2
    ;;
esac
