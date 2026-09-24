/**
 * Shared HTTP plumbing for the vendor adapters — Node 20's global `fetch`
 * only (no SDKs). Classifies a response into the two error kinds the
 * registry routes on and honours `Retry-After` on 429/503.
 */
import { EmailProviderError } from '../../identity/services/email-provider.interface';

export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/** Parses `Retry-After` (delta-seconds or HTTP-date) into milliseconds; `undefined` when absent or unparsable. */
export function parseRetryAfterMs(
  header: string | null,
  now = Date.now(),
): number | undefined {
  if (!header) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - now);
}

/** 4xx other than 429 = permanent; 429/5xx = transient. */
export function classifyStatus(status: number): 'transient' | 'permanent' {
  if (status === 429 || status >= 500) return 'transient';
  return 'permanent';
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

/** Turns a non-2xx response into the right `EmailProviderError`. Reads nothing from the body except a short, PII-free excerpt for the log line. */
export async function errorFromResponse(
  provider: string,
  response: Response,
): Promise<EmailProviderError> {
  const kind = classifyStatus(response.status);
  const retryAfterMs =
    kind === 'transient'
      ? parseRetryAfterMs(response.headers.get('retry-after'))
      : undefined;
  let detail = '';
  try {
    const body = (await response.json()) as {
      message?: unknown;
      code?: unknown;
      name?: unknown;
    };
    const code = body?.code ?? body?.name;
    detail = typeof code === 'string' ? ` (${code})` : '';
  } catch {
    detail = '';
  }
  return new EmailProviderError(
    provider,
    kind,
    `${provider}: HTTP ${response.status}${detail}`,
    response.status,
    retryAfterMs,
  );
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
