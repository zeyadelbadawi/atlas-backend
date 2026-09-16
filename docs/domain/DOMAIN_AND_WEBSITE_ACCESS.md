# Domain, subdomain & website access (P63)

**Status: IMPLEMENTED · REAL-POSTGRESQL E2E · REAL CHROME (EN + AR/RTL) · see §12 for what is and is not production-verified.**

This is the authority on how an Academy website is addressed, how a
customer connects a custom domain, how Atlas verifies it, which address is
canonical, and what the Platform Owner can see and do about all of it.
Everything below describes what the code does today; nothing here is an
intended design that was not built.

---

## 1. The three layers

| Layer | Host | Source of truth | Served by |
|---|---|---|---|
| Atlas app | `atlass.dpdns.org` | `PLATFORM_BASE_DOMAIN` | Caddy (wildcard cert via Cloudflare DNS-01), behind Cloudflare proxy |
| Academy subdomain | `{slug}.atlass.dpdns.org` | `subdomain_allocations` (`subdomain = academy.slug`) | same wildcard site block |
| Custom domain | customer hostname | `domain_connections` | Cloudflare for SaaS custom hostname → fallback origin → Caddy `:443` catch-all (`tls internal`) |

`resolve_public_hostname(hostname, label)` — the one SECURITY DEFINER
function for public resolution — matches a **connected** custom hostname
first, then an **assigned** subdomain label, and excludes archived or
suspended Academies. P63 extended its return list (not its matching rules)
with the Academy's connected custom hostname and subdomain label so the
public runtime can name a canonical host.

## 2. The base domain has one source of truth

`PlatformDomainService.getEffectiveBaseDomain()` returns the deployment's
`PLATFORM_BASE_DOMAIN` when set (`source: 'environment'`), otherwise the
`platform_domain_configuration` row (`source: 'database'`). The
environment wins because it is what CORS, public hostname resolution, the
wildcard certificate and DNS are actually configured for; a database edit
never changed any of that. `PATCH /platform-domain` is refused with 409
`errors.domain.baseDomainManagedByEnvironment` while the environment owns
the value, and the Platform Owner page shows the value read-only with its
source. Provisioning, `AcademiesService.create` and the subdomain
availability pre-check keep computing `full_host` from the database row
as before (unchanged); the effective value is what every P63 read uses.

## 3. Custom domain lifecycle (customer)

Endpoints (unchanged paths, `AcademyScopeGuard` + academy-role check):

| Method | Path | Effect |
|---|---|---|
| GET | `academies/:id/website/domain` | configuration incl. `canonicalHost`, `dns` |
| POST | `academies/:id/website/domain/custom-domain` | connect / re-submit / replace |
| POST | `academies/:id/website/domain/verify` | "Check now" |
| DELETE | `academies/:id/website/domain/custom-domain` | disconnect (reset, never delete) |

Statuses are the P11 enum, unchanged: `not_configured`, `pending`,
`verification_required`, `verifying`, `connected`, `failed`,
`disconnected`. They are set **only** from provider answers
(`cloudflare-status-mapper.ts`) — no request body can move a row to
`connected`.

**Add.** Validates and normalises the hostname (lower-case, RFC-1035
shape, not an IPv4 literal), refuses a hostname another Academy holds (409
inside the tenant's RLS view; the `hostname` UNIQUE index catches the
cross-tenant case RLS hides), registers the hostname with the provider
(idempotent: an existing custom hostname is reused, its records kept),
releases the previous provider resource when the hostname changes, stores
`provider_hostname_id`, runs an immediate check, audits
`domain.custom_domain_added`. When the provider is unavailable the row is
created with `verification_required`, no records, and
`last_check_error = provider_unavailable` — intent recorded, nothing
simulated.

**Check.** `DomainCheckService.check` (one implementation for the customer
button, the operator button and the sweep) asks the provider (by id, then
by hostname), maps status/SSL/CDN, sets `last_checked_at`, sets
`last_check_error` to one of `provider_unavailable`,
`provider_hostname_missing` (a previously connected domain becomes
`disconnected`), `provider_error`, `dns_not_pointing`, and — only when the
provider says the hostname is live — runs Atlas's own HTTPS probe and
stores `https_reachable` / `https_checked_at`. Audits
`domain.verification_checked` with status/SSL before→after.

**Remove.** Releases the provider resource, resets every column (the table
has no DELETE policy by design), audits `domain.custom_domain_removed`.
Repeating it is a no-op.

**DNS instructions** returned as `dns`: the CNAME the customer must create
(`hostname → <zone fallback origin>`, read live from Cloudflare and cached
five minutes) plus the provider's ownership/SSL TXT records. When no
fallback origin exists the response carries no `cnameTarget` and the UI
says Atlas is not ready to route custom domains — it never invents a
target.

