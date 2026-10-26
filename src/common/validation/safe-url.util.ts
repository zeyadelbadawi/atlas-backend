/**
 * B3 — URL scheme rules for content the Platform Owner writes and the
 * public marketing site renders (blog markdown, announcement CTAs, cover
 * and pop-up images, checklist links).
 *
 * The renderer sanitizes again (no raw HTML; links only http(s)/mailto/
 * site-relative; images only https or site-relative). These checks refuse
 * the content at write time, so a dangerous URL is never stored in the
 * first place and the editor hears about it on save.
 *
 * Before a scheme is read, the URL is normalised the way a browser would
 * read it: HTML character references are decoded (`javascript&#58;`), and
 * ASCII whitespace and control characters are removed (`java\tscript:`).
 */
import { registerDecorator, type ValidationOptions } from 'class-validator';

export type UnsafeUrlKind = 'link' | 'image';

export interface UnsafeMarkdownUrl {
  readonly kind: UnsafeUrlKind;
  readonly url: string;
}

const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  colon: ':',
  tab: '\t',
  newline: '\n',
  sol: '/',
  bsol: '\\',
  period: '.',
  amp: '&',
  lpar: '(',
  rpar: ')',
};

const SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):/i;
const LINK_SCHEMES = new Set(['http', 'https', 'mailto']);
const MAX_URL_LENGTH = 2000;

/** What a browser would see once entities are decoded and whitespace/control characters dropped. */
export function normalizeUrlForSchemeCheck(raw: string): string {
  const decoded = raw
    .replace(/&#x([0-9a-f]+);?/gi, (_, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(
      /&([a-z]+);/gi,
      (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match,
    );
  // eslint-disable-next-line no-control-regex
  return decoded.replace(/[\u0000-\u0020\u007f-\u009f\u200b-\u200d\ufeff]/g, '');
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return '';
  return String.fromCodePoint(code);
}

function schemeOf(normalized: string): string | null {
  const match = SCHEME_PATTERN.exec(normalized);
  return match ? match[1].toLowerCase() : null;
}

/** `/path` on this site — never `//host` or `/\host`, which a browser reads as another host. */
function isSiteRelativePath(normalized: string): boolean {
  return /^\/(?![/\\])/.test(normalized) && !normalized.includes('\\');
}

/**
 * A URL the API stores for a button, an image or a checklist link:
 * `https://…` or a site-relative `/…`. Nothing else (no `http:`, no
 * protocol-relative `//host`, no whitespace or control characters).
 */
export function isSafeHttpsOrSiteRelativeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0 || value.length > MAX_URL_LENGTH) return false;
  // Stored values must already be clean: no whitespace or control characters at all.
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f-\u009f]/.test(value)) return false;
  const normalized = normalizeUrlForSchemeCheck(value);
  if (normalized !== value) return false;
  if (isSiteRelativePath(value)) return true;
  if (schemeOf(value) !== 'https') return false;
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === 'https:' &&
      parsed.hostname.length > 0 &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

/** A markdown link destination: http(s), mailto, a fragment or a path on this site. */
export function isSafeMarkdownLink(raw: string): boolean {
  const normalized = normalizeUrlForSchemeCheck(raw);
  if (normalized.length === 0) return true; // `[text]()` renders as nothing harmful
  const scheme = schemeOf(normalized);
  if (scheme) return LINK_SCHEMES.has(scheme);
  if (
    normalized.startsWith('//') ||
    normalized.startsWith('/\\') ||
    normalized.startsWith('\\')
  ) {
    return false;
  }
  return true;
}

/** A markdown image source: https or a site-relative `/…` path only. */
export function isSafeMarkdownImage(raw: string): boolean {
  const normalized = normalizeUrlForSchemeCheck(raw);
  if (normalized.length === 0) return false;
  if (isSiteRelativePath(normalized)) return true;
  return schemeOf(normalized) === 'https';
}

/** The longest link text scanned for its closing bracket (bounds the work on hostile input). */
const MAX_LABEL_SCAN = 1000;

