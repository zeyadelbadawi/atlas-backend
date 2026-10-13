/**
 * Campaign SQL never binds an array that contains NULL.
 *
 * Prisma reuses a prepared statement per connection and types an array
 * parameter from the values it first saw. Once the release ran with an
 * all-NULL outbox column (an in-app-only campaign, or a batch where nobody
 * gets email), the next email campaign on that connection failed with
 * 22P03 "improper binary format in array element 1" (or 08P01), and the
 * campaign stayed in "sending" until a retry happened to land on another
 * connection. The same held for the recipients' `exclusion` column. Both
 * now bind '' for "none" and turn it back into NULL in SQL (NULLIF).
 *
 * The e2e suite cannot pin a connection, so this checks the invariant
 * directly on the values each statement binds.
 */
import type { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { expandAudiencePage } from './campaign-audience';
import { CampaignWorkerService } from './campaign-worker.service';

type Bound = unknown[];

/** A transaction double that records the values of every tagged-template call. */
function recordingTx(answers: unknown[]): {
  tx: Prisma.TransactionClient;
  calls: Bound[];
} {
  const calls: Bound[] = [];
  const queue = [...answers];
  const call = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push(values);
    return Promise.resolve(queue.shift() ?? 0);
  };
  return {
    tx: { $queryRaw: call, $executeRaw: call } as unknown as Prisma.TransactionClient,
    calls,
  };
}

function arraysWithNull(calls: Bound[]): unknown[][] {
  return calls
    .flat()
    .filter((value): value is unknown[] => Array.isArray(value))
    .filter((array) => array.some((item) => item === null || item === undefined));
}

describe('campaign SQL binds no array containing NULL', () => {
  const page = [
    { user_id: 'u-1', suppressed: false, opted_out: false },
    { user_id: 'u-2', suppressed: true, opted_out: false },
    { user_id: 'u-3', suppressed: false, opted_out: true },
  ];

  it.each([
    ['email channel, mixed exclusions', true],
    ['in-app only (no exclusion for anyone)', false],
  ])('expandAudiencePage: %s', async (_label, emailChannel) => {
    const { tx, calls } = recordingTx([page, []]);
    await expandAudiencePage(tx, {
      campaignId: 'c-1',
      audience: { type: 'platform', segment: 'all_owners' } as never,
      context: {} as never,
      cursor: null,
      limit: 100,
      emailChannel,
      emailBudget: null,
    });
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(arraysWithNull(calls)).toEqual([]);
  });

  it.each([
    ['in-app only (nobody gets email)', { email: false, inApp: true }],
    ['email, first recipient not eligible', { email: true, inApp: true }],
  ])('release: %s', async (_label, channels) => {
    const rows = [
      { user_id: 'u-1', email_eligible: false },
      { user_id: 'u-2', email_eligible: true },
    ];
    // locked row, recipient batch, then the writes (counts).
    const { tx, calls } = recordingTx([[{ status: 'sending' }], rows, 1, 1, 1, 1]);
    const worker = new CampaignWorkerService(
      {} as never,
      {} as never,
      { enqueueAfterCommit: jest.fn() } as never,
      {} as never,
      { get: () => undefined } as unknown as ConfigService,
    );
    let ran = false;
    jest
      .spyOn(
        worker as unknown as { inCampaignContext: unknown },
        'inCampaignContext' as never,
      )
      .mockImplementation((async (
        _owner: string,
        _campaign: unknown,
        fn: (t: Prisma.TransactionClient) => Promise<unknown>,
      ) => {
        // One batch, then nothing left.
        if (ran) return { count: 0, outboxIds: [] };
        ran = true;
        return fn(tx);
      }) as never);

    await worker.release('owner-1', {
      id: 'c-1',
      scope: 'platform',
      status: 'sending',
      organizationId: null,
      academyId: null,
      academyName: null,
      academyLanguage: null,
      channels,
      audience: { type: 'platform', segment: 'all_owners' } as never,
      subject: 'Subject',
      bodyText: 'Body',
    } as never);

    expect(calls.length).toBeGreaterThan(2);
    expect(arraysWithNull(calls)).toEqual([]);
  });
});
