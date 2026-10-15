/**
 * The throttle identity of a client address.
 *
 * A single IPv6 subscriber is normally handed a whole /64 (and often far
 * more), so keying a limiter on the full IPv6 address lets one client
 * rotate through 2^64 addresses and never meet the limit (security review
 * L2, the contact forms). An IPv6 address is therefore keyed on its /64
 * prefix. IPv4 is unchanged: one address, one bucket. IPv4-mapped IPv6
 * (`::ffff:203.0.113.7`, what a dual-stack socket reports for an IPv4
 * peer) is keyed as the IPv4 address it carries, never as the shared
 * `::/64` every mapped address would otherwise fall into.
 *
 * Anything that is not a valid IP is returned as-is, so the caller's
 * existing fallback behaviour (an `'unknown'` bucket) is unchanged.
 */
import { isIP } from 'node:net';

export function ipThrottleKey(address: string): string {
  const ip = address.trim().toLowerCase().split('%')[0];
  if (isIP(ip) === 4) return ip;
  if (isIP(ip) !== 6) return address;

  const hextets = expandIpv6(ip);
  const mappedV4 = hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff;
  if (mappedV4) {
    return [hextets[6] >> 8, hextets[6] & 0xff, hextets[7] >> 8, hextets[7] & 0xff].join(
      '.',
    );
  }
  return `${hextets
    .slice(0, 4)
    .map((h) => h.toString(16))
    .join(':')}::/64`;
}

/** Eight 16-bit groups of a valid IPv6 address (`::` and a dotted IPv4 tail expanded). */
function expandIpv6(ip: string): number[] {
  const toGroups = (part: string): number[] => {
    if (!part) return [];
    const groups: number[] = [];
    for (const piece of part.split(':')) {
      if (piece.includes('.')) {
        const [a, b, c, d] = piece.split('.').map(Number);
        groups.push((a << 8) | b, (c << 8) | d);
      } else {
        groups.push(parseInt(piece, 16));
      }
    }
    return groups;
  };
  const [head, tail] = ip.split('::');
  const headGroups = toGroups(head);
  if (tail === undefined) return headGroups;
  const tailGroups = toGroups(tail);
  const zeros = new Array<number>(8 - headGroups.length - tailGroups.length).fill(0);
  return [...headGroups, ...zeros, ...tailGroups];
}