/** Reads an inline link destination starting at `start` (just after `(`). */
function readDestination(text: string, start: number): string {
  let index = start;
  // Optional spaces/tabs and at most one line break before the destination.
  let newlines = 0;
  while (index < text.length) {
    const ch = text[index];
    if (ch === ' ' || ch === '\t') index++;
    else if (ch === '\n' && newlines === 0) {
      newlines++;
      index++;
    } else break;
  }
  if (text[index] === '<') {
    const end = text.indexOf('>', index + 1);
    const stop = end === -1 ? Math.min(text.length, index + 1 + MAX_URL_LENGTH) : end;
    return text.slice(index + 1, stop);
  }
  let depth = 0;
  let out = '';
  for (; index < text.length && out.length <= MAX_URL_LENGTH; index++) {
    const ch = text[index];
    if (ch === '\\' && index + 1 < text.length) {
      out += text[index + 1];
      index++;
      continue;
    }
    if (/\s/.test(ch)) break;
    if (ch === '(') depth++;
    if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    out += ch;
  }
  return out;
}

/**
 * Every link and image URL in a markdown body that breaks the rules above:
 * inline links and images (nested ones included), reference definitions,
 * autolinks, and `href`/`src` attributes of any raw HTML (which the
 * renderer drops anyway).
 */
export function findUnsafeMarkdownUrls(markdown: string): UnsafeMarkdownUrl[] {
  const unsafe: UnsafeMarkdownUrl[] = [];
  const push = (kind: UnsafeUrlKind, url: string) => {
    if (!unsafe.some((entry) => entry.kind === kind && entry.url === url)) {
      unsafe.push({ kind, url: url.slice(0, 200) });
    }
  };

  // Inline links and images: every `[`, so a link nested in another is checked too.
  for (
    let open = markdown.indexOf('[');
    open !== -1;
    open = markdown.indexOf('[', open + 1)
  ) {
    if (open > 0 && markdown[open - 1] === '\\') continue;
    let depth = 0;
    let close = -1;
    const limit = Math.min(markdown.length, open + MAX_LABEL_SCAN);
    for (let index = open; index < limit; index++) {
      const ch = markdown[index];
      if (ch === '\\') {
        index++;
        continue;
      }
      if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) {
          close = index;
          break;
        }
      }
    }
    if (close === -1 || markdown[close + 1] !== '(') continue;
    const destination = readDestination(markdown, close + 2);
    const isImage = open > 0 && markdown[open - 1] === '!';
    if (isImage ? !isSafeMarkdownImage(destination) : !isSafeMarkdownLink(destination)) {
      push(isImage ? 'image' : 'link', destination);
    }
  }

  // Reference definitions: `[label]: destination`.
  for (const match of markdown.matchAll(
    /^ {0,3}\[[^\]\n]{1,999}\]:[ \t]*\n?[ \t]*(<[^>\n]*>|\S+)/gm,
  )) {
    const destination = match[1].startsWith('<') ? match[1].slice(1, -1) : match[1];
    if (!isSafeMarkdownLink(destination)) push('link', destination);
  }

  // Autolinks: `<scheme:…>`.
  for (const match of markdown.matchAll(/<([a-z][a-z0-9+.-]{1,31}:[^<>\s]*)>/gi)) {
    if (!isSafeMarkdownLink(match[1])) push('link', match[1]);
  }

  // Raw HTML attributes (stripped by the renderer; refused here all the same).
  for (const match of markdown.matchAll(
    /\b(href|src|srcset|xlink:href|action|formaction|poster|data)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
  )) {
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    const isImage = /^(src|srcset|poster)$/i.test(match[1]);
    if (isImage ? !isSafeMarkdownImage(value) : !isSafeMarkdownLink(value)) {
      push(isImage ? 'image' : 'link', value);
    }
  }

  return unsafe;
}

/** class-validator: `https://…` or a site-relative `/…` path (see `isSafeHttpsOrSiteRelativeUrl`). */
export function IsHttpsOrSiteRelativeUrl(options?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyName: string | symbol) => {
    registerDecorator({
      name: 'isHttpsOrSiteRelativeUrl',
      target: target.constructor,
      propertyName: propertyName as string,
      options: {
        message: '$property must be an https:// URL or a path on this site',
        ...options,
      },
      validator: {
        validate: (value: unknown) => isSafeHttpsOrSiteRelativeUrl(value),
      },
    });
  };
}
