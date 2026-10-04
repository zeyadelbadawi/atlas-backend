/**
 * W3-compose — the dispatcher's two new behaviours, against mocks:
 *
 *   1. PROVIDER QUOTA EXHAUSTION DEFERS. When every provider is out of
 *      quota (`EmailQuotaExhaustedError`), the claimed row is parked until
 *      the reset with its attempt handed back — it is NOT retried six
 *      times inside fifteen minutes and then marked `failed`, which is what
 *      the registry's generic transient error used to cause. Security mail
 *      keeps the old failure path (a code delivered tomorrow is useless).
 *   2. CAMPAIGN ROWS render from the campaign's copy and carry RFC 8058
 *      `List-Unsubscribe` headers; a cancelled campaign sends nothing.
 */
import { randomUUID } from 'node:crypto';
import {
  EmailProviderError,
  EmailQuotaExhaustedError,
} from '../../identity/services/email-provider.interface';
import { CommunicationDispatchService } from './communication-dispatch.service';
import { NoopCommunicationSuppression } from './communication-suppression.interface';

type Row = Record<string, unknown>;

function harness(row: Row, campaign: Row | null = null) {
  const executed: string[] = [];
  const tx = {
    $executeRaw: jest.fn(async (strings: TemplateStringsArray) => {
      const sql = strings.join('?');
      executed.push(sql);
      // The claim UPDATE succeeds once.
      return 1;
    }),
    communicationOutbox: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: { data: Row }) => ({ ...row, ...data })),
    },
    communicationDelivery: { create: jest.fn(async () => ({})) },
    communicationCampaign: { findUnique: jest.fn(async () => campaign) },
    organizationMembership: { count: jest.fn(async () => 1) },
    academyMember: { count: jest.fn(async () => 0) },
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_u: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const users = {
    findFirstPlatformOwnerId: jest.fn(async () => ({ id: 'po-1' })),
    findById: jest.fn(async () => ({
      id: row.recipientUserId,
      email: 'person@example.com',
      preferences: {},
      status: 'active',
      deletedAt: null,
    })),
  };
  const redis = {
    getClient: () => ({
      get: jest.fn(async () => null),
      incr: jest.fn(async () => 1),
      expire: jest.fn(async () => 1),
      set: jest.fn(async () => 'OK'),
      pttl: jest.fn(async () => -1),
    }),
  };
  const transport = { send: jest.fn(), providerName: 'registry' };
  const links = {
    onHost: jest.fn(() => 'https://academy.example/x'),
    platform: jest.fn((p: string) => `https://atlas.example${p}`),
    settings: jest.fn(() => 'https://atlas.example/dashboard/profile'),
    unsubscribe: jest.fn(
      () => 'https://atlas.example/api/v1/communications/unsubscribe?token=t',
    ),
  };
  const branding = {
    resolve: jest.fn(async () => ({
      branding: { platformName: 'Atlas', platformUrl: 'https://atlas.example' },
      host: null,
      academyLanguage: null,
      academyTimezone: null,
    })),
  };
  const producer = { enqueueDispatch: jest.fn() };
  const metrics = {
    recordOutbox: jest.fn(),
    recordDispatchLatency: jest.fn(),
    recordRetry: jest.fn(),
    recordDeadLetter: jest.fn(),
    recordDigestItem: jest.fn(),
    recordOldestPendingSeconds: jest.fn(),
  };
  const service = new CommunicationDispatchService(
    tenancy as never,
    users as never,
    redis as never,
    transport as never,
    links as never,
    branding as never,
    producer as never,
    metrics as never,
    new NoopCommunicationSuppression(),
  );
  return { service, tx, transport, executed, metrics, links };
}

