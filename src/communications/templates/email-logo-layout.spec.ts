/**
 * W3 — the email header brand mark (`renderHtmlLayout`): an absolute https
 * logo with explicit width/height and alt, or the academy name as text.
 */
import { renderHtmlLayout, type TemplateRenderContext } from './layout';

function render(
  branding: Partial<TemplateRenderContext['branding']>,
  locale: 'en' | 'ar' = 'en',
) {
  return renderHtmlLayout(
    { title: 'Hello', paragraphs: ['Body'] },
    {
      locale,
      branding: {
        platformName: 'Atlas',
        platformUrl: 'https://app.atlas.test/',
        ...branding,
      },
      actionUrl: null,
      settingsUrl: 'https://app.atlas.test/dashboard/profile',
    },
  );
}

const LOGO = 'https://app.atlas.test/api/v1/public/websites/a1/logo?v=0123456789abcdef';

describe('email layout — academy logo', () => {
  it('renders the logo with width, height, alt and an email-safe inline reset', () => {
    const html = render({
      academyName: 'Horizon <Academy>',
      academyLogoUrl: LOGO,
      academyLogoWidth: 120,
      academyLogoHeight: 40,
    });
    const img = /<img [^>]*>/.exec(html)?.[0] ?? '';
    expect(img).toContain(`src="${LOGO.replace(/&/g, '&amp;')}"`);
    expect(img).toContain('width="120"');
    expect(img).toContain('height="40"');
    // alt is the escaped academy name.
    expect(img).toContain('alt="Horizon &lt;Academy&gt;"');
    expect(img).toContain('display:block;border:0;outline:none;text-decoration:none;');
    expect(img).toContain('width:120px;');
    expect(img).toContain('max-width:200px;');
  });

  it('keeps height-only sizing when no width is known', () => {
    const html = render({ academyName: 'Horizon', academyLogoUrl: LOGO });
    const img = /<img [^>]*>/.exec(html)?.[0] ?? '';
    expect(img).toContain('height="40"');
    expect(img).not.toContain(' width="');
  });

  it('falls back to the academy name as text when there is no usable logo', () => {
    const html = render({ academyName: 'Horizon' });
    expect(html).not.toContain('<img');
    expect(html).toContain('>Horizon</span>');
  });

  it('never puts a data: URI, a relative path or a script scheme into <img src>', () => {
    for (const bad of [
      'data:image/png;base64,AAAA',
      '/api/v1/public/media/academies/a/b.png',
      '//protocol-relative.example/logo.png',
      'javascript:alert(1)',
    ]) {
      const html = render({ academyName: 'Horizon', academyLogoUrl: bad });
      expect(html).not.toContain('<img');
      expect(html).toContain('>Horizon</span>');
    }
  });

  it('uses the platform name when no academy is attached, in both locales', () => {
    expect(render({})).toContain('>Atlas</span>');
    const ar = render({ academyName: 'أكاديمية', academyLogoUrl: LOGO }, 'ar');
    expect(ar).toContain('dir="rtl"');
    expect(ar).toContain('alt="أكاديمية"');
  });
});
