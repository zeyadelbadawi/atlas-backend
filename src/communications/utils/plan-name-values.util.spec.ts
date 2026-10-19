import { TemplateRegistry } from '../templates/template-registry';
import { planNameValues, resolveLocalizedPlanName } from './plan-name-values.util';

describe('plan names in the recipient language', () => {
  const academy = {
    name: 'Academy',
    nameLocalized: { en: 'Academy', ar: 'الأكاديمية' },
  };

  it('carries the English name and the localized pair', () => {
    expect(planNameValues(academy)).toEqual({
      planName: 'Academy',
      planNameLocalized: { en: 'Academy', ar: 'الأكاديمية' },
    });
  });

  it('falls back to the English name alone when the catalog has no localized text', () => {
    expect(planNameValues({ name: 'Academy', nameLocalized: null })).toEqual({
      planName: 'Academy',
    });
    expect(planNameValues({ name: 'Academy', nameLocalized: { ar: '  ' } })).toEqual({
      planName: 'Academy',
    });
    expect(planNameValues(null)).toEqual({ planName: '' });
  });

  it('swaps planName for the locale, and keeps it when that locale is missing', () => {
    const values = planNameValues(academy);
    expect(resolveLocalizedPlanName(values, 'ar').planName).toBe('الأكاديمية');
    expect(resolveLocalizedPlanName(values, 'en').planName).toBe('Academy');
    const enOnly = { planName: 'Academy', planNameLocalized: { en: 'Academy' } };
    expect(resolveLocalizedPlanName(enOnly, 'ar').planName).toBe('Academy');
  });

  it('an Arabic trial-started email names the plan in Arabic, the English one in English', () => {
    const input = {
      branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
      actionUrl: 'https://platform.test/dashboard',
      settingsUrl: 'https://platform.test/settings/notifications',
    };
    const values = {
      anchorAt: '2026-11-02T09:00:00.000Z',
      trialEndsAtDate: '2026-11-02 09:00 UTC',
      ...planNameValues(academy),
    };
    const ar = TemplateRegistry.render('lifecycle.trial.started', 'ar', input, values);
    const en = TemplateRegistry.render('lifecycle.trial.started', 'en', input, values);
    expect(ar.text).toContain('الأكاديمية');
    expect(ar.text).not.toContain('Academy');
    expect(en.text).toContain('Academy');
  });
});
