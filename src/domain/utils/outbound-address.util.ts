/**
 * Outbound-address vetting for the HTTPS probe (P63).
 *
 * The probe connects to a hostname a CUSTOMER controls the DNS for. Node's
 * `fetch` cannot be told which address to use, so a hostname that
 * resolved publicly while Cloudflare validated it could resolve to
 * `127.0.0.1`, `10.x`, `169.254.169.254` or `::1` by the time Atlas
 * probes it (DNS rebinding), turning the probe into a port-443 oracle for
 * the internal network. The dotted-quad form also passes the hostname
 * regex outright.
 *
 * Rule: resolve every address first; if ANY resolved address is not a
 * globally routable unicast address, the hostname is not probed at all;
 * otherwise the connection is pinned to the vetted address so resolution
 * cannot happen a second time. Pure functions here; the pinning lives in
 * `HttpsProbeService`.
 */
import { isIP } from 'node:net';

function ipv4ToNumber(address: string): number | null {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255))
    return null;
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3];
}

function inCidr4(address: number, base: string, bits: number): boolean {
  const baseNumber = ipv4ToNumber(base);
  if (baseNumber === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (address & mask) >>> 0 === (baseNumber & mask) >>> 0;
}

/** Everything that is not public unicast: loopback, private, link-local (incl. cloud metadata), CGNAT, multicast, reserved, broadcast, "this" network. */
const BLOCKED_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
  ['255.255.255.255', 32],
];

export function isPublicIpv4(address: string): boolean {
  const n = ipv4ToNumber(address);
  if (n === null) return false;
  return !BLOCKED_V4.some(([base, bits]) => inCidr4(n, base, bits));
}

/** Expands an IPv6 textual address to eight 16-bit groups; `null` when malformed. */
function expandIpv6(address: string): number[] | null {
  const [head, tail] = address.split('::');
  if (address.split('::').length > 2) return null;
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const headGroups = parse(head);
  const tailGroups = tail === undefined ? [] : parse(tail);
  if ([...headGroups, ...tailGroups].some((g) => Number.isNaN(g) || g < 0 || g > 0xffff))
    return null;
  const missing = 8 - headGroups.length - tailGroups.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  return [...headGroups, ...new Array(missing).fill(0), ...tailGroups];
}

export function isPublicIpv6(address: string): boolean {
  // An IPv4-mapped or IPv4-compatible address is judged as its IPv4.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicIpv4(mapped[1]);
  const groups = expandIpv6(address.replace(/%.*$/, ''));
  if (!groups) return false;
  const [g0, g1] = groups;
  if (groups.every((g) => g === 0)) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  if ((g0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((g0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x0064 && g1 === 0xff9b) return false; // 64:ff9b::/96 NAT64 (maps v4; be conservative)
  if (g0 === 0 && groups.slice(1, 6).every((g) => g === 0) && groups[6] !== 0)
    return false; // ::a.b.c.d compatible
  return true;
}

/** `true` only for a globally routable unicast address of either family. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

/** A hostname that is really an IP literal (dotted quad, or bracketed/colon IPv6) must never be treated as a domain name. */
export function isIpLiteralHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return isIP(bare) !== 0 || /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
}
