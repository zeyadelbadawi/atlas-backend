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

/** Matches the frontend's own `RESERVED_SUBDOMAINS` exactly — subdomains Atlas itself needs, that a customer must never be assigned. */
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
];

export const MAX_ACADEMY_NAME_LENGTH = 100;

/** Terminal statuses — once reached, an orchestrator run stops and no further step executes. Matches the frontend's own `TERMINAL_PROVISIONING_STATUSES` exactly. */
export const TERMINAL_PROVISIONING_STATUSES: ReadonlySet<ProvisioningStatus> = new Set([
  'ready',
  'failed',
  'cancelled',
]);
