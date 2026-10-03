import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { CommunicationService } from '../../communications/services/communication.service';
import type { PlatformContactSubmissionsRepository } from '../repositories/platform-contact-submissions.repository';
import { PlatformContactSubmissionsService } from './platform-contact-submissions.service';

describe('PlatformContactSubmissionsService.delete', () => {
  function build(found: boolean) {
    const tx = { marker: 'owner-tx' };
    const order: string[] = [];
    const repository = {
      findById: jest
        .fn()
        .mockResolvedValue(found ? { id: 'sub-1', status: 'read' } : null),
      delete: jest.fn(async () => {
        order.push('delete');
      }),
    };
    const forgetEntity = jest.fn(async () => {
      order.push('forget');
      return 2;
    });
    const write = jest.fn(async () => {
      order.push('audit');
    });
    const runInUserContext = jest.fn((_id: string, work: (t: unknown) => unknown) =>
      work(tx),
    );
    const service = new PlatformContactSubmissionsService(
      { runInUserContext } as unknown as TenancyContextService,
      repository as unknown as PlatformContactSubmissionsRepository,
      { write } as unknown as AuditLogWriterService,
      { forgetEntity } as unknown as CommunicationService,
    );
    return { service, tx, order, forgetEntity, runInUserContext };
  }

  it('takes back the notification copies in the same owner transaction as the delete', async () => {
    const { service, tx, order, forgetEntity, runInUserContext } = build(true);
    await service.delete('po-1', 'sub-1');
    expect(runInUserContext).toHaveBeenCalledTimes(1);
    expect(runInUserContext.mock.calls[0][0]).toBe('po-1');
    expect(forgetEntity).toHaveBeenCalledWith(
      tx,
      'platform.contact_submission.received',
      {
        type: 'platform_contact_submission',
        id: 'sub-1',
      },
    );
    expect(order).toEqual(['delete', 'forget', 'audit']);
  });

  it('touches nothing for an enquiry the caller cannot see', async () => {
    const { service, forgetEntity } = build(false);
    await expect(service.delete('po-1', 'missing')).rejects.toThrow();
    expect(forgetEntity).not.toHaveBeenCalled();
  });
});
