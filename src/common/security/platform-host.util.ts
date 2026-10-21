/**
 * The platform's own web hosts — where the platform web app (sign-in,
 * registration, every dashboard) is served, as opposed to an academy's
 * website.
 *
 * Two hosts during and after the dashboard move: the base domain itself
 * (the apex, which keeps `/api` and the Google callback and redirects old
 * app links) and the dashboard subdomain (`PLATFORM_APP_HOST`, default
 * `dashboard.<base>`). The dashboard host is accepted only when it is a
 * single-label subdomain of the base domain, so a mistyped or hostile value
 * can never make a foreign host count as the platform. `dashboard` is a
 * reserved academy label (DL-58), so no academy can hold it.
 */
import type { PlatformDomainRuntimeConfig } from '../../config/configuration';

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The validated dashboard host, or `undefined` when no base domain is configured or the value is not a single-label subdomain of it. */
export function platformAppHost(
  config: PlatformDomainRuntimeConfig | undefined,
): string | undefined {
  const base = config?.baseDomain?.toLowerCase();
  if (!base) return undefined;
  const host = (config?.appHost ?? `dashboard.${base}`).toLowerCase();
  // A DNS name is at most 253 characters, the generated default included.
  if (host.length > 253 || !host.endsWith(`.${base}`)) return undefined;
  const label = host.slice(0, -(base.length + 1));
  return LABEL.test(label) ? host : undefined;
}

/** Every host that is the platform itself: the base domain and the dashboard host. */
export function platformHosts(
  config: PlatformDomainRuntimeConfig | undefined,
): readonly string[] {
  const base = config?.baseDomain?.toLowerCase();
  if (!base) return [];
  const app = platformAppHost(config);
  return app ? [base, app] : [base];
}

/** `true` when `hostname` (bare, no port) is the base domain or the dashboard host. */
export function isPlatformHost(
  hostname: string | undefined | null,
  config: PlatformDomainRuntimeConfig | undefined,
): boolean {
  if (!hostname) return false;
  return platformHosts(config).includes(hostname.toLowerCase());
}
