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
  // P63g — HSTS is set by `hstsPerHost` below, per request host.
  hsts: false,
};

/**
 * P63g — `Strict-Transport-Security` per host. The platform domain and
 * every Atlas subdomain get `includeSubDomains` (Atlas owns that whole
 * tree); a customer's custom domain gets the bare directive, because
 * Atlas does not own — and must not make policy for — `mail.customer.com`
 * or any other name under the customer's apex. Same one-year max-age in
 * both cases, matching the edge.
 */
export function hstsPerHost(
  baseDomain: string | undefined,
): (
  req: { hostname?: string; headers: Record<string, unknown> },
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
) => void {
  const base = baseDomain?.toLowerCase();
  return (req, res, next) => {
    const rawHost = (req.hostname ?? String(req.headers.host ?? '')).toLowerCase();
    const host = rawHost.replace(/:\d+$/, '');
    const platform = Boolean(base) && (host === base || host.endsWith(`.${base}`));
    res.setHeader(
      'Strict-Transport-Security',
      platform
        ? `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`
        : `max-age=${HSTS_MAX_AGE_SECONDS}`,
    );
    next();
  };
}

/**
 * W14 — `Permissions-Policy` for every API response.
 *
 * Helmet does not set this header. The API answers JSON, media bytes and
 * the odd plain page (the Google callback), none of which needs a single
 * powerful browser feature, so every one is denied outright: if an API
 * response is ever rendered as a document — a sniffed upload, an error
 * page, a future HTML endpoint — it can still not open the camera, the
 * microphone, location, payments or a USB/serial/HID device.
 *
 * Deliberately NOT the policy for the documents the frontend serves: the
 * embedded Zoom meeting (Component View, rendered in the page itself)
 * needs `camera`, `microphone` and `display-capture` for `self`, and the
 * YouTube lesson embed needs `fullscreen`/`autoplay`/`encrypted-media`/
 * `picture-in-picture` delegated to its origin. That header belongs to the
 * edge configuration (the frontend repo's `Caddyfile`).
 */
export const API_PERMISSIONS_POLICY = [
  'accelerometer=()',
  'autoplay=()',
  'bluetooth=()',
  'camera=()',
  'display-capture=()',
  'encrypted-media=()',
  'fullscreen=()',
  'geolocation=()',
  'gyroscope=()',
  'hid=()',
  'idle-detection=()',
  'magnetometer=()',
  'microphone=()',
  'midi=()',
  'payment=()',
  'picture-in-picture=()',
  'publickey-credentials-get=()',
  'screen-wake-lock=()',
  'serial=()',
  'usb=()',
  'xr-spatial-tracking=()',
].join(', ');

export function permissionsPolicy(): (
  req: unknown,
  res: { setHeader: (name: string, value: string) => void },
  next: () => void,
) => void {
  return (_req, res, next) => {
    res.setHeader('Permissions-Policy', API_PERMISSIONS_POLICY);
    next();
  };
}

/**
 * Every security header the API sets, installed in one call so `main.ts`
 * and the test that asserts the headers exercise the same wiring.
 */
type Middleware = (req: never, res: never, next: never) => void;

export function installSecurityHeaders(
  app: { use(handler: Middleware): unknown },
  hstsBaseDomain: string | undefined,
  helmetFactory: (options: HelmetOptions) => Middleware,
): void {
  app.use(helmetFactory(HELMET_OPTIONS));
  // P63g — HSTS is asserted per host: `includeSubDomains` only for the
  // platform's own domain. A customer's apex domain must never have its
  // unrelated subdomains force-upgraded for a year by Atlas.
  app.use(hstsPerHost(hstsBaseDomain));
  app.use(permissionsPolicy());
}
