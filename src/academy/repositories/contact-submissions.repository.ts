/**
 * ContactSubmissionsRepository — Phase 6, the real backend destination for
 * the public Contact section's form (previously an intentional no-op —
 * see `ContactSection.tsx`'s own doc comment for "no fake backend").
 *
 * `create` is the ONE method called from the PUBLIC (unauthenticated)
 * write path (`PublicWebsiteService.submitContactMessage`) — it runs
 * inside `runInTenantContext(<server-resolved organizationId>, ...)`,
 * never `runInUserContext` (there is no user), and is gated by the
 * `contact_submissions_public_insert` RLS policy (P27 migration), which
 * itself checks the target academy actually belongs to that same
 * server-resolved organization — never a client-supplied one trusted on
 * its own.
 *
 * `findManyForAcademy`/`updateStatus` are the STAFF-side read/triage
 * methods, called from `AcademiesService` under the caller's own
 * `runInTenantContext`, gated by `contact_submissions_manage_select/
 * update` (`is_academy_moderator`).
 */
import { Injectable } from '@nestjs/common';
import type { ContactSubmission, ContactSubmissionStatus, Prisma } from '@prisma/client';

@Injectable()
export class ContactSubmissionsRepository {
  /**
   * Deliberately takes the "unchecked" input shape (a plain `academyId`
   * scalar, never `academy: { connect: { id } }`) — same reasoning as
   * `AcademyStudentsRepository.create`'s own doc comment: Prisma's nested-
   * `connect` form issues its own validating SELECT against `academies`
   * before inserting, and that extra query proved to break this specific
   * public, no-user-context write path in practice (confirmed live via
   * e2e testing: the checked form's insert was rejected by
   * `contact_submissions_public_insert`'s RLS check even though the same
   * check, run directly against the database, evaluates true for the
   * exact same academy/organization pair) — the real Postgres foreign-key
   * constraint on `contact_submissions.academy_id` still enforces the row
   * genuinely exists.
   */
  create(
    tx: Prisma.TransactionClient,
    data: Prisma.ContactSubmissionUncheckedCreateInput,
  ): Promise<ContactSubmission> {
    return tx.contactSubmission.create({ data });
  }

  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    options: { skip: number; take: number },
  ): Promise<{ items: ContactSubmission[]; totalItems: number }> {
    const where: Prisma.ContactSubmissionWhereInput = { academyId };
    const [items, totalItems] = await Promise.all([
      tx.contactSubmission.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: options.skip,
        take: options.take,
      }),
      tx.contactSubmission.count({ where }),
    ]);
    return { items, totalItems };
  }

  findById(tx: Prisma.TransactionClient, id: string): Promise<ContactSubmission | null> {
    return tx.contactSubmission.findUnique({ where: { id } });
  }

  updateStatus(
    tx: Prisma.TransactionClient,
    id: string,
    status: ContactSubmissionStatus,
  ): Promise<ContactSubmission> {
    return tx.contactSubmission.update({ where: { id }, data: { status } });
  }
}
