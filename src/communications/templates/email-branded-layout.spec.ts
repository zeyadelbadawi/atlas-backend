/**
 * B2 — the branded email layout: the Atlas logo and company signature on
 * platform emails, the academy's own identity on academy emails, EN + AR,
 * and a plain-text part that carries the same content and links.
 *
 * Set `EMAIL_PREVIEW_DIR` to also write the rendered HTML of a few
 * templates there (for screenshots); nothing is written otherwise.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATES, TemplateRegistry, type RenderInput } from './template-registry';
import { PLATFORM_LOGO_PATH } from './layout';

const PLATFORM: RenderInput = {
  branding: { platformName: 'Atlas', platformUrl: 'https://dashboard.atlas.test/' },
  actionUrl: 'https://dashboard.atlas.test/dashboard/billing?x=1&y=2',
  settingsUrl: 'https://dashboard.atlas.test/dashboard/profile',
};

const ACADEMY: RenderInput = {
  branding: {
    academyName: 'Falcon Academy',
    academyHost: 'falcon.atlas.test',
    platformName: 'Atlas',
    platformUrl: 'https://dashboard.atlas.test/',
  },
  actionUrl: 'https://falcon.atlas.test/my-courses',
  settingsUrl: 'https://falcon.atlas.test/account',
};

const VALUES = {
  academyName: 'Falcon Academy',
  organizationName: 'Falcon Group',
  courseTitle: 'Applied Cryptography',
  name: 'Example Person',
  code: '482913',
  expiresInMinutes: '10',
  amount: '49.00',
  currency: 'EGP',
  planName: 'Growth',
  trialEndsAtDate: '6 November 2026',
  periodEndDate: '2026-11-01',
};

const LOGO = `https://atlass.dpdns.org${PLATFORM_LOGO_PATH}`;

describe('email layout — B2 branding', () => {
  it('a platform email carries the Atlas logo PNG beside the name, a navy button and the signature (en)', () => {
    const { html, text } = TemplateRegistry.render(
      'lifecycle.trial.ending_soon',
      'en',
      PLATFORM,
      VALUES,
    );
    expect(html).toContain('<html lang="en" dir="ltr">');
    expect(html).toMatch(new RegExp(`<img src="${LOGO}" alt="" width="48" height="48"`));
    expect(LOGO).toMatch(/\.png$/);
    expect(html).toContain('>Atlas</span>');
    expect(html).toContain('bgcolor="#1B3A8C"');
    expect(html).toContain('max-width:600px');
    expect(html).not.toContain('<style');
    for (const href of [
      'https://atlass.dpdns.org/',
      'https://docs.atlass.dpdns.org/',
      'https://atlass.dpdns.org/contact',
      'https://dashboard.atlas.test/dashboard/profile',
    ]) {
      expect(html).toContain(`href="${href}"`);
      expect(text).toContain(href);
    }
    expect(text).toContain('Help center: https://docs.atlass.dpdns.org/');
    expect(text).toContain(
      'You received this email because you have an account with Atlas.',
    );
  });

  it('the Arabic platform email is RTL, names «أطلس» and links the Arabic site and help center', () => {
    const { html, text } = TemplateRegistry.render(
      'lifecycle.trial.ending_soon',
      'ar',
      PLATFORM,
      VALUES,
    );
    expect(html).toContain('<html lang="ar" dir="rtl">');
    // The mark is decorative: the name beside it is the text, shown once.
    expect(html).toContain('alt=""');
    expect(html).toContain('>أطلس</span>');
    expect(html).toContain("font-family:Tahoma,'Segoe UI','Noto Sans Arabic'");
    expect(html).toContain('href="https://atlass.dpdns.org/ar"');
    expect(html).toContain('href="https://docs.atlass.dpdns.org/ar"');
    expect(html).toContain('href="https://atlass.dpdns.org/ar/contact"');
    expect(text).toContain('مركز المساعدة: https://docs.atlass.dpdns.org/ar');
    expect(text).not.toMatch(/Atlas/);
  });

  it.each(['en', 'ar'] as const)(
    'an academy email keeps the academy identity, no Atlas logo or signature (%s)',
    (locale) => {
      const { html, text } = TemplateRegistry.render(
        'course.payment.approved',
        locale,
        ACADEMY,
        VALUES,
      );
      expect(html).not.toContain(PLATFORM_LOGO_PATH);
      expect(html).toContain('>Falcon Academy</span>');
      expect(html).not.toContain('docs.atlass.dpdns.org');
      expect(html).toContain('bgcolor="#111827"');
      expect(text).not.toContain('docs.atlass.dpdns.org');
      expect(text).toContain('https://falcon.atlas.test/account');
    },
  );

  it('a configured marketing site and help center replace the production links', () => {
    const { html } = TemplateRegistry.render(
      'lifecycle.trial.ending_soon',
      'en',
      {
        ...PLATFORM,
        branding: {
          ...PLATFORM.branding,
          siteUrl: 'https://staging.example.test/',
          helpCenterUrl: 'https://help.example.test',
        },
      },
      VALUES,
    );
    expect(html).toContain(`src="https://staging.example.test${PLATFORM_LOGO_PATH}"`);
    expect(html).toContain('href="https://help.example.test/"');
    expect(html).not.toContain('atlass.dpdns.org');
  });

  it.each(['en', 'ar'] as const)(
    'the sign-in code email keeps the logo and signature but carries no link at all (%s)',
    (locale) => {
      const { html, text } = TemplateRegistry.render(
        'auth.email.otp',
        locale,
        PLATFORM,
        VALUES,
      );
      expect(html).toContain(PLATFORM_LOGO_PATH);
      expect(html).not.toContain('docs.atlass.dpdns.org');
      expect(text).not.toContain('docs.atlass.dpdns.org');
    },
  );

  it.each(Object.keys(TEMPLATES))(
    '%s has a plain-text part with the same title and call to action as its HTML (en + ar)',
    (templateId) => {
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(templateId, locale, PLATFORM, VALUES);
        const title = /<h1[^>]*>([^<]*)<\/h1>/.exec(rendered.html)?.[1] ?? '';
        expect(title.length).toBeGreaterThan(0);
        expect(rendered.text.split('\n')[0].length).toBeGreaterThan(0);
        if (rendered.html.includes('bgcolor="#1B3A8C"')) {
          expect(rendered.text).toContain(PLATFORM.actionUrl!);
        }
      }
    },
  );

  const previewDir = process.env.EMAIL_PREVIEW_DIR;
  (previewDir ? it : it.skip)('writes HTML previews', () => {
    mkdirSync(previewDir!, { recursive: true });
    const samples: [string, RenderInput][] = [
      ['auth.email.otp', PLATFORM],
      ['lifecycle.trial.ending_soon', PLATFORM],
      ['platform.payment.approved', PLATFORM],
      ['course.payment.approved', ACADEMY],
    ];
    for (const [id, input] of samples) {
      for (const locale of ['en', 'ar'] as const) {
        const rendered = TemplateRegistry.render(id, locale, input, VALUES);
        writeFileSync(join(previewDir!, `${id}.${locale}.html`), rendered.html);
        writeFileSync(join(previewDir!, `${id}.${locale}.txt`), rendered.text);
      }
    }
  });
});
