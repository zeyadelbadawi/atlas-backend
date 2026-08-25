/**
 * URL safety — a field-for-field backend reproduction of the real
 * frontend's `isSafeExternalUrl` (`url-safety.utils.ts`). The single place
 * the backend decides whether a tenant-authored URL is safe to persist —
 * used by every section/CTA schema that accepts a URL, never duplicated
 * per call site (master plan §16: "no `javascript:`/`data:`/etc. URL ever
 * reaches a rendered `href`").
 */
import { ALLOWED_URL_SCHEMES } from '../constants/website.constants';

export function isSafeExternalUrl(value: string | undefined): boolean {
  if (!value) return true;
  try {
    const parsed = new URL(value);
    return ALLOWED_URL_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}
