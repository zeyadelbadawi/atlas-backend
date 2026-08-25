/** `HostnameResolution` response contract — matches `public-website.types.ts` field-for-field. The ONLY thing a hostname resolves to: an Academy identity, nothing else. */
export interface HostnameResolutionResponse {
  readonly academyId: string;
  readonly academyName: string;
  readonly academySlug: string;
  readonly academyLogo?: string;
}
