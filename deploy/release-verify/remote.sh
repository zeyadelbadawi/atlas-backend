#!/usr/bin/env bash
# Atlas — server-side helper for the Final Completion release verification
# (`Release verify` workflow). Run ON the VPS, from /opt/atlas, over the
# restricted deploy identity, fed through stdin like the other verifiers.
#
#   remote.sh facts   -> PASS/FAIL/INFO: the release's migrations, health,
#                        runtime flags, renderer, data backfills, Bank
#                        Transfer configuration state (never its details),
#                        the customer-identity key (set yes/no, match/
#                        mismatch with its derivation — never a value)
#   remote.sh hosts   -> up to two published Academy hosts: "host|<hostname>"
#   remote.sh rum     -> "rum|<total samples>": the sum of the RUM
#                        histograms' _count series in Prometheus
#   remote.sh dups    -> "w4dups|<entity>|<groups>|<rows>|<to rename>": the
#                        W4 duplicate-name report (counts only)
#   remote.sh config  -> the "Configuration facts" section of `facts` alone
#                        (B0-OPS-01): host-only settings, secret presence
#                        (set / not set, never a value), academy-ID lists as
#                        counts, and the Platform Owner authenticator counts
#   remote.sh b0      -> the B0 release (atlas-backend#46): its five
#                        migrations, and when all are applied, RLS forced
#                        and the expected policies on the three new/changed
#                        tables (also part of `facts`)
#   remote.sh owners  -> Platform Owner inventory (B0-OC-01): masked, per
#                        account sign-in methods / TOTP / sessions as counts,
#                        and every row that still references each account
#   remote.sh video   -> Normal-tier hosted video readiness (B0-MED-11 /
#                        B0-OC-34): tier settings, the protected bucket's
#                        CORS rules and a browser-style CORS preflight
#                        (OPTIONS only — nothing is uploaded), the delivery
#                        Worker's answer to a token-less request, and
#                        hosted-video usage as counts
#
# Read-only: every statement is a SELECT, every probe a GET. Prints
# non-secret facts only — no secret value, no personal data, no bank detail,
# and no sign-in code (this verifier never reads one).
set -uo pipefail
# RELEASE_VERIFY_DIR exists for the unit test (fixture .env, stubbed docker);
# production always runs from /opt/atlas.
cd "${RELEASE_VERIFY_DIR:-/opt/atlas}"
export COMPOSE_PROFILES=monitoring

FAILS=0
pass() { echo "PASS  $*"; }
fail() { echo "FAIL  $*"; FAILS=$((FAILS + 1)); }
info() { echo "INFO  $*"; }

env_value() { grep -E "^$1=" .env | tail -1 | cut -d= -f2-; }
PGUSER_=$(env_value POSTGRES_USER)
PGDB_=$(env_value POSTGRES_DB)
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -c "$1"; }
prom() { docker compose exec -T prometheus wget -qO- "http://localhost:9090$1"; }
count_json() { docker compose exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log($1)})"; }

# --- B0-OPS-01: configuration facts ---------------------------------------
#
# Settings that only the host .env can carry (the deploy workflow never
# passes them) and secret PRESENCE. Three kinds of name, and nothing else is
# printed:
#   - plain settings print their value;
#   - secrets print "set" / "not set in .env", never a character of the value;
#   - academy-ID lists print an entry count, never an ID.
# Then the Platform Owner authenticator counts (B0-OC-02): two integers from
# `users` and `user_two_factor`, reading no column but `confirmed_at`, and
# the effective enforcement instant.
TOTP_DEFAULT_FROM=2026-10-24T00:00:00.000Z
env_has() { grep -qE "^$1=" .env; }
secret_presence() {
  if [ -n "$(env_value "$1")" ]; then info "$1: set"; else info "$1: not set in .env"; fi
}
config_facts() {
  echo "== Configuration facts (host .env; secrets as set/not set only)"
  for k in $(grep -oE '^FLAG_[A-Z0-9_]+' .env | sort -u); do
    v=$(env_value "$k")
    # `*_ACADEMY_IDS` lists are academy IDs, like the allowlists: counts only.
    # (The mask used to match ALLOWLIST alone and printed the IDs.)
    case "$k" in *ACADEMY_IDS*|*ALLOWLIST*) info "$k entries=$(printf '%s' "$v" | tr ',' '\n' | grep -c .)";; *) info "$k=$v";; esac
  done
  for k in VIDEO_PROVIDER AUTH_PRIVILEGED_EMAIL_OTP_FLOOR SURFACE_ENFORCE_MODE WATERMARK_RETENTION_DAYS EMAIL_PROVIDERS EMAIL_PROVIDER EMAIL_FROM_NAME EMAIL_DELIVERABILITY_CHECK_ENABLED BREVO_DAILY_LIMIT BREVO_MONTHLY_LIMIT BREVO_PER_SECOND RESEND_DAILY_LIMIT RESEND_MONTHLY_LIMIT RESEND_PER_SECOND SENTRY_ENVIRONMENT FLAG_PHONE_VERIFICATION_MODE; do
    if env_has "$k"; then info "$k=$(env_value "$k")"; else info "$k=<unset>"; fi
  done
  for k in $(grep -oE '^[A-Z0-9_]*ACADEMY_IDS[A-Z0-9_]*' .env | grep -v '^FLAG_' | sort -u); do
    info "$k entries=$(env_value "$k" | tr ',' '\n' | grep -c .)"
  done
  for k in SENTRY_DSN METRICS_SCRAPE_TOKEN ALERT_SLACK_WEBHOOK_URL BREVO_API_KEY RESEND_API_KEY ZOOM_WEBHOOK_SECRET_TOKEN \
    $(grep -oE '^(BASIC_VIDEO_|CLOUDFLARE_STREAM_|ZOOM_OAUTH_|ZOOM_SDK_)[A-Z0-9_]*' .env | sort -u); do
    secret_presence "$k"
  done

  echo "== Platform Owner authenticator (counts only)"
  local from effective
  from=$(env_value PLATFORM_OWNER_TOTP_REQUIRED_FROM)
  if ! env_has PLATFORM_OWNER_TOTP_REQUIRED_FROM || [ -z "$from" ]; then
    effective=$TOTP_DEFAULT_FROM; info "PLATFORM_OWNER_TOTP_REQUIRED_FROM=default ($TOTP_DEFAULT_FROM)"
  elif [ "$from" = never ]; then
    effective=never; info "PLATFORM_OWNER_TOTP_REQUIRED_FROM=never (not enforced)"
  elif [ "$from" = "$TOTP_DEFAULT_FROM" ]; then
    effective=$from; info "PLATFORM_OWNER_TOTP_REQUIRED_FROM=default ($from, set explicitly)"
  else
    effective=$from; info "PLATFORM_OWNER_TOTP_REQUIRED_FROM=$from (overrides the default $TOTP_DEFAULT_FROM)"
  fi
  local owners confirmed
  IFS='|' read -r owners confirmed <<< "$(sql "select count(*), count(t.confirmed_at) from users u left join user_two_factor t on t.user_id = u.id where u.is_platform_owner" | tr -d '[:space:]')"
  if ! [[ "$owners" =~ ^[0-9]+$ && "$confirmed" =~ ^[0-9]+$ ]]; then
    fail "Platform Owner authenticator counts could not be read"
  elif [ "$owners" -gt 0 ] && [ "$owners" = "$confirmed" ]; then
    pass "every Platform Owner has a confirmed authenticator ($confirmed of $owners)"
  elif [ "$effective" != never ] && [ "$(date -u +%s)" -ge "$(date -u -d "$effective" +%s 2>/dev/null || echo 0)" ]; then
    fail "$confirmed of $owners Platform Owner(s) have a confirmed authenticator, and enforcement began $effective"
  else
    info "$confirmed of $owners Platform Owner(s) have a confirmed authenticator; enforcement: $effective"
  fi
}

