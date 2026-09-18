/**
 * Domain verification sweep (P63) — one BullMQ repeatable job, the same
 * shape as `subscription-sweep`. Re-asks the provider about custom domains
 * still waiting on it, so a customer who adds their DNS records and walks
 * away finds the domain connected when they come back, without anyone
 * clicking "Check now".
 */
export const DOMAIN_VERIFICATION_SWEEP_QUEUE = 'domain-verification-sweep';
export const DOMAIN_VERIFICATION_SWEEP_JOB = 'domain-verification-sweep';
export const DOMAIN_VERIFICATION_SWEEP_REPEAT_JOB_ID = 'domain-verification-sweep:repeat';
/** Every 10 minutes — DNS propagation is measured in minutes to hours; tighter would only burn provider quota. */
export const DOMAIN_VERIFICATION_SWEEP_INTERVAL_MS = 10 * 60 * 1000;
/** A row still waiting on the provider is re-checked once it is this old (a customer's own "Check now" counts). */
export const DOMAIN_VERIFICATION_SWEEP_MIN_AGE_MS = 5 * 60 * 1000;
/**
 * A SETTLED row (live, provider certificate active) is re-checked this
 * often, so a domain whose DNS later breaks stops being "live" (and stops
 * being canonical) without anyone clicking. P63f: one hour, down from six
 * — a production test removed a live domain's DNS and the dashboard could
 * not notice for hours; one read per settled domain per hour is far below
 * provider quota at any plausible scale. Anything not yet settled is on
 * the fast cadence.
 */
export const DOMAIN_VERIFICATION_SWEEP_CONNECTED_RECHECK_MS = 60 * 60 * 1000;
/** Rows fetched per batch; batches repeat until nothing is due or the per-tick cap is reached. */
export const DOMAIN_VERIFICATION_SWEEP_BATCH_SIZE = 50;
/** Hard cap per tick — provider rate limits are shared with every other Cloudflare call Atlas makes. */
export const DOMAIN_VERIFICATION_SWEEP_MAX_PER_TICK = 200;
/** P63g — pending provider releases retried per tick. */
export const DOMAIN_VERIFICATION_SWEEP_RELEASES_PER_TICK = 50;
/** P63g — wall-clock budget for one tick, comfortably inside the interval so ticks never queue behind each other. */
export const DOMAIN_VERIFICATION_SWEEP_TICK_BUDGET_MS = 7 * 60 * 1000;
/** P63g — BullMQ lock renewal window for the worker; the tick budget above is what actually bounds the work. */
export const DOMAIN_VERIFICATION_SWEEP_LOCK_MS = 60 * 1000;

export type DomainVerificationSweepJobPayload = Record<string, never>;
