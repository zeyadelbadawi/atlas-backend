/**
 * Helmet's configuration, in one named place so it can be asserted on.
 *
 * HSTS IS A HOST-LEVEL POLICY, SO THE WEAKEST RESPONSE WINS. The browser
 * keeps one HSTS entry per host and rewrites it from every response it
 * sees, so a single response carrying a shorter `max-age` silently
 * shortens the protection the rest of the site just asked for.
 *
 * Helmet's own default is 180 days. The edge (the frontend repo's
 * `Caddyfile`) sets one year on the documents it serves, and those two
 * used to arrive together on every `/api` response — RFC 6797 §8.1 says a
 * user agent processes only the FIRST such header, so the year happened to
 * be the one that counted, but only because of the order two
 * independently-configured layers wrote their headers in.
 *
 * Caddy no longer adds its copy to proxied responses, so this is the only
 * HSTS the API emits. Leaving it on the default would therefore have been
 * a real downgrade for every host that reaches Atlas through an API
 * response first.
 *
 * Everything else stays on helmet's defaults deliberately, including the
 * stricter `Referrer-Policy: no-referrer` — the right answer for JSON that
 * is never a document anyone navigates from.
 */
import type { HelmetOptions } from 'helmet';

/** One year, matching the edge exactly. Never lower this independently of the `Caddyfile`. */
export const HSTS_MAX_AGE_SECONDS = 31_536_000;

export const HELMET_OPTIONS: HelmetOptions = {
  hsts: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true },
};
