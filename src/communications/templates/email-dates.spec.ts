/**
 * B2 — dates in emails are written in the email's language, on Cairo time:
 * the services hand templates `2026-11-06 23:35 UTC`, which used to reach
 * Arabic readers as is.
 */
import { formatEmailDate } from './layout';
import { TemplateRegistry, type RenderInput } from './template-registry';

const PLATFORM: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://dashboard.atlas.test/' },
  actionUrl: 'https://dashboard.atlas.test/dashboard/tenant/subscription',
  settingsUrl: 'https://dashboard.atlas.test/dashboard/profile',
};

describe('formatEmailDate', () => {
  it('writes an instant on Cairo time, in English and in Arabic with Latin digits', () => {
    // 23:35 UTC is 01:35 the next day in Cairo (UTC+2 in November).
    expect(formatEmailDate('2026-11-06 23:35 UTC', 'en')).toBe(
      '7 November 2026 at 01:35 (Cairo time)',
    );
    expect(formatEmailDate('2026-11-06 23:35 UTC', 'ar')).toBe(
      '7 نوفمبر 2026 في 1:35 ص (بتوقيت القاهرة)',
    );
  });

  it('writes a bare calendar day without shifting it', () => {
    expect(formatEmailDate('2026-11-06', 'en')).toBe('6 November 2026');
    expect(formatEmailDate('2026-11-06', 'ar')).toBe('6 نوفمبر 2026');
  });

  it('returns anything else unchanged', () => {
    for (const value of [
      '',
      'tomorrow',
      '2026-11-06T23:35:00Z',
      '2026-13-45 99:99 UTC x',
      '2026-13-01 10:00 UTC',
      '2026-02-31',
    ]) {
      expect(formatEmailDate(value, 'ar')).toBe(value);
    }
  });
});

describe('lifecycle emails', () => {
  const values = { planName: 'Growth', trialEndsAtDate: '2026-11-06 23:35 UTC' };

  it('show the trial end date in Arabic in the Arabic email, text and HTML', () => {
    const { html, text } = TemplateRegistry.render(
      'lifecycle.trial.ending_soon',
      'ar',
      PLATFORM,
      values,
    );
    for (const part of [html, text]) {
      expect(part).toContain('7 نوفمبر 2026 في 1:35 ص (بتوقيت القاهرة)');
      expect(part).not.toContain('2026-11-06 23:35 UTC');
    }
  });

  it('show it in English in the English email', () => {
    const { text, subject } = TemplateRegistry.render(
      'lifecycle.trial.ending_soon',
      'en',
      PLATFORM,
      values,
    );
    expect(text).toContain('7 November 2026 at 01:35 (Cairo time)');
    expect(subject).toBe('Your trial ends tomorrow');
  });
});
