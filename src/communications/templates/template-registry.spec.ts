/**
 * What this protects: the email a person actually receives.
 *
 * Every template in the registry is rendered here in BOTH locales, because
 * the failure modes are all silent from the dispatcher's point of view:
 *
 *  - a missing `ar` half throws inside the worker, so an Arabic-speaking
 *    recipient simply never gets the email;
 *  - an Arabic render that forgets `dir="rtl"`/`lang="ar"` produces a
 *    left-to-right Arabic email that is readable only by accident (§24);
 *  - a plain-text part derived by stripping HTML — the thing §24 explicitly
 *    forbids — leaks markup into the text/plain alternative, which is what
 *    a screen reader, a text-only client and most spam filters read; the
 *    `<`-free assertion below is the cheap, total check for it;
 *  - an un-escaped value turns any title a user can set (a course name, a
 *    support-case subject) into HTML injection in someone's inbox;
 *  - and `version` is recorded on every `communication_deliveries` row, so
 *    a template id/version that is absent or unstable makes "which copy did
 *    this person actually receive" unanswerable after a copy change.
 */
import { TEMPLATES, TemplateRegistry, DIGEST_TEMPLATE } from './template-registry';
import type { RenderInput } from './template-registry';
import {
  COMMUNICATION_EVENT_KEYS,
  COMMUNICATION_CATALOG,
} from '../catalog/communication-catalog';

const TEMPLATE_IDS = Object.keys(TEMPLATES);

const PLATFORM_INPUT: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://platform.test' },
  actionUrl: 'https://platform.test/dashboard/billing',
  settingsUrl: 'https://platform.test/settings/notifications',
};

const ACADEMY_INPUT: RenderInput = {
  branding: {
    academyName: 'Falcon Academy',
    academyLogoUrl: 'https://cdn.test/logo.png',
    academyHost: 'falcon.atlas.test',
    platformName: 'Atlas',
    platformUrl: 'https://platform.test',
  },
  actionUrl: 'https://falcon.atlas.test/ar/my/certificates',
  settingsUrl: 'https://falcon.atlas.test/ar/settings/notifications',
};

/**
 * One values bag that satisfies every template — each reads only the keys
 * it knows about, so a superset keeps this table small and makes "a
 * template renders with nothing missing" a single assertion.
 */
const VALUES = {
  academyName: 'Falcon Academy',
  courseTitle: 'Applied Cryptography',
  verificationCode: 'ATL-1234-5678',
  assignmentTitle: 'Week 3 lab report',
  quizTitle: 'Module 2 quiz',
  score: 88,
  title: 'Live review session',
  startsAt: '2026-09-25T10:00:00.000Z',
  subject: 'Cannot upload a video',
  status: 'resolved',
  stepKey: 'subdomain',
  amount: '49.00',
  currency: 'USD',
  reason: 'Transfer reference did not match',
  items: [
    { subject: 'Your assignment has been graded', url: 'https://falcon.atlas.test/a' },
    { subject: 'Your certificate is ready', url: null },
  ],
};

