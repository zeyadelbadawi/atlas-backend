/**
 * TrialEligibilityService — W8B keyed-hash (v2) migration with v1 dual-read.
 */
import { ConfigService } from '@nestjs/config';
import { CustomerIdentityHasher } from './customer-identity-hasher.service';
import { TrialEligibilityService } from './trial-eligibility.service';
import { customerSubjectHashV2, legacySubjectHashV1 } from '../utils/trial-subject.util';
import { deriveCustomerIdentityKey } from '../utils/customer-identity-key.util';

const PAYMENT_KEY = 'b'.repeat(64);
const EMAIL = 'First.Last+promo@gmail.com';

function makeService(): TrialEligibilityService {
  const config = {
    getOrThrow: () => ({ credentialEncryptionKeyHex: PAYMENT_KEY }),
  } as unknown as ConfigService;
  return new TrialEligibilityService(new CustomerIdentityHasher(config));
}

function makeTx(legacyRow: unknown, insertedCount = 1, describeRow: unknown = null) {
  return {
    trialRedemption: {
      findUnique: jest.fn().mockResolvedValue(legacyRow),
      findFirst: jest.fn().mockResolvedValue(describeRow),
      createMany: jest.fn().mockResolvedValue({ count: insertedCount }),
    },
  };
}

const claimInput = {
  email: EMAIL,
  organizationId: 'org-1',
  userId: 'user-1',
  trialEndsAt: new Date('2026-11-07T00:00:00.000Z'),
  context: { ipAddress: '203.0.113.9', userAgent: 'UA' },
};

describe('TrialEligibilityService (W8B v2 hashes)', () => {
  const key = deriveCustomerIdentityKey({ paymentCredentialsKeyHex: PAYMENT_KEY });
  const v2 = customerSubjectHashV2(EMAIL, key);
  const v1 = legacySubjectHashV1(EMAIL);

  it('v2 is a keyed HMAC: different from v1 and from a v2 under another key', () => {
    expect(v2).not.toBe(v1);
    const otherKey = deriveCustomerIdentityKey({
      paymentCredentialsKeyHex: 'c'.repeat(64),
    });
    expect(customerSubjectHashV2(EMAIL, otherKey)).not.toBe(v2);
    // Alias collapsing is preserved under v2.
    expect(customerSubjectHashV2('firstlast@gmail.com', key)).toBe(v2);
  });

  it('a dedicated CUSTOMER_IDENTITY_HMAC_KEY takes precedence over the derived key', () => {
    const dedicated = 'd'.repeat(64);
    expect(
      deriveCustomerIdentityKey({
        dedicatedKeyHex: dedicated,
        paymentCredentialsKeyHex: PAYMENT_KEY,
      }).toString('hex'),
    ).toBe(dedicated);
    expect(() =>
      deriveCustomerIdentityKey({
        dedicatedKeyHex: 'zz',
        paymentCredentialsKeyHex: PAYMENT_KEY,
      }),
    ).toThrow();
  });

  it('a fresh subject is granted and the row stores the v2 hash, labelled 2', async () => {
    const tx = makeTx(null, 1);
    const result = await makeService().claimTrial(tx as never, claimInput);
    expect(result).toEqual({ granted: true });
    expect(tx.trialRedemption.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subjectHash: v1 } }),
    );
    const row = tx.trialRedemption.createMany.mock.calls[0][0].data[0];
    expect(row).toMatchObject({ subjectHash: v2, hashVersion: 2, source: 'claim' });
  });

  it('a subject holding only a LEGACY v1 row is refused, and a v2 copy is written', async () => {
    const legacy = {
      organizationId: 'old-org',
      redeemedByUserId: null,
      redeemedAt: new Date('2026-01-01T00:00:00.000Z'),
      trialEndsAt: new Date('2026-01-04T00:00:00.000Z'),
    };
    const tx = makeTx(legacy, 1);
    const result = await makeService().claimTrial(tx as never, claimInput);
    expect(result).toEqual({ granted: false, reason: 'already_redeemed' });
    const copy = tx.trialRedemption.createMany.mock.calls[0][0];
    expect(copy.skipDuplicates).toBe(true);
    expect(copy.data[0]).toMatchObject({
      subjectHash: v2,
      hashVersion: 2,
      source: 'v1_upgrade',
      organizationId: 'old-org',
      redeemedAt: legacy.redeemedAt,
    });
    // The copy carries no forensic data from THIS request.
    expect(copy.data[0].ipAddress).toBeUndefined();
  });

  it('a v2 conflict (already redeemed, or lost the race) is refused', async () => {
    const tx = makeTx(null, 0);
    expect(await makeService().claimTrial(tx as never, claimInput)).toEqual({
      granted: false,
      reason: 'already_redeemed',
    });
  });

  it('describeEligibility checks BOTH digests', async () => {
    const tx = makeTx(null, 1, { id: 'legacy' });
    expect(await makeService().describeEligibility(tx as never, EMAIL)).toEqual({
      eligible: false,
    });
    expect(tx.trialRedemption.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { subjectHash: { in: [v2, v1] } } }),
    );
  });

  it('never logs the email or a digest of it', async () => {
    const service = makeService();
    const logSpy = jest
      .spyOn((service as unknown as { logger: { log: () => void } }).logger, 'log')
      .mockImplementation(() => undefined);
    await service.claimTrial(makeTx(null, 0) as never, claimInput);
    await service.claimTrial(makeTx({ redeemedAt: new Date() }, 1) as never, claimInput);
    const logged = JSON.stringify(logSpy.mock.calls);
    expect(logged).not.toContain('gmail');
    expect(logged).not.toContain(v2);
    expect(logged).not.toContain(v1);
  });
});
