/**
 * P5 — explainable integrity signals: the rules, one by one, and the
 * labelled-scenario evaluation (see integrity-eval/scenarios.ts for what
 * those scenarios are and are not).
 */
import {
  AWAY_REVIEW_TOTAL_SECONDS,
  deriveIntegritySignals,
  type SignalEvent,
} from './integrity-signals.util';
import { INTEGRITY_SCENARIOS } from './integrity-eval/scenarios';
import { evaluateIntegritySignals } from './integrity-eval/evaluate';

const T0 = new Date('2026-01-01T09:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
let n = 0;
const ev = (s: number, type: SignalEvent['type'], extra: Partial<SignalEvent> = {}): SignalEvent => ({
  id: `e${(n += 1)}`,
  type,
  serverAt: at(s),
  clientAt: at(s),
  ...extra,
});
/** Real attempts send a heartbeat every 60 s; `silent` leaves them out. */
const derive = (
  events: SignalEvent[],
  options: { requireFullscreen?: boolean; end?: number; silent?: boolean } = {},
) =>
  deriveIntegritySignals({
    events: options.silent
      ? events
      : [
          ...events,
          ...Array.from({ length: Math.floor((options.end ?? 600) / 60) }, (_, i) =>
            ev((i + 1) * 60, 'heartbeat'),
          ),
        ],
    startedAt: T0,
    endedAt: at(options.end ?? 600),
    integrityMode: 'warn',
    requireFullscreen: options.requireFullscreen ?? false,
  });

describe('deriveIntegritySignals', () => {
  it('integrity off → no signals at all', () => {
    expect(
      deriveIntegritySignals({
        events: [ev(10, 'print')],
        startedAt: T0,
        endedAt: at(60),
        integrityMode: 'off',
        requireFullscreen: false,
      }),
    ).toEqual([]);
  });

  it('time away: pairs hidden→visible, totals and longest, with its evidence; review at the threshold', () => {
    const hidden = ev(100, 'visibility_hidden');
    const visible = ev(100 + AWAY_REVIEW_TOTAL_SECONDS, 'visibility_visible');
    expect(derive([hidden, visible])).toEqual([
      {
        key: 'time_away',
        level: 'review',
        occurrences: 1,
        totalSeconds: AWAY_REVIEW_TOTAL_SECONDS,
        longestSeconds: AWAY_REVIEW_TOTAL_SECONDS,
        eventIds: [hidden.id, visible.id],
      },
    ]);
  });

  it('an interval still open at the end runs to the end of the attempt', () => {
    const [signal] = derive([ev(560, 'visibility_hidden')], { end: 600 });
    expect(signal).toMatchObject({ key: 'time_away', totalSeconds: 40 });
  });

  it('within one batch (same server time) the client clock measures the gap', () => {
    const hidden = ev(100, 'visibility_hidden', { clientAt: at(90) });
    const visible = ev(100, 'visibility_visible', { clientAt: at(98) });
    expect(derive([hidden, visible])[0]).toMatchObject({ key: 'time_away', totalSeconds: 8, level: 'info' });
  });

  it('a blur that becomes a hidden tab is reported once, as time away', () => {
    const keys = derive([
      ev(100, 'blur'),
      ev(100.2, 'visibility_hidden'),
      ev(160, 'visibility_visible'),
      ev(160.1, 'focus'),
    ]).map((s) => s.key);
    expect(keys).toEqual(['time_away']);
  });

  it('full screen: required + never entered → worth a look; unavailable → context with the reason', () => {
    expect(derive([], { requireFullscreen: true }).map((s) => [s.key, s.level])).toEqual([
      ['fullscreen_never_entered', 'review'],
    ]);
    const unavailable = derive(
      [ev(0, 'fullscreen_unavailable', { payload: { reason: 'unsupported' } })],
      { requireFullscreen: true },
    );
    expect(unavailable).toEqual([
      expect.objectContaining({ key: 'fullscreen_unavailable', level: 'info', reasons: ['unsupported'] }),
    ]);
    // Not required → full-screen events are not signals.
    expect(derive([ev(10, 'fullscreen_exit')])).toEqual([]);
  });

  it('paste: after an in-attempt copy is context; without one is worth a look', () => {
    const copy = ev(10, 'copy');
    const ownPaste = ev(20, 'paste');
    expect(derive([copy, ownPaste]).map((s) => [s.key, s.level])).toEqual([
      ['paste_after_copy', 'info'],
      ['copy', 'info'],
    ]);
    expect(derive([ev(30, 'paste')]).map((s) => [s.key, s.level])).toEqual([
      ['paste_without_copy', 'review'],
    ]);
  });

  it('silence: a long stretch with no batch is context (never worth a look on its own)', () => {
    const signals = derive([ev(60, 'heartbeat'), ev(400, 'heartbeat')], {
      end: 460,
      silent: true,
    });
    expect(signals).toEqual([
      expect.objectContaining({ key: 'connection_gap', level: 'info', occurrences: 1, totalSeconds: 340 }),
    ]);
  });
});

describe('labelled-scenario evaluation', () => {
  const evaluation = evaluateIntegritySignals(INTEGRITY_SCENARIOS);
  const out = (id: string) => evaluation.outputs.find((o) => o.id === id)!;

  it('no honest scenario among the common ones is flagged (notifications, a short call, own paste, Esc, iPhone, Wi-Fi)', () => {
    for (const id of ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H14']) {
      expect([id, out(id).review]).toEqual([id, []]);
    }
  });

  it('known false positives are the documented ones (long break, sleep, dictation, outdated client)', () => {
    expect(evaluation.attempt.falsePositives).toEqual(['H10', 'H11', 'H12', 'H13']);
  });

  it('known false negatives include what no browser signal can see (a phone, another person)', () => {
    expect(evaluation.attempt.falseNegatives).toEqual(['D04', 'D08', 'D09', 'D12', 'D15']);
  });

  it('a rate with nothing to measure is n/a, never 0 or 100%', () => {
    expect(evaluation.perSignal.connection_gap.precision).toBeNull();
  });
});