## 4. Concurrency

Every add/check/remove (customer, operator and sweep) takes
`DomainConnectionsRepository.lockByAcademyId`: a transaction-scoped
advisory lock keyed by academy (serialises even the first add, when no row
exists) plus `SELECT … FOR UPDATE` on the row. Cross-Academy claims of the
same hostname are decided by the database UNIQUE index (exactly one 201,
the other 409 — `P63-DOM-004`). Overlapping checks queue and each records
a consistent result (`P63-DOM-010`). The sweep re-reads under the lock
and skips a row its owner checked a moment ago.

## 5. Verification sweep

Queue `domain-verification-sweep`, one BullMQ repeatable every 10 minutes
(`DomainVerificationSweepScheduler`, same shape as `subscription-sweep`).
Runs under `runInUserContext(<first platform owner>)` through the P63
`domain_connections_platform_update` policy. Candidates: rows awaiting the
provider (`pending`/`verification_required`/`verifying`) not checked in 5
minutes, and `connected` rows not checked in 6 hours (so DNS that breaks
after connection stops being "connected" — and stops being canonical —
without a click). Batches of 50 up to 200 per tick; each row in its own
transaction; skips entirely (and logs why) when no platform owner exists
or provider credentials are absent.

## 6. Canonical host

`resolveCanonicalHost` (`domain/utils/canonical-host.util.ts`) is the one
rule, used by the tenant read, the Platform Owner list and the public
resolve response:

> the custom domain when it is `connected` **and** Atlas's last HTTPS probe
> did not find it unreachable; otherwise the Atlas subdomain from the
> **assigned `subdomain_allocations` row** (`full_host`, else
> `{label}.{baseDomain}`); `null` when neither exists.

The Academy slug is deliberately not used as a fallback: a subdomain
without an assigned allocation does not resolve publicly, so advertising it
would be a fabricated address. Every application-created Academy has an
allocation (`P104-SUB-008`); only legacy seed fixtures lack one.

There is deliberately **no stored "primary domain" preference**: a
customer who completed DNS verification did so to use that address, and a
preference that could point at an unverified or dead hostname would send
visitors to a dead site. Both hosts keep resolving. The public website:

- sets `<link rel="canonical">` (and `og:url`, breadcrumbs) to the canonical
  host for every page;
- when a visitor lands on the non-canonical host in a production build,
  performs `window.location.replace` to the canonical host with path, query
  and hash preserved (`canonical-redirect.utils.ts`). No server-side
  redirect exists (Caddy cannot consult the database), and none is needed
  for correctness — only for SEO consolidation and one cookie/session
  origin. Loops are impossible: the redirect fires only when the current
  host differs from the single canonical host.

Because `https_reachable = false` demotes the custom domain, a broken
custom domain never becomes a redirect target from the working Atlas
subdomain (`P63-DOM-015`).

## 7. HTTPS probe and SSRF discipline

`HttpsProbeService.probe(hostname)`: one bounded `GET https://{hostname}/`
using `node:https` with the connection **pinned to a vetted address**. The
hostname is refused (recorded unreachable, never dialled) when it is an IP
literal, does not resolve, or resolves to **any** non-public address
(loopback, RFC 1918, link-local incl. `169.254.169.254`, CGNAT,
multicast, reserved, IPv6 loopback/ULA/link-local/multicast/v4-mapped
private/documentation). `node:fetch` is not used because it cannot pin the
address (DNS rebinding between vetting and connect). Port is always 443,
scheme always https, redirects are never followed, the body is discarded
unread. Unit-tested (`outbound-address.util.spec.ts`,
`https-probe.service.spec.ts`). The Platform Owner readiness probes only
platform-owned hosts.

## 8. Platform Owner operations

| Method | Path | Guard |
|---|---|---|
| GET | `platform-domain` | `JwtAuthGuard` (base domain is public information) |
| GET | `platform-domain/readiness` | + `PlatformOwnerGuard` |
| PATCH | `platform-domain` | + `PlatformOwnerGuard` (409 when environment-managed) |
| GET | `platform-domains` | + `PlatformOwnerGuard` — paginated, `search` (academy, slug, organization, hostname, full host), `kind` (`custom`/`subdomain`), `status`, `attention`, `sortBy` allow-list |
| GET | `platform-domains/overview` | real counts |
| GET | `platform-domains/:academyId` | one row |
| POST | `platform-domains/:academyId/check` | operator re-check, audited `domain.platform_check` with `role: platform_owner` |

