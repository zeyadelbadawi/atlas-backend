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
    for m in 20261102000000_website_published_snapshots 20261102000100_course_progress_item_counts 20261102000200_payment_instructions_snapshot 20261102000300_payment_method_instapay 20261102000400_egypt_manual_payment_placeholders; do
      state=$(sql "select coalesce((select case when finished_at is not null and rolled_back_at is null then 'applied' else 'unfinished' end from _prisma_migrations where migration_name='$m'), 'absent')")
      if [ "$state" = applied ]; then pass "$m applied"; else fail "$m $state"; fi
    done
    pending=$(sql "select count(*) from _prisma_migrations where finished_at is null or rolled_back_at is not null")
    if [ "$pending" = 0 ]; then pass "no unfinished or rolled-back migration rows"; else fail "$pending unfinished/rolled-back migration rows"; fi

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
         order by a.created_at limit 2" | { grep -v '^$' || true; } | sed 's/^/host|/'
    ;;
  rum)
    total=$(prom '/api/v1/query?query=sum(atlas_rum_lcp_seconds_count)%2Bsum(atlas_rum_inp_seconds_count)%2Bsum(atlas_rum_cls_count)' \
      | count_json "d.data.result.length?d.data.result[0].value[1]:0" 2>/dev/null)
    lcp=$(prom '/api/v1/query?query=sum(atlas_rum_lcp_seconds_count)' | count_json "d.data.result.length?d.data.result[0].value[1]:0" 2>/dev/null)
    echo "rum|${total:-0}|lcp=${lcp:-0}"
    ;;
  *) echo "usage: remote.sh facts|hosts|rum" >&2; exit 2 ;;
esac