# --- B0-OC-01: Platform Owner inventory (read-only) ---------------------
#
# Before the owner decides which Platform Owner accounts to keep, list each
# one with what it would take to remove it. One SELECT per section, inside a
# READ ONLY transaction. Per account: an ordinal, the first 8 characters of
# the id, a MASKED email (first two characters of the local part, its
# length, the domain), status, created / last sign-in dates, which sign-in
# methods exist (password row yes/no, Google link yes/no), whether TOTP is
# confirmed, the NUMBER of unused recovery codes and live sessions. Never a
# secret, a hash, a code, a full email or a name.
# Then every foreign key that points at `users`, swept generically from the
# catalog (so nothing is missed by a hand-made list): per account, the
# tables/columns that still reference it, with the row count and the FK's
# ON DELETE rule (r = restrict, a = no action, c = cascade, n = set null).
owners_facts() {
  echo "== Platform Owner inventory (read-only; masked, no secrets)"
  local rows refs
  rows=$(sql "BEGIN READ ONLY;
    SELECT 'po', row_number() OVER (ORDER BY u.created_at, u.id), left(u.id::text, 8),
      left(split_part(u.email,'@',1), 2) || '…(' || length(split_part(u.email,'@',1)) || ')@' || split_part(u.email,'@',2),
      u.status, CASE WHEN u.deleted_at IS NULL THEN 'live' ELSE 'deleted' END,
      to_char(u.created_at,'YYYY-MM-DD'), coalesce(to_char(u.last_sign_in_at,'YYYY-MM-DD'),'never'),
      CASE WHEN EXISTS (SELECT 1 FROM user_credentials c WHERE c.user_id = u.id) THEN 'password' ELSE 'no-password' END,
      CASE WHEN EXISTS (SELECT 1 FROM user_auth_identities i WHERE i.user_id = u.id AND i.provider = 'google') THEN 'google' ELSE 'no-google' END,
      CASE WHEN t.confirmed_at IS NOT NULL THEN 'totp-confirmed' WHEN t.user_id IS NOT NULL THEN 'totp-pending' ELSE 'no-totp' END,
      (SELECT count(*) FROM two_factor_recovery_codes r WHERE r.user_id = u.id AND r.used_at IS NULL),
      (SELECT count(*) FROM refresh_tokens r WHERE r.user_id = u.id AND r.revoked_at IS NULL AND r.expires_at > now()),
      CASE WHEN u.email_verified_at IS NULL THEN 'email-unverified' ELSE 'email-verified' END
    FROM users u LEFT JOIN user_two_factor t ON t.user_id = u.id
    WHERE u.is_platform_owner ORDER BY 2;
    COMMIT;" 2>/dev/null | grep '^po|')
  if [ -z "$rows" ]; then fail "Platform Owner inventory could not be read"; return; fi
  echo "INFO  columns: #|id8|email(masked)|status|state|created|last-sign-in|password|google|totp|recovery-codes-unused|live-sessions|email"
  printf '%s\n' "$rows" | sed 's/^po|/INFO  owner|/'
  refs=$(sql "BEGIN READ ONLY;
    WITH po AS (SELECT id, row_number() OVER (ORDER BY created_at, id) n FROM users WHERE is_platform_owner),
    fks AS (
      SELECT c.conrelid::regclass::text tbl, a.attname col, c.confdeltype del
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
      WHERE c.contype = 'f' AND c.confrelid = 'public.users'::regclass AND cardinality(c.conkey) = 1)
    SELECT 'ref', po.n, f.tbl || '.' || f.col, f.del, x.c
    FROM po CROSS JOIN fks f CROSS JOIN LATERAL (
      SELECT (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM %s WHERE %I = %L', f.tbl, f.col, po.id), false, true, '')))[1]::text::bigint c) x
    WHERE x.c > 0 ORDER BY 2, 3;
    COMMIT;" 2>/dev/null | grep '^ref|')
  if [ -z "$refs" ]; then info "no rows reference any Platform Owner (or the sweep could not run)"; else
    echo "INFO  references: owner#|table.column|on-delete(r=restrict a=no-action c=cascade n=set-null)|rows"
    printf '%s\n' "$refs" | sed 's/^ref|/INFO  ref|/'
  fi
}

# --- B0 release (atlas-backend#46): the five migrations and their RLS ------
#
# Read-only catalog checks. Before the release is deployed none of the five
# migrations is recorded: that prints INFO and fails nothing, so a run
# between now and the deploy stays green. All five applied: each RLS table
# must be enabled AND forced with its expected policies, and the privacy
# table must have no DELETE policy. Some but not all applied is a FAIL (a
# half-applied release).
B0_MIGRATIONS="20261112000100_subscription_scheduled_plan_change 20261113000100_subscription_price_change_notice 20261114000100_live_provider_events_rls 20261115000100_organization_platform_flags 20261116000100_privacy_requests"
b0_release_facts() {
  echo "== B0 release migrations (atlas-backend#46)"
  local applied=0 total=0 m state
  for m in $B0_MIGRATIONS; do
    total=$((total + 1))
    state=$(sql "select coalesce((select case when finished_at is not null and rolled_back_at is null then 'applied' else 'unfinished' end from _prisma_migrations where migration_name='$m'), 'absent')")
    case "$state" in
      applied) applied=$((applied + 1)) ;;
      absent) ;;
      unfinished) fail "$m unfinished or rolled back" ;;
      # An unreadable database is never mistaken for "not deployed yet".
      *) fail "$m migration state could not be read"; return 0 ;;
    esac
  done
  if [ "$applied" = 0 ]; then
    info "B0 release not deployed yet: 0 of $total migrations recorded"
    return 0
  fi
  if [ "$applied" != "$total" ]; then
    fail "B0 release half-applied: $applied of $total migrations recorded"
    return 0
  fi
  pass "all $total B0 release migrations applied"
  local t rls
  for t in privacy_requests live_provider_events organization_platform_flags; do
    rls=$(sql "select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class where relname='$t' and relnamespace='public'::regnamespace")
    if [ "$rls" = "true,true" ]; then pass "$t RLS enabled and forced"; else fail "$t RLS state '$rls'"; fi
  done
  local expected name table want cmd
  for expected in privacy_requests_self_select:privacy_requests:SELECT privacy_requests_self_insert:privacy_requests:INSERT \
    privacy_requests_platform_select:privacy_requests:SELECT privacy_requests_platform_update:privacy_requests:UPDATE \
    live_provider_events_system_insert:live_provider_events:INSERT live_provider_events_platform_select:live_provider_events:SELECT \
    live_provider_events_platform_update:live_provider_events:UPDATE \
    organization_platform_flags_platform_select:organization_platform_flags:SELECT \
    organization_platform_flags_platform_insert:organization_platform_flags:INSERT \
    organization_platform_flags_platform_update:organization_platform_flags:UPDATE; do
    name=${expected%%:*}; table=${expected#*:}; want=${table#*:}; table=${table%%:*}
    cmd=$(sql "select coalesce((select cmd from pg_policies where schemaname='public' and tablename='$table' and policyname='$name'), 'absent')")
    if [ "$cmd" = "$want" ]; then pass "policy $name on $table is $want"; else fail "policy $name on $table: $cmd (expected $want)"; fi
  done
  local deletes
  deletes=$(sql "select count(*) from pg_policies where schemaname='public' and tablename in ('privacy_requests','live_provider_events','organization_platform_flags') and cmd in ('DELETE','ALL')")
  if [ "$deletes" = 0 ]; then pass "no DELETE (or ALL) policy on the three B0 tables"; else fail "$deletes DELETE/ALL policies on the B0 tables"; fi
  local purpose
  purpose=$(sql "select count(*) from pg_constraint where conname='account_deletion_challenges_purpose_check'")
  if [ "$purpose" = 1 ]; then pass "account_deletion_challenges purpose check present"; else fail "account_deletion_challenges purpose check missing"; fi
}

# --- B0-MED-11 / B0-OC-34: Normal-tier hosted video readiness ---------------
#
# What the course builder's direct upload needs before the tier is turned
# on: the browser PUTs the file to a presigned URL on the PROTECTED bucket,
# so that bucket must answer the CORS preflight for the dashboard origin.
# Read-only throughout: GetBucketCors (a read; the app's token may not be
# allowed it, which is reported, not worked around), OPTIONS preflights
# against a presigned PUT URL for a key that is never written (signing is
# local; no PUT is ever sent), one token-less GET to the delivery host, and
# SELECT counts. Prints no bucket name, account ID, key or URL.
video_facts() {
  echo "== Normal-tier video settings (host .env; secrets as set/not set only)"
  for k in VIDEO_PROVIDER FLAG_VIDEO_NORMAL_MODE BASIC_VIDEO_DELIVERY_HOST BASIC_VIDEO_PLAYBACK_TTL_SECONDS \
    BASIC_VIDEO_ALLOWED_ORIGINS_CONFIGURED VIDEO_MAX_UPLOAD_BYTES PROTECTED_MEDIA_URL_TTL_SECONDS \
    PROTECTED_MEDIA_MAX_UPLOAD_BYTES PLATFORM_BASE_DOMAIN CORS_ALLOWED_ORIGINS FRONTEND_URL; do
    if env_has "$k"; then info "$k=$(env_value "$k")"; else info "$k=<unset>"; fi
  done
  info "FLAG_VIDEO_NORMAL_ACADEMY_IDS entries=$(env_value FLAG_VIDEO_NORMAL_ACADEMY_IDS | tr ',' '\n' | grep -c .)"
  if [ -n "$(env_value R2_PROTECTED_BUCKET)" ]; then info "R2_PROTECTED_BUCKET: set (name not printed)"; else info "R2_PROTECTED_BUCKET: default (<R2_BUCKET>-protected)"; fi
  secret_presence R2_PROTECTED_ACCESS_KEY_ID
  secret_presence BASIC_VIDEO_SIGNING_SECRET

  echo "== Protected bucket CORS (read-only; no upload is made)"
  cors=$(docker compose exec -T backend node -e '
    const { S3Client, PutObjectCommand, GetBucketCorsCommand } = require("@aws-sdk/client-s3");
    const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
    const e = process.env;
    const bucket = e.R2_PROTECTED_BUCKET || e.R2_BUCKET + "-protected";
    const c = new S3Client({ region: e.R2_REGION, endpoint: e.R2_ENDPOINT,
      forcePathStyle: e.R2_FORCE_PATH_STYLE !== "false",
      credentials: { accessKeyId: e.R2_PROTECTED_ACCESS_KEY_ID || e.R2_ACCESS_KEY_ID,
        secretAccessKey: e.R2_PROTECTED_SECRET_ACCESS_KEY || e.R2_SECRET_ACCESS_KEY },
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
    // The dashboard origin(s) must pass; other API origins are reported
    // for information (the course builder may never run on them).
    const origins = [], extra = [];
    const add = (list, o) => { try { const u = new URL(o.trim()); if (/^https?:$/.test(u.protocol) && !origins.includes(u.origin) && !extra.includes(u.origin)) list.push(u.origin); } catch {} };
    if (e.FRONTEND_URL) add(origins, e.FRONTEND_URL);
    if (e.PLATFORM_BASE_DOMAIN) add(origins, "https://" + e.PLATFORM_BASE_DOMAIN);
    (e.CORS_ALLOWED_ORIGINS || "").split(",").filter(Boolean).slice(0, 6).forEach((o) => add(extra, o));
    const foreign = "https://cors-probe.invalid";
    (async () => {
      try {
        const r = await c.send(new GetBucketCorsCommand({ Bucket: bucket }));
        const rules = r.CORSRules || [];
        console.log("INFO  bucket CORS rules: " + rules.length);
        rules.forEach((x, i) => console.log("INFO  rule " + (i + 1) + ": origins=" + JSON.stringify(x.AllowedOrigins || []) +
          " methods=" + JSON.stringify(x.AllowedMethods || []) + " headers=" + JSON.stringify(x.AllowedHeaders || []) +
          " expose=" + JSON.stringify(x.ExposeHeaders || []) + " maxAge=" + (x.MaxAgeSeconds ?? "-")));
      } catch (err) {
        const st = err.$metadata && err.$metadata.httpStatusCode;
        console.log("INFO  bucket CORS rules not readable with the app token: " + (err.name || err.Code || "Error") + (st ? " (" + st + ")" : ""));
      }
      let url;
      try {
        url = await getSignedUrl(c, new PutObjectCommand({ Bucket: bucket, Key: "release-verify/cors-preflight-never-written",
          ContentType: "video/mp4", ContentLength: 1 }), { expiresIn: 120 });
      } catch (err) { console.log("FAIL  could not presign a probe URL: " + (err.name || "Error")); return; }
      const probe = async (origin) => {
        try {
          const res = await fetch(url, { method: "OPTIONS", headers: { Origin: origin,
            "Access-Control-Request-Method": "PUT", "Access-Control-Request-Headers": "content-type" } });
          const h = (n) => res.headers.get(n) || "";
          const aco = h("access-control-allow-origin"), acm = h("access-control-allow-methods"), ach = h("access-control-allow-headers");
          const ok = res.status < 300 && (aco === "*" || aco === origin) && /(^|[ ,])(PUT|\*)([ ,]|$)/i.test(acm) && (ach === "*" || /content-type/i.test(ach));
          return { ok, line: "origin=" + origin + " status=" + res.status + " allow-origin=" + (aco || "-") + " allow-methods=" + (acm || "-") +
            " allow-headers=" + (ach || "-") + " max-age=" + (h("access-control-max-age") || "-") };
        } catch (err) { return { ok: false, line: "origin=" + origin + " request failed: " + (err.cause && err.cause.code || err.name) }; }
      };
      if (!origins.length) console.log("FAIL  no dashboard origin to test (FRONTEND_URL / PLATFORM_BASE_DOMAIN / CORS_ALLOWED_ORIGINS unset)");
      for (const o of origins) { const r = await probe(o); console.log((r.ok ? "PASS  " : "FAIL  ") + "preflight PUT " + r.line); }
      for (const o of extra) { const r = await probe(o); console.log("INFO  preflight PUT (other API origin) " + (r.ok ? "allowed: " : "not allowed: ") + r.line); }
      const f = await probe(foreign);
      console.log((f.ok ? "INFO  " : "PASS  ") + "preflight PUT from a foreign origin " + (f.ok ? "is ALLOWED (wildcard or too broad): " : "is refused: ") + f.line);
    })();' 2>/dev/null) || cors="FAIL  CORS check could not run"
  printf '%s\n' "$cors"
  FAILS=$((FAILS + $(printf '%s\n' "$cors" | grep -c '^FAIL')))

  echo "== Delivery Worker (token-less request; expect a refusal)"
  local dh code
  dh=$(env_value BASIC_VIDEO_DELIVERY_HOST)
  if [ -z "$dh" ]; then
    info "BASIC_VIDEO_DELIVERY_HOST unset: no delivery Worker configured"
  else
    code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://${dh#https://}/v/release-verify-probe" || true)
    case "$code" in
      401|403) pass "delivery host answers a token-less request with $code" ;;
      000|"") fail "delivery host unreachable" ;;
      *) info "delivery host answered $code to a token-less request" ;;
    esac
  fi

  echo "== Hosted video usage (counts only)"
  sql "select 'videos|' || count(*) || '|' || count(*) filter (where processing_status = 'ready') || '|' ||
       count(*) filter (where processing_status in ('pending','processing')) || '|' || count(*) filter (where processing_status = 'failed') || '|' ||
       coalesce(sum(size_bytes),0) || '|' || coalesce(sum(duration_seconds),0)
       from media_assets where type = 'video' and access = 'protected'" |
    awk -F'|' 'NF>=7 {printf "INFO  protected videos=%s ready=%s in-progress=%s failed=%s bytes=%s seconds=%s\n",$2,$3,$4,$5,$6,$7}'
  sql "select 'limits|' || key || '|' || status || '|' || coalesce(limits->>'videoStorageMinutes','-') || '|' || coalesce(limits->>'videoStorage','-')
       from plans order by display_order, key" |
    awk -F'|' 'NF>=5 {printf "INFO  plan %s (%s): videoStorageMinutes=%s videoStorage=%s\n",$2,$3,$4,$5}'
}

case "${1:-}" in
  facts)
    echo "== Migrations"
    for m in 20261103000100_platform_contact_submissions 20261104000000_w3_outbox_secret_code_scrub 20261104000010_w3_email_activity_index_challenge_retention 20261104000020_w3_security_events 20261104000100_communication_campaigns 20261104000200_provisioning_requested_brand_progress 20261104000300_w4_name_key_foundation 20261104000310_w4_duplicate_name_remediation 20261104000320_w4_name_unique_indexes 20261104000330_w4_backups_out_of_public 20261104000340_w4_deleted_learner_name_exemption 20261104000341_academy_member_helpers_active_only 20261104000500_course_creation_idempotency_key 20261104000600_w8_plans_gifted_days 20261104000610_w8_tenant_subscriptions_gift 20261104000620_w8_paid_gift_redemptions 20261104000630_w8_trial_redemptions_v2 20261104000640_w8_subscription_cancellations_per_period 20261104000690_w8_seed_plan_gifted_days_defaults 20261104000700_org_owner_academy_rls_helpers; do
      state=$(sql "select coalesce((select case when finished_at is not null and rolled_back_at is null then 'applied' else 'unfinished' end from _prisma_migrations where migration_name='$m'), 'absent')")
      if [ "$state" = applied ]; then pass "$m applied"; else fail "$m $state"; fi
    done
    pending=$(sql "select count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null")
    if [ "$pending" = 0 ]; then pass "no unfinished or rolled-back migration rows"; else fail "$pending unfinished/rolled-back migration rows"; fi

    # Platform-wide initiative (3 Oct 2026): the marketing enquiries table
    # is RLS-forced, and the tenant course-order read policies are SELECT
    # only. Catalog reads, no row data.
    rls=$(sql "select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class where relname='platform_contact_submissions'")
    if [ "$rls" = "true,true" ]; then pass "platform_contact_submissions RLS enabled and forced"; else fail "platform_contact_submissions RLS state '$rls'"; fi
    # Each expected policy must exist on its own table, in `public`, as a
    # SELECT policy; a missing or misplaced one fails.
    for expected in course_orders_tenant_select:course_orders payments_tenant_course_order_select:payments course_order_refunds_tenant_select:course_order_refunds checkouts_platform_select:checkouts; do
      name=${expected%%:*}; table=${expected#*:}
      cmd=$(sql "select coalesce((select cmd from pg_policies where schemaname='public' and tablename='$table' and policyname='$name'), 'absent')")
      if [ "$cmd" = SELECT ]; then pass "policy $name on $table is SELECT-only"; else fail "policy $name on $table: $cmd"; fi
    done

    # Large-Scale initiative (4 Oct 2026). Counts and catalog state only.
    echo "== Large-Scale initiative (counts only)"
    otp=$(sql "select count(*) from communication_outbox where key in ('auth.email.otp','auth.account.deletion_code') and (\"values\" ? 'code')")
    if [ "$otp" = 0 ]; then pass "no sign-in or deletion code is stored in the outbox"; else fail "$otp outbox row(s) still hold a code"; fi
    for t in security_events communication_campaigns campaign_recipients tenant_email_usage_periods tenant_email_usage_ledger; do
      rls=$(sql "select coalesce((select relrowsecurity::text || ',' || relforcerowsecurity::text from pg_class where relname='$t' and relnamespace='public'::regnamespace), 'absent')")
      if [ "$rls" = "true,true" ]; then pass "$t RLS enabled and forced"; else fail "$t RLS state '$rls'"; fi
    done
    dups=$(sql "select (select count(*) from (select 1 from organizations group by name_key having count(*)>1) a) || ',' || (select count(*) from (select 1 from academies group by name_key having count(*)>1) b)")
    if [ "$dups" = "0,0" ]; then pass "no duplicate organization or academy names (W4)"; else fail "duplicate name groups (orgs,academies)=$dups"; fi
    info "W4 rename backups (orgs,academies): $(sql "select (select count(*) from atlas_migration_backups.w4_backup_organization_names) || ',' || (select count(*) from atlas_migration_backups.w4_backup_academy_names)")"
    info "plans with gifted days (monthly,yearly): $(sql "select count(*) filter (where gifted_days_monthly is not null) || ',' || count(*) filter (where gifted_days_yearly is not null) from plans")"

    # W8B — the customer-identity key behind every v2 trial/gift hash. Read
    # inside the backend container with the image's own util; prints only
    # set yes/no and match/mismatch, never a value. A mismatch means the
    # pinned key is not the derivation the existing rows were hashed under:
    # trial and gift eligibility would reset. (After a DELIBERATE rotation
    # of PAYMENT_CREDENTIALS_ENCRYPTION_KEY, a pinned key no longer equals
    # the derivation by design — update this check then.)
    echo "== Customer identity key (W8B; set/match only, never a value)"
    idk=$(docker compose exec -T backend node -e '
      const u = require("./dist/plans/utils/customer-identity-key.util.js");
      const e = process.env;
      if (!e.CUSTOMER_IDENTITY_HMAC_KEY) { console.log("unset"); process.exit(0); }
      try {
        const pinned = u.customerIdentityKeyFromEnv(e);
        const derived = u.deriveCustomerIdentityKey({ paymentCredentialsKeyHex: e.PAYMENT_CREDENTIALS_ENCRYPTION_KEY });
        console.log(pinned.equals(derived) ? "match" : "mismatch");
      } catch { console.log("error"); }' 2>/dev/null | tr -d '\r') || idk=error
    case "$idk" in
      match)
        info "CUSTOMER_IDENTITY_HMAC_KEY set: yes"
        pass "CUSTOMER_IDENTITY_HMAC_KEY equals the HKDF derivation of PAYMENT_CREDENTIALS_ENCRYPTION_KEY: match" ;;
      unset) info "CUSTOMER_IDENTITY_HMAC_KEY set: no (the derived key is in use; the next deploy pins it)" ;;
      mismatch)
        info "CUSTOMER_IDENTITY_HMAC_KEY set: yes"
        fail "CUSTOMER_IDENTITY_HMAC_KEY does not equal the HKDF derivation: mismatch (trial and gift eligibility would reset)" ;;
      *) fail "customer identity key check could not run (${idk:-no output})" ;;
    esac

    echo "== Health"
    health=$(docker compose exec -T backend node -e "fetch('http://localhost:3000/health').then(async r=>console.log(r.status)).catch(()=>console.log('000'))")
    if [ "$health" = 200 ]; then pass "backend /health 200"; else fail "backend /health $health"; fi
    for svc in backend caddy ssr; do
      cid=$(docker compose ps -q "$svc" 2>/dev/null)
      if [ -n "$cid" ]; then
        info "$svc $(docker inspect -f '{{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}} started={{.State.StartedAt}} image={{.Config.Image}}' "$cid")"
      else
        info "$svc not running"
      fi
    done
    logs=$(docker compose logs --no-color --since 30m backend 2>/dev/null)
    info "backend error lines (30 min): $(printf '%s\n' "$logs" | grep -c '"level":50') fatal: $(printf '%s\n' "$logs" | grep -c '"level":60')"

    # Sanitized: time, message, error type/code/status and the request's
    # method + path (no query, no body, no headers); long token-like
    # strings are redacted. Errors and warnings from the last 6 hours.
    echo "== Recent backend errors + payment-proof storage warnings (24 h, sanitized, last 10)"
    docker compose logs --no-color --no-log-prefix --since 24h backend 2>/dev/null \
      | grep -E '"level":(50|60)|CreateBucket|payment-proofs' | tail -10 \
      | docker compose exec -T backend node -e '
          const red = (v) => String(v ?? "").replace(/[A-Za-z0-9+\/=_-]{24,}/g, "<redacted>").slice(0, 300);
          let buf = ""; process.stdin.on("data", (c) => (buf += c)).on("end", () => {
            for (const line of buf.split("\n")) {
              const i = line.indexOf("{"); if (i < 0) continue;
              let j; try { j = JSON.parse(line.slice(i)); } catch { continue; }
              const e = j.err || j.error || {};
              // AllExceptionsFilter logs { requestId, status, exception: <stack> }.
              const st = typeof j.exception === "string" ? j.exception.split("\n") : [];
              const head = st.length ? "exception=" + red(st[0]) : "";
              const frames = st.slice(1, 5).map((f) => f.trim().replace(/\(.*\/(dist|node_modules)\//, "($1/").slice(0, 160)).join(" | ");
              const req = j.req || {};
              const path = String(req.url || j.url || "").split("?")[0];
              console.log(["INFO ", new Date(j.time || Date.now()).toISOString(), "level=" + j.level,
                j.context ? "ctx=" + red(j.context) : "", "msg=" + red(j.msg),
                e.type || e.name ? "err=" + red(e.type || e.name) : "", e.code || e.Code ? "code=" + red(e.code || e.Code) : "",
                e.message ? "errmsg=" + red(e.message) : "", e.$metadata && e.$metadata.httpStatusCode ? "s3status=" + e.$metadata.httpStatusCode : "",
                j.status ? "status=" + j.status : "", head, frames ? "at " + frames : "",
                req.method ? req.method + " " + path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ":id").replace(/[^\/]{24,}/g, "<redacted>") : ""].filter(Boolean).join(" "));
            }
          });' 2>/dev/null || info "could not read backend logs"

    # Read-only: can the app's own credentials reach each bucket? One
    # GetObject on a key that never exists, per bucket from inside the backend container;
    # only the role and the outcome are printed, never a name or a key.
    echo "== Object storage access (app credentials, read-only probe)"
    storage=$(docker compose exec -T backend node -e '
      const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
      const e = process.env;
      const client = (id, secret) => new S3Client({ region: e.R2_REGION, endpoint: e.R2_ENDPOINT,
        forcePathStyle: e.R2_FORCE_PATH_STYLE !== "false",
        credentials: { accessKeyId: id, secretAccessKey: secret } });
      const main = client(e.R2_ACCESS_KEY_ID, e.R2_SECRET_ACCESS_KEY);
      const prot = client(e.R2_PROTECTED_ACCESS_KEY_ID || e.R2_ACCESS_KEY_ID, e.R2_PROTECTED_SECRET_ACCESS_KEY || e.R2_SECRET_ACCESS_KEY);
      const checks = [
        ["media (public)", main, e.R2_BUCKET],
        ["payment-proofs (private)", main, e.R2_BUCKET + "-payment-proofs"],
        ["protected media (private)", prot, e.R2_PROTECTED_BUCKET || e.R2_BUCKET + "-protected"],
      ];
      (async () => {
        for (const [role, c, bucket] of checks) {
          // A key that never exists: NoSuchKey = the credential reaches the
          // bucket; NoSuchBucket / AccessDenied = it does not (R2 answers
          // AccessDenied for a bucket outside the token scope).
          try { await c.send(new GetObjectCommand({ Bucket: bucket, Key: "release-verify/probe-never-exists" }));
            console.log((role.startsWith("payment") ? "PASS  " : "INFO  ") + role + " bucket: reachable");
          } catch (err) {
            const st = err.$metadata && err.$metadata.httpStatusCode;
            if (err.name === "NoSuchKey") { console.log((role.startsWith("payment") ? "PASS  " : "INFO  ") + role + " bucket: reachable"); continue; }
            console.log((role.startsWith("payment") ? "FAIL  " : "INFO  ") + role + " bucket: " + (err.name && err.name !== "Error" ? err.name : err.code || "Error") + (st ? " (" + st + ")" : ""));
          }
        }
      })();' 2>/dev/null) || storage="FAIL  storage check could not run"
    printf '%s\n' "$storage"
    FAILS=$((FAILS + $(printf '%s\n' "$storage" | grep -c '^FAIL')))

    echo "== Runtime flags (non-secret values)"
    for k in ATLAS_SSR RUM_ENABLED SSR_CACHE_TTL_MS SSR_CACHE_MAX; do
      v=$(env_value "$k"); info "$k=${v:-<unset>}"
    done
    # FLAG_* values print in the configuration facts below.
    if [ "$(env_value ATLAS_SSR)" = on ]; then
      if [ -n "$(docker compose ps -q ssr 2>/dev/null)" ]; then pass "ATLAS_SSR=on and the renderer is running"; else fail "ATLAS_SSR=on but the renderer is not running"; fi
    fi

    config_facts

    b0_release_facts
    owners_facts

    # Reported, not gating (a subshell keeps its FAIL count out of this
    # mode's exit): the tier stays off until every line passes and the
    # owner turns it on (B0-OC-34). `remote.sh video` alone does gate.
    echo "== Normal-tier video readiness follows (B0-MED-11; reported, not gating)"
    ( video_facts ) || true

    echo "== Website published copy"
    IFS='|' read -r _ all snap <<< "$(sql "select 'published_sites', count(*), count(published_snapshot) from website_configurations where status='published'")"
    if [ "$all" = "$snap" ]; then pass "every published site has a published snapshot ($snap/$all)"; else fail "published sites with a snapshot: $snap/$all"; fi
    IFS='|' read -r _ n <<< "$(sql "select 'pages_unpublished_changes', count(*) from website_pages p join website_configurations c on c.academy_id=p.academy_id where c.status='published' and (p.published_version is null or p.published_version <> p.version)")"
    info "pages on published sites with unpublished changes: $n"

    echo "== Course progress item counts"
    IFS='|' read -r _ all bad1 bad2 <<< "$(sql "select 'progress_rows', count(*), count(*) filter (where total_items < total_lessons), count(*) filter (where completed_items > total_items) from course_progress")"
    if [ "$bad1" = 0 ] && [ "$bad2" = 0 ]; then pass "course_progress: $all rows, item counts consistent"; else fail "course_progress: total<lessons=$bad1 completed>total=$bad2 of $all"; fi

    echo "== Bank Transfer (configuration state only)"
    IFS='|' read -r _ all en conf <<< "$(sql "select 'bank_methods', count(*), count(*) filter (where enabled), count(*) filter (where enabled and manual_instructions is not null) from payment_methods where type='manual_bank_transfer'")"
    info "bank transfer methods: $all, enabled: $en, enabled with instructions: $conf"
    IFS='|' read -r _ ph phen <<< "$(sql "select 'placeholders', count(*), count(*) filter (where enabled) from payment_methods where manual_instructions->>'placeholder' = 'true'")"
    if [ "${phen:-1}" = 0 ]; then pass "placeholder payment methods: $ph, none enabled"; else fail "placeholder payment methods enabled: $phen of $ph"; fi
    sql "select 'manual_methods', type, count(*), count(*) filter (where enabled) from payment_methods where type::text like 'manual_%' group by type order by type" | while IFS='|' read -r _ t n e; do info "$t: $n configured, $e enabled"; done
    IFS='|' read -r _ y all <<< "$(sql "select 'plans_yearly', count(*) filter (where pricing ? 'yearlyAmount'), count(*) from plans")"
    info "plans with a yearly price: $y of $all"
    IFS='|' read -r _ s all <<< "$(sql "select 'payments_snapshot', count(*) filter (where instructions_snapshot is not null), count(*) from payments")"
    info "payments with an instructions snapshot: $s of $all"

    echo "== Website messages and favicons (counts only)"
    IFS='|' read -r _ msgs newmsgs <<< "$(sql "select 'contact', count(*), count(*) filter (where status='new') from contact_submissions")"
    info "contact submissions stored: $msgs (new: $newmsgs)"
    IFS='|' read -r _ fav <<< "$(sql "select 'favicons', count(*) from academies where coalesce(favicon_url,'') <> '' and archived_at is null")"
    info "academies with a favicon: $fav"

    echo "== Result: $FAILS failing check(s)"
    [ "$FAILS" = 0 ]
    ;;
  hosts)
    # The app's base domain is PLATFORM_BASE_DOMAIN (env); the DB row is a
    # fallback only. Without one, a subdomain is not a host: print nothing.
    base=$(env_value PLATFORM_BASE_DOMAIN)
    [ -n "$base" ] || base=$(docker compose exec -T backend printenv PLATFORM_BASE_DOMAIN 2>/dev/null | tr -d '\r')
    [ -n "$base" ] || base=$(sql "select base_domain from platform_domain_configuration where configured and base_domain is not null limit 1")
    sql "select coalesce(s.full_host, case when '$base' <> '' then s.subdomain || '.' || '$base' end)
         from academies a
         join subdomain_allocations s on s.academy_id=a.id and s.status='assigned'
         join website_configurations w on w.academy_id=a.id and w.status='published'
         where a.archived_at is null and a.status='active'
         order by (coalesce(a.favicon_url,'') <> '') desc, a.created_at limit 2" | { grep -v '^$' || true; } | sed 's/^/host|/'
    ;;
  rum)
    # One selector over the three histograms: `sum(a)+sum(b)` is EMPTY when
    # any one has no series yet (INP needs an interaction), which read as 0.
    q='/api/v1/query?query=sum(%7B__name__%3D~%22atlas_rum_(lcp_seconds%7Cinp_seconds%7Ccls)_count%22%7D)'
    total=$(prom "$q" | count_json "d.data.result.length?d.data.result[0].value[1]:0" 2>/dev/null)
    per=$(prom '/api/v1/query?query=sum%20by%20(__name__)(%7B__name__%3D~%22atlas_rum_(lcp_seconds%7Cinp_seconds%7Ccls)_count%22%7D)' \
      | count_json "d.data.result.map(r=>r.metric.__name__.replace('atlas_rum_','').replace('_count','')+'='+r.value[1]).join(',')||'none'" 2>/dev/null)
    echo "rum|${total:-0}|${per:-none}"
    ;;
  dups)
    # W4 pre-deploy report: how many organization / academy names collide
    # under the W4 name key, and how many learners share a key inside one
    # academy. Counts only, never a name. The key function is a session-
    # temporary copy of migration 20261104000300's atlas_name_key, created
    # inside a transaction that is rolled back: nothing persists.
    docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
