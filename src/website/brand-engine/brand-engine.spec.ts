/**
 * Brand engine mirror — parity and authority (Theme 1 plan §F.4.3, §I).
 *
 * 1. Golden vectors: the SAME `__golden__/bp-1.golden.json` the frontend
 *    generates and checks. Passing here means the API derives and judges
 *    every vector exactly like the browser preview does.
 * 2. Property: 500 random seed sets, every §F.4.4 pair passes and every
 *    built palette validates.
 * 3. Authority: crafted/tampered palettes are rejected (the backend is the
 *    only thing standing between a modified client and a stored palette).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildBrandPalette, deriveBrandPalette } from './derive';
import {
  BRAND_ENGINE_ALGORITHM_VERSION,
  BRAND_PALETTE_VARIANTS,
  type BrandOverrides,
  type BrandPaletteVariant,
  type BrandSeeds,
} from './palette.types';
import { validateBrandPalette } from './validate';

interface GoldenInput {
  readonly name: string;
  readonly seeds: BrandSeeds;
  readonly variant: BrandPaletteVariant;
  readonly overrides?: BrandOverrides;
  readonly neutralChromaCap?: number;
}

function compute(input: GoldenInput) {
  const options = {
    variant: input.variant,
    overrides: input.overrides,
    neutralChromaCap: input.neutralChromaCap,
  };
  const derived = deriveBrandPalette(input.seeds, options);
  const palette = buildBrandPalette({ seeds: input.seeds, source: 'manual', ...options });
  return { derived, validation: validateBrandPalette(palette) };
}

const golden = JSON.parse(
  readFileSync(
    join(__dirname, '__golden__', `${BRAND_ENGINE_ALGORITHM_VERSION}.golden.json`),
    'utf8',
  ),
) as {
  algorithmVersion: string;
  vectors: { input: GoldenInput; expected: ReturnType<typeof compute> }[];
};

describe(`brand engine mirror — golden vectors (${BRAND_ENGINE_ALGORITHM_VERSION})`, () => {
  it('is the file for this algorithm version, with vectors', () => {
    expect(golden.algorithmVersion).toBe(BRAND_ENGINE_ALGORITHM_VERSION);
    expect(golden.vectors.length).toBeGreaterThan(40);
  });

  it.each(golden.vectors.map((vector) => [vector.input.name, vector] as const))(
    '%s',
    (_name, vector) => {
      expect(JSON.parse(JSON.stringify(compute(vector.input)))).toEqual(vector.expected);
    },
  );
});

/** mulberry32 — same seeded PRNG as the frontend suite. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('brand engine mirror — contrast guarantee', () => {
  it('every §F.4.4 pair passes for 500 random seed sets, and every built palette validates', () => {
    const random = prng(20260929);
    const triplet = () =>
      `${Math.floor(random() * 360)} ${Math.floor(random() * 101)}% ${Math.floor(random() * 101)}%`;
    for (let run = 0; run < 500; run += 1) {
      const seeds: BrandSeeds = {
        primary: triplet(),
        ...(random() < 0.6 ? { secondary: triplet() } : {}),
        ...(random() < 0.5 ? { accent: triplet() } : {}),
      };
      const variant = BRAND_PALETTE_VARIANTS[run % BRAND_PALETTE_VARIANTS.length];
      const derived = deriveBrandPalette(seeds, { variant });
      expect(derived.report.pairs.filter((pair) => !pair.pass)).toEqual([]);
      expect(
        validateBrandPalette(buildBrandPalette({ seeds, source: 'logo', variant }))
          .issues,
      ).toEqual([]);
    }
  });
});

describe('brand engine mirror — authority', () => {
  const valid = buildBrandPalette({
    seeds: { primary: '221 83% 53%' },
    source: 'manual',
  });

  it('rejects a crafted failing override, with the nearest passing value', () => {
    const crafted = buildBrandPalette({
      seeds: { primary: '221 83% 53%' },
      source: 'manual',
      overrides: { foreground: '0 0% 70%' },
    });
    const result = validateBrandPalette(crafted);
    expect(result.valid).toBe(false);
    expect(result.issues[0]).toMatchObject({
      path: 'overrides.foreground',
      code: 'contrastFailure',
      messageKey: 'website:brand.validation.contrastFailure',
    });
    expect(result.issues[0].suggestion).toMatch(/^\d{1,3} \d{1,3}% \d{1,3}%$/);
  });

  it('rejects a tampered role even when the stored report says it passes', () => {
    const tampered = {
      ...valid,
      roles: { ...valid.roles, ctaForeground: '221 83% 50%' },
    };
    expect(validateBrandPalette(tampered).valid).toBe(false);
  });

  it('rejects injection attempts in colour fields and unknown keys', () => {
    expect(
      validateBrandPalette({
        ...valid,
        roles: { ...valid.roles, cta: '1 1% 1%; }</style>' },
      }).valid,
    ).toBe(false);
    expect(
      validateBrandPalette({ ...valid, overrides: { __proto__x: '0 0% 0%' } }).valid,
    ).toBe(false);
    expect(validateBrandPalette({ ...valid, algorithmVersion: 'bp-2' }).valid).toBe(
      false,
    );
  });
});
