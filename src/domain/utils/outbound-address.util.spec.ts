import {
  isIpLiteralHostname,
  isPublicAddress,
  isPublicIpv4,
  isPublicIpv6,
} from './outbound-address.util';

describe('outbound-address.util (P63 SSRF discipline)', () => {
  it('rejects every non-public IPv4 range a customer DNS could point at', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '10.0.0.5',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '192.0.2.10',
      '198.18.0.1',
    ]) {
      expect(isPublicIpv4(address)).toBe(false);
    }
  });

  it('accepts public IPv4', () => {
    for (const address of [
      '104.21.42.225',
      '172.67.167.34',
      '8.8.8.8',
      '172.32.0.1',
      '11.0.0.1',
    ]) {
      expect(isPublicIpv4(address)).toBe(true);
    }
  });

  it('rejects loopback, ULA, link-local, multicast, v4-mapped-private and documentation IPv6', () => {
    for (const address of [
      '::1',
      '::',
      'fc00::1',
      'fd12:3456::1',
      'fe80::1',
      'fe80::1%eth0',
      'ff02::1',
      '::ffff:127.0.0.1',
      '::ffff:10.0.0.1',
      '2001:db8::1',
      '64:ff9b::a00:1',
    ]) {
      expect(isPublicIpv6(address)).toBe(false);
    }
  });

  it('accepts public IPv6 and v4-mapped public', () => {
    expect(isPublicIpv6('2606:4700::6810:2ae1')).toBe(true);
    expect(isPublicIpv6('::ffff:104.21.42.225')).toBe(true);
  });

  it('isPublicAddress dispatches by family and rejects garbage', () => {
    expect(isPublicAddress('8.8.8.8')).toBe(true);
    expect(isPublicAddress('::1')).toBe(false);
    expect(isPublicAddress('not-an-ip')).toBe(false);
  });

  it('treats dotted quads and IPv6 literals as IP literals, not hostnames', () => {
    expect(isIpLiteralHostname('127.0.0.1')).toBe(true);
    expect(isIpLiteralHostname('169.254.169.254')).toBe(true);
    expect(isIpLiteralHostname('[::1]')).toBe(true);
    expect(isIpLiteralHostname('::1')).toBe(true);
    expect(isIpLiteralHostname('www.example.com')).toBe(false);
    expect(isIpLiteralHostname('1e100.net')).toBe(false);
  });
});
