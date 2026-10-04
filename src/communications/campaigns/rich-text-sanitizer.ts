/**
 * W3-compose — the server-side allowlist for an author's rich text.
 *
 * WHY HAND-WRITTEN. No HTML sanitiser is a dependency of this backend
 * (checked: no `sanitize-html`, `dompurify`, `xss`, `jsdom`, `parse5` in
 * package.json), and a message body needs very little: paragraphs,
 * emphasis, lists, a heading or two, and links. The frontend already
 * follows the same reasoning for lesson bodies
 * (`atlas/src/features/learner/utils/lesson-html.utils.ts`).
 *
 * WHY IT FAILS CLOSED. The output is REBUILT, never filtered in place:
 *
 *   - the input is cut into tags and text with one strict pattern;
 *   - a tag is emitted only when its name is on the allowlist, and then
 *     with NO attributes except a re-validated `href` on `<a>`;
 *   - every text run is entity-decoded and then re-escaped, so a `<` that
 *     is not part of an allowlisted tag reaches the reader as the
 *     character `<`, never as markup;
 *   - `<script>`, `<style>`, `<template>`, `<iframe>`, `<object>`,
 *     `<textarea>`, `<title>` and `<noscript>` are removed WITH their
 *     content, comments and doctype/processing instructions are removed;
 *   - nesting is tracked on a stack, so the output is always balanced:
 *     a stray closing tag is ignored, an unclosed one is closed at the end.
 *
 * Links: `https:` and `mailto:` only (no `javascript:`, `data:`, `http:`,
 * relative or protocol-relative URLs). No images — a remote image in a
 * broadcast is a tracking pixel or a phishing lure. No `style`, `class`,
 * `id` or event handler attribute ever survives.
 */

const ALLOWED: ReadonlySet<string> = new Set([
  'p',
  'br',
  'strong',
  'em',
  'u',
  's',
  'ul',
  'ol',
  'li',
  'a',
  'h2',
  'h3',
  'blockquote',
]);

/** Equivalent spellings mapped to the one tag the output uses. */
const ALIASES: Readonly<Record<string, string>> = {
  b: 'strong',
  i: 'em',
  strike: 's',
  del: 's',
  div: 'p',
  h1: 'h2',
  h4: 'h3',
  h5: 'h3',
  h6: 'h3',
};

/** Elements whose CONTENT is dropped along with the tags. */
const DROP_WITH_CONTENT = [
  'script',
  'style',
  'template',
  'iframe',
  'object',
  'embed',
  'textarea',
  'title',
  'noscript',
  'svg',
  'math',
  'head',
];

const VOID: ReadonlySet<string> = new Set(['br']);
/** Block elements — each starts a new line in the plain-text twin. */
const BLOCK: ReadonlySet<string> = new Set([
  'p',
  'ul',
  'ol',
  'li',
  'h2',
  'h3',
  'blockquote',
]);

const MAX_DEPTH = 16;
const MAX_HREF = 2_000;

export interface SanitizedRichText {
  /** Balanced allowlist HTML, no attributes but `href`/`rel`/`target` on links. */
  readonly html: string;
  /** Plain-text twin: what a text/plain email part and the in-app excerpt carry. */
  readonly text: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
};

export function decodeEntities(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,8});/gi,
    (match, body: string) => {
      if (body[0] === '#') {
        const code =
          body[1] === 'x' || body[1] === 'X'
            ? Number.parseInt(body.slice(2), 16)
            : Number.parseInt(body.slice(1), 10);
        // Refuse NUL, surrogates and out-of-range code points.
        if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return '';
        if (code >= 0xd800 && code <= 0xdfff) return '';
        return String.fromCodePoint(code);
      }
      const named = NAMED_ENTITIES[body.toLowerCase()];
      return named ?? match;
    },
  );
}

export function escapeHtmlText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * `https:` or `mailto:` only, after entity decoding and with control and
 * whitespace characters removed (the classic `java\tscript:` bypass).
 */
