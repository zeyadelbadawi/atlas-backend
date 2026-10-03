import type { ConfigService } from '@nestjs/config';
import type { RedisService } from '../../redis/redis.service';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import type { CommunicationService } from '../../communications/services/communication.service';
import type { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import type { SubmitPlatformContactDto } from '../dto/submit-platform-contact.dto';
import { PlatformContactIntakeService } from './platform-contact-intake.service';

const NOW = new Date('2026-10-03T12:00:00.000Z');

function payload(
  overrides: Partial<SubmitPlatformContactDto> = {},
): SubmitPlatformContactDto {
  return {
    name: 'Layla',
    email: 'layla@example.com',
    topic: 'sales',
    message: 'We would like a demo of Atlas.',
    startedAt: NOW.getTime() - 30_000,
    ...overrides,
  } as SubmitPlatformContactDto;
}

function build(
  options: { redisSet?: jest.Mock; insert?: jest.Mock; owner?: boolean } = {},
) {
  const redisSet = options.redisSet ?? jest.fn().mockResolvedValue('OK');
  const redisDel = jest.fn().mockResolvedValue(1);
  const insert = options.insert ?? jest.fn().mockResolvedValue('new-id');
  const tx = {
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'po-1' }, { id: 'po-2' }]) },
  };
  const tenancy = {
    runWithoutContext: jest.fn((work: (t: unknown) => unknown) => work(tx)),
    runInUserContext: jest.fn((_id: string, work: (t: unknown) => unknown) => work(tx)),
  };
  const emit = jest.fn().mockResolvedValue({ created: true, outboxId: 'outbox' });
  const enqueueAfterCommit = jest.fn().mockResolvedValue(undefined);
  const service = new PlatformContactIntakeService(
    tenancy as unknown as TenancyContextService,
    { insertAnonymous: insert } as unknown as PlatformContactSubmissionsRepository,
    {
      getClient: () => ({ set: redisSet, del: redisDel }),
    } as unknown as RedisService,
    {
      findFirstPlatformOwnerId: jest
        .fn()
        .mockResolvedValue(options.owner === false ? null : { id: 'po-1' }),
    } as unknown as UsersRepository,
    { emit, enqueueAfterCommit } as unknown as CommunicationService,
    {
      getOrThrow: () => ({ jwtAccessSecret: 'test-secret-value' }),
    } as unknown as ConfigService,
  );
  return { service, insert, redisSet, redisDel, emit, enqueueAfterCommit, tenancy };
}

describe('PlatformContactIntakeService', () => {
  it('stores a valid enquiry and notifies every active platform owner after commit', async () => {
    const { service, insert, emit, enqueueAfterCommit } = build();
    await expect(service.submit(payload(), { ip: '203.0.113.9' }, NOW)).resolves.toEqual({
      received: true,
    });
    expect(insert).toHaveBeenCalledTimes(1);
    const row = insert.mock.calls[0][1];
    expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('203.0.113.9');
    // The fan-out runs after the answer; drain it before asserting.
    await service.drainNotifications();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit.mock.calls[0][1]).toMatchObject({
      key: 'platform.contact_submission.received',
      recipientUserId: 'po-1',
      entity: { type: 'platform_contact_submission', id: 'new-id' },
    });
    expect(enqueueAfterCommit).toHaveBeenCalledTimes(2);
  });

  it('discards a honeypot hit with the ordinary answer and stores nothing', async () => {
    const { service, insert, redisSet } = build();
    await expect(
      service.submit(payload({ company: 'Acme Bots' }), {}, NOW),
    ).resolves.toEqual({ received: true });
    expect(insert).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('discards a submission sent faster than a person could type', async () => {
    const { service, insert } = build();
    await service.submit(payload({ startedAt: NOW.getTime() - 500 }), {}, NOW);
    expect(insert).not.toHaveBeenCalled();
  });

  it('accepts a startedAt slightly in the future (visitor clock ahead)', () => {
    const { service } = build();
    expect(
      service.screen(payload({ startedAt: NOW.getTime() + 60_000 }), NOW),
    ).toBeNull();
  });

  it('suppresses an identical address + message inside the window', async () => {
    const { service, insert } = build({ redisSet: jest.fn().mockResolvedValue(null) });
    await expect(service.submit(payload(), {}, NOW)).resolves.toEqual({ received: true });
    expect(insert).not.toHaveBeenCalled();
  });

  it('stores anyway when Redis is unavailable (dedupe fails open)', async () => {
    const { service, insert } = build({
      redisSet: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
    });
    await service.submit(payload(), {}, NOW);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('releases the dedupe claim when the insert fails, and surfaces the error', async () => {
    const { service, redisDel } = build({
      insert: jest.fn().mockRejectedValue(new Error('db down')),
    });
    await expect(service.submit(payload(), {}, NOW)).rejects.toThrow('db down');
    expect(redisDel).toHaveBeenCalledTimes(1);
  });

  it('keeps the stored enquiry when notifying fails', async () => {
    const { service, emit, insert } = build();
    emit.mockRejectedValueOnce(new Error('outbox unavailable'));
    await expect(service.submit(payload(), {}, NOW)).resolves.toEqual({ received: true });
    await expect(service.drainNotifications()).resolves.toBeUndefined();
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it('answers before the owner fan-out has finished', async () => {
    const { service, emit } = build();
    let release: () => void = () => undefined;
    emit.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ created: true, outboxId: 'late' });
        }),
    );
    await expect(service.submit(payload(), {}, NOW)).resolves.toEqual({ received: true });
    while (emit.mock.calls.length === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    release();
    await service.drainNotifications();
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('stores without notifying when no platform owner exists', async () => {
    const { service, emit, insert } = build({ owner: false });
    await service.submit(payload(), {}, NOW);
    await service.drainNotifications();
    expect(insert).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it('hashes the same address to the same value and never returns it raw', () => {
    const { service } = build();
    expect(service.hashIp('198.51.100.1')).toBe(service.hashIp('198.51.100.1'));
    expect(service.hashIp('198.51.100.1')).not.toBe(service.hashIp('198.51.100.2'));
    expect(service.hashIp('198.51.100.1')).not.toContain('198.51');
  });
});
