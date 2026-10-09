/**
 * Small, pure helpers for what a watermark shows and what a lookup reports.
 */

/**
 * `layla.hassan@gmail.com` → `l•••@gmail.com`. Enough for a learner to
 * recognise their own account on screen and for a viewer of a leak to see the
 * mark is personal, without printing a full address on every frame.
 */
export function maskEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${email[0]}•••${email.slice(at)}`;
}

export interface ParsedUserAgent {
  readonly browser: string | null;
  readonly os: string | null;
  readonly type: 'mobile' | 'tablet' | 'desktop' | 'unknown';
}

/** Coarse, display-only parse — the raw agent is always reported beside it. */
export function parseUserAgent(userAgent: string | null | undefined): ParsedUserAgent {
  if (!userAgent) return { browser: null, os: null, type: 'unknown' };
  const ua = userAgent;
  const version = (pattern: RegExp): string | null => pattern.exec(ua)?.[1] ?? null;
  const browser = /\bEdg[eA]?\//.test(ua)
    ? `Edge ${version(/\bEdg[eA]?\/(\d+)/) ?? ''}`.trim()
    : /\bOPR\/|\bOpera\//.test(ua)
      ? `Opera ${version(/\bOPR\/(\d+)/) ?? ''}`.trim()
      : /\bSamsungBrowser\//.test(ua)
        ? `Samsung Internet ${version(/SamsungBrowser\/(\d+)/) ?? ''}`.trim()
        : /\bCriOS\//.test(ua)
          ? `Chrome ${version(/CriOS\/(\d+)/) ?? ''}`.trim()
          : /\bFxiOS\//.test(ua)
            ? `Firefox ${version(/FxiOS\/(\d+)/) ?? ''}`.trim()
            : /\bChrome\//.test(ua)
              ? `Chrome ${version(/Chrome\/(\d+)/) ?? ''}`.trim()
              : /\bFirefox\//.test(ua)
                ? `Firefox ${version(/Firefox\/(\d+)/) ?? ''}`.trim()
                : /\bSafari\//.test(ua)
                  ? `Safari ${version(/Version\/(\d+(?:\.\d+)?)/) ?? ''}`.trim()
                  : null;
  const os = /\bWindows NT 10/.test(ua)
    ? 'Windows 10/11'
    : /\bWindows NT\b/.test(ua)
      ? 'Windows'
      : /\biPad\b/.test(ua)
        ? `iPadOS ${(version(/OS (\d+[_.]\d+)/) ?? '').replace('_', '.')}`.trim()
        : /\b(iPhone|iPod)\b/.test(ua)
          ? `iOS ${(version(/OS (\d+[_.]\d+)/) ?? '').replace('_', '.')}`.trim()
          : /\bAndroid\b/.test(ua)
            ? `Android ${version(/Android (\d+(?:\.\d+)?)/) ?? ''}`.trim()
            : /\bCrOS\b/.test(ua)
              ? 'ChromeOS'
              : /\bMac OS X\b/.test(ua)
                ? 'macOS'
                : /\bLinux\b/.test(ua)
                  ? 'Linux'
                  : null;
  const type =
    /\biPad\b|\bTablet\b/.test(ua) || (/\bAndroid\b/.test(ua) && !/\bMobile\b/.test(ua))
      ? 'tablet'
      : /\bMobi|\biPhone\b|\biPod\b/.test(ua)
        ? 'mobile'
        : browser || os
          ? 'desktop'
          : 'unknown';
  return { browser, os, type };
}
