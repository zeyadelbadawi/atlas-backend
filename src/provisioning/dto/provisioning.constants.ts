/**
 * Provisioning constants (Phase P14, master plan §5.11/§21).
 *
 * `PROVISIONING_STEP_ORDER` is the exact, confirmed-against-the-repository
 * `PROVISIONING_STEP_KEYS` order (`atlas-front/src/features/provisioning/
 * constants/provisioning.constants.ts`) — the canonical sequence every
 * orchestrator run walks, never re-derived or guessed elsewhere.
 *
 * `MIN_SUBDOMAIN_LENGTH`/`MAX_SUBDOMAIN_LENGTH`/`SUBDOMAIN_REGEX`/
 * `RESERVED_SUBDOMAINS` mirror the frontend's own
 * `provisioning.constants.ts` values exactly — the same floors are
 * re-enforced server-side per this codebase's blanket "never trust the
 * client alone" rule (master plan §16).
 */
import type { ProvisioningStepKey, ProvisioningStatus } from '@prisma/client';

export const PROVISIONING_STEP_ORDER: readonly ProvisioningStepKey[] = [
  'tenant',
  'academy',
  'theme',
  'branding',
  'subdomain',
  'domain',
  'finalization',
];

/** The request-level milestone reached once a given step completes/skips — see schema.prisma's own P14 header comment for the full reasoning behind this exact mapping. */
export const STATUS_AFTER_STEP: Readonly<
  Record<ProvisioningStepKey, ProvisioningStatus>
> = {
  tenant: 'tenant_created',
  academy: 'academy_created',
  theme: 'theme_applied',
  branding: 'branding_applied',
  subdomain: 'subdomain_assigned',
  domain: 'provisioning',
  finalization: 'ready',
};

export const MIN_SUBDOMAIN_LENGTH = 3;
export const MAX_SUBDOMAIN_LENGTH = 50;
export const SUBDOMAIN_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Labels Atlas itself needs, or that read as an Atlas service, that a
 * customer must never be assigned (LB-RESERVED in
 * `docs/ATLAS_GLOBAL_IDENTITY_PLAN_v3.md`, plus the help center's `docs`,
 * `doc` and `help` hosts, DL-57). Matches the frontend's own
 * `RESERVED_SUBDOMAINS` and the database's `atlas_is_reserved_subdomain()`
 * exactly (the specs compare). Use `isReservedSubdomain`, which also
 * refuses look-alikes.
 */
export const RESERVED_SUBDOMAINS: readonly string[] = [
  'www',
  'app',
  'api',
  'admin',
  'dashboard',
  'platform',
  'atlas',
  'mail',
  'status',
  'support',
  // Help center and content hosts.
  'docs',
  'doc',
  'help',
  'blog',
  'learn',
  'kb',
  'faq',
  'wiki',
  // Live infrastructure records and probes.
  'video',
  'ssh',
  'cdn',
  'static',
  'assets',
  'media',
  'files',
  // Sign-in, accounts and money.
  'auth',
  'login',
  'signin',
  'signup',
  'register',
  'account',
  'accounts',
  'billing',
  'pay',
  'payment',
  'payments',
  'checkout',
  'sso',
  'oauth',
  'id',
  'identity',
  'secure',
  'security',
  'verify',
  // Mail and DNS.
  'email',
  'webmail',
  'smtp',
  'imap',
  'pop',
  'mx',
  'ns1',
  'ns2',
  'ftp',
  // Environments and operations.
  'dev',
  'staging',
  'test',
  'preview',
  'sandbox',
  'beta',
  'demo',
  'internal',
  'system',
  'root',
  'origin',
  'metrics',
  'health',
  // Roles and tenancy words.
  'owner',
  'manage',
  'management',
  'academy',
  'org',
  'organization',
];

/**
 * Words that, alone or joined only with each other, digits and
 * `SUBDOMAIN_FILLER_WORDS`, make a label read as an Atlas service
 * (`help-center`, `docs2`, `apidocs`, `support-desk`). Generic teaching
 * words (`learn`, `academy`, `demo`, …) are reserved exactly but are not
 * here, so `learn-english` and `math-academy` stay available.
 */
export const PLATFORM_LOOKALIKE_WORDS: readonly string[] = [
  'www',
  'app',
  'api',
  'admin',
  'dashboard',
  'platform',
  'mail',
  'webmail',
  'email',
  'status',
  'support',
  'docs',
  'doc',
  'help',
  'blog',
  'kb',
  'faq',
  'wiki',
  'video',
  'ssh',
  'cdn',
  'static',
  'assets',
  'media',
  'files',
  'auth',
  'login',
  'signin',
  'signup',
  'register',
  'account',
  'accounts',
  'billing',
  'pay',
  'payment',
  'payments',
  'checkout',
  'sso',
  'oauth',
  'identity',
  'secure',
  'security',
  'verify',
  'staging',
  'preview',
  'sandbox',
  'internal',
  'system',
  'root',
  'origin',
];

