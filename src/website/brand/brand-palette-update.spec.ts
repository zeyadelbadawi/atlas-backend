import { BadRequestException } from '@nestjs/common';
import { resolveBrandUpdate, toPublicBrand } from './brand-palette-update';

const actor = { userId: 'user-1', now: new Date('2026-09-29T10:00:00.000Z') };
const legacy = {
  primaryColor: '221 83% 53%',
  secondaryColor: '221 83% 53%',
  accentColor: '221 83% 53%',
};

function violationsOf(
  fn: () => unknown,
): { field: string; messageKey: string; values?: Record<string, unknown> }[] {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return ((error as BadRequestException).getResponse() as { violations: never[] })
      .violations;
  }
  throw new Error('expected a validation error');
}

describe('brand palette persistence (plan §F.4.3, §F.4.6)', () => {
  it('derives every role server-side, ignoring roles a client sends', () => {
    const next = resolveBrandUpdate(
      legacy,
      {
        palette: {
          seeds: { primary: '24 95% 53%' },
          status: 'proposed',
          source: 'logo',
          roles: { cta: '0 0% 90%' },
          report: { lies: true },
        },
      },
      actor,
    );
    const palette = next.palette as {
      roles: { cta: string };
      algorithmVersion: string;
      report: { lies?: unknown };
    };
    expect(palette.algorithmVersion).toBe('bp-1');
    expect(palette.roles.cta).not.toBe('0 0% 90%');
    expect(palette.report.lies).toBeUndefined();
  });

  it('writes the legacy colours equal to the resolved seeds', () => {
    const next = resolveBrandUpdate(
      legacy,
      {
        palette: {
          seeds: { primary: '262 70% 50%', secondary: '330 75% 55%' },
          status: 'proposed',
          source: 'manual',
        },
      },
      actor,
    );
    expect(next.primaryColor).toBe('262 70% 50%');
    expect(next.secondaryColor).toBe('330 75% 55%');
    // No accent seed: the harmony-filled one, so the field is never empty.
    expect(next.accentColor).toMatch(/^\d{1,3} \d{1,3}% \d{1,3}%$/);
  });

  it('stamps confirmation from the server, not the request, and keeps it on an identical re-save', () => {
    const input = {
      seeds: { primary: '221 83% 53%' },
      status: 'confirmed',
      source: 'manual',
      confirmedBy: 'someone-else',
      confirmedAt: '1999-01-01T00:00:00.000Z',
    };
    const first = resolveBrandUpdate(legacy, { palette: input }, actor);
    expect(first.palette).toMatchObject({
      confirmedBy: 'user-1',
      confirmedAt: actor.now.toISOString(),
    });
    const later = { userId: 'user-2', now: new Date('2026-10-01T00:00:00.000Z') };
    const again = resolveBrandUpdate(first, { palette: input }, later);
    expect(again.palette).toMatchObject({
      confirmedBy: 'user-1',
      confirmedAt: actor.now.toISOString(),
    });
  });

  it('refuses a failing role override with the pair and the nearest passing value', () => {
    const violations = violationsOf(() =>
      resolveBrandUpdate(
        legacy,
        {
          palette: {
            seeds: { primary: '221 83% 53%' },
            overrides: { link: '221 83% 80%' },
            status: 'confirmed',
            source: 'manual',
          },
        },
        actor,
      ),
    );
    expect(violations[0]).toMatchObject({
      field: 'brand.palette.overrides.link',
      messageKey: 'website:brand.validation.contrastFailure',
      values: { fg: 'link', required: 4.5 },
    });
    expect(violations[0].values?.suggestion).toMatch(/^\d{1,3} \d{1,3}% \d{1,3}%$/);
  });

  it('refuses malformed input with field paths', () => {
    const violations = violationsOf(() =>
      resolveBrandUpdate(
        legacy,
        { palette: { seeds: { primary: 'red' }, status: 'maybe', source: 'manual' } },
        actor,
      ),
    );
    expect(violations.map((v) => v.field).sort()).toEqual([
      'brand.palette.seeds.primary',
      'brand.palette.status',
    ]);
  });

  it('keeps palette and legacy colours in step when an older client edits a legacy colour', () => {
    const withPalette = resolveBrandUpdate(
      legacy,
      {
        palette: {
          seeds: { primary: '221 83% 53%' },
          overrides: { link: '221 83% 30%' },
          status: 'confirmed',
          source: 'manual',
        },
      },
      actor,
    );
    const next = resolveBrandUpdate(withPalette, { primaryColor: '150 70% 35%' }, actor);
    const palette = next.palette as {
      seeds: { primary: string };
      overrides: Record<string, string>;
      roles: { link: string };
    };
    expect(palette.seeds.primary).toBe('150 70% 35%');
    expect(palette.overrides).toEqual({ link: '221 83% 30%' });
    expect(palette.roles.link).toBe('221 83% 30%');
  });

  it('leaves the palette alone when a legacy save changes nothing, and removes it on null', () => {
    const withPalette = resolveBrandUpdate(
      legacy,
      {
        palette: { seeds: { primary: '24 95% 53%' }, status: 'proposed', source: 'logo' },
      },
      actor,
    );
    expect(
      resolveBrandUpdate(withPalette, { darkLogo: 'https://x/y.png' }, actor).palette,
    ).toBe(withPalette.palette);
    const removed = resolveBrandUpdate(withPalette, { palette: null }, actor);
    expect(removed.palette).toBeUndefined();
    expect(removed.primaryColor).toBe(withPalette.primaryColor);
  });

  it('the public configuration never carries who confirmed, when, or the logo analysis', () => {
    const stored = resolveBrandUpdate(
      legacy,
      {
        palette: {
          seeds: { primary: '24 95% 53%' },
          status: 'confirmed',
          source: 'logo',
          extraction: { logoFingerprint: 'a'.repeat(64), candidates: [], flags: [] },
        },
      },
      actor,
    );
    const publicBrand = toPublicBrand(stored);
    expect(publicBrand.palette).not.toHaveProperty('confirmedBy');
    expect(publicBrand.palette).not.toHaveProperty('confirmedAt');
    expect(publicBrand.palette).not.toHaveProperty('extraction');
    expect(publicBrand.palette).toHaveProperty('roles');
    // The stored object is untouched.
    expect(stored.palette).toHaveProperty('confirmedBy', 'user-1');
  });
});
