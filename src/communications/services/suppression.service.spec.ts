/** SuppressionService — hashing, canonicalisation, expiry defaults; Prisma/tenancy stubbed. */
import { SuppressionService, defaultExpiry, hashEmail } from './suppression.service';
import type { PrismaService } from '../../database/prisma.service';
import type { IdentityResolver } from '../../identity/repositories/identity-resolver';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { createHash } from 'node:crypto';

function harness(ownerId: string | null, row: { expiresAt: Date | null } | null) {
  const findUnique = jest.fn().mockResolvedValue(row);
  const upsert = jest.fn().mockResolvedValue({});
  const create = jest.fn().mockResolvedValue({});
  const tx = { communicationSuppression: { findUnique, upsert } };
  const prisma = {
    communicationSuppression: { create },
  } as unknown as PrismaService;
  const resolver = {
    platformOwnerId: jest.fn().mockResolvedValue(ownerId),
  } as unknown as IdentityResolver;
  const runInUserContext = jest.fn(
    async (_id: string, work: (t: typeof tx) => Promise<unknown>) => work(tx),
  );
  const tenancy = { runInUserContext } as unknown as TenancyContextService;
  return {
    service: new SuppressionService(prisma, tenancy, resolver),
    findUnique,
    upsert,
    create,
    runInUserContext,
  };
}

describe('SuppressionService', () => {
  it('hashes the canonical (trimmed, lower-cased) address with SHA-256', () => {
    const expected = createHash('sha256').update('person@example.com').digest('hex');
    expect(hashEmail('  Person@Example.COM ')).toBe(expected);
    expect(hashEmail('person@example.com')).toBe(expected);
    expect(hashEmail('other@example.com')).not.toBe(expected);
  });

  it('defaults hard bounce/complaint/invalid/manual to permanent and soft bounce to 30 days', () => {
    const now = new Date('2026-09-24T00:00:00Z');
    expect(defaultExpiry('hard_bounce', now)).toBeNull();
    expect(defaultExpiry('complaint', now)).toBeNull();
    expect(defaultExpiry('invalid', now)).toBeNull();
    expect(defaultExpiry('manual', now)).toBeNull();
    expect(defaultExpiry('soft_bounce', now)).toEqual(new Date('2026-10-24T00:00:00Z'));
  });

  it('isSuppressed looks the hash up in the platform owner context and honours expiry', async () => {
    const now = new Date('2026-09-24T00:00:00Z');
    const permanent = harness('owner-1', { expiresAt: null });
    expect(await permanent.service.isSuppressed('Person@Example.com', now)).toBe(true);
    expect(permanent.runInUserContext).toHaveBeenCalledWith(
      'owner-1',
      expect.any(Function),
    );
    expect(permanent.findUnique).toHaveBeenCalledWith({
      where: { emailHash: hashEmail('person@example.com') },
      select: { expiresAt: true },
    });

    const expired = harness('owner-1', { expiresAt: new Date('2026-09-01T00:00:00Z') });
    expect(await expired.service.isSuppressed('person@example.com', now)).toBe(false);

    const missing = harness('owner-1', null);
    expect(await missing.service.isSuppressed('person@example.com', now)).toBe(false);
  });

  it('isSuppressed answers false (and never queries the table) with no platform owner', async () => {
    const h = harness(null, { expiresAt: null });
    expect(await h.service.isSuppressed('person@example.com')).toBe(false);
    expect(h.runInUserContext).not.toHaveBeenCalled();
  });

  it('suppress upserts by hash with the domain, never the address, and never shortens a permanent block', async () => {
    const h = harness('owner-1', null);
    await h.service.suppress({
      email: 'Person@Example.com',
      reason: 'soft_bounce',
      source: 'webhook:brevo',
      note: 'mailbox full',
    });
    const call = h.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ emailHash: hashEmail('person@example.com') });
    expect(call.create.emailDomain).toBe('example.com');
    expect(call.create.expiresAt).toBeInstanceOf(Date);
    expect(call.update.expiresAt).toBeUndefined();
    expect(JSON.stringify(call)).not.toContain('person@');

    await h.service.suppress({
      email: 'person@example.com',
      reason: 'complaint',
      source: 'webhook:resend',
    });
    expect(h.upsert.mock.calls[1][0].update.expiresAt).toBeNull();
  });

  it('suppress falls back to a plain insert with no platform owner (RLS allows insert only)', async () => {
    const h = harness(null, null);
    await h.service.suppress({
      email: 'a@example.com',
      reason: 'hard_bounce',
      source: 'webhook:brevo',
    });
    expect(h.create).toHaveBeenCalledTimes(1);
    expect(h.upsert).not.toHaveBeenCalled();
  });
});
