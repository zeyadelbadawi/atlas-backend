/**
 * CMS phase 3d (batch A) — the two section values that are not plain text:
 * a `video` section's YouTube video id and a `countdown` section's deadline.
 *
 * A field-for-field backend reproduction of the frontend's
 * `section-media-values.utils.ts`; the shared parity cases
 * (`validation/__parity__`) prove both accept and refuse the same values.
 */
import {
  COUNTDOWN_DEADLINE_PATTERN,
  YOUTUBE_VIDEO_ID_PATTERN,
} from '../constants/website.constants';

/** The hosts a YouTube link may use (after `www.` / `m.` / `music.`). */
const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
]);
/** `/embed/ID`, `/shorts/ID`, `/live/ID`, `/v/ID`, then nothing or a separator. */
const PATH_ID_PATTERN = /^\/(?:embed|shorts|live|v)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;

/**
 * The 11-character video id of a YouTube link in any common form
 * (`watch?v=`, `youtu.be/`, `shorts/`, `embed/`, `live/`, with or without
 * `https://`, `www.` or `m.`), or of a bare id; `null` for anything else.
 * Only the id is ever stored: the public site builds the poster and the
 * `youtube-nocookie.com` player address from it, never from a typed URL.
 */
export function toYouTubeVideoId(raw: string): string | null {
  const text = raw.trim();
  if (YOUTUBE_VIDEO_ID_PATTERN.test(text)) return text;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase().replace(/^(?:www|m|music)\./, '');
  if (!YOUTUBE_HOSTS.has(host)) return null;
  if (host === 'youtu.be') {
    const first = url.pathname.split('/').filter(Boolean)[0] ?? '';
    return YOUTUBE_VIDEO_ID_PATTERN.test(first) ? first : null;
  }
  if (url.pathname === '/watch') {
    const id = url.searchParams.get('v') ?? '';
    return YOUTUBE_VIDEO_ID_PATTERN.test(id) ? id : null;
  }
  return PATH_ID_PATTERN.exec(url.pathname)?.[1] ?? null;
}

/** What a `videoId` field holds once parsed: a pasted link becomes its id; anything else is checked as typed. */
export function normalizeYouTubeVideoInput(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  return toYouTubeVideoId(value) ?? value.trim();
}

/** Empty (no video chosen yet — it saves, and the public site leaves the section out) or an 11-character id. */
export function isYouTubeVideoIdOrEmpty(value: string): boolean {
  return value === '' || YOUTUBE_VIDEO_ID_PATTERN.test(value);
}

/**
 * An ISO 8601 date and time with its offset that names a real moment: the
 * calendar date exists (no 30 February), the time is a real time, and the
 * offset is one the world uses (at most ±14:00).
 */
export function isCountdownDeadline(value: string): boolean {
  const match = COUNTDOWN_DEADLINE_PATTERN.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, , offsetHours, offsetMinutes] = match;
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1) return false;
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return false;
  if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) {
    return false;
  }
  if (offsetHours !== undefined) {
    if (Number(offsetMinutes) > 59) return false;
    if (Number(offsetHours) * 60 + Number(offsetMinutes) > 14 * 60) return false;
  }
  return !Number.isNaN(Date.parse(value));
}

/** Empty (no deadline chosen yet — the public site leaves the section out) or a valid deadline. */
export function isCountdownDeadlineOrEmpty(value: string): boolean {
  return value === '' || isCountdownDeadline(value);
}