CREATE FUNCTION pg_temp.w4_key(p text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $fn$
  SELECT btrim(
    regexp_replace(
      normalize(
        translate(
          lower(
            regexp_replace(
              normalize(p, NFKD),
              '[̀-ًͯ-ٰٟۖ-ۭـ​-‏‪-‮⁠-⁩﻿]',
              '',
              'g'
            ) COLLATE "und-x-icu"
          ),
          'ς',
          'σ'
        ),
        NFKC
      ),
      '\s+',
      ' ',
      'g'
    )
  )
$fn$;
SELECT 'w4dups', e, count(*), coalesce(sum(n),0), coalesce(sum(n-1),0) FROM (
  SELECT 'organizations' e, count(*) n FROM organizations GROUP BY pg_temp.w4_key(name) HAVING count(*) > 1
  UNION ALL
  SELECT 'academies', count(*) FROM academies GROUP BY pg_temp.w4_key(name) HAVING count(*) > 1
  UNION ALL
  SELECT 'learners', count(*) FROM academy_students s JOIN users u ON u.id = s.user_id
   GROUP BY s.academy_id, pg_temp.w4_key(u.name) HAVING count(*) > 1
) g GROUP BY e ORDER BY e;
SELECT 'w4totals', (SELECT count(*) FROM organizations), (SELECT count(*) FROM academies), (SELECT count(*) FROM academy_students);
ROLLBACK;
SQL
    ;;
  config)
    config_facts
    [ "$FAILS" = 0 ]
    ;;
  video)
    video_facts
    [ "$FAILS" = 0 ]
    ;;
  b0)
    b0_release_facts
    [ "$FAILS" = 0 ]
    ;;
  owners)
    owners_facts
    [ "$FAILS" = 0 ]
    ;;
  *) echo "usage: remote.sh facts|hosts|rum|dups|config|video|b0|owners" >&2; exit 2 ;;
esac
