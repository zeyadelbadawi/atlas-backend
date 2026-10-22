/**
 * Theme 1 plan Phase 2 — frontend/backend section-contract parity. The cases
 * file is byte-identical in atlas (`src/features/website/schemas/__parity__`)
 * and here; the frontend suite asserts the same outcomes against its Zod
 * mirror, so the editor can never accept what the API rejects (or the
 * reverse). A case's `preserves` paths must come out of the parse exactly as
 * they went in: a key the schema does not declare is silently stripped.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { SECTION_TYPES } from '../constants/website.constants';
import { getSectionConfigSchema } from './section-config.schemas';

interface ParityCase {
  readonly name: string;
  readonly type: (typeof SECTION_TYPES)[number];
  readonly config: unknown;
  readonly valid: boolean;
  readonly preserves?: readonly string[];
}

function at(value: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[key]
          : undefined,
      value,
    );
}

const { cases } = JSON.parse(
  readFileSync(
    join(__dirname, '__parity__', 'section-contracts-theme1.cases.json'),
    'utf8',
  ),
) as { cases: ParityCase[] };

describe('section contracts — parity cases', () => {
  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, parityCase) => {
    expect(SECTION_TYPES).toContain(parityCase.type);
    const result = getSectionConfigSchema(parityCase.type).safeParse(parityCase.config);
    expect(result.success).toBe(parityCase.valid);
    for (const path of parityCase.preserves ?? []) {
      expect(at(result.data, path)).toEqual(at(parityCase.config, path));
      expect(at(parityCase.config, path)).toBeDefined();
    }
  });
});