export function safeHref(raw: string): string | null {
  // eslint-disable-next-line no-control-regex
  const decoded = decodeEntities(raw).replace(/[\u0000- \u007f-\u009f]/g, '');
  if (decoded.length === 0 || decoded.length > MAX_HREF) return null;
  const lower = decoded.toLowerCase();
  if (lower.startsWith('mailto:')) {
    return /^mailto:[^<>"'\s]+$/i.test(decoded) ? decoded : null;
  }
  if (!lower.startsWith('https://')) return null;
  try {
    const url = new URL(decoded);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function readHref(attributes: string): string | null {
  const match = /(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(
    attributes,
  );
  if (!match) return null;
  return safeHref(match[1] ?? match[2] ?? match[3] ?? '');
}

function stripDangerousBlocks(input: string): string {
  let out = input
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?(?:\]\]>|$)/gi, '')
    // `[^<>]`, not `[^>]`: an unterminated `<!` must not scan to the end of
    // the input from every `<!` (quadratic on `<!<!<!…`).
    .replace(/<![^<>]*>/g, '')
    .replace(/<\?[\s\S]*?(?:\?>|>|$)/g, '');
  for (const tag of DROP_WITH_CONTENT) {
    const block = new RegExp(`<${tag}\\b[\\s\\S]*?(?:<\\/${tag}\\s*>|$)`, 'gi');
    out = out.replace(block, '');
    // A stray closing tag of the same family is dropped too.
    out = out.replace(new RegExp(`<\\/${tag}\\s*>`, 'gi'), '');
  }
  return out;
}

/**
 * Rebuilds `input` from allowlisted tags and escaped text.
 */
export function sanitizeRichText(input: string): SanitizedRichText {
  const source = stripDangerousBlocks(input ?? '');
  // One unambiguous attribute run (`\s[^<>]*`), then an optional `/`: the
  // old `(\s[^<>]*)?\s*(\/?)>` let two quantifiers share the trailing
  // whitespace, which backtracks quadratically on `<a` + many spaces.
  const tagPattern = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)(\s[^<>]*)?\/?>/g;
  const htmlParts: string[] = [];
  const textParts: string[] = [];
  const stack: { name: string; href?: string }[] = [];
  const listCounters: number[] = [];

  // The text twin's state, tracked incrementally (security review finding
  // 3): re-joining every part per block made sanitising O(n²) — 20 KB of
  // `<p>x` took ~1.5 s.
  let textHasContent = false;
  let trailingNewlines = 0;
  const pushText = (part: string): void => {
    if (!part) return;
    textParts.push(part);
    let newlines = 0;
    while (newlines < part.length && part[part.length - 1 - newlines] === '\n') {
      newlines += 1;
    }
    trailingNewlines = newlines === part.length ? trailingNewlines + newlines : newlines;
    if (!textHasContent && part.trim().length > 0) textHasContent = true;
  };

  /** Makes the text twin end with at least `count` line breaks (none at the very start). */
  const ensureBreak = (count: number): void => {
    if (!textHasContent) return;
    if (trailingNewlines < count) pushText('\n'.repeat(count - trailingNewlines));
  };

  const emitText = (raw: string): void => {
    if (!raw) return;
    const decoded = decodeEntities(raw).split(String.fromCharCode(0)).join('');
    // Collapse source-formatting whitespace the way a browser would.
    const collapsed = decoded.replace(/[\t\r\n ]+/g, ' ');
    if (!collapsed) return;
    htmlParts.push(escapeHtmlText(collapsed));
    pushText(collapsed);
  };

  const close = (name: string): void => {
    const index = stack.map((entry) => entry.name).lastIndexOf(name);
    if (index === -1) return;
    while (stack.length > index) {
      const entry = stack.pop()!;
      htmlParts.push(`</${entry.name}>`);
      if (entry.name === 'a' && entry.href) {
        pushText(` (${entry.href})`);
      }
      if (entry.name === 'ul' || entry.name === 'ol') listCounters.pop();
      if (BLOCK.has(entry.name)) ensureBreak(entry.name === 'li' ? 1 : 2);
    }
  };

  let cursor = 0;
  for (const match of source.matchAll(tagPattern)) {
    emitText(source.slice(cursor, match.index));
    cursor = (match.index ?? 0) + match[0].length;

    const closing = match[1] === '/';
    const rawName = match[2].toLowerCase();
    const name = ALIASES[rawName] ?? rawName;
    if (!ALLOWED.has(name)) continue;

    if (closing) {
      if (!VOID.has(name)) close(name);
      continue;
    }
    if (VOID.has(name)) {
      htmlParts.push('<br>');
      pushText('\n');
      continue;
    }
    // A new paragraph-level block implicitly ends an open paragraph, like a browser.
    if (BLOCK.has(name) && name !== 'li') {
      const top = stack[stack.length - 1];
      if (top && (top.name === 'p' || top.name === 'h2' || top.name === 'h3'))
        close(top.name);
    }
    if (name === 'li') {
      const top = stack[stack.length - 1];
      if (top && top.name === 'li') close('li');
    }
    if (stack.length >= MAX_DEPTH) continue;

    if (name === 'a') {
      // No nested links; a link without a safe href is just its text.
      if (stack.some((entry) => entry.name === 'a')) continue;
      const href = readHref(match[3] ?? '');
      if (!href) continue;
      stack.push({ name, href });
      htmlParts.push(
        `<a href="${escapeHtmlText(href)}" rel="noopener noreferrer nofollow" target="_blank">`,
      );
      continue;
    }

    if (BLOCK.has(name)) ensureBreak(name === 'li' ? 1 : 2);
    if (name === 'ul') listCounters.push(0);
    if (name === 'ol') listCounters.push(1);
    if (name === 'li') {
      const depth = listCounters.length;
      const counter = depth > 0 ? listCounters[depth - 1] : 0;
      if (counter > 0) {
        pushText(`${counter}. `);
        listCounters[depth - 1] = counter + 1;
      } else {
        pushText('- ');
      }
    }
    stack.push({ name });
    htmlParts.push(`<${name}>`);
  }
  emitText(source.slice(cursor));
  while (stack.length > 0) close(stack[stack.length - 1].name);

  const html = htmlParts
    .join('')
    // Empty blocks left by stripped content carry nothing for the reader.
    .replace(/<(p|h2|h3|li|blockquote|strong|em|u|s)>\s*<\/\1>/g, '')
    .replace(/<(ul|ol)>\s*<\/\1>/g, '')
    .trim();
  const text = textParts
    .join('')
    .replace(/\u00a0/g, ' ')
    // Blanks around line breaks, line by line: `/[ \t]+\n/g` restarts at
    // every blank of a long run (adjacent text parts) and was quadratic.
    .split('\n')
    .map(trimBlanks)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { html, text };
}

