/**
 * `ipThrottleKey` — IPv6 clients are one bucket per /64; IPv4 behaviour is
 * exactly what it was (one bucket per address).
 */
import { ipThrottleKey } from './ip-throttle-key.util';

describe('ipThrottleKey', () => {
  it('keeps every IPv4 address its own bucket', () => {
    expect(ipThrottleKey('198.51.100.7')).toBe('198.51.100.7');
    expect(ipThrottleKey('198.51.100.8')).toBe('198.51.100.8');
  });

  it('keys an IPv4-mapped IPv6 address as the IPv4 address, not the shared ::/64', () => {
    expect(ipThrottleKey('::ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(ipThrottleKey('::FFFF:c633:6407')).toBe('198.51.100.7');
    expect(ipThrottleKey('::ffff:198.51.100.8')).not.toBe(
      ipThrottleKey('::ffff:198.51.100.7'),
    );
  });

  it('collapses every address inside one IPv6 /64 to the same key', () => {
    const key = ipThrottleKey('2001:db8:1:2::1');
    expect(key).toBe('2001:db8:1:2::/64');
    for (const address of [
      '2001:db8:1:2:ffff:ffff:ffff:ffff',
      '2001:0DB8:0001:0002:a:b:c:d',
      '2001:db8:1:2:0:0:0:0',
      '2001:db8:1:2::1%eth0',
    ]) {
      expect(ipThrottleKey(address)).toBe(key);
    }
  });

  it('keeps different /64 prefixes apart', () => {
    expect(ipThrottleKey('2001:db8:1:3::1')).not.toBe(ipThrottleKey('2001:db8:1:2::1'));
    expect(ipThrottleKey('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipThrottleKey('::1')).toBe('0:0:0:0::/64');
  });

  it('returns anything that is not an IP unchanged', () => {
    expect(ipThrottleKey('unknown')).toBe('unknown');
    expect(ipThrottleKey('not:an:ip')).toBe('not:an:ip');
  });
});
