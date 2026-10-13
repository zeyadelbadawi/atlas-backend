import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import type { CommunicationService } from './communication.service';
import { COMMUNICATION_CATALOG } from '../catalog/communication-catalog';
import { TEMPLATES } from '../templates/template-registry';
import {
  PLATFORM_OWNER_ALERT_KEYS,
  PlatformOwnerAlertService,
} from './platform-owner-alert.service';

function build(
  options: {
    owner?: boolean;
    owners?: string[];
    emit?: jest.Mock;
  } = {},
) {
  const owners = options.owners ?? ['po-1', 'po-2'];
  const tx = {
    user: { findMany: jest.fn().mockResolvedValue(owners.map((id) => ({ id }))) },
    organization: {
      findUnique: jest.fn().mockResolvedValue({ name: 'Nile Academy Group' }),
    },
    academy: { findUnique: jest.fn().mockResolvedValue({ name: 'Nile Academy' }) },
  };
  const tenancy = {
    runInUserContext: jest.fn((_id: string, work: (t: unknown) => unknown) => work(tx)),
  };
  const emit =
    options.emit ??
    jest.fn().mockImplementation(async (_tx, input: { recipientUserId: string }) => ({
      created: true,
      outboxId: `outbox-${input.recipientUserId}`,
    }));
  const enqueueAfterCommit = jest.fn().mockResolvedValue(undefined);
  const service = new PlatformOwnerAlertService(
    tenancy as unknown as TenancyContextService,
    {
      findFirstPlatformOwnerId: jest
        .fn()
        .mockResolvedValue(options.owner === false ? null : { id: 'po-1' }),
    } as unknown as UsersRepository,
    { emit, enqueueAfterCommit } as unknown as CommunicationService,
  );
  return { service, tx, tenancy, emit, enqueueAfterCommit };
}

describe('PlatformOwnerAlertService (B0-SUP-01)', () => {
  it('emits one alert per active Platform Owner and enqueues each after its batch commits', async () => {
    const { service, tx, emit, enqueueAfterCommit } = build();
    service.notify({
      key: 'platform.subscription_payment.submitted',
      entity: { type: 'payment', id: 'pay-1' },
      organizationId: 'org-1',
      values: { proofId: 'proof-1', amount: 1190, currency: 'EGP' },
    });
    await service.drain();

    expect(tx.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { isPlatformOwner: true, status: 'active', deletedAt: null },
      }),
    );
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls.map((call) => call[1].recipientUserId)).toEqual([
      'po-1',
      'po-2',
    ]);
    expect(emit.mock.calls[0][1]).toEqual({
      key: 'platform.subscription_payment.submitted',
      recipientUserId: 'po-1',
      entity: { type: 'payment', id: 'pay-1' },
      values: {
        proofId: 'proof-1',
        amount: 1190,
        currency: 'EGP',
        organizationName: 'Nile Academy Group',
      },
    });
    expect(enqueueAfterCommit.mock.calls.map((call) => call[0])).toEqual([
      'outbox-po-1',
      'outbox-po-2',
    ]);
  });

  it('resolves the academy name only when an academy is given', async () => {
    const { service, tx, emit } = build({ owners: ['po-1'] });
    service.notify({
      key: 'platform.refund.recorded',
      entity: { type: 'course_order_refund', id: 'refund-1' },
      academyId: 'academy-1',
      values: {
        paymentId: 'pay-9',
        courseTitle: 'Arabic 101',
        amount: '500.00',
        currency: 'EGP',
      },
    });
    await service.drain();
    expect(tx.organization.findUnique).not.toHaveBeenCalled();
    expect(emit.mock.calls[0][1].values).toEqual({
      paymentId: 'pay-9',
      courseTitle: 'Arabic 101',
      amount: '500.00',
      currency: 'EGP',
      academyName: 'Nile Academy',
    });
  });

  it('returns at once and never throws when no Platform Owner exists', async () => {
    const { service, emit } = build({ owner: false });
    expect(() =>
      service.notify({
        key: 'platform.support_case.created',
        entity: { type: 'support_case', id: 'case-1' },
        organizationId: 'org-1',
      }),
    ).not.toThrow();
    await expect(service.drain()).resolves.toBeUndefined();
    expect(emit).not.toHaveBeenCalled();
  });

  it('a failing emit is logged, not thrown, and later alerts still go out', async () => {
    const emit = jest
      .fn()
      .mockRejectedValueOnce(new Error('outbox down'))
      .mockResolvedValue({ created: true, outboxId: 'outbox' });
    const { service, enqueueAfterCommit } = build({ owners: ['po-1'], emit });
    service.notify({
      key: 'platform.organization.signed_up',
      entity: { type: 'organization', id: 'org-1' },
      organizationId: 'org-1',
      values: { trialStarted: true },
    });
    service.notify({
      key: 'platform.support_case.customer_replied',
      entity: { type: 'support_case', id: 'case-1' },
      organizationId: 'org-1',
      values: { messageId: 'msg-1' },
    });
    await expect(service.drain()).resolves.toBeUndefined();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(enqueueAfterCommit).toHaveBeenCalledTimes(1);
  });

  it('gives each owner its own short transaction so the fan-out never pins pool connections', async () => {
    const owners = Array.from({ length: 45 }, (_, i) => `po-${i}`);
    const { service, tenancy, emit } = build({ owners });
    service.notify({
      key: 'platform.support_case.created',
      entity: { type: 'support_case', id: 'case-1' },
      organizationId: 'org-1',
    });
    await service.drain();
    expect(emit).toHaveBeenCalledTimes(45);
    // 1 resolve transaction + one per owner.
    expect(tenancy.runInUserContext).toHaveBeenCalledTimes(46);
  });

  describe.each(PLATFORM_OWNER_ALERT_KEYS)('%s', (key) => {
    const entry = COMMUNICATION_CATALOG[key];

    it('is a Platform Owner, in-app + email operational event with a template', () => {
      expect(entry.audience).toBe('platform');
      expect(entry.category).toBe('operational');
      expect(entry.channels).toEqual({ inApp: 'always', email: 'always' });
      expect(entry.branding).toBe('platform');
      expect(TEMPLATES[entry.template]).toBeDefined();
    });

    it('dedupes per entity (a retried emit writes nothing new)', () => {
      const context = {
        entity: { type: 'x', id: 'entity-1' },
        values: { proofId: 'p', messageId: 'm', paymentId: 'pay' },
      } as unknown as Parameters<typeof entry.dedupe>[0];
      const key1 = entry.dedupe(context);
      expect(key1).toContain('entity-1');
      expect(entry.dedupe(context)).toBe(key1);
    });

    it('links into the Platform Owner dashboard', () => {
      const url = entry.actionUrl?.({
        entity: { type: 'x', id: 'entity-1' },
        values: { paymentId: 'pay-1' },
      } as unknown as Parameters<NonNullable<typeof entry.actionUrl>>[0]);
      expect(url).toMatch(/^\/dashboard\/platform\//);
    });
  });
});