/** Strips spaces and tabs from both ends of one line, in linear time. */
function trimBlanks(line: string): string {
  let start = 0;
  let end = line.length;
  while (start < end && (line[start] === ' ' || line[start] === '\t')) start += 1;
  while (end > start && (line[end - 1] === ' ' || line[end - 1] === '\t')) end -= 1;
  return start === 0 && end === line.length ? line : line.slice(start, end);
}

/** Plain text → minimal paragraphs, for a body that arrived without markup. */
export function plainTextToHtml(text: string): string {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtmlText(paragraph).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

const EMAIL_STYLES: Readonly<Record<string, string>> = {
  p: 'margin:0 0 16px 0;font-size:16px;line-height:24px;color:#111827;text-align:start;',
  h2: 'margin:8px 0 12px 0;font-size:18px;line-height:26px;font-weight:600;color:#111827;text-align:start;',
  h3: 'margin:8px 0 8px 0;font-size:16px;line-height:24px;font-weight:600;color:#111827;text-align:start;',
  ul: 'margin:0 0 16px 0;padding-inline-start:24px;font-size:16px;line-height:24px;color:#111827;',
  ol: 'margin:0 0 16px 0;padding-inline-start:24px;font-size:16px;line-height:24px;color:#111827;',
  li: 'margin:0 0 4px 0;',
  blockquote:
    'margin:0 0 16px 0;padding-inline-start:12px;border-inline-start:3px solid #e5e7eb;color:#374151;',
  a: 'color:#1d4ed8;text-decoration:underline;',
};

/**
 * Inline styles for mail clients, applied to ALREADY-sanitised HTML.
 * Only the opening tags this sanitiser itself emits are matched, so the
 * replacement cannot be steered by content (text is escaped; no `<` in it).
 */
export function styleForEmail(sanitizedHtml: string): string {
  return sanitizedHtml
    .replace(/<(p|h2|h3|ul|ol|li|blockquote)>/g, (_m, tag: string) => {
      return `<${tag} style="${EMAIL_STYLES[tag]}">`;
    })
    .replace(/<a href="/g, `<a style="${EMAIL_STYLES.a}" href="`);
}

/** A bounded single-line summary of the text — the in-app excerpt. */
export function excerpt(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
