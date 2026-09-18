/**
 * P63g — is `origin` the platform's own web origin (the base domain or a
 * single-label subdomain of it, over HTTPS)? Parsed with `URL`, so the
 * base domain is never interpolated into a regular expression (the
 * previous regex escaped only dots, letting a hostile-looking env value
 * open the allowlist). Custom domains are deliberately NOT here: the SPA
 * on a custom domain calls the API same-origin (`/api/v1`), so CORS
 * never sees them.
 */
export function isPlatformOrigin(
  origin: string,
  baseDomain: string | undefined,
): boolean {
  if (!baseDomain) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  const base = baseDomain.toLowerCase();
  if (host === base) return true;
  if (!host.endsWith(`.${base}`)) return false;
  const label = host.slice(0, -(base.length + 1));
  return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label);
}
