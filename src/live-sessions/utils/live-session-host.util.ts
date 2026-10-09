/**
 * Who may HOST a Live Session — one rule, read by both the write path
 * (`LiveSessionService`, when a host is assigned) and the join path
 * (`LiveSessionAccessService`, when somebody claims the host role).
 *
 * A host is a person with a real, CURRENT teaching relationship to the
 * session's course:
 *   - an ACTIVE `academy_members` row of the session's academy in the
 *     managing tier (owner/administrator/manager) — they may run any
 *     course's class in their academy;
 *   - an ACTIVE `academy_members` `instructor` row AND a
 *     `course_instructors` row for THIS course — an instructor hosts only
 *     the courses they are assigned to (the same course-scoped rule quiz/
 *     assignment authoring applies, `assertCanAuthorCourseContent`);
 *   - the OWNER of the academy's organization, who owns every academy in
 *     it with or without a row (`AcademyScopeGuard`'s organization-owner
 *     rule, `AcademyMembersRepository.isOrganizationOwnerOfAcademy`).
 *
 * Everyone else — an instructor of another course, `staff`, an inactive or
 * removed member, a student — is not a host, whatever `host_user_id`
 * says. Checking it at join time as well as at assignment time is what
 * keeps a removed instructor from entering a meeting as its host through a
 * stale `host_user_id`.
 *
 * Plain `tx` reads in the caller's tenant context: `academy_members`,
 * `course_instructors`, `academies` and `organization_memberships` are all
 * readable there under their `_tenant_select` policies.
 */
import type { Prisma } from '@prisma/client';

/** The academy-wide hosting tier — identical to the managing tier every academy write uses. */
const ACADEMY_WIDE_HOST_ROLES: ReadonlySet<string> = new Set([
  'owner',
  'administrator',
  'manager',
]);

export async function isEligibleLiveSessionHost(
  tx: Prisma.TransactionClient,
  args: {
    readonly academyId: string;
    readonly courseId: string;
    readonly userId: string;
  },
): Promise<boolean> {
  const member = await tx.academyMember.findFirst({
    // `status: 'active'` matters: a removed or suspended member must not
    // remain a host just because the row still exists.
    where: { academyId: args.academyId, userId: args.userId, status: 'active' },
    select: { role: true },
  });

  if (member && ACADEMY_WIDE_HOST_ROLES.has(member.role)) return true;

  if (member?.role === 'instructor') {
    const assignment = await tx.courseInstructor.findUnique({
      where: { courseId_userId: { courseId: args.courseId, userId: args.userId } },
      select: { courseId: true },
    });
    if (assignment) return true;
  }

  // Otherwise only the organization owner's implicit ownership can still
  // make them a host (the guard resolves them to `owner` whatever their
  // own staff row says).
  const academy = await tx.academy.findUnique({
    where: { id: args.academyId },
    select: { organizationId: true },
  });
  if (!academy) return false;
  const ownerMembership = await tx.organizationMembership.findFirst({
    where: { organizationId: academy.organizationId, userId: args.userId, role: 'owner' },
    select: { id: true },
  });
  return ownerMembership !== null;
}
