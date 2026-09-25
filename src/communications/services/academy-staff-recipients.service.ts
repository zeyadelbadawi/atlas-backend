/**
 * AcademyStaffRecipientsService — who on an academy's staff should be told
 * about something a LEARNER just did.
 *
 * A learner's transaction cannot read `academy_members`: the tenant policy
 * has no tenant context in a plain user session and the self policy
 * returns only the learner's own row. Without this the staff-addressed
 * events (a review needing moderation, someone waiting for approval)
 * cannot be emitted at all, because `emit` runs inside that same
 * transaction on purpose — so the notification is atomic with the
 * business write and a crash between the two cannot lose it.
 *
 * The lookup therefore goes through `academy_notification_recipients`, a
 * narrow SECURITY DEFINER function (migration
 * `20261015000000_p64_c3_staff_recipients`) that returns USER IDS ONLY,
 * for ACTIVE memberships only, and is executable solely by the
 * application role. Everything done with those ids afterwards runs under
 * normal RLS.
 */
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/** Who gets an academy's work items. Deliberately narrow — see `MODERATORS`. */
export const ACADEMY_MODERATOR_ROLES = ['owner', 'administrator', 'manager'] as const;

@Injectable()
export class AcademyStaffRecipientsService {
  /**
   * The staff who should act on a learner-generated work item.
   *
   * Instructors are NOT included by default: they teach, they do not
   * moderate, and adding them would turn every review on a large academy
   * into mail for people who cannot act on it. A caller that genuinely
   * wants them passes its own roles.
   */
  async moderators(
    tx: Prisma.TransactionClient,
    academyId: string | null | undefined,
    roles: readonly string[] = ACADEMY_MODERATOR_ROLES,
  ): Promise<string[]> {
    if (!academyId || roles.length === 0) return [];
    const rows = await tx.$queryRaw<{ user_id: string }[]>`
      SELECT "user_id" FROM academy_notification_recipients(${academyId}, ${[...roles]}::text[])
    `;
    return rows.map((row) => row.user_id);
  }
}
