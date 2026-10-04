#!/usr/bin/env bash
# Atlas — server-side helper for the Final Completion release verification
# (`Release verify` workflow). Run ON the VPS, from /opt/atlas, over the
# restricted deploy identity, fed through stdin like the other verifiers.
#
#   remote.sh facts   -> PASS/FAIL/INFO: the release's migrations, health,
#                        runtime flags, renderer, data backfills, Bank
#                        Transfer configuration state (never its details)
#   remote.sh hosts   -> up to two published Academy hosts: "host|<hostname>"
#   remote.sh rum     -> "rum|<total samples>": the sum of the RUM
#                        histograms' _count series in Prometheus
#   remote.sh dups    -> "w4dups|<entity>|<groups>|<rows>|<to rename>": the
#                        W4 duplicate-name report (counts only)
#
# Read-only: every statement is a SELECT, every probe a GET. Prints
# non-secret facts only — no secret value, no personal data, no bank detail,
# and no sign-in code (this verifier never reads one).
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
sql() { docker compose exec -T postgres psql -U "$PGUSER_" -d "$PGDB_" -t -A -F'|' -c "$1"; }
prom() { docker compose exec -T prometheus wget -qO- "http://localhost:9090$1"; }
count_json() { docker compose exec -T backend node -e "let s='';process.stdin.on('data',c=>s+=c).on('end',()=>{const d=JSON.parse(s);console.log($1)})"; }

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
    for k in $(grep -oE '^FLAG_[A-Z0-9_]+' .env | sort -u); do
      v=$(env_value "$k")
      case "$k" in *ALLOWLIST*) info "$k entries=$(printf '%s' "$v" | tr ',' '\n' | grep -c .)";; *) info "$k=$v";; esac
    done
    if [ "$(env_value ATLAS_SSR)" = on ]; then
      if [ -n "$(docker compose ps -q ssr 2>/dev/null)" ]; then pass "ATLAS_SSR=on and the renderer is running"; else fail "ATLAS_SSR=on but the renderer is not running"; fi
    fi

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
  *) echo "usage: remote.sh facts|hosts|rum|dups" >&2; exit 2 ;;
esac
