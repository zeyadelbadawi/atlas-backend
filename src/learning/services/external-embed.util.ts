/**
 * Classifies an `external` lesson URL into something the unified player
 * may EMBED, as opposed to merely link to.
 *
 * The rule is deliberately narrow: only YouTube, only its real URL shapes,
 * only an id that matches YouTube's 11-character alphabet. Everything
 * else stays a link-out. The player never builds an iframe from the raw
 * URL — it builds one from the `videoId` this function vetted — so an
 * academy pasting an arbitrary address into a lesson cannot turn the
 * learner's page into a frame of that address.
 *
 * Mirrors `parseYouTubeVideoId` in the frontend (`shared/utils/youtube.utils.ts`),
 * which the CMS lesson editor already uses to validate the same links; the
 * server is the one that decides, so the two surfaces cannot disagree.
 */
import type { ExternalEmbedContract } from '../dto/lesson-content.contract';

const YOUTUBE_HOSTS: ReadonlySet<string> = new Set([
  'youtube.com',
  'youtu.be',
  'youtube-nocookie.com',
]);
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;
const PATH_ID_PATTERN = /^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})(?:[/?#]|$)/;
/** `t=1m30s`, `t=90s`, `t=90`, `start=90` — YouTube's own shapes. */
const TIME_PATTERN = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;
const MAX_START_SECONDS = 24 * 60 * 60;

function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^(www|m)\./, '');
}

function parseStartSeconds(url: URL): number | undefined {
  const raw = url.searchParams.get('start') ?? url.searchParams.get('t');
  if (!raw) return undefined;
  const match = TIME_PATTERN.exec(raw.trim());
  if (!match || raw.trim() === '') return undefined;
  const [, h, m, s] = match;
  if (h === undefined && m === undefined && s === undefined) return undefined;
  const seconds = Number(h ?? 0) * 3600 + Number(m ?? 0) * 60 + Number(s ?? 0);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_START_SECONDS) {
    return undefined;
  }
  return seconds;
}

export function classifyExternalEmbed(
  rawUrl: string | null | undefined,
): ExternalEmbedContract | null {
  if (!rawUrl) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = normalizeHost(url.hostname);
  if (!YOUTUBE_HOSTS.has(host)) return null;

  let videoId: string | null = null;
  if (host === 'youtu.be') {
    const first = url.pathname.split('/').filter(Boolean)[0];
    videoId = first && VIDEO_ID_PATTERN.test(first) ? first : null;
  } else {
    const v = url.searchParams.get('v');
    if (v && VIDEO_ID_PATTERN.test(v)) {
      videoId = v;
    } else {
      const match = PATH_ID_PATTERN.exec(url.pathname);
      videoId = match ? match[1] : null;
    }
  }
  if (!videoId) return null;

  const startSeconds = parseStartSeconds(url);
  return startSeconds === undefined
    ? { provider: 'youtube', videoId }
    : { provider: 'youtube', videoId, startSeconds };
}
