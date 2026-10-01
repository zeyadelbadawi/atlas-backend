/**
 * Prints the integrity-signal evaluation (P5) as Markdown:
 *   npx ts-node -r tsconfig-paths/register scripts/integrity-eval.ts
 * Pure computation over the scenario corpus — no database, no network.
 */
import { INTEGRITY_SCENARIOS } from '../src/learning/services/integrity-eval/scenarios';
import {
  evaluateIntegritySignals,
  renderEvaluationMarkdown,
} from '../src/learning/services/integrity-eval/evaluate';

process.stdout.write(`${renderEvaluationMarkdown(evaluateIntegritySignals(INTEGRITY_SCENARIOS))}\n`);
