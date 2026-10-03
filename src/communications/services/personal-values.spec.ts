/**
 * `personalValues` — a third party's personal data (a website visitor's
 * name, address, message) that an email may carry but the in-app feed must
 * not, and that the outbox drops once the dispatch settles or the source
 * record is deleted. The end-to-end proof (real intake, real dispatch,
 * real delete, real RLS) is in `test/platform-contact-submissions.e2e-spec.ts`.
 */
import { COMMUNICATION_CATALOG, settleScrubKeys } from '../catalog/communication-catalog';
import { withoutCredentials } from './communication-dispatch.service';
import { CommunicationService, withoutPersonalValues } from './communication.service';
import type { NotificationsRepository } from '../../notification-events/repositories/notifications.repository';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import type { RedisService } from '../../redis/redis.service';
import type { CommunicationsProducer } from '../queue/communications.producer';
import type { CommunicationMetricsService } from '../metrics/communication-metrics.service';
import type { Prisma } from '@prisma/client';

const CONTACT_VALUES = {
  name: 'Layla Haddad',
  email: 'layla@example.test',
  organizationName: 'Falcon Learning',
  topic: 'sales',
  message: 'Please call me back.',
};

/** A tagged-template `$executeRaw` mock that records each call's SQL text and bound values. */
function rawRecorder() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const fn = jest.fn((strings: TemplateStringsArray, ...params: unknown[]) => {
    calls.push({ sql: strings.join('?'), params });
    return Promise.resolve(1);
  });
  return { fn, calls };
}

function buildService() {
  const create = jest.fn().mockResolvedValue(true);
  const service = new CommunicationService(
    { create } as unknown as NotificationsRepository,
    { findById: jest.fn().mockResolvedValue(null) } as unknown as UsersRepository,
    {
      getClient: () => ({ pttl: jest.fn().mockResolvedValue(-2) }),
    } as unknown as RedisService,
    {} as unknown as CommunicationsProducer,
    { recordOutbox: jest.fn() } as unknown as CommunicationMetricsService,
  );
  return { service, create };
}

describe('personalValues', () => {
  it('the contact-form notification declares every visitor field personal, not the topic', () => {
    expect(
      [
        ...(COMMUNICATION_CATALOG['platform.contact_submission.received']
          .personalValues ?? []),
      ].sort(),
    ).toEqual(['email', 'message', 'name', 'organizationName']);
  });

  it('settle scrubbing covers credentials and personal values together', () => {
    expect(
      settleScrubKeys({ credentialValues: ['token'], personalValues: ['email'] }),
    ).toEqual(['token', 'email']);
    expect(settleScrubKeys({})).toEqual([]);
    expect(
      withoutCredentials(
        COMMUNICATION_CATALOG['platform.contact_submission.received'],
        CONTACT_VALUES,
      ),
    ).toEqual({ topic: 'sales' });
  });

  it('withoutPersonalValues keeps everything for an entry that declares none', () => {
    const values = { academyName: 'A' };
    expect(withoutPersonalValues({}, values)).toBe(values);
    expect(
      withoutPersonalValues({ personalValues: ['email'] }, { email: 'x', topic: 't' }),
    ).toEqual({ topic: 't' });
  });

  it('emit writes the in-app row without personal values, and the outbox row with them', async () => {
    const { service, create } = buildService();
    const raw = rawRecorder();
    const tx = {
      $executeRaw: raw.fn,
      $executeRawUnsafe: jest.fn().mockResolvedValue(0),
    } as unknown as Prisma.TransactionClient;

    await expect(
      service.emit(tx, {
        key: 'platform.contact_submission.received',
        recipientUserId: 'po-1',
        entity: { type: 'platform_contact_submission', id: 'sub-1' },
        values: CONTACT_VALUES,
      }),
    ).resolves.toMatchObject({ created: true });

    expect(create).toHaveBeenCalledTimes(1);
    const inApp = create.mock.calls[0][1];
    expect(inApp.values).toEqual({ topic: 'sales' });
    expect(JSON.stringify(inApp)).not.toContain('layla@example.test');
    expect(JSON.stringify(inApp)).not.toContain('Please call me back.');

    const insert = raw.calls.find((call) =>
      call.sql.includes('INSERT INTO "communication_outbox"'),
    );
    expect(insert).toBeDefined();
    // The email still needs the details until it is rendered.
    expect(insert!.params).toContain(JSON.stringify(CONTACT_VALUES));
  });

  it('forgetEntity blanks the outbox rows of that entity and the caller’s own in-app row', async () => {
    const { service } = buildService();
    const raw = rawRecorder();
    const tx = { $executeRaw: raw.fn } as unknown as Prisma.TransactionClient;

    await service.forgetEntity(tx, 'platform.contact_submission.received', {
      type: 'platform_contact_submission',
      id: 'sub-1',
    });

    expect(raw.calls).toHaveLength(2);
    const [outbox, notifications] = raw.calls;
    expect(outbox.sql).toContain('UPDATE "communication_outbox"');
    expect(outbox.sql).toContain("'source_deleted'");
    expect(outbox.params).toEqual([
      ['name', 'email', 'organizationName', 'message'],
      'platform.contact_submission.received',
      'platform_contact_submission',
      'sub-1',
    ]);
    expect(notifications.sql).toContain('UPDATE "notifications"');
    expect(notifications.params).toEqual([
      ['name', 'email', 'organizationName', 'message'],
      'platform_contact_received:sub-1',
    ]);
  });
});
