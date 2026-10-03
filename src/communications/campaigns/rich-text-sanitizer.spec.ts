import {
  decodeEntities,
  excerpt,
  plainTextToHtml,
  safeHref,
  sanitizeRichText,
  styleForEmail,
} from './rich-text-sanitizer';

describe('sanitizeRichText (W3-compose allowlist)', () => {
  it('keeps the allowlisted structure', () => {
    const { html, text } = sanitizeRichText(
      '<p>Hello <strong>world</strong> and <em>you</em></p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(html).toBe(
      '<p>Hello <strong>world</strong> and <em>you</em></p><ul><li>One</li><li>Two</li></ul>',
    );
    expect(text).toBe('Hello world and you\n\n- One\n- Two');
  });

  it('maps equivalent spellings to one tag (b→strong, i→em, div→p, h1→h2)', () => {
    expect(sanitizeRichText('<div><b>x</b><i>y</i></div><h1>T</h1>').html).toBe(
      '<p><strong>x</strong><em>y</em></p><h2>T</h2>',
    );
  });

  it('removes script, style and iframe elements together with their content', () => {
    const { html, text } = sanitizeRichText(
      '<p>a</p><script>alert(1)</script><style>p{}</style><iframe src="https://x"></iframe><p>b</p>',
    );
    expect(html).toBe('<p>a</p><p>b</p>');
    expect(text).not.toContain('alert');
  });

  it('drops an unterminated script and everything after it (fails closed)', () => {
    expect(sanitizeRichText('<p>ok</p><script>steal()').html).toBe('<p>ok</p>');
  });

  it('strips every attribute: event handlers, style, class, id', () => {
    const { html } = sanitizeRichText(
      '<p onclick="x()" style="color:red" class="c" id="i">t</p><strong onmouseover=y>u</strong>',
    );
    expect(html).toBe('<p>t</p><strong>u</strong>');
  });

  it('drops images entirely (no tracking pixels)', () => {
    expect(
      sanitizeRichText('<p>a<img src="https://t.example/p.gif" onerror="x">b</p>').html,
    ).toBe('<p>ab</p>');
  });

  it('keeps https and mailto links, with rel/target, and nothing else', () => {
    const { html, text } = sanitizeRichText(
      '<a href="https://atlas.example/path?q=1" onclick="x">Go</a> <a href="mailto:hi@example.com">Mail</a>',
    );
    expect(html).toBe(
      '<a href="https://atlas.example/path?q=1" rel="noopener noreferrer nofollow" target="_blank">Go</a> ' +
        '<a href="mailto:hi@example.com" rel="noopener noreferrer nofollow" target="_blank">Mail</a>',
    );
    expect(text).toContain('Go (https://atlas.example/path?q=1)');
  });

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'java\tscript:alert(1)',
    'java&#x09;script:alert(1)',
    '&#106;avascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'http://plain.example',
    '//protocol-relative.example',
    '/relative',
    'https://user:pass@evil.example',
  ])('turns an unsafe link (%s) into plain text', (href) => {
    const { html } = sanitizeRichText(`<a href="${href}">click</a>`);
    expect(html).toBe('click');
  });

  it('escapes markup that is not an allowlisted tag instead of emitting it', () => {
    const { html, text } = sanitizeRichText('5 < 6 and <unknown>tag</unknown> &lt;b&gt;');
    expect(html).toBe('5 &lt; 6 and tag &lt;b&gt;');
    expect(text).toBe('5 < 6 and tag <b>');
  });

  it('removes comments, doctype and CDATA', () => {
    expect(
      sanitizeRichText('<!doctype html><!-- hidden --><p>v</p><![CDATA[x]]>').html,
    ).toBe('<p>v</p>');
  });

  it('balances nesting: closes unclosed tags, ignores stray closers', () => {
    expect(sanitizeRichText('<p><strong>bold</p></em>tail').html).toBe(
      '<p><strong>bold</strong></p>tail',
    );
  });

  it('does not nest links', () => {
    expect(
      sanitizeRichText(
        '<a href="https://a.example">a<a href="https://b.example">b</a></a>',
      ).html,
    ).toBe(
      '<a href="https://a.example/" rel="noopener noreferrer nofollow" target="_blank">ab</a>',
    );
  });

  it('bounds the nesting depth', () => {
    const deep = '<blockquote>'.repeat(40) + 'x' + '</blockquote>'.repeat(40);
    const { html } = sanitizeRichText(deep);
    expect((html.match(/<blockquote>/g) ?? []).length).toBeLessThanOrEqual(16);
  });

  it('numbers ordered lists in the text twin', () => {
    expect(sanitizeRichText('<ol><li>a</li><li>b</li></ol>').text).toBe('1. a\n2. b');
  });

  it('removes empty blocks left behind', () => {
    expect(sanitizeRichText('<p></p><p> </p><ul></ul><p>x</p>').html).toBe('<p>x</p>');
  });

  it('never lets an attribute break out of a quoted href', () => {
    const { html } = sanitizeRichText(
      '<a href="https://a.example/&quot;onmouseover=&quot;x">t</a>',
    );
    expect(html).not.toContain('onmouseover="');
    expect(html).toContain('%22onmouseover=%22x');
  });
});

describe('helpers', () => {
  it('decodeEntities refuses NUL and surrogates', () => {
    expect(decodeEntities('a&#0;b&#xD800;c&amp;')).toBe('abc&');
  });

  it('safeHref normalises a valid https URL', () => {
    expect(safeHref('https://Example.com')).toBe('https://example.com/');
  });

  it('plainTextToHtml escapes and keeps line breaks', () => {
    expect(plainTextToHtml('a <b>\nline\n\nnext')).toBe(
      '<p>a &lt;b&gt;<br>line</p><p>next</p>',
    );
  });

  it('styleForEmail adds inline styles only to sanitizer-emitted tags', () => {
    const styled = styleForEmail(
      sanitizeRichText('<p>x <a href="https://a.example">y</a></p>').html,
    );
    expect(styled).toMatch(
      /^<p style="[^"]+">x <a style="[^"]+" href="https:\/\/a.example\/"/,
    );
  });

  it('excerpt truncates on a word boundary with an ellipsis', () => {
    expect(excerpt('one two three four five', 12)).toBe('one two…');
    expect(excerpt('short', 12)).toBe('short');
  });
});
