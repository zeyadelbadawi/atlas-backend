/**
 * P64 Phase 3 (§D.6) — the certificate queue's vocabulary. Kept free of
 * Nest imports so the learning module (which enqueues an issuance check
 * when completion is reached) and the certificates module (which
 * processes it) share it without importing each other.
 */
export const CERTIFICATE_JOBS_QUEUE = 'certificate-jobs';

export const CERTIFICATE_ISSUE_JOB = 'issue';
export const CERTIFICATE_RENDER_JOB = 'render';
/** Account deletion: replace the holder's name on every certificate they hold (§D.6 anonymisation). */
export const CERTIFICATE_ANONYMIZE_JOB = 'anonymize';

export interface CertificateAnonymizeJobPayload {
  readonly userId: string;
}

export interface CertificateIssueJobPayload {
  readonly enrollmentId: string;
  /** The enrollment's academy — the processor resolves the tenant context from it (via the definer), never from the payload's word alone. */
  readonly academyId: string;
}

export interface CertificateRenderJobPayload {
  readonly certificateId: string;
  readonly academyId: string;
}

/** Render concurrency on the single VPS (master plan risk table: "queue concurrency 2"). */
export const CERTIFICATE_RENDER_CONCURRENCY = 2;
