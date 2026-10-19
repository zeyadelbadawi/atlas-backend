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

  describe('linear time (security review finding 3)', () => {
    // Each shape used to be quadratic (text-twin re-joins per block,
    // ambiguous tag-attribute quantifiers, `<!` and blank-run scans).
    // Budgets are relative to the runner, not absolute: a shared CI runner is
    // several times slower than a laptop, so "50 KB in under 100 ms" failed
    // on runner speed alone (102-113 ms on 13 Oct 2026). A quadratic
    // regression is still caught twice over: it grows ~100x when the input
    // grows 10x, and at the 50 KB body cap it costs far more than a normal
    // 50 KB message measured on the same runner.
    const SIZE = 50_000; // CAMPAIGN_BODY_HTML_MAX_BYTES
    const ADVERSARIAL: Record<string, (size: number) => string> = {
      paragraphs: (n) => '<p>x'.repeat(n / 4),
      listItems: (n) => '<ol>' + '<li>x'.repeat(n / 5),
      breaks: (n) => 'x<br>'.repeat(n / 5),
      closedParagraphs: (n) => '<p>x</p>'.repeat(n / 8),
      tagThenSpaces: (n) => '<a' + ' '.repeat(n),
      unterminatedBang: (n) => '<!x'.repeat(n / 3),
      blankRuns: (n) => ' <b>'.repeat(n / 4),
      quotes: (n) => '<a href=' + '"'.repeat(n),
      nestedLists: (n) => '<ul><li>'.repeat(n / 8),
    };
    /** 10x the input may cost at most this many times as much (linear ≈ 10, quadratic ≈ 100). */
    const MAX_GROWTH_FOR_10X = 25;
    /** An adversarial 50 KB body may cost at most this many times a normal 50 KB message (measured: 1-4x). */
    const MAX_COST_VS_BENIGN = 15;
    /** Hard ceiling at full size: catches a catastrophic regression on any runner. */
    const CEILING_MS = 1_000;
    /**
     * Below this a measurement is timer noise, so growth is measured from
     * here. 2 ms, not 1: the 5 KB sample runs in about 1 ms, so with a 1 ms
     * floor one slow sample alone moved the ratio past 25 on a shared CI
     * runner (27.6x on 19 Oct 2026). Quadratic still reads about 50x.
     */
    const NOISE_FLOOR_MS = 2;

    /** Best of five, so a GC pause on a shared runner is not a failure. */
    function fastestMs(input: string): number {
      let best = Infinity;
      for (let i = 0; i < 5; i += 1) {
        const started = performance.now();
        sanitizeRichText(input);
        best = Math.min(best, performance.now() - started);
      }
      return best;
    }

    /** A normal message body of the same size, timed on the same runner (set in beforeAll). */
    let benignMs = NOISE_FLOOR_MS;

    function expectLinear(build: (size: number) => string): void {
      const small = fastestMs(build(SIZE / 10));
      const full = fastestMs(build(SIZE));
      expect(full).toBeLessThan(CEILING_MS);
      expect(full / Math.max(small, NOISE_FLOOR_MS)).toBeLessThan(MAX_GROWTH_FOR_10X);
      expect(full / benignMs).toBeLessThan(MAX_COST_VS_BENIGN);
    }

    beforeAll(() => {
      sanitizeRichText('<p>warm-up</p>'.repeat(200));
      const paragraph =
        '<p>Hello <strong>class</strong>, the next lesson is on ' +
        '<a href="https://example.com/schedule">Thursday</a>.</p>';
      const benign = paragraph.repeat(Math.ceil(SIZE / paragraph.length)).slice(0, SIZE);
      benignMs = Math.max(fastestMs(benign), NOISE_FLOOR_MS);
    });

    it.each(Object.entries(ADVERSARIAL))(
      '%s (~50 KB) sanitises in linear time',
      (_label, build) => {
        expect(build(SIZE).length).toBeGreaterThanOrEqual(SIZE * 0.99);
        expectLinear(build);
      },
    );

    it('re-sanitising stored output stays linear and idempotent', () => {
      const stored = (n: number) => sanitizeRichText('<p>x'.repeat(n / 4)).html;
      expectLinear(stored);
      const first = stored(SIZE);
      expect(sanitizeRichText(first).html).toBe(first);
    });

    it('keeps the text twin identical to the block structure', () => {
      expect(sanitizeRichText('<p>a<p>b<ul><li>c<li>d</ul><p>e<br>f').text).toBe(
        'a\n\nb\n\n- c\n- d\n\ne\nf',
      );
      expect(sanitizeRichText('<br/>x<br />y').html).toBe('<br>x<br>y');
    });
  });
});
