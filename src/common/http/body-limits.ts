/**
 * W3 — JSON request-body size limits, per route.
 *
 * THE PROBLEM. One global JSON parser accepted `MEDIA_MAX_UPLOAD_BYTES × 3`
 * (30 MB by default) on EVERY route, and body parsing runs before any
 * guard or the throttler: an anonymous caller could make the API buffer
 * and `JSON.parse` 30 MB on `POST auth/sign-in`, as often as it liked.
 *
 * NOW. Every route gets Express's own 100 KB default, and only the routes
 * that genuinely carry more name a larger tier here:
 *
 *  - `upload` (the old 30 MB): the base64 data-URL file bridge (media,
 *    protected files, submission attachments, support attachments, payment
 *    proofs) and the content routes that still re-send LEGACY inline
 *    `data:image/…;base64` images unchanged on every save (branding,
 *    visual identity, website configuration/pages/testimonials, blog
 *    posts, course thumbnails — see `LEGACY_DATA_IMAGE_PATTERN`).
 *  - `content` (5 MB): rich text whose validated maximum is well over
 *    100 KB — quiz authoring (100 questions × prompt/options/explanation),
 *    quiz answers (100 × 20 000-character essays), campaign/academy
 *    message bodies (50 KB of HTML, JSON-escaped), FAQ entries.
 *  - `webhook` (1 MB): provider deliveries (Zoom, Cloudflare Stream, email
 *    providers, payments), verified against their exact bytes.
 *
 * Paths are matched without the global `/api/v1` prefix, so `main.ts` and
 * the e2e app (which has no prefix) use the same table. `body-limits.spec`
 * proves every entry names a real route, and the e2e spec proves a small
 * route refuses 101 KB while an upload route still accepts its payload.
 * URL-encoded bodies keep Nest's 100 KB default; uploads are base64 JSON
 * or direct-to-storage presigned PUTs, never multipart through the API.
 */
import { json } from 'express';
import type { RequestHandler } from 'express';
import type { IncomingMessage } from 'node:http';

/** Express/body-parser's own default — what every unlisted route gets. */
export const DEFAULT_JSON_BODY_LIMIT_BYTES = 100 * 1024;
export const CONTENT_JSON_BODY_LIMIT_BYTES = 5 * 1024 * 1024;
export const WEBHOOK_JSON_BODY_LIMIT_BYTES = 1024 * 1024;

export type BodyLimitTier = 'upload' | 'content' | 'webhook';

export interface RouteBodyLimit {
  readonly method: 'POST' | 'PUT' | 'PATCH';
  /** The route as its controller declares it (`:param` segments). */
  readonly path: string;
  readonly tier: BodyLimitTier;
}

export const ROUTE_BODY_LIMITS: readonly RouteBodyLimit[] = [
  // --- base64 file bridge ---------------------------------------------------
  { method: 'POST', path: 'academies/:id/media', tier: 'upload' },
  { method: 'POST', path: 'academies/:id/media/protected', tier: 'upload' },
  {
    method: 'POST',
    path: 'courses/:id/assignments/:assignmentId/submission/attachment',
    tier: 'upload',
  },
  { method: 'POST', path: 'academies/:id/support-cases', tier: 'upload' },
  { method: 'POST', path: 'organizations/:id/support-cases', tier: 'upload' },
  { method: 'POST', path: 'support-cases/:id/messages', tier: 'upload' },
  { method: 'POST', path: 'support-cases/mine/:caseId/messages', tier: 'upload' },
  {
    method: 'PATCH',
    path: 'course-orders/:id/payments/:paymentId/proof',
    tier: 'upload',
  },
  {
    method: 'PATCH',
    path: 'organizations/:id/payments/:paymentId/proof',
    tier: 'upload',
  },
  // --- content that may still carry legacy inline images -------------------
  { method: 'PATCH', path: 'academies/:id/branding', tier: 'upload' },
  { method: 'PUT', path: 'academies/:id/visual-identity', tier: 'upload' },
  { method: 'PATCH', path: 'academies/:id/website/configuration', tier: 'upload' },
  { method: 'POST', path: 'academies/:id/website/pages', tier: 'upload' },
  { method: 'PATCH', path: 'academies/:id/website/pages/:pageId', tier: 'upload' },
  { method: 'POST', path: 'academies/:id/website/testimonial-entries', tier: 'upload' },
  {
    method: 'PATCH',
    path: 'academies/:id/website/testimonial-entries/:entryId',
    tier: 'upload',
  },
  { method: 'POST', path: 'blog-posts', tier: 'upload' },
  { method: 'PATCH', path: 'blog-posts/:id', tier: 'upload' },
  { method: 'POST', path: 'academies/:id/courses', tier: 'upload' },
  { method: 'PATCH', path: 'academies/:id/courses/:courseId', tier: 'upload' },
  // --- rich text over 100 KB ------------------------------------------------
  { method: 'POST', path: 'academies/:id/website/faq-entries', tier: 'content' },
  {
    method: 'PATCH',
    path: 'academies/:id/website/faq-entries/:entryId',
    tier: 'content',
  },
  { method: 'POST', path: 'courses/:id/quizzes', tier: 'content' },
  { method: 'PATCH', path: 'courses/:id/quizzes/:quizId', tier: 'content' },
  {
    method: 'PUT',
    path: 'courses/:id/quizzes/:quizId/attempts/:attemptId/answers',
    tier: 'content',
  },
  {
    method: 'POST',
    path: 'courses/:id/quizzes/:quizId/attempts/:attemptId/submit',
    tier: 'content',
  },
  { method: 'POST', path: 'academies/:id/messages', tier: 'content' },
  { method: 'POST', path: 'academies/:id/messages/preview', tier: 'content' },
  { method: 'POST', path: 'platform-communications/campaigns', tier: 'content' },
  { method: 'POST', path: 'platform-communications/campaigns/preview', tier: 'content' },
  // --- provider webhooks ----------------------------------------------------
  { method: 'POST', path: 'webhooks/email/:provider', tier: 'webhook' },
  { method: 'POST', path: 'webhooks/video/stream', tier: 'webhook' },
  { method: 'POST', path: 'live-sessions/webhook', tier: 'webhook' },
  { method: 'POST', path: 'live-sessions/deauthorization', tier: 'webhook' },
  { method: 'POST', path: 'payments/webhook', tier: 'webhook' },
];

