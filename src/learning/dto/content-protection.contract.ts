/**
 * Per-academy content-protection settings (master plan D8, Phase 2 §D.9).
 *
 * Stored as JSON on `academies.content_protection` — validated by the DTO,
 * not by the schema, following `academies.address`'s existing precedent.
 * Null means "platform defaults", which is what every academy has until an
 * owner changes something.
 *
 * THE DEFAULTS ARE THE STRONGER SETTING. A missing, malformed or
 * partially-written value resolves to full protection, never to none: the
 * failure mode of a settings blob must be "more protected than the owner
 * asked for", which is recoverable, rather than "less", which is not.
 *
 * Every one of these is a DETERRENT and is described as such (D1). They
 * raise the effort of casual copying; they do not stop a determined person
 * with a screen recorder, and Atlas does not claim they do.
 */
export interface AcademyContentProtection {
  /**
   * The per-viewer forensic watermark. MANDATORY since
   * docs/FORENSIC_WATERMARK.md: always `true`, whatever is stored. Kept on
   * the shape so the frontend already in production keeps reading it.
   */
  readonly watermark: true;
  /**
   * Always `null`. Custom overlay text used to REPLACE the viewer's identity,
   * which made a leak untraceable; it is no longer honoured or stored.
   */
  readonly watermarkText: null;
  /** Ask the player to hide its download control (`controlsList`). */
  readonly disableDownload: boolean;
  /** Ask the browser to refuse picture-in-picture. */
  readonly disablePip: boolean;
  /** Suppress the right-click menu over the player. */
  readonly disableContextMenu: boolean;
}

export const DEFAULT_CONTENT_PROTECTION: AcademyContentProtection = {
  watermark: true,
  watermarkText: null,
  disableDownload: true,
  disablePip: true,
  disableContextMenu: true,
};

/** Reads the stored blob defensively — an unknown shape resolves to the defaults above. */
export function resolveContentProtection(value: unknown): AcademyContentProtection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return DEFAULT_CONTENT_PROTECTION;
  }
  const raw = value as Record<string, unknown>;
  const bool = (key: 'disableDownload' | 'disablePip' | 'disableContextMenu'): boolean =>
    typeof raw[key] === 'boolean'
      ? (raw[key] as boolean)
      : DEFAULT_CONTENT_PROTECTION[key];
  return {
    // Mandatory: a stored `false` (or custom text) from before the forensic
    // watermark is ignored rather than honoured.
    watermark: true,
    watermarkText: null,
    disableDownload: bool('disableDownload'),
    disablePip: bool('disablePip'),
    disableContextMenu: bool('disableContextMenu'),
  };
}