describe('TemplateRegistry', () => {
  it('has a template for every catalogue key, and `digest.daily` as the only extra', () => {
    const catalogTemplates = new Set(
      COMMUNICATION_EVENT_KEYS.map((key) => COMMUNICATION_CATALOG[key].template),
    );
    for (const template of catalogTemplates) {
      expect(TemplateRegistry.has(template)).toBe(true);
    }
    const extras = TEMPLATE_IDS.filter((id) => !catalogTemplates.has(id));
    expect(extras).toEqual([DIGEST_TEMPLATE]);
  });

  it('throws on an unknown template id rather than sending an empty email', () => {
    expect(() =>
      TemplateRegistry.render('no.such.template', 'en', PLATFORM_INPUT),
    ).toThrow(/Unknown communication template: no\.such\.template/);
  });

  it('reports `has` honestly, including for inherited Object properties', () => {
    expect(TemplateRegistry.has(DIGEST_TEMPLATE)).toBe(true);
    expect(TemplateRegistry.has('constructor')).toBe(false);
    expect(TemplateRegistry.has('toString')).toBe(false);
  });

  describe.each(TEMPLATE_IDS)('%s', (templateId) => {
    it.each(['en', 'ar'] as const)(
      'renders a non-empty subject, text and html in %s',
      (locale) => {
        const rendered = TemplateRegistry.render(
          templateId,
          locale,
          locale === 'ar' ? ACADEMY_INPUT : PLATFORM_INPUT,
          VALUES,
        );
        expect(rendered.subject.trim().length).toBeGreaterThan(0);
        expect(rendered.text.trim().length).toBeGreaterThan(0);
        expect(rendered.html.trim().length).toBeGreaterThan(0);
        // Nothing may render the literal `undefined` — `str()` exists to
        // make a missing value an empty string, not the word.
        expect(rendered.subject).not.toMatch(/undefined/);
        expect(rendered.text).not.toMatch(/undefined/);
      },
    );

    it('renders a different subject per locale (the ar half is real copy, not the en one)', () => {
      const en = TemplateRegistry.render(templateId, 'en', PLATFORM_INPUT, VALUES);
      const ar = TemplateRegistry.render(templateId, 'ar', PLATFORM_INPUT, VALUES);
      expect(ar.subject).not.toBe(en.subject);
      // Arabic copy contains Arabic script.
      expect(ar.subject).toMatch(/[؀-ۿ]/);
    });

    it('marks the Arabic html as rtl and lang="ar"', () => {
      const { html } = TemplateRegistry.render(templateId, 'ar', ACADEMY_INPUT, VALUES);
      expect(html).toContain('lang="ar"');
      expect(html).toContain('dir="rtl"');
      expect(html).not.toContain('dir="ltr"');
    });

    it('marks the English html as ltr and lang="en"', () => {
      const { html } = TemplateRegistry.render(templateId, 'en', PLATFORM_INPUT, VALUES);
      expect(html).toContain('lang="en"');
      expect(html).toContain('dir="ltr"');
      expect(html).not.toContain('dir="rtl"');
    });

    it.each(['en', 'ar'] as const)(
      'builds the %s text part from copy, never by stripping the html',
      (locale) => {
        const { text } = TemplateRegistry.render(
          templateId,
          locale,
          PLATFORM_INPUT,
          VALUES,
        );
        expect(text).not.toContain('<');
        expect(text).not.toContain('&amp;');
        // The footer §24 requires is part of the text alternative too.
        expect(text).toContain(PLATFORM_INPUT.settingsUrl);
      },
    );

    it.each(['en', 'ar'] as const)(
      'stamps a stable `templateId@version` on the %s render',
      (locale) => {
        const first = TemplateRegistry.render(templateId, locale, PLATFORM_INPUT, VALUES);
        const second = TemplateRegistry.render(templateId, locale, ACADEMY_INPUT, VALUES);
        expect(first.version).toBe(`${templateId}@${TEMPLATES[templateId].version}`);
        // Neither branding nor values may change what gets recorded on the
        // delivery row — only a copy change (a version bump) may.
        expect(second.version).toBe(first.version);
        expect(TEMPLATES[templateId].version.length).toBeGreaterThan(0);
      },
    );

    it('renders with an empty values bag rather than throwing', () => {
      expect(() =>
        TemplateRegistry.render(templateId, 'en', PLATFORM_INPUT, {}),
      ).not.toThrow();
      expect(() =>
        TemplateRegistry.render(templateId, 'ar', PLATFORM_INPUT, {}),
      ).not.toThrow();
    });
  });

  describe('interpolation and escaping', () => {
    it('interpolates the values it was given into both parts', () => {
      const rendered = TemplateRegistry.render(
        'certificate.issued',
        'en',
        ACADEMY_INPUT,
        VALUES,
      );
      expect(rendered.text).toContain('Applied Cryptography');
      expect(rendered.text).toContain('ATL-1234-5678');
      expect(rendered.html).toContain('Applied Cryptography');
      expect(rendered.html).toContain('ATL-1234-5678');
    });

    it('interpolates the Arabic copy with the same values', () => {
      const rendered = TemplateRegistry.render(
        'certificate.issued',
        'ar',
        ACADEMY_INPUT,
        VALUES,
      );
      expect(rendered.text).toContain('Applied Cryptography');
      expect(rendered.html).toContain('ATL-1234-5678');
    });

    it('escapes a value that contains markup instead of emitting it', () => {
      const rendered = TemplateRegistry.render(
        'certificate.issued',
        'en',
        ACADEMY_INPUT,
        {
          ...VALUES,
          courseTitle: '<script>alert(1)</script>',
        },
      );
      expect(rendered.html).not.toContain('<script>');
      expect(rendered.html).toContain('&lt;script&gt;');
      // The text part carries the raw characters (there is no markup to
      // escape in text/plain) — but still no tag the html part would run.
      expect(rendered.text).toContain('alert(1)');
    });

    it('carries the call-to-action url into both parts when the key has one', () => {
      const rendered = TemplateRegistry.render(
        'platform.payment.approved',
        'en',
        PLATFORM_INPUT,
        VALUES,
      );
      expect(rendered.html).toContain(PLATFORM_INPUT.actionUrl);
      expect(rendered.text).toContain(PLATFORM_INPUT.actionUrl);
    });

    it('omits the call-to-action entirely when there is no action url', () => {
      const rendered = TemplateRegistry.render(
        'platform.payment.approved',
        'en',
        { ...PLATFORM_INPUT, actionUrl: null },
        VALUES,
      );
      expect(rendered.html).not.toContain('/dashboard/billing');
      expect(rendered.subject.length).toBeGreaterThan(0);
    });

    it('uses the academy name as the brand when one is supplied, the platform otherwise', () => {
      const academy = TemplateRegistry.render(
        'certificate.issued',
        'en',
        ACADEMY_INPUT,
        VALUES,
      );
      expect(academy.text).toContain('Falcon Academy');
      const platform = TemplateRegistry.render(
        'auth.password.changed',
        'en',
        PLATFORM_INPUT,
        VALUES,
      );
      expect(platform.text).toContain('Atlas');
    });
  });

  describe('digest.daily', () => {
    it('lists every item it was given, in both parts', () => {
      const rendered = TemplateRegistry.render(
        DIGEST_TEMPLATE,
        'en',
        PLATFORM_INPUT,
        VALUES,
      );
      expect(rendered.subject).toContain('2');
      for (const item of VALUES.items) {
        expect(rendered.text).toContain(item.subject);
        expect(rendered.html).toContain(item.subject);
      }
      expect(rendered.html).toContain('https://falcon.atlas.test/a');
    });

    it('renders an item with no url as plain text rather than an empty link', () => {
      const rendered = TemplateRegistry.render(DIGEST_TEMPLATE, 'en', PLATFORM_INPUT, {
        items: [{ subject: 'No link here', url: null }],
      });
      expect(rendered.html).toContain('No link here');
      expect(rendered.html).not.toContain('href="null"');
    });

    it('ignores garbage in `items` instead of throwing', () => {
      expect(() =>
        TemplateRegistry.render(DIGEST_TEMPLATE, 'ar', PLATFORM_INPUT, {
          items: 'not-an-array',
        }),
      ).not.toThrow();
      const rendered = TemplateRegistry.render(DIGEST_TEMPLATE, 'en', PLATFORM_INPUT, {
        items: [null, 42, { subject: 'Kept' }],
      });
      expect(rendered.html).toContain('Kept');
    });
  });
});