/**
 * Routes whose handlers verify a signature over the EXACT request bytes,
 * so the parser keeps a copy as `request.rawBody` (Zoom, Cloudflare
 * Stream, Resend/Brevo). Prefixes, unprefixed like the table above.
 */
export const RAW_BODY_PATH_PREFIXES: readonly string[] = [
  'live-sessions/webhook',
  'live-sessions/deauthorization',
  'webhooks/video',
  'webhooks/email',
];

/** `/api/v1/academies/x/media?y` → `academies/x/media`. */
export function normalizeRoutePath(url: string): string {
  const path = url.split('?')[0].split('#')[0];
  return path
    .replace(/^\/+/, '')
    .replace(/^api\/v\d+\//, '')
    .replace(/\/+$/, '');
}

function compile(path: string): RegExp {
  const pattern = path
    .split('/')
    .map((segment) =>
      segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    )
    .join('/');
  return new RegExp(`^${pattern}$`);
}

const COMPILED = ROUTE_BODY_LIMITS.map((entry) => ({
  ...entry,
  regex: compile(entry.path),
}));

/** The tier for a request, or `null` for the 100 KB default. */
export function bodyLimitTierFor(method: string, url: string): BodyLimitTier | null {
  const path = normalizeRoutePath(url);
  const upper = method.toUpperCase();
  return (
    COMPILED.find((entry) => entry.method === upper && entry.regex.test(path))?.tier ??
    null
  );
}

export interface JsonBodyParserOptions {
  /** The `upload` tier's limit — `MEDIA_MAX_UPLOAD_BYTES × 3` (see `main.ts`). */
  readonly uploadLimitBytes: number;
}

/**
 * The application's ONE JSON body parser. Named `jsonParser` on purpose:
 * Nest skips registering its own default JSON parser when a middleware of
 * that name is already installed (`ExpressAdapter.isMiddlewareApplied`).
 */
export function createJsonBodyParser(options: JsonBodyParserOptions): RequestHandler {
  const verify = (
    request: IncomingMessage & { rawBody?: Buffer },
    _res: unknown,
    buffer: Buffer,
  ): void => {
    const path = normalizeRoutePath(request.url ?? '');
    if (RAW_BODY_PATH_PREFIXES.some((prefix) => path.startsWith(prefix))) {
      request.rawBody = Buffer.from(buffer);
    }
  };
  // Browsers send CSP violation reports as `application/csp-report` or
  // `application/reports+json`; both are JSON (authentication audit,
  // Decision 4).
  const type = ['application/json', 'application/csp-report', 'application/reports+json'];
  const parsers: Record<BodyLimitTier | 'default', RequestHandler> = {
    default: json({ limit: DEFAULT_JSON_BODY_LIMIT_BYTES, type, verify }),
    upload: json({ limit: options.uploadLimitBytes, type, verify }),
    content: json({ limit: CONTENT_JSON_BODY_LIMIT_BYTES, type, verify }),
    webhook: json({ limit: WEBHOOK_JSON_BODY_LIMIT_BYTES, type, verify }),
  };
  return function jsonParser(request, response, next) {
    const tier = bodyLimitTierFor(request.method, request.originalUrl ?? request.url);
    parsers[tier ?? 'default'](request, response, next);
  };
}
