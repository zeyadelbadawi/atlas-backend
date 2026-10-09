import {
  LearnerOpLedger,
  MAX_CLIENT_CLOCK_LEAD_MS,
  type LessonOpRecord,
} from './learner-op-ledger.service';
import { certificateIssueJobId } from './course-completion.service';
import { offlineReadingFor } from './lesson-content.service';
import { OFFLINE_READING_TTL_SECONDS } from '../dto/lesson-content.contract';
import type { RedisService } from '../../redis/redis.service';

function fakeRedis(store = new Map<string, string>(), failing = false) {
  const client = {
    get: jest.fn(async (key: string) => {
      if (failing) throw new Error('down');
      return store.get(key) ?? null;
    }),
    set: jest.fn(async (key: string, value: string) => {
      if (failing) throw new Error('down');
      store.set(key, value);
      return 'OK';
    }),
  };
  return {
    service: { getClient: () => client } as unknown as RedisService,
    client,
    store,
  };
}

describe('LearnerOpLedger — lesson operation ordering', () => {
  const now = 1_800_000_000_000;
  const latest: LessonOpRecord = { at: now - 1_000, opId: 'op-newer-1', action: 'undo' };

  it('applies when nothing is remembered', () => {
    expect(
      LearnerOpLedger.judgeLessonOp(null, { opId: 'op-a-0001', clientOpAt: 5 }, now),
    ).toEqual({
      apply: true,
      at: 5,
    });
  });

  it('refuses an operation older than the latest applied one', () => {
    const verdict = LearnerOpLedger.judgeLessonOp(
      latest,
      { opId: 'op-older-1', clientOpAt: now - 60_000 },
      now,
    );
    expect(verdict).toEqual({ apply: false, latest });
  });

  it('applies the same operation again (a replay of an idempotent state-setter)', () => {
    expect(
      LearnerOpLedger.judgeLessonOp(
        latest,
        { opId: latest.opId, clientOpAt: latest.at },
        now,
      ).apply,
    ).toBe(true);
  });

  it('applies a newer operation', () => {
    expect(
      LearnerOpLedger.judgeLessonOp(latest, { opId: 'op-newest', clientOpAt: now }, now)
        .apply,
    ).toBe(true);
  });

  it('clamps a device clock that runs ahead, so it cannot pin the lesson', () => {
    const verdict = LearnerOpLedger.judgeLessonOp(
      null,
      { opId: 'op-future', clientOpAt: now + 86_400_000 },
      now,
    );
    expect(verdict).toEqual({ apply: true, at: now + MAX_CLIENT_CLOCK_LEAD_MS });
  });
});

describe('LearnerOpLedger — storage', () => {
  it('scopes submission records by user and assignment', async () => {
    const { service, store } = fakeRedis();
    const ledger = new LearnerOpLedger(service);
    await ledger.rememberSubmission('user-1', 'asg-1', 'key-12345678', {
      submissionId: 's1',
      revision: 1,
      fingerprint: 'f',
    });
    expect([...store.keys()]).toEqual([
      'learning:idem:assignment-submit:user-1:asg-1:key-12345678',
    ]);
    expect(await ledger.findSubmission('user-2', 'asg-1', 'key-12345678')).toBeNull();
    expect(await ledger.findSubmission('user-1', 'asg-1', 'key-12345678')).toMatchObject({
      submissionId: 's1',
    });
  });

  it('falls back to "nothing remembered" when Redis is down, never throwing', async () => {
    const { service } = fakeRedis(new Map(), true);
    const ledger = new LearnerOpLedger(service);
    await expect(ledger.latestLessonOp('u', 'l')).resolves.toBeNull();
    await expect(
      ledger.recordLessonOp('u', 'l', { at: 1, opId: 'op-x-0001', action: 'complete' }),
    ).resolves.toBeUndefined();
  });

  it('fingerprints are order-independent and payload-sensitive', () => {
    const a = LearnerOpLedger.fingerprint({ response: 'x', attachmentAssetId: null });
    const b = LearnerOpLedger.fingerprint({ attachmentAssetId: null, response: 'x' });
    const c = LearnerOpLedger.fingerprint({ response: 'y', attachmentAssetId: null });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe('certificate-issue job id', () => {
  it('is deterministic per enrollment and valid for BullMQ (no ":")', () => {
    expect(certificateIssueJobId('e-1')).toBe(certificateIssueJobId('e-1'));
    expect(certificateIssueJobId('e-1')).not.toContain(':');
    expect(certificateIssueJobId('e-1', 'followup')).not.toBe(
      certificateIssueJobId('e-1'),
    );
  });
});

describe('offline reading permission', () => {
  const base = {
    kind: 'text' as const,
    hasVideo: false,
    signedIn: true,
    staffPreview: false,
  };

  it('allows a signed-in learner to keep a text lesson, with an expiry', () => {
    const now = 1_800_000_000_000;
    expect(offlineReadingFor({ ...base, now })).toEqual({
      allowed: true,
      until: new Date(now + OFFLINE_READING_TTL_SECONDS * 1000).toISOString(),
    });
  });

  it.each([
    ['video', { kind: 'video' as const }],
    ['file', { kind: 'file' as const }],
    ['external', { kind: 'external' as const }],
    ['text with a video attached', { hasVideo: true }],
    ['an anonymous preview', { signedIn: false }],
    ['a staff preview', { staffPreview: true }],
  ])('never for %s', (_label, over) => {
    expect(offlineReadingFor({ ...base, ...over })).toEqual({
      allowed: false,
      until: null,
    });
  });
});
