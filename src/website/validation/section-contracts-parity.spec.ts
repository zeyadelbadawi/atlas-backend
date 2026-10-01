/**
 * Theme 1 plan Phase 2 — frontend/backend section-contract parity. The cases
 * file is byte-identical in atlas (`src/features/website/schemas/__parity__`)
 * and here; the frontend suite asserts the same outcomes against its Zod
 * mirror, so the editor can never accept what the API rejects (or the
 * reverse).
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
    expect(
      getSectionConfigSchema(parityCase.type).safeParse(parityCase.config).success,
    ).toBe(parityCase.valid);
  });
});
