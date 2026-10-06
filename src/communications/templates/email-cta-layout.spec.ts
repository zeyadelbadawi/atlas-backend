/**
 * Production QA Issue 3 — the call-to-action every email shares
 * (`renderHtmlLayout`). The whole button is the link (a bulletproof table
 * cell with the link filling it), and the address under it is a real link
 * too — never plain text a phone cannot tap.
 */
import { renderHtmlLayout, type TemplateRenderContext } from './layout';

const URL_WITH_QUERY = 'https://academy.example/reset-password?token=abc&x=1';

function render(locale: 'en' | 'ar' = 'en') {
  const context: TemplateRenderContext = {
    locale,
    branding: { platformName: 'Atlas', platformUrl: 'https://app.atlas.test/' },
    actionUrl: URL_WITH_QUERY,
    settingsUrl: 'https://app.atlas.test/dashboard/profile',
  };
  return renderHtmlLayout(
    {
      title: 'Reset your password',
      paragraphs: ['Body'],
      cta: { label: 'Reset <password>', url: URL_WITH_QUERY },
    },
    context,
  );
}

const ESCAPED = URL_WITH_QUERY.replace(/&/g, '&amp;');

describe('email layout — call to action', () => {
  it.each(['en', 'ar'] as const)(
    '%s: the button cell is coloured and its link fills it',
    (locale) => {
      const html = render(locale);
      const cell = /<td [^>]*bgcolor="#111827"[^>]*>(.*?)<\/td>/.exec(html);
      expect(cell).not.toBeNull();
      const link = /<a [^>]*>/.exec(cell![1])?.[0] ?? '';
      expect(link).toContain(`href="${ESCAPED}"`);
      expect(link).toContain('display:block');
      // Escaped exactly once, label included.
      expect(html).not.toContain('&amp;amp;');
      expect(cell![1]).toContain('Reset &lt;password&gt;');
    },
  );

  it('prints the address under the button as a link to the same place', () => {
    const html = render();
    const links = [...html.matchAll(/<a href="([^"]+)"[^>]*>([^<]*)<\/a>/g)];
    const fallback = links.find(([, , text]) => text === ESCAPED);
    expect(fallback?.[1]).toBe(ESCAPED);
  });
});
