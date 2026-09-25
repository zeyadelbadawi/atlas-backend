/**
 * Shared HTTP plumbing for the vendor adapters — Node 20's global `fetch`
 * only (no SDKs). Classifies a response into the two error kinds the
 * registry routes on and honours `Retry-After` on 429/503.
 */
import { EmailProviderError } from '../../identity/services/email-provider.interface';

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * A retry delay longer than this is not actionable for a transactional
 * email — the outbox's own backoff will have run long before it — and a
 * value that large is far more likely to be a vendor sending an absolute
 * epoch where the spec wants delta-seconds than a genuine instruction.
 * Clamped rather than dropped so a real long `Retry-After` still slows us.
 */
export const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds; `undefined` when absent or unparsable. */
export function parseRetryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) {
    return Math.min(Number(trimmed) * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - now), MAX_RETRY_AFTER_MS);
}

/**
 * The shared default: 429 and 5xx are transient, and so are the two 4xx
 * codes whose HTTP semantics are "the same request, sent again, can
 * succeed" — 408 Request Timeout and 425 Too Early. Everything else in
 * 4xx is permanent: the request itself is wrong and no other provider
 * would take it either. A vendor whose own codes contradict this passes
 * `ProviderErrorOverrides` to `errorFromResponse`.
 */
export function classifyStatus(status: number): 'transient' | 'permanent' {
  if (status === 429 || status === 408 || status === 425 || status >= 500) {
    return 'transient';
  }
  return 'permanent';
}

/**
 * Vendor-specific corrections to the shared classifier. A code list wins
 * over the status because a vendor's own error name is the more precise
 * statement of what happened (Resend, for instance, returns 409 for "an
 * identical idempotent request is still in flight" — retryable — while a
 * bare 409 Conflict is not generally retryable).
 */
export interface ProviderErrorOverrides {
  /** Status codes this vendor uses transiently beyond the shared default. */
  readonly transientStatuses?: readonly number[];
  /** Vendor error names/codes that are TRANSIENT whatever the status says. */
  readonly transientCodes?: readonly string[];
  /** Vendor error names/codes that are PERMANENT whatever the status says. */
  readonly permanentCodes?: readonly string[];
  /** Fallback headers to read a retry delay from, in order, when `Retry-After` is absent. */
  readonly retryAfterHeaders?: readonly string[];
}

/**
 * Performs the request; network failures and timeouts become transient
 * `EmailProviderError`s so the registry can fall through to the next
 * provider. Never includes the request body in the error (it carries the
 * recipient and message content).
 */
export async function providerFetch(
  provider: string,
  url: string,
  init: RequestInit,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    throw new EmailProviderError(
      provider,
      'transient',
      `${provider}: request failed (${error instanceof Error ? error.name : 'network error'})`,
    );
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Turns a non-2xx response into the right `EmailProviderError`.
 *
 * Reads nothing from the body except the vendor's own error name/code —
 * never the `message`, which can quote the recipient or the subject. The
 * classification order is: vendor code (permanent first, so a code we
 * KNOW is unretryable can never be turned into a retry loop that gets the
 * sender blocked), then vendor status, then the shared status rule.
 * `Retry-After` is only attached to a transient error, because a delay on
 * a permanent one would invite exactly that retry loop.
 */
export async function errorFromResponse(
  provider: string,
  response: Response,
  overrides: ProviderErrorOverrides = {},
): Promise<EmailProviderError> {
  const code = await readErrorCode(response);
  const kind = classifyResponse(response.status, code, overrides);
  const retryAfterMs =
    kind === 'transient' ? retryAfterFrom(response.headers, overrides) : undefined;
  const detail = code ? ` (${code})` : '';
  return new EmailProviderError(
    provider,
    kind,
    `${provider}: HTTP ${response.status}${detail}`,
    response.status,
    retryAfterMs,
  );
}

/** The vendor's machine-readable error name, lower-cased; `undefined` when the body is missing, empty or not JSON. */
export async function readErrorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as {
      code?: unknown;
      name?: unknown;
      error?: unknown;
    } | null;
    const raw = body?.code ?? body?.name ?? body?.error;
    return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : undefined;
  } catch {
    // A malformed or empty body must never change the classification: the
    // status alone still decides, and the send still fails honestly.
    return undefined;
  }
}

/** The classification rule `errorFromResponse` applies, exposed so adapters and tests can assert it directly. */
export function classifyResponse(
  status: number,
  code: string | undefined,
  overrides: ProviderErrorOverrides = {},
): 'transient' | 'permanent' {
  if (code) {
    if (overrides.permanentCodes?.includes(code)) return 'permanent';
    if (overrides.transientCodes?.includes(code)) return 'transient';
  }
  if (overrides.transientStatuses?.includes(status)) return 'transient';
  return classifyStatus(status);
}

function retryAfterFrom(
  headers: Headers,
  overrides: ProviderErrorOverrides,
): number | undefined {
  const direct = parseRetryAfterMs(headers.get('retry-after'));
  if (direct !== undefined) return direct;
  for (const name of overrides.retryAfterHeaders ?? []) {
    const parsed = parseRetryAfterMs(headers.get(name));
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

/** Lower-cases header names and flattens single-element arrays; adapters never care about the wire casing. */
export function headerValue(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  name: string,
): string | undefined {
  const direct = headers[name] ?? headers[name.toLowerCase()];
  const value =
    direct ??
    Object.entries(headers).find(
      ([key]) => key.toLowerCase() === name.toLowerCase(),
    )?.[1];
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Never logs a whole address — only enough to correlate with a support ticket. */
export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  return `${local.slice(0, 1)}***@${domain}`;
}
