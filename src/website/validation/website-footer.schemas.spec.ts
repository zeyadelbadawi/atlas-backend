/**
 * Footer social links name their platform (`platform`) so the public site
 * can draw its icon. Links saved before the picker (label + URL only) stay
 * valid, an unknown platform is refused, and the URL keeps its safety
 * check.
 */
import { SOCIAL_PLATFORMS, websiteFooterSchema } from './website-config.schemas';

const footer = (socialLinks: unknown[]) => ({ groups: [], socialLinks });

describe('websiteFooterSchema — social links', () => {
  it.each(SOCIAL_PLATFORMS)('keeps platform "%s"', (platform) => {
    const result = websiteFooterSchema.safeParse(
      footer([
        { id: 's1', label: { en: 'x', ar: '' }, url: 'https://example.com/a', platform },
      ]),
    );
    expect(result.success).toBe(true);
    expect(result.success && result.data.socialLinks[0].platform).toBe(platform);
  });

  it('keeps a legacy link with no platform unchanged', () => {
    const legacy = {
      id: 's1',
      label: { en: 'Facebook', ar: '' },
      url: 'https://facebook.com/acme',
    };
    const result = websiteFooterSchema.safeParse(footer([legacy]));
    expect(result.success).toBe(true);
    expect(result.success && result.data.socialLinks[0]).toEqual(legacy);
  });

  it('refuses a platform outside the catalogue', () => {
    const result = websiteFooterSchema.safeParse(
      footer([
        {
          id: 's1',
          label: { en: 'x', ar: '' },
          url: 'https://example.com',
          platform: 'myspace',
        },
      ]),
    );
    expect(result.success).toBe(false);
  });

  it.each(['javascript:alert(1)', 'data:text/html,hi', 'not a url'])(
    'refuses the URL %s',
    (url) => {
      const result = websiteFooterSchema.safeParse(
        footer([{ id: 's1', label: { en: 'x', ar: '' }, url, platform: 'facebook' }]),
      );
      expect(result.success).toBe(false);
    },
  );
});
