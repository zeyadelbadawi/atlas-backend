/**
 * Sentry error monitoring (Phase 10, Phase 7 carry-over).
 *
 * DISABLED BY DEFAULT, AND THAT IS A REAL STATE — not a stub. With no
 * `SENTRY_DSN` configured, `initializeSentry` returns `false` and the SDK
 * is never initialised, so nothing is collected, nothing is transmitted,
 * and no network egress is attempted. Local development, CI and any
 * self-hosted deployment therefore need no Sentry account whatsoever.
 * Supplying a valid DSN is the ONLY step required to turn it on; no code
 * change accompanies it.
 *
 * WHY THIS IS A PLAIN FUNCTION AND NOT A NEST MODULE. `Sentry.init` must
 * run before the modules it instruments are loaded, which is earlier than
 * any Nest provider can be constructed. It is therefore called at the very
 * top of `main.ts`, reading `process.env` directly — the one place in this
 * codebase permitted to do so, because `ConfigService` does not exist yet
 * at that point. The values are re-validated by `env.validation.ts` a few
 * lines later, so a malformed DSN still fails the boot loudly.
 *
 * SCRUBBING. `sendDefaultPii` is off and `beforeSend` strips credential
 * material from every event before transmission — see its own comment.
 * The rule this phase enforces ("never log passwords, refresh tokens,
 * access tokens, authorization headers, secret environment variables")
 * applies to anything leaving the process, and an error report leaves the
 * process more definitively than a log line does.
 */
import * as Sentry from '@sentry/node';
import type { ErrorEvent, EventHint } from '@sentry/node';

/** Header names that carry credentials and must never reach Sentry. Lowercased for comparison. */
const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
]);

/** Request/response body and context keys that carry credentials. Compared case-insensitively. */
const SENSITIVE_KEYS = [
  'password',
  'currentpassword',
  'newpassword',
  'confirmpassword',
  'passwordhash',
  'password_hash',
  'token',
  'tokenhash',
  'token_hash',
  'accesstoken',
  'refreshtoken',
  'secret',
  'apikey',
  'api_key',
  'authorization',
];

const CENSOR = '[REDACTED]';

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return SENSITIVE_KEYS.some((candidate) => normalized.includes(candidate));
}

/**
 * Recursively replaces credential-bearing values with a censor marker.
 *
 * Depth-bounded because an event payload can contain a cyclic or
 * pathologically deep object, and a `beforeSend` hook that throws or hangs
 * would take down error reporting entirely — the one path that must stay
 * reliable when everything else is failing.
 */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((entry) => scrub(entry, depth + 1));
  }

  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    result[key] = isSensitiveKey(key) ? CENSOR : scrub(entry, depth + 1);
  }
  return result;
}

/**
 * Strips credential material from an event before it leaves the process.
 *
 * Exported (rather than living inline in `Sentry.init`) purely so it can
 * be unit-tested directly: "no secrets reach Sentry" is a claim that has
 * to be provable on demand, not asserted once by inspection. See
 * `sentry.spec.ts`.
 */
export function scrubEvent(event: ErrorEvent): ErrorEvent {
  // Headers first — `authorization` is the single most likely place for
  // a live access token to escape.
  if (event.request?.headers) {
    const headers: Record<string, string> = {};
    for (const [name, headerValue] of Object.entries(event.request.headers)) {
      headers[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? CENSOR : headerValue;
    }
    event.request.headers = headers;
  }

  if (event.request?.data !== undefined) {
    event.request.data = scrub(event.request.data);
  }

  // Query strings and cookies are dropped wholesale rather than scrubbed:
  // neither is needed to diagnose an error, and a token smuggled through
  // an unexpected query parameter would otherwise slip past a
  // key-name-based filter.
  if (event.request) {
    delete event.request.cookies;
    delete event.request.query_string;
  }

  if (event.extra) event.extra = scrub(event.extra) as Record<string, unknown>;
  if (event.contexts) {
    event.contexts = scrub(event.contexts) as typeof event.contexts;
  }

  return event;
}

/**
 * Initialises Sentry if — and only if — a DSN is configured.
 *
 * @returns whether error reporting is active, so the caller can log the
 *          state plainly instead of leaving operators guessing.
 */
export function initializeSentry(): boolean {
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) return false;

  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV ?? 'development',
    // Off unless explicitly opted into: enabling error reporting should
    // not silently start sampling performance data and consuming quota.
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE ?? 0),
    // Never attach IPs, cookies or headers automatically. Anything useful
    // is added deliberately below, after scrubbing.
    sendDefaultPii: false,
    beforeSend: (event: ErrorEvent, _hint: EventHint): ErrorEvent | null =>
      scrubEvent(event),
  });

  return true;
}
