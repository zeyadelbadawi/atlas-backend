import { DueReminderSweepService } from './due-reminder-sweep.service';

const NOW = new Date('2026-10-31T12:00:00.000Z');
const CANDIDATE = {
  user_id: 'u1',
  academy_id: 'a1',
  academy_name: 'Ziadd',
  kind: 'assignment' as const,
  item_id: 'i1',
  course_id: 'c1',
  due_at: new Date('2026-11-01T08:00:00.000Z'),
};

function make(opts: {
  enabled?: boolean;
  claimed?: boolean;
  submitted?: boolean;
  liveSession?: boolean;
  token?: string;
  transient?: boolean;
}) {
  const sent: { token: string; body: string; data: Record<string, string> }[] = [];
  const provider = {
    send: jest.fn(
      async (m: { token: string; body: string; data: Record<string, string> }) => {
        sent.push(m);
        if (opts.transient) return { ok: false, reason: 'transient', detail: '503' };
        return m.token.startsWith('invalid-')
          ? { ok: false, reason: 'invalid_token' }
          : { ok: true, providerMessageId: 'x' };
      },
    ),
  };
  const deleted: unknown[] = [];
  const released: unknown[] = [];
  const tx = {
    $queryRaw: jest.fn(),
    dueReminderSend: { deleteMany: jest.fn((a: unknown) => released.push(a)) },
    academyStudent: {
      findUnique: jest.fn().mockResolvedValue({ status: 'active', blockedAt: null }),
    },
    quizAttempt: { count: jest.fn().mockResolvedValue(0) },
    assignmentSubmission: { count: jest.fn().mockResolvedValue(opts.submitted ? 1 : 0) },
    pushDevice: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'd1', token: opts.token ?? 'tok-1', locale: 'ar', sessionId: 's1' },
        ]),
      deleteMany: jest.fn((a: unknown) => deleted.push(a)),
      updateMany: jest.fn(),
    },
    refreshToken: {
      findMany: jest
        .fn()
        .mockResolvedValue(opts.liveSession === false ? [] : [{ sessionId: 's1' }]),
    },
  };
  let call = 0;
  tx.$queryRaw.mockImplementation(async () => {
    call += 1;
    // 1st: candidates (owner context); 2nd: the claim insert.
    if (call === 1) return [CANDIDATE];
    return opts.claimed === false ? [] : [{ id: 'claim' }];
  });
  const tenancy = {
    runInUserContext: (_u: string, fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const prisma = { $queryRaw: jest.fn().mockResolvedValue([{ id: 'owner' }]) };
  const delivery = { enabled: () => opts.enabled !== false };
  const service = new DueReminderSweepService(
    prisma as never,
    tenancy as never,
    delivery as never,
    provider as never,
  );
  return { service, sent, deleted, released };
}

describe('DueReminderSweepService', () => {
  it('does nothing while push is off', async () => {
    const { service, sent } = make({ enabled: false });
    expect(await service.run(NOW)).toEqual({
      reminded: 0,
      skipped: 0,
      pushesSent: 0,
      failures: 0,
    });
    expect(sent).toHaveLength(0);
  });

  it('pushes once, in the device language, with the item path and no item name', async () => {
    const { service, sent } = make({});
    expect(await service.run(NOW)).toMatchObject({ reminded: 1, pushesSent: 1 });
    expect(sent[0].body).toContain('واجب');
    expect(sent[0].data).toEqual({
      kind: 'due_reminder',
      context: 'academy',
      academyId: 'a1',
      path: '/my/courses/c1/activities/i1',
    });
  });

  it('skips a pair another sweep already claimed', async () => {
    const { service, sent } = make({ claimed: false });
    expect(await service.run(NOW)).toMatchObject({ reminded: 0, skipped: 1 });
    expect(sent).toHaveLength(0);
  });

  it('skips learners who already submitted, or whose session ended', async () => {
    for (const opts of [{ submitted: true }, { liveSession: false }]) {
      const { service, sent } = make(opts);
      expect(await service.run(NOW)).toMatchObject({ skipped: 1 });
      expect(sent).toHaveLength(0);
    }
  });

  it('releases the claim when every push failed transiently, so it is retried', async () => {
    const { service, released } = make({ transient: true });
    expect(await service.run(NOW)).toMatchObject({ pushesSent: 0 });
    expect(released).toEqual([
      {
        where: {
          userId: 'u1',
          itemType: 'assignment',
          itemId: 'i1',
          dueAt: CANDIDATE.due_at,
        },
      },
    ]);
  });

  it('drops a dead token', async () => {
    const { service, deleted } = make({ token: 'invalid-tok' });
    expect(await service.run(NOW)).toMatchObject({ reminded: 1, pushesSent: 0 });
    expect(deleted).toHaveLength(1);
  });
});