Readiness reports live facts only: provider token valid, fallback origin
present and `active` (⇒ custom domains routable), zone origin SSL mode and
whether it is compatible with Caddy's internal certificate (`full`/
`flexible` yes, `strict` no), and two live HTTPS probes of the base domain
and a wildcard label. The UI is `/dashboard/platform/domain` ("Domains"):
base-domain card (read-only when environment-managed), readiness card,
four real counters, and the operations table with filters, pagination,
row → academy detail, and "Check now".

## 9. Security & RLS

- Guards unchanged: `JwtAuthGuard` + `AcademyScopeGuard` + academy-role
  check for customers; `JwtAuthGuard` + `PlatformOwnerGuard` for operators.
- RLS: `domain_connections` gains `domain_connections_platform_update`
  (`is_platform_owner(current user)`), mirroring `tenant_subscriptions`
  (P22). No platform INSERT/DELETE. Tenant policies unchanged. Checks use
  `UPDATE`, never `upsert`, under the platform context because Prisma's
  upsert is `INSERT … ON CONFLICT` and PostgreSQL evaluates the INSERT
  policy first. `P63-RLS-001` proves a non-owner user context sees zero
  rows and updates zero rows, the platform context updates one and cannot
  insert.
- Secrets: never in responses, audit rows or logs. Provider errors become
  the four codes; Cloudflare's own messages are not stored.
- Audit: four actions, written in the caller's transaction, with
  `changes` (hostname/status/sslStatus before→after) and a non-sensitive
  `context` (outcome, error code, HTTPS result, replaced hostname).

## 10. Database

Migration `20261007000000_p63_domain_operations`: five nullable columns on
`domain_connections` (`provider_hostname_id`, `last_checked_at`,
`last_check_error`, `https_reachable`, `https_checked_at`), indexes on
`status` and `last_checked_at`, the platform UPDATE policy, and the
extended `resolve_public_hostname` (DROP + CREATE: the OUT list changed).
Migration `20261007010000_p63b_canonical_https_fallback`: the function's
`custom_hostname` ignores a connected hostname whose last probe failed.
Additive; NULL on every existing row means "never checked", exactly the
prior behaviour. `prisma migrate diff` shows no domain drift (only the
long-known raw-SQL `search_vector` items).

## 11. Tests

- Unit: `canonical-host.util.spec.ts`, `platform-domain.service.spec.ts`,
  `outbound-address.util.spec.ts`, `https-probe.service.spec.ts`,
  `cloudflare-status-mapper.spec.ts` (unchanged).
- Real PostgreSQL e2e: `test/p63-domain-operations.e2e-spec.ts`
  (`P63-DOM-001..015`, `P63-RLS-001`, `P63-OPS-001..004`,
  `P63-SWP-001..003`) with the stateful `FakeCloudflareProvider` and
  `FakeHttpsProbe` substituted through `createTestApp({ overrides })`;
  the pre-existing `domain.e2e-spec.ts` and `rls-domain.e2e-spec.ts`
  still pass unchanged.
- Frontend vitest: `domain-lifecycle.utils.test.ts`,
  `canonical-redirect.utils.test.ts`.

## 12. Production dependencies and what is verified

| Item | State |
|---|---|
| `PLATFORM_BASE_DOMAIN` in production | inferred `atlass.dpdns.org` (full-hostname public resolution works only with the suffix strip) |
| Wildcard `*.atlass.dpdns.org` over HTTPS | VERIFIED by probe |
| Caddy `:443` catch-all answers custom hostnames | VERIFIED in the Caddyfile; behaviour depends on Cloudflare's origin SSL mode |
| Production Cloudflare token can manage custom hostnames | UNKNOWN — the readiness endpoint reports it |
| Cloudflare for SaaS fallback origin configured | UNKNOWN — the readiness endpoint reports it; without it no custom domain can complete |
| Zone origin SSL mode | UNKNOWN — the readiness endpoint reports it; `strict` would fail every custom hostname because the origin answers with an internal certificate |
| End-to-end custom domain on a real customer hostname | NOT VERIFIED — requires a real hostname the operator controls |

No new environment variable is required. No new external service is
introduced; the verification sweep is one more BullMQ repeatable on the
existing Redis.

## 13. Known limitations

- Canonical choice is a fixed rule, not a customer setting (deliberate).
- The customer tab states that the Atlas subdomain's HTTPS is managed by
  Atlas; that is an architectural fact, not a per-request measurement (the
  live wildcard probe is Platform Owner-only).
- The HTTPS probe measures transport (TLS + any response), not content.
- The sweep uses the first platform owner as its actor, like every other
  cross-tenant job.
