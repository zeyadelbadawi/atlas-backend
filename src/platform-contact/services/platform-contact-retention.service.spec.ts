import type { ConfigService } from '@nestjs/config';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import type { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { CommunicationService } from '../../communications/services/communication.service';
import type { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import type { LeadCaptureConfig } from '../../config/configuration';
import {
  PlatformContactRetentionService,
  retentionCutoff,
} from './platform-contact-retention.service';

describe('PlatformContactRetentionService (B0-SUP-04)', () => {
  const NOW = new Date('2026-10-15T10:00:00.000Z');

  function build(
    overrides: Partial<LeadCaptureConfig> = {},
    options: { ids?: string[]; eligible?: number; owner?: boolean } = {},
  ) {
    const config: LeadCaptureConfig = {
      contactConsentMode: 'off',
      signupWhatsappConsentMode: 'off',
      attributionCaptureMode: 'off',
      contactRetentionMode: 'dry_run',
      contactRetentionMonths: 24,
      ...overrides,
    };
    const tx = { marker: 'owner-tx' };
    const order: string[] = [];
    const repository = {
      countCreatedBefore: jest.fn().mockResolvedValue(options.eligible ?? 3),
      findIdsCreatedBefore: jest.fn().mockResolvedValue(options.ids ?? ['a', 'b']),
      deleteMany: jest.fn(async (_tx: unknown, ids: string[]) => {
        order.push('delete');
        return ids.length;
      }),
    };
    const forgetEntity = jest.fn(async () => {
      order.push('forget');
      return 1;
    });
    const write = jest.fn(async () => {
      order.push('audit');
    });
    const runInUserContext = jest.fn((_id: string, work: (t: unknown) => unknown) =>
      work(tx),
    );
    const findFirstPlatformOwnerId = jest
      .fn()
      .mockResolvedValue(options.owner === false ? null : { id: 'po-1' });
    const service = new PlatformContactRetentionService(
      { runInUserContext } as unknown as TenancyContextService,
      { findFirstPlatformOwnerId } as unknown as UsersRepository,
      repository as unknown as PlatformContactSubmissionsRepository,
      { forgetEntity } as unknown as CommunicationService,
      { write } as unknown as AuditLogWriterService,
      { getOrThrow: () => config } as unknown as ConfigService,
    );
    return { service, repository, forgetEntity, write, runInUserContext, order, tx };
  }

  it('computes the cutoff in whole calendar months, clamped to the month end', () => {
    expect(retentionCutoff(NOW, 24).toISOString()).toBe('2024-10-15T10:00:00.000Z');
    expect(retentionCutoff(new Date('2026-03-31T00:00:00.000Z'), 1).toISOString()).toBe(
      '2026-02-28T00:00:00.000Z',
    );
  });

  it('does nothing at all while the mode is off', async () => {
    const { service, repository, runInUserContext } = build({
      contactRetentionMode: 'off',
    });
    await expect(service.run(NOW)).resolves.toMatchObject({ eligible: 0, deleted: 0 });
    expect(runInUserContext).not.toHaveBeenCalled();
    expect(repository.countCreatedBefore).not.toHaveBeenCalled();
  });

  it('only counts in dry_run (the default) and deletes nothing', async () => {
    const { service, repository, forgetEntity, write } = build({}, { eligible: 7 });
    const result = await service.run(NOW);
    expect(result).toEqual({
      mode: 'dry_run',
      retentionMonths: 24,
      cutoff: '2024-10-15T10:00:00.000Z',
      eligible: 7,
      deleted: 0,
    });
    expect(repository.countCreatedBefore.mock.calls[0][1]).toEqual(
      new Date('2024-10-15T10:00:00.000Z'),
    );
    expect(repository.deleteMany).not.toHaveBeenCalled();
    expect(forgetEntity).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('in on: deletes the aged batch, blanks its notification copies and audits once, in one owner transaction', async () => {
    const { service, repository, forgetEntity, write, runInUserContext, order, tx } =
      build(
        { contactRetentionMode: 'on', contactRetentionMonths: 12 },
        { ids: ['old-1', 'old-2'] },
      );
    const result = await service.run(NOW);
    expect(result).toMatchObject({
      mode: 'on',
      eligible: 2,
      deleted: 2,
      retentionMonths: 12,
    });
    expect(runInUserContext).toHaveBeenCalledTimes(1);
    expect(runInUserContext.mock.calls[0][0]).toBe('po-1');
    expect(repository.findIdsCreatedBefore).toHaveBeenCalledWith(
      tx,
      new Date('2025-10-15T10:00:00.000Z'),
      500,
    );
    expect(repository.deleteMany).toHaveBeenCalledWith(tx, ['old-1', 'old-2']);
    expect(forgetEntity).toHaveBeenCalledTimes(2);
    expect(forgetEntity).toHaveBeenCalledWith(
      tx,
      'platform.contact_submission.received',
      {
        type: 'platform_contact_submission',
        id: 'old-1',
      },
    );
    expect(write).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        action: 'platform.contact_submission.retention_purged',
        context: { deletedCount: 2, retentionMonths: 12 },
      }),
    );
    expect(order).toEqual(['delete', 'forget', 'forget', 'audit']);
  });

  it('writes nothing when no enquiry is past the period', async () => {
    const { service, repository, write } = build(
      { contactRetentionMode: 'on' },
      { ids: [] },
    );
    await expect(service.run(NOW)).resolves.toMatchObject({ eligible: 0, deleted: 0 });
    expect(repository.deleteMany).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('skips the run when no Platform Owner exists to act as', async () => {
    const { service, runInUserContext } = build(
      { contactRetentionMode: 'on' },
      { owner: false },
    );
    await expect(service.run(NOW)).resolves.toMatchObject({ deleted: 0, cutoff: null });
    expect(runInUserContext).not.toHaveBeenCalled();
  });
});
