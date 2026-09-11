/**
 * Request-metadata helpers for session/device records (Phase 10).
 *
 * TRUST MODEL — why reading these headers is safe here, and would not be
 * in a directly-exposed service.
 *
 * The backend container publishes no host port at all (see
 * `deploy/docker-compose.prod.yml`: only Caddy binds 80/443), so the only
 * path to it is Caddy on the compose network, and the only path to Caddy
 * in production is Cloudflare. Every hop in that chain either sets or
 * appends the headers below, and a client cannot reach the origin to forge
 * them. Express is additionally configured (`main.ts`) to trust only
 * loopback/link-local/unique-local peers, so `request.ip` itself already
 * resolves through the proxy chain rather than reporting Caddy's address.
 *
 * Nothing here reads a request BODY or any client-controlled field — the
 * roadmap's "do not trust client-supplied arbitrary values" rule. A
 * spoofed header on a request that somehow bypassed the proxy would at
 * worst mislabel the attacker's OWN session row; it grants no access,
 * because authorization never consults these values.
 */
import type { Request } from 'express';

/** Bounded so a hostile or malformed header can never write an unbounded row. */
const MAX_IP_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

function firstHeaderValue(request: Request, name: string): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The real client IP, resolved through the production proxy chain in
 * order of decreasing authority:
 *
 *   1. `CF-Connecting-IP` — set by Cloudflare and always the true end
 *      user. Preferred because Caddy's own `X-Real-IP {remote_host}`
 *      (see the production Caddyfile) records CLOUDFLARE's edge address,
 *      not the visitor's, so trusting `X-Real-IP` first would label every
 *      session with a Cloudflare datacentre IP.
 *   2. The leftmost `X-Forwarded-For` entry — the original client as the
 *      first proxy recorded it.
 *   3. `X-Real-IP` — correct for a deployment without Cloudflare in front.
 *   4. `request.ip` — the direct socket peer; correct in local
 *      development, where there is no proxy at all.
 *
 * Returns `undefined` rather than a placeholder when nothing resolves, so
 * the session list can say "unknown" honestly instead of showing a made-up
 * address.
 */
export function resolveClientIp(request: Request): string | undefined {
  const cloudflare = firstHeaderValue(request, 'cf-connecting-ip');
  if (cloudflare) return cloudflare.slice(0, MAX_IP_LENGTH);

  const forwardedFor = firstHeaderValue(request, 'x-forwarded-for');
  if (forwardedFor) {
    const [leftmost] = forwardedFor.split(',');
    if (leftmost?.trim()) return leftmost.trim().slice(0, MAX_IP_LENGTH);
  }

  const realIp = firstHeaderValue(request, 'x-real-ip');
  if (realIp) return realIp.slice(0, MAX_IP_LENGTH);

  return request.ip ? request.ip.slice(0, MAX_IP_LENGTH) : undefined;
}

/** The raw `User-Agent`, stored verbatim and parsed only for display. `undefined` when absent — never a fabricated default. */
export function resolveUserAgent(request: Request): string | undefined {
  return firstHeaderValue(request, 'user-agent')?.slice(0, MAX_USER_AGENT_LENGTH);
}

/**
 * A short, human-readable device label derived from the User-Agent, for
 * the session list ("Chrome on macOS"). Deliberately coarse: this is a
 * recognition aid so a user can spot an unfamiliar session, not device
 * fingerprinting, and it is derived on the SERVER from the real header
 * rather than accepted from the client.
 *
 * Returns `undefined` when the agent is absent or unrecognised, so the UI
 * falls back to showing the raw agent or an explicit "unknown device"
 * rather than a confidently wrong label.
 */
export function deriveDeviceLabel(userAgent: string | undefined): string | undefined {
  if (!userAgent) return undefined;

  // Order matters: Edge and Opera both also contain "Chrome", and Chrome
  // contains "Safari", so the more specific brand has to win first.
  const browser = /\bEdg[e]?\//i.test(userAgent)
    ? 'Edge'
    : /\bOPR\/|\bOpera\//i.test(userAgent)
      ? 'Opera'
      : /\bChrome\//i.test(userAgent)
        ? 'Chrome'
        : /\bFirefox\//i.test(userAgent)
          ? 'Firefox'
          : /\bSafari\//i.test(userAgent)
            ? 'Safari'
            : undefined;

  const platform = /\bWindows NT\b/i.test(userAgent)
    ? 'Windows'
    : /\b(iPhone|iPad|iPod)\b/i.test(userAgent)
      ? 'iOS'
      : /\bAndroid\b/i.test(userAgent)
        ? 'Android'
        : /\bMac OS X\b/i.test(userAgent)
          ? 'macOS'
          : /\bLinux\b/i.test(userAgent)
            ? 'Linux'
            : undefined;

  if (browser && platform) return `${browser} on ${platform}`;
  return browser ?? platform;
}

/**
 * Cloudflare's non-country sentinel values for `CF-IPCountry`.
 *
 * `XX` means Cloudflare could not determine a country; `T1` means the
 * request arrived over Tor. Neither is a place, and storing either would
 * make the UI display a country code that is not one.
 */
const CLOUDFLARE_NON_COUNTRY_CODES = new Set(['XX', 'T1']);

/**
 * The visitor's country, as reported by Cloudflare's edge.
 *
 * WHY THIS IS TRUSTWORTHY AND AN IP LOOKUP WOULD NOT BE. Cloudflare
 * resolves the country at the edge that actually terminated the
 * connection, and the header reaches this service over the same
 * unreachable-from-outside path as `CF-Connecting-IP` (see this file's
 * trust-model note). It is the same signal Cloudflare uses for its own
 * country-based firewall rules.
 *
 * WHY COUNTRY AND NOT CITY. There is no city-level source available:
 * `CF-IPCity` is Enterprise-only, and commercial IP-to-city databases are
 * estimates that are frequently wrong by hundreds of kilometres on mobile
 * networks. Showing a confidently wrong city on a security screen is
 * worse than showing none, because it makes a legitimate session look
 * foreign — or a hostile one look local.
 *
 * Returns `undefined` rather than a placeholder when absent, so the
 * session list can say "Location unavailable" honestly.
 */
export function resolveClientCountry(request: Request): string | undefined {
  const raw = firstHeaderValue(request, 'cf-ipcountry');
  if (!raw) return undefined;

  const code = raw.toUpperCase();
  // Exactly two letters: anything else is not an ISO 3166-1 alpha-2 code,
  // and is discarded rather than stored and rendered.
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  if (CLOUDFLARE_NON_COUNTRY_CODES.has(code)) return undefined;

  return code;
}