function outboxRow(overrides: Row = {}): Row {
  return {
    id: randomUUID(),
    key: 'platform.payment.approved',
    category: 'transactional',
    recipientUserId: 'user-1',
    organizationId: null,
    academyId: null,
    entityType: 'payment',
    entityId: 'p-1',
    locale: 'en',
    branding: 'platform',
    values: { planName: 'Growth' },
    channels: { inApp: false, email: 'always' },
    attempts: 1,
    campaignId: null,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('dispatch — provider quota exhaustion', () => {
  it('defers the row to the reset instant, hands the attempt back and does not rethrow', async () => {
    const row = outboxRow();
    const h = harness(row);
    const retryAt = new Date(Date.UTC(2030, 0, 2));
    h.transport.send.mockRejectedValue(new EmailQuotaExhaustedError(retryAt, 'daily'));

    await expect(h.service.dispatch(row.id as string, { made: 0, max: 6 })).resolves.toBe(
      'deferred',
    );
    const deferral = h.executed.find((sql) => sql.includes('SET "state" = \'deferred\''));
    expect(deferral).toBeDefined();
    expect(deferral).toContain('"attempts" = GREATEST("attempts" - 1, 0)');
    const call = h.tx.$executeRaw.mock.calls.find((c) =>
      (c[0] as unknown as string[]).join('?').includes('SET "state" = \'deferred\''),
    ) as unknown[];
    expect(call).toContain(retryAt);
    expect(call).toContain('provider_quota_exhausted:daily');
    // Nothing was attempted, so no failed delivery row and no dead letter.
    expect(h.tx.communicationDelivery.create).not.toHaveBeenCalled();
    expect(h.metrics.recordDeadLetter).not.toHaveBeenCalled();
    expect(h.tx.communicationOutbox.update).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
  });

  it('keeps the old retry path for an ordinary transient provider error', async () => {
    const row = outboxRow();
    const h = harness(row);
    h.transport.send.mockRejectedValue(
      new EmailProviderError('brevo', 'transient', 'HTTP 503'),
    );
    await expect(
      h.service.dispatch(row.id as string, { made: 0, max: 6 }),
    ).rejects.toThrow('HTTP 503');
    expect(h.tx.communicationOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'pending' }) }),
    );
  });

  it('does not defer security mail (a code delivered tomorrow is useless)', async () => {
    const row = outboxRow({
      key: 'auth.password.changed',
      category: 'security',
      values: {},
    });
    const h = harness(row);
    h.transport.send.mockRejectedValue(
      new EmailQuotaExhaustedError(new Date(Date.now() + 3600_000), 'daily'),
    );
    await expect(
      h.service.dispatch(row.id as string, { made: 5, max: 6 }),
    ).rejects.toBeInstanceOf(EmailQuotaExhaustedError);
    expect(h.tx.communicationOutbox.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ state: 'failed' }) }),
    );
  });
});

describe('dispatch — campaign rows', () => {
  const campaign = {
    scope: 'platform',
    status: 'sending',
    subject: 'Scheduled maintenance on Sunday',
    bodyHtml:
      '<p>We will be <strong>offline</strong> for one hour.</p><script>x()</script>',
    bodyText: 'We will be offline for one hour.',
    contentLocale: 'en',
  };

  it('renders the campaign copy and sends List-Unsubscribe headers', async () => {
    const row = outboxRow({
      key: 'platform.broadcast.sent',
      category: 'operational',
      channels: { inApp: false, email: 'preference' },
      values: {},
      entityType: 'communication_campaign',
      campaignId: 'c-1',
    });
    const h = harness(row, campaign);
    h.transport.send.mockResolvedValue({ provider: 'stub', providerMessageId: 'm-1' });

    await expect(h.service.dispatch(row.id as string, { made: 0, max: 6 })).resolves.toBe(
      'sent',
    );
    const sent = h.transport.send.mock.calls[0][0];
    expect(sent.subject).toBe('Scheduled maintenance on Sunday');
    expect(sent.html).toContain('<strong>offline</strong>');
    expect(sent.html).not.toContain('<script');
    expect(sent.text).toContain('We will be offline for one hour.');
    expect(sent.headers).toEqual({
      'List-Unsubscribe':
        '<https://atlas.example/api/v1/communications/unsubscribe?token=t>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(h.links.unsubscribe).toHaveBeenCalledWith('user-1', 'operational');
  });

  it('settles a row of a cancelled campaign as suppressed without sending', async () => {
    const row = outboxRow({
      key: 'platform.broadcast.sent',
      category: 'operational',
      channels: { inApp: false, email: 'preference' },
      campaignId: 'c-2',
    });
    const h = harness(row, { ...campaign, status: 'cancelled' });
    await expect(h.service.dispatch(row.id as string, { made: 0, max: 6 })).resolves.toBe(
      'suppressed',
    );
    expect(h.transport.send).not.toHaveBeenCalled();
  });
});
