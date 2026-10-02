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

  /**
   * One page of an Academy's messages, filtered and sorted in the
   * database. Every filter is ANDed onto `academyId`, so no combination of
   * them can reach another Academy's rows (RLS is the backstop). Ties are
   * broken by `id`, so paging is stable.
   */
  async findManyForAcademy(
    tx: Prisma.TransactionClient,
    academyId: string,
    options: {
      readonly skip: number;
      readonly take: number;
      readonly search?: string;
      readonly status?: ContactSubmissionStatus;
      readonly from?: Date;
      readonly toExclusive?: Date;
      readonly sortBy?: 'createdAt' | 'name' | 'email';
      readonly sortDirection?: 'asc' | 'desc';
    },
  ): Promise<{ items: ContactSubmission[]; totalItems: number }> {
    const search = options.search?.trim();
    const where: Prisma.ContactSubmissionWhereInput = {
      academyId,
      ...(options.status ? { status: options.status } : {}),
      ...(options.from || options.toExclusive
        ? {
            createdAt: {
              ...(options.from ? { gte: options.from } : {}),
              ...(options.toExclusive ? { lt: options.toExclusive } : {}),
            },
          }
        : {}),
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
              { message: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };
    const direction = options.sortDirection ?? 'desc';
    const [items, totalItems] = await Promise.all([
      tx.contactSubmission.findMany({
        where,
        orderBy: [{ [options.sortBy ?? 'createdAt']: direction }, { id: direction }],
        skip: options.skip,
        take: options.take,
      }),
      tx.contactSubmission.count({ where }),
    ]);
    return { items, totalItems };
  }

  /** Message counts per status for one Academy (the Messages page's tabs). */
  async countByStatus(
    tx: Prisma.TransactionClient,
    academyId: string,
  ): Promise<Record<ContactSubmissionStatus, number>> {
    const rows = await tx.contactSubmission.groupBy({
      by: ['status'],
      where: { academyId },
      _count: { _all: true },
    });
    const counts: Record<ContactSubmissionStatus, number> = {
      new: 0,
      read: 0,
      archived: 0,
    };
    for (const row of rows) counts[row.status] = row._count._all;
    return counts;
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