/** Words that add nothing to a look-alike (`help` + `center`). */
export const SUBDOMAIN_FILLER_WORDS: readonly string[] = [
  'center',
  'centre',
  'central',
  'portal',
  'desk',
  'hub',
  'page',
  'pages',
  'site',
  'web',
  'official',
  'team',
  'panel',
  'home',
  'online',
  'info',
  'main',
  'service',
  'services',
  'my',
  'the',
  'get',
  'go',
  'net',
  'cloud',
];

/** Digit look-alikes (`d0cs`, `he1p`, `4tlas`). */
const LOOKALIKE_DIGITS: Readonly<Record<string, string>> = {
  '0': 'o',
  '1': 'l',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
};

const LOOKALIKE_SET = new Set(PLATFORM_LOOKALIKE_WORDS);
const FILLER_SET = new Set(SUBDOMAIN_FILLER_WORDS);
const RESERVED_SET = new Set(RESERVED_SUBDOMAINS);

/** Can `text` be split entirely into look-alike words, fillers and digit runs, with at least one look-alike word? */
function readsAsPlatformService(text: string): boolean {
  // best[i]: 0 = no split of text[0..i), 1 = split without a look-alike word, 2 = with one.
  const best: number[] = new Array(text.length + 1).fill(0);
  best[0] = 1;
  for (let end = 1; end <= text.length; end += 1) {
    for (let start = 0; start < end; start += 1) {
      if (best[start] === 0) continue;
      const piece = text.slice(start, end);
      let found = 0;
      if (LOOKALIKE_SET.has(piece)) found = 2;
      else if (FILLER_SET.has(piece) || /^[0-9]+$/.test(piece)) found = 1;
      if (found) best[end] = Math.max(best[end], found === 2 ? 2 : best[start]);
    }
  }
  return best[text.length] === 2;
}

/**
 * Whether a subdomain label is unavailable to customers: reserved exactly,
 * contains the Atlas name or starts with `admin` (impersonation, also with
 * digit look-alikes and hyphens removed), or reads as an Atlas service.
 */
export function isReservedSubdomain(rawLabel: string): boolean {
  const label = rawLabel.trim().toLowerCase();
  if (RESERVED_SET.has(label)) return true;
  const joined = label.replace(/-/g, '');
  const spelled = joined.replace(/[0-9]/g, (d) => LOOKALIKE_DIGITS[d] ?? d);
  // `1` stands for `l` and for `i` (`adm1n`).
  const spelledI = joined.replace(/[0-9]/g, (d) =>
    d === '1' ? 'i' : (LOOKALIKE_DIGITS[d] ?? d),
  );
  for (const form of [joined, spelled, spelledI]) {
    if (form.includes('atlas') || form.startsWith('admin')) return true;
    if (RESERVED_SET.has(form)) return true;
  }
  return readsAsPlatformService(joined) || readsAsPlatformService(spelled);
}

export const MAX_ACADEMY_NAME_LENGTH = 100;

/** Terminal statuses — once reached, an orchestrator run stops and no further step executes. Matches the frontend's own `TERMINAL_PROVISIONING_STATUSES` exactly. */
export const TERMINAL_PROVISIONING_STATUSES: ReadonlySet<ProvisioningStatus> = new Set([
  'ready',
  'failed',
  'cancelled',
]);

/**
 * Phase 8 — the number of consecutive attempts (`provisioning_requests.
 * attempt_count`, the existing "the orchestrator picked this request up"
 * counter `runToCompletion` already increments — never a second, new
 * failure counter) a request may accumulate while still landing in
 * `status = 'failed'` before `ProvisioningOrchestratorService` auto-opens
 * a support case on the requester's behalf.
 *
 * `2` is the roadmap's own stated acceptance criterion, verbatim: "Two
 * consecutive provisioning failures automatically open a ticket with a
 * friendly, non-technical message" (ATLAS_PRODUCTION_ROADMAP.md, Phase 8)
 * — not a number chosen here. A single transient blip still never opens a
 * ticket (and the connection-pool class of transient failure is absorbed
 * one layer lower by `withTransientRetry` before it is ever recorded as a
 * step failure at all), while a genuinely broken request reaches a human
 * quickly.
 */
export const PROVISIONING_AUTO_SUPPORT_CASE_FAILURE_THRESHOLD = 2;

/**
 * W2 — the stages a person sees, each tied to real steps. The no-op rows
 * (`tenant`, the `subdomain` re-check, the always-skipped `domain`) are
 * folded into the stage around them rather than shown as their own rows:
 * the address is reserved inside the `academy` step itself
 * (`AcademiesService.create`), and a custom domain is a separate flow.
 */
export type ProvisioningStage = 'academy' | 'website' | 'brand' | 'finalize';

export const PROVISIONING_STAGE_OF_STEP: Readonly<
  Record<ProvisioningStepKey, ProvisioningStage>
> = {
  tenant: 'academy',
  academy: 'academy',
  theme: 'website',
  branding: 'brand',
  subdomain: 'finalize',
  domain: 'finalize',
  finalization: 'finalize',
};

/** Fallback when configuration is unavailable (unit tests) — matches `PROVISIONING_STALL_SECONDS`'s default. */
export const DEFAULT_PROVISIONING_STALL_SECONDS = 120;
