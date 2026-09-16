/** `HostnameResolution` response contract — matches `public-website.types.ts` field-for-field. The ONLY thing a hostname resolves to: an Academy identity, nothing else. */
export interface HostnameResolutionResponse {
  readonly academyId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly academyLogo?: string;
  /**
   * P63 — the ONE host this Academy's website advertises (its connected
   * custom domain, otherwise its Atlas subdomain). Absent only when
   * neither exists. The public runtime sets `<link rel="canonical">` to
   * it and sends a visitor who arrived on the other host there. See
   * `domain/utils/canonical-host.util.ts` for the rule.
   */
  readonly canonicalHost?: string;
}
