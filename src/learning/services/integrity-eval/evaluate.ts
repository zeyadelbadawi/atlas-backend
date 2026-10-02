/**
 * Runs the integrity signals over the labelled scenarios and computes,
 * per signal and per attempt: TP / FP / FN / TN, precision, recall,
 * false-positive rate and false-negative rate (P5).
 *
 * A signal "fires" when it is at `review` level (worth a reviewer's look);
 * `info` is context and counts as not firing. For signal S, a scenario is
 * a true positive case when it is dishonest AND S is in its footprint.
 * At attempt level, "flagged" means any signal fired, against `dishonest`.
 * A rate whose denominator is zero is `null` ("not measurable here"),
 * never 0 or 1.
 *
 * Read the scope note in `scenarios.ts` before quoting any number: these
 * are designed scenarios, not a sample of real learners.
 */
import {
  deriveIntegritySignals,
  type IntegritySignal,
  type IntegritySignalKey,
  type SignalEvent,
} from '../integrity-signals.util';
import type { IntegrityScenario } from './scenarios';

const START = new Date('2026-01-01T09:00:00.000Z');
const at = (seconds: number) => new Date(START.getTime() + seconds * 1000);

export function scenarioSignals(scenario: IntegrityScenario): IntegritySignal[] {
  const events: SignalEvent[] = [];
  const all: [number, SignalEvent['type'], Record<string, string> | undefined][] =
    scenario.events.map(([seconds, type, payload]) => [seconds, type, payload]);
  if (!scenario.silent) {
    for (let s = 60; s < scenario.durationSeconds; s += 60)
      all.push([s, 'heartbeat', undefined]);
  }
  all
    .sort((a, b) => a[0] - b[0])
    .forEach(([seconds, type, payload], index) =>
      events.push({
        id: `${scenario.id}-e${index + 1}`,
        type,
        serverAt: at(seconds),
        clientAt: at(seconds),
        payload: payload ?? null,
      }),
    );
  return deriveIntegritySignals({
    events,
    startedAt: START,
    endedAt: at(scenario.durationSeconds),
    integrityMode: 'warn',
    requireFullscreen: scenario.requireFullscreen,
  });
}

/** The signals that can reach `review` level, i.e. that can fire. */
export const EVALUATED_SIGNALS: readonly IntegritySignalKey[] = [
  'time_away',
  'focus_lost',
  'fullscreen_left',
  'fullscreen_never_entered',
  'paste_without_copy',
  'print',
  'connection_gap',
];

export interface Confusion {
  readonly tp: number;
  readonly fp: number;
  readonly fn: number;
  readonly tn: number;
  readonly precision: number | null;
  readonly recall: number | null;
  readonly falsePositiveRate: number | null;
  readonly falseNegativeRate: number | null;
  /** Scenario ids behind each FP and FN, so every number can be traced. */
  readonly falsePositives: readonly string[];
  readonly falseNegatives: readonly string[];
}

function ratio(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function confusion(
  cases: readonly { id: string; actual: boolean; predicted: boolean }[],
): Confusion {
  const tp = cases.filter((c) => c.actual && c.predicted);
  const fp = cases.filter((c) => !c.actual && c.predicted);
  const fn = cases.filter((c) => c.actual && !c.predicted);
  const tn = cases.filter((c) => !c.actual && !c.predicted);
  return {
    tp: tp.length,
    fp: fp.length,
    fn: fn.length,
    tn: tn.length,
    precision: ratio(tp.length, tp.length + fp.length),
    recall: ratio(tp.length, tp.length + fn.length),
    falsePositiveRate: ratio(fp.length, fp.length + tn.length),
    falseNegativeRate: ratio(fn.length, fn.length + tp.length),
    falsePositives: fp.map((c) => c.id),
    falseNegatives: fn.map((c) => c.id),
  };
}

export interface IntegrityEvaluation {
  readonly scenarios: number;
  readonly honest: number;
  readonly dishonest: number;
  readonly perSignal: Readonly<Record<string, Confusion>>;
  readonly attempt: Confusion;
  readonly outputs: readonly {
    readonly id: string;
    readonly description: string;
    readonly dishonest: boolean;
    readonly review: readonly IntegritySignalKey[];
    readonly info: readonly IntegritySignalKey[];
  }[];
}

export function evaluateIntegritySignals(
  scenarios: readonly IntegrityScenario[],
): IntegrityEvaluation {
  const outputs = scenarios.map((scenario) => {
    const signals = scenarioSignals(scenario);
    return {
      scenario,
      review: signals.filter((s) => s.level === 'review').map((s) => s.key),
      info: signals.filter((s) => s.level === 'info').map((s) => s.key),
    };
  });
  const perSignal: Record<string, Confusion> = {};
  for (const key of EVALUATED_SIGNALS) {
    perSignal[key] = confusion(
      outputs.map(({ scenario, review }) => ({
        id: scenario.id,
        actual: scenario.dishonest && scenario.footprint.includes(key),
        predicted: review.includes(key),
      })),
    );
  }
  return {
    scenarios: scenarios.length,
    honest: scenarios.filter((s) => !s.dishonest).length,
    dishonest: scenarios.filter((s) => s.dishonest).length,
    perSignal,
    attempt: confusion(
      outputs.map(({ scenario, review }) => ({
        id: scenario.id,
        actual: scenario.dishonest,
        predicted: review.length > 0,
      })),
    ),
    outputs: outputs.map(({ scenario, review, info }) => ({
      id: scenario.id,
      description: scenario.description,
      dishonest: scenario.dishonest,
      review,
      info,
    })),
  };
}

const pct = (value: number | null) =>
  value === null ? 'n/a' : `${Math.round(value * 100)}%`;

/** The evaluation as Markdown tables (for the report). */
export function renderEvaluationMarkdown(evaluation: IntegrityEvaluation): string {
  const row = (name: string, c: Confusion) =>
    `| ${name} | ${c.tp} | ${c.fp} | ${c.fn} | ${c.tn} | ${pct(c.precision)} | ${pct(c.recall)} | ${pct(c.falsePositiveRate)} | ${pct(c.falseNegativeRate)} | ${c.falsePositives.join(', ') || '—'} | ${c.falseNegatives.join(', ') || '—'} |`;
  const lines = [
    `Scenarios: ${evaluation.scenarios} (${evaluation.honest} honest, ${evaluation.dishonest} dishonest). Designed scenarios, not real learners — see the scope note.`,
    '',
    '| Signal | TP | FP | FN | TN | Precision | Recall | FPR | FNR | FP scenarios | FN scenarios |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...EVALUATED_SIGNALS.map((key) => row(key, evaluation.perSignal[key])),
    row('**Attempt (any signal)**', evaluation.attempt),
    '',
    '| Scenario | Label | Worth a look | Context |',
    '|---|---|---|---|',
    ...evaluation.outputs.map(
      (o) =>
        `| ${o.id} — ${o.description} | ${o.dishonest ? 'dishonest' : 'honest'} | ${o.review.join(', ') || '—'} | ${o.info.join(', ') || '—'} |`,
    ),
  ];
  return lines.join('\n');
}
