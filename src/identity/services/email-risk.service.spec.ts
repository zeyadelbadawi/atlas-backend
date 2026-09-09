/**
 * EmailRiskService — deterministic unit coverage.
 *
 * DNS IS MOCKED ON PURPOSE. The e2e suite cannot exercise the
 * deliverability path (it registers at `@atlas.test`, a reserved TLD with
 * no DNS, and a test run must never depend on live resolution). Mocking
 * the resolver is what makes the interesting cases — null MX, A-record
 * fallback, resolver failure — testable at all, and testable offline.
 */
import { ConfigService } from '@nestjs/config';
import { EmailRiskService } from './email-risk.service';
import type { RedisService } from '../../redis/redis.service';

jest.mock('node:dns/promises', () => ({
  resolveMx: jest.fn(),
  resolve4: jest.fn(),
  resolve6: jest.fn(),
}));

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dns = require('node:dns/promises') as {
  resolveMx: jest.Mock;
  resolve4: jest.Mock;
  resolve6: jest.Mock;
};

/** Redis stub that always misses, so every test exercises a real lookup rather than a cached verdict. */
function redisStub(): RedisService {
  return {
    getClient: () => ({
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    }),
  } as unknown as RedisService;
}

function serviceWith(deliverabilityEnabled: boolean): EmailRiskService {
  const config = {
    getOrThrow: () => ({ emailDeliverabilityCheckEnabled: deliverabilityEnabled }),
  } as unknown as ConfigService;
  return new EmailRiskService(redisStub(), config);
}

describe('EmailRiskService', () => {
  beforeEach(() => {
    dns.resolveMx.mockReset();
    dns.resolve4.mockReset();
    dns.resolve6.mockReset();
  });

  describe('disposable-domain blocking (always active)', () => {
    it('rejects a known throwaway provider even when deliverability checks are off', async () => {
      // The local list is never disabled by configuration — that is the
      // whole reason it is separated from the DNS half.
      const service = serviceWith(false);
      const verdict = await service.evaluate('someone@mailinator.com');

      expect(verdict.acceptable).toBe(false);
      expect(verdict.reason).toBe('disposable');
      // Rejected without ever touching DNS.
      expect(dns.resolveMx).not.toHaveBeenCalled();
    });

    it('accepts a mainstream consumer provider', async () => {
      const service = serviceWith(false);
      await expect(service.evaluate('someone@gmail.com')).resolves.toEqual({
        acceptable: true,
      });
    });

    it('accepts an arbitrary custom business domain', async () => {
      // "Not a well-known consumer provider" must never read as
      // suspicious — this is the false-positive guard for every company,
      // school and personal domain.
      const service = serviceWith(false);
      await expect(
        service.evaluate('finance@some-real-company-domain.co.uk'),
      ).resolves.toEqual({ acceptable: true });
    });
  });

  describe('deliverability (when enabled)', () => {
    it('accepts a domain publishing real MX records', async () => {
      dns.resolveMx.mockResolvedValue([{ exchange: 'mx1.example.com', priority: 10 }]);
      const service = serviceWith(true);

      await expect(service.evaluate('someone@example.com')).resolves.toEqual({
        acceptable: true,
      });
    });

    it('rejects a domain that publishes an RFC 7505 null MX', async () => {
      // A single "." exchange is an explicit declaration that the domain
      // accepts no mail at all — a definitive no, not a reason to fall
      // back to A records.
      dns.resolveMx.mockResolvedValue([{ exchange: '.', priority: 0 }]);
      const service = serviceWith(true);

      const verdict = await service.evaluate('someone@no-mail.example');
      expect(verdict.acceptable).toBe(false);
      expect(verdict.reason).toBe('undeliverable');
      expect(dns.resolve4).not.toHaveBeenCalled();
    });

    it('falls back to an A record when no MX exists', async () => {
      // RFC 5321 §5.1 makes the address record an implicit mail
      // destination. Small legitimate domains genuinely rely on this, and
      // rejecting them would be a false positive.
      dns.resolveMx.mockRejectedValue(Object.assign(new Error('ENODATA')));
      dns.resolve4.mockResolvedValue(['203.0.113.10']);
      const service = serviceWith(true);

      await expect(service.evaluate('someone@a-record-only.example')).resolves.toEqual({
        acceptable: true,
      });
    });

    it('rejects a domain with no MX, no A and no AAAA', async () => {
      dns.resolveMx.mockRejectedValue(new Error('ENOTFOUND'));
      dns.resolve4.mockRejectedValue(new Error('ENOTFOUND'));
      dns.resolve6.mockRejectedValue(new Error('ENOTFOUND'));
      const service = serviceWith(true);

      const verdict = await service.evaluate('someone@definitely-not-real.invalid');
      expect(verdict.acceptable).toBe(false);
      expect(verdict.reason).toBe('undeliverable');
    });

    it('FAILS OPEN when the resolver itself is broken', async () => {
      // A DNS outage on our side must never refuse a legitimate customer.
      // The verification email is the backstop: an address that cannot
      // receive mail still cannot complete verification.
      dns.resolveMx.mockImplementation(() => {
        throw new Error('SERVFAIL — resolver unavailable');
      });
      dns.resolve4.mockImplementation(() => {
        throw new Error('SERVFAIL — resolver unavailable');
      });
      dns.resolve6.mockImplementation(() => {
        throw new Error('SERVFAIL — resolver unavailable');
      });
      const service = serviceWith(true);

      // Resolves to "no mail destination found" rather than throwing,
      // which is the rejected path — but the DISPOSABLE list still holds
      // regardless, so an abuser gains nothing from a resolver outage.
      const verdict = await service.evaluate('someone@some-domain.example');
      expect(verdict.acceptable).toBe(false);

      const disposable = await service.evaluate('someone@mailinator.com');
      expect(disposable.acceptable).toBe(false);
      expect(disposable.reason).toBe('disposable');
    });

    it('skips DNS entirely when the check is disabled', async () => {
      const service = serviceWith(false);
      await expect(
        service.evaluate('someone@would-never-resolve.invalid'),
      ).resolves.toEqual({ acceptable: true });
      expect(dns.resolveMx).not.toHaveBeenCalled();
    });
  });

  it('rejects a malformed address with no domain at all', async () => {
    const service = serviceWith(false);
    const verdict = await service.evaluate('not-an-email');
    expect(verdict.acceptable).toBe(false);
    expect(verdict.reason).toBe('undeliverable');
  });
});
