/**
 * Forensic watermark wire contracts (docs/FORENSIC_WATERMARK.md).
 */
import type { ForensicWatermarkSurface } from '@prisma/client';

/**
 * What a player must draw over a video (lesson grant `watermark`, live-class
 * redeem `watermark`). Everything here is the SERVER's: the client renders it
 * and has no fallback text of its own, so blanking it means tampering with
 * the page, which the player's watchdog reports.
 */
export interface ForensicWatermarkDisplay {
  /** `7K3QM-X9TR2` — the code an operator reads off a recording. */
  readonly code: string;
  /** `account` when a signed-in viewer is identified; `preview` for an anonymous visitor. */
  readonly kind: 'account' | 'preview';
  /** A masked hint of whose account this is (`a•••@gmail.com`). Null for an anonymous preview. */
  readonly maskedIdentity: string | null;
  /** The academy host, shown with "Preview" for an anonymous visitor. Null otherwise. */
  readonly host: string | null;
}

export type WatermarkAccountState =
  'active' | 'suspended' | 'deleted' | 'missing' | 'anonymous';

export interface WatermarkRelatedCode {
  readonly code: string;
  readonly surface: ForensicWatermarkSurface;
  readonly courseTitle: string | null;
  readonly lessonTitle: string | null;
  readonly liveSessionTitle: string | null;
  readonly issuedAt: string;
  readonly lastSeenAt: string;
  readonly tamperEvents: number;
}

/** `GET /platform/watermarks/:code` — Platform Owner only. */
export interface WatermarkLookupResponse {
  readonly code: string;
  readonly surface: ForensicWatermarkSurface;
  readonly issuedAt: string;
  readonly lastSeenAt: string;
  readonly tamperEvents: number;
  readonly lastTamperAt: string | null;
  readonly account: {
    readonly userId: string | null;
    readonly state: WatermarkAccountState;
    /** Present only while the account still exists and is not deleted. */
    readonly currentName: string | null;
    readonly currentEmail: string | null;
    readonly deletedAt: string | null;
  };
  /** Decrypted identity at issue time. Null for an anonymous preview. */
  readonly identityAtIssue: {
    readonly name: string | null;
    readonly email: string | null;
    readonly phone: string | null;
    readonly phoneCountry: string | null;
  } | null;
  /** `ok`, `absent` (anonymous preview) or `unreadable` (tampered row or rotated key). */
  readonly snapshotStatus: 'ok' | 'absent' | 'unreadable';
  readonly content: {
    readonly organization: { readonly id: string | null; readonly name: string | null };
    readonly academy: { readonly id: string; readonly name: string | null };
    readonly course: { readonly id: string; readonly title: string | null } | null;
    readonly lesson: { readonly id: string; readonly title: string | null } | null;
    readonly liveSession: {
      readonly id: string;
      readonly title: string | null;
      readonly scheduledStartAt: string | null;
    } | null;
  };
  readonly session: {
    readonly id: string | null;
    readonly startedAt: string | null;
    readonly signInIp: string | null;
    readonly signInCountry: string | null;
    readonly signInDevice: string | null;
  };
  readonly device: {
    readonly id: string | null;
    readonly label: string | null;
    readonly userAgent: string | null;
    readonly browser: string | null;
    readonly os: string | null;
    readonly type: 'mobile' | 'tablet' | 'desktop' | 'unknown';
  };
  readonly network: { readonly ip: string | null; readonly country: string | null };
  /** Every other code issued to the same session (or, anonymously, the same device). */
  readonly relatedInSession: readonly WatermarkRelatedCode[];
}
