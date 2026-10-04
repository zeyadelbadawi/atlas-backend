/**
 * Security review finding 3 — a campaign's body is re-sanitised at render
 * (the row is never trusted), but once per distinct body, not once per
 * recipient.
 */
import * as sanitizer from '../../campaigns/rich-text-sanitizer';
import { campaignBodyEmailHtml } from './campaign-message';

describe('campaignBodyEmailHtml', () => {
  afterEach(() => jest.restoreAllMocks());

  it('still sanitises a stored body that is not what it claims to be', () => {
    const html = campaignBodyEmailHtml(
      '<p onclick="x()">Hi <script>alert(1)</script><a href="javascript:1">l</a></p>',
    );
    expect(html).not.toMatch(/script|onclick|javascript/i);
    expect(html).toMatch(/^<p style="[^"]+">Hi l<\/p>$/);
  });

  it('renders one body once for any number of recipients', () => {
    const spy = jest.spyOn(sanitizer, 'sanitizeRichText');
    const body = `<p>Campaign ${Date.now()}</p>`;
    const first = campaignBodyEmailHtml(body);
    for (let i = 0; i < 500; i += 1) expect(campaignBodyEmailHtml(body)).toBe(first);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('keeps the cache bounded', () => {
    const spy = jest.spyOn(sanitizer, 'sanitizeRichText');
    const oldest = '<p>oldest body</p>';
    campaignBodyEmailHtml(oldest);
    for (let i = 0; i < 40; i += 1) campaignBodyEmailHtml(`<p>body ${i}</p>`);
    spy.mockClear();
    campaignBodyEmailHtml(oldest);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
