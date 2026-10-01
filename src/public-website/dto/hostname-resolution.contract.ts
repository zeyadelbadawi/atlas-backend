/** `HostnameResolution` response contract — matches `public-website.types.ts` field-for-field. What a hostname resolves to: an Academy identity, plus its public presentation (theme + public colours). */
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
  /**
   * Theme 1 plan Phase 6 (§C.0, Owner decision 30 Sep 2026) — how the
   * Academy's website looks, so a page that renders before anything is
   * published (Coming Soon) can wear the Academy's theme and colours. Only
   * the theme key and the PUBLIC brand colours (the same fields a published
   * site already exposes); never content, drafts, or who confirmed the
   * palette. Absent when the Academy has no website configuration.
   */
  readonly presentation?: HostnamePresentation;
}

export interface HostnamePresentation {
  readonly themeKey: string;
  readonly brand: {
    readonly primaryColor?: string;
    readonly secondaryColor?: string;
    readonly accentColor?: string;
    readonly palette?: Record<string, unknown>;
  };
}
