/**
 * W3 / B0-OC-17 — the daily digest follows the visual identity of its
 * entries, like a single email does. Every digestible staff work item
 * (`roster.student.awaiting_approval`, `review.submitted`,
 * `academy.contact_submission.received`) is platform-HOSTED but read as
 * coming FROM the academy (`identity: 'academy'`). The digest used to
 * resolve its branding from the host rule alone, so it rendered the
 * platform signature — and with it the operating company's disclosure —
 * instead of the academy's name and logo.
 */
import { randomUUID } from 'node:crypto';
import { CommunicationDispatchService } from './communication-dispatch.service';
import { NoopCommunicationSuppression } from './communication-suppression.interface';

type Row = Record<string, unknown>;

const ACADEMY_ID = '11111111-1111-4111-8111-111111111111';

function harness(items: Row[]) {
  const tx = {
    $executeRaw: jest.fn(async () => 1),
    communicationDigest: {
      findUnique: jest.fn(async () => ({ id: 'digest-1', recipientUserId: 'user-1' })),
      update: jest.fn(async () => ({})),
    },
    communicationOutbox: {
      findMany: jest.fn(async () => items),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: items.length })),
    },
    communicationDelivery: { createMany: jest.fn(async () => ({ count: items.length })) },
    communicationCampaign: { findUnique: jest.fn(async () => null) },
    organizationMembership: { count: jest.fn(async () => 1) },
    academyMember: { count: jest.fn(async () => 1) },
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_u: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const users = {
    findById: jest.fn(async () => ({
      id: 'user-1',
      email: 'owner@example.com',
      preferences: {},
      status: 'active',
      deletedAt: null,
    })),
  };
  const redis = {
    getClient: () => ({ incr: jest.fn(async () => 1), expire: jest.fn(async () => 1) }),
  };
  const transport = {
    send: jest.fn(async () => ({ provider: 'test', providerMessageId: 'm-1' })),
    providerName: 'registry',
  };
  const links = {
    onHost: jest.fn(() => 'https://academy.example/x'),
    platform: jest.fn((p: string) => `https://atlas.example${p}`),
    settings: jest.fn(() => 'https://atlas.example/dashboard/profile'),
  };
  const branding = {
    resolve: jest.fn(
      async (
        _tx: unknown,
        _mode: string,
        _academyId: string | null,
        identity?: string,
      ) => ({
        branding:
          identity === 'academy'
            ? {
                platformName: 'Atlas',
                platformUrl: 'https://atlas.example',
                academyName: 'Falcon Academy',
              }
            : { platformName: 'Atlas', platformUrl: 'https://atlas.example' },
        host: null,
        academyLanguage: null,
        academyTimezone: null,
      }),
    ),
  };
  const metrics = {
    recordOutbox: jest.fn(),
    recordDigestItem: jest.fn(),
  };
  const service = new CommunicationDispatchService(
    tenancy as never,
    users as never,
    redis as never,
    transport as never,
    links as never,
    branding as never,
    { enqueueDispatch: jest.fn() } as never,
    metrics as never,
    new NoopCommunicationSuppression(),
  );
  return { service, transport, branding };
}

function digestItem(key: string, values: Row): Row {
  return {
    id: randomUUID(),
    key,
    category: 'operational',
    recipientUserId: 'user-1',
    organizationId: null,
    academyId: ACADEMY_ID,
    entityType: 'x',
    entityId: 'x-1',
    locale: 'en',
    branding: 'platform',
    values,
    campaignId: null,
    createdAt: new Date(),
  };
}

describe('dispatch — digest identity', () => {
  it('renders an academy-identity digest under the academy, without the platform company line', async () => {
    const h = harness([
      digestItem('roster.student.awaiting_approval', {
        academyId: ACADEMY_ID,
        academyName: 'Falcon Academy',
        learnerName: 'Example Learner',
      }),
    ]);

    const sent = await (
      h.service as unknown as {
        sendDigest: (owner: string, digestId: string) => Promise<boolean>;
      }
    ).sendDigest('po-1', 'digest-1');

    expect(sent).toBe(true);
    // Host rule `platform`, visual identity `academy`.
    expect(h.branding.resolve).toHaveBeenCalledWith(
      expect.anything(),
      'platform',
      ACADEMY_ID,
      'academy',
    );
    const email = (h.transport.send.mock.calls as unknown as [Row][])[0][0];
    for (const part of [email.html, email.text] as string[]) {
      expect(part).toContain('Falcon Academy');
      expect(part).not.toContain('CoreMind');
    }
  });
});
