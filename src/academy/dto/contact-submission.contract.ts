/** `ContactSubmission` response contract — Phase 6. Matches `contact.types.ts` (atlas frontend) field-for-field. */
import type { ContactSubmission as PrismaContactSubmission } from '@prisma/client';

export interface ContactSubmissionResponse {
  readonly id: string;
  readonly academyId: string;
  readonly name: string;
  /** Empty when an interest form did not ask for (or get) one. */
  readonly email: string;
  /** Empty when an interest submission came without a message. */
  readonly message: string;
  readonly status: PrismaContactSubmission['status'];
  readonly createdAt: string;
  /** CMS phase 3d (batch C) — the Contact form (`contact`) or a "register your interest" section (`interest`). */
  readonly kind: PrismaContactSubmission['kind'];
  /** An interest submission's phone, E.164; `null` for a contact message. */
  readonly phone: string | null;
  /** The option the visitor chose and the choice list's label, as the form showed them. */
  readonly choice: string | null;
  readonly choiceLabel: string | null;
}

/** `GET academies/:id/contact-submissions/summary` — message counts per status. */
export interface ContactSubmissionSummaryResponse {
  readonly total: number;
  readonly new: number;
  readonly read: number;
  readonly archived: number;
}

export function toContactSubmissionResponse(
  submission: PrismaContactSubmission,
): ContactSubmissionResponse {
  return {
    id: submission.id,
    academyId: submission.academyId,
    name: submission.name,
    email: submission.email,
    message: submission.message,
    status: submission.status,
    createdAt: submission.createdAt.toISOString(),
    kind: submission.kind,
    phone: submission.phoneE164,
    choice: submission.choice,
    choiceLabel: submission.choiceLabel,
  };
}
