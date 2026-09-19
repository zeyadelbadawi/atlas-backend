/**
 * P64 Phase 1 — the one rule for "this enrollment grants access right now".
 * Every reader (content, quizzes, assignments, progress, roster) shares it,
 * so it is unit-tested directly rather than only through HTTP.
 *
 * P64 Phase 2 security review adds the three AUTHORIZATION helpers below it.
 * They are unit-tested here rather than only through e2e because each is the
 * TypeScript half of a SQL predicate (`can_review_course`,
 * `can_author_course_content`, the owner-only rule behind D8), and the
 * project rule is that the guard and the policy must agree independently.
 * A unit test states what the guard half promises, precisely enough that a
 * drift from the SQL half is visible as a diff rather than as a 403 nobody
 * expected.
 */
import {
  assertActiveEnrollment,
  assertCanManageSecurityPolicy,
  assertCanReviewCourse,
  assertCourseReadAccess,
  isEnrollmentActive,
} from './learning-access.util';
import type { Prisma } from '@prisma/client';

const base = {
  status: 'enrolled' as const,
  revokedAt: null as Date | null,
  expiresAt: null as Date | null,
};

describe('isEnrollmentActive (P64 Phase 1)', () => {
  it('accepts an enrolled or completed enrollment with no lifecycle limits', () => {
    expect(isEnrollmentActive(base)).toBe(true);
    expect(isEnrollmentActive({ ...base, status: 'completed' })).toBe(true);
  });

  it('refuses every non-active status', () => {
    for (const status of ['available', 'pending', 'unavailable'] as const) {
      expect(isEnrollmentActive({ ...base, status })).toBe(false);
    }
  });

  it('refuses a revoked enrollment even when the status still says enrolled', () => {
    expect(isEnrollmentActive({ ...base, revokedAt: new Date() })).toBe(false);
  });

  it('refuses an expired enrollment and accepts one expiring in the future', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(
      isEnrollmentActive(
        { ...base, expiresAt: new Date('2026-09-18T11:59:59.000Z') },
        now,
      ),
    ).toBe(false);
    expect(
      isEnrollmentActive(
        { ...base, expiresAt: new Date('2026-09-18T12:00:01.000Z') },
        now,
      ),
    ).toBe(true);
  });

  it('treats an expiry exactly at "now" as expired — access ends at the boundary', () => {
    const now = new Date('2026-09-18T12:00:00.000Z');
    expect(isEnrollmentActive({ ...base, expiresAt: now }, now)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The authorization helpers.
//
// Hand-built doubles rather than `jest.mock`: each of these functions takes
// its repositories as ARGUMENTS, which is exactly what makes them testable
// without a database, and a literal object states the fixture's shape where a
// mock factory would hide it.
// ---------------------------------------------------------------------------

const tx = {} as Prisma.TransactionClient;

type Membership = { role: string; status: string } | null;

function academyMembers(membership: Membership) {
  return {
    findForUserInAcademy: () => Promise.resolve(membership),
  } as unknown as Parameters<typeof assertCanReviewCourse>[2];
}

function courses(academyId: string | null) {
  return {
    findById: () => Promise.resolve(academyId ? { id: 'course-1', academyId } : null),
  } as unknown as Parameters<typeof assertCanReviewCourse>[1];
}

function courseInstructors(isInstructor: boolean) {
  return {
    isInstructor: () => Promise.resolve(isInstructor),
  } as unknown as Parameters<typeof assertCanReviewCourse>[3];
}

function enrollments(enrollment: Record<string, unknown> | null) {
  return {
    findByStudentAndCourse: () => Promise.resolve(enrollment),
  } as unknown as Parameters<typeof assertActiveEnrollment>[1];
}

type StudentMembership = { role: string; status: string; blockedAt?: Date | null } | null;

function academyStudents(membership: StudentMembership) {
  return {
    findForUserInAcademy: () => Promise.resolve(membership),
  } as unknown as Parameters<typeof assertActiveEnrollment>[4];
}

describe('assertActiveEnrollment (condition 3 + the membership half of condition 7)', () => {
  const activeEnrollment = {
    id: 'e1',
    academyId: 'academy-1',
    status: 'enrolled',
    revokedAt: null,
    expiresAt: null,
  };

  it('admits an active enrollment held by an active, unblocked member', async () => {
    await expect(
      assertActiveEnrollment(
        tx,
        enrollments(activeEnrollment),
        'user-1',
        'course-1',
        academyStudents({ role: 'student', status: 'active', blockedAt: null }),
      ),
    ).resolves.toMatchObject({ id: 'e1' });
  });

  it('refuses with 404 rather than 403 — an unauthorized caller learns nothing about the course', async () => {
    await expect(
      assertActiveEnrollment(tx, enrollments(null), 'user-1', 'course-1'),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a revoked enrollment, an expired one, and a refunded one', async () => {
    for (const enrollment of [
      { ...activeEnrollment, revokedAt: new Date() },
      { ...activeEnrollment, expiresAt: new Date(Date.now() - 1_000) },
      { ...activeEnrollment, status: 'unavailable', revokedAt: new Date() },
    ]) {
      await expect(
        assertActiveEnrollment(tx, enrollments(enrollment), 'user-1', 'course-1'),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it('refuses a BLOCKED academy membership even though the enrollment itself is untouched', async () => {
    await expect(
      assertActiveEnrollment(
        tx,
        enrollments(activeEnrollment),
        'user-1',
        'course-1',
        academyStudents({ role: 'student', status: 'active', blockedAt: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses a membership that is no longer active, and one that never existed', async () => {
    for (const membership of [
      { role: 'student', status: 'inactive', blockedAt: null },
      null,
    ] as StudentMembership[]) {
      await expect(
        assertActiveEnrollment(
          tx,
          enrollments(activeEnrollment),
          'user-1',
          'course-1',
          academyStudents(membership),
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });
});

describe('assertCourseReadAccess (definition reads)', () => {
  const activeEnrollment = {
    id: 'e1',
    academyId: 'academy-1',
    status: 'enrolled',
    revokedAt: null,
    expiresAt: null,
  };

  it('a blocked membership closes the definition read too, not only the content grant', async () => {
    await expect(
      assertCourseReadAccess(
        tx,
        enrollments(activeEnrollment),
        courseInstructors(false),
        'user-1',
        'course-1',
        undefined,
        academyStudents({ role: 'student', status: 'active', blockedAt: new Date() }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it('an assigned instructor passes without any enrollment at all', async () => {
    await expect(
      assertCourseReadAccess(
        tx,
        enrollments(null),
        courseInstructors(true),
        'user-1',
        'course-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('a reviewer passes only while their membership is active', async () => {
    const reviewers = (status: string) => ({
      coursesRepository: courses('academy-1') as never,
      academyMembersRepository: academyMembers({ role: 'manager', status }) as never,
    });

    await expect(
      assertCourseReadAccess(
        tx,
        enrollments(null),
        courseInstructors(false),
        'user-1',
        'course-1',
        reviewers('active'),
      ),
    ).resolves.toBeUndefined();

    await expect(
      assertCourseReadAccess(
        tx,
        enrollments(null),
        courseInstructors(false),
        'user-1',
        'course-1',
        reviewers('inactive'),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('assertCanReviewCourse (the review/grading tier, mirrors can_review_course)', () => {
  it('admits the course instructor, and says so in the reviewer role', async () => {
    await expect(
      assertCanReviewCourse(
        tx,
        courses('academy-1'),
        academyMembers(null),
        courseInstructors(true),
        'user-1',
        'course-1',
      ),
    ).resolves.toEqual({ academyId: 'academy-1', reviewerRole: 'instructor' });
  });

  it('admits an active owner, administrator and manager', async () => {
    for (const role of ['owner', 'administrator', 'manager'] as const) {
      await expect(
        assertCanReviewCourse(
          tx,
          courses('academy-1'),
          academyMembers({ role, status: 'active' }),
          courseInstructors(false),
          'user-1',
          'course-1',
        ),
      ).resolves.toEqual({ academyId: 'academy-1', reviewerRole: role });
    }
  });

  it('refuses academy staff, a plain member and anyone with no membership', async () => {
    for (const membership of [
      { role: 'staff', status: 'active' },
      { role: 'instructor', status: 'active' },
      null,
    ] as Membership[]) {
      await expect(
        assertCanReviewCourse(
          tx,
          courses('academy-1'),
          academyMembers(membership),
          courseInstructors(false),
          'user-1',
          'course-1',
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it('refuses a managing role whose membership is no longer active', async () => {
    for (const status of ['inactive', 'pending']) {
      await expect(
        assertCanReviewCourse(
          tx,
          courses('academy-1'),
          academyMembers({ role: 'owner', status }),
          courseInstructors(false),
          'user-1',
          'course-1',
        ),
      ).rejects.toMatchObject({ status: 404 });
    }
  });

  it('refuses a course that does not exist, before reading any membership', async () => {
    await expect(
      assertCanReviewCourse(
        tx,
        courses(null),
        academyMembers({ role: 'owner', status: 'active' }),
        courseInstructors(true),
        'user-1',
        'missing',
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});

describe('assertCanManageSecurityPolicy (D8 — the Client Owner alone)', () => {
  it('admits only an active owner', async () => {
    await expect(
      assertCanManageSecurityPolicy(
        tx,
        academyMembers({ role: 'owner', status: 'active' }),
        'academy-1',
        'user-1',
      ),
    ).resolves.toBeUndefined();
  });

  it('refuses a MANAGER — academy-wide operational authority stops short of security policy', async () => {
    await expect(
      assertCanManageSecurityPolicy(
        tx,
        academyMembers({ role: 'manager', status: 'active' }),
        'academy-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('refuses administrator, instructor, staff and a non-member alike', async () => {
    for (const membership of [
      { role: 'administrator', status: 'active' },
      { role: 'instructor', status: 'active' },
      { role: 'staff', status: 'active' },
      null,
    ] as Membership[]) {
      await expect(
        assertCanManageSecurityPolicy(
          tx,
          academyMembers(membership),
          'academy-1',
          'user-1',
        ),
      ).rejects.toMatchObject({ status: 403 });
    }
  });

  it('refuses an owner whose membership is not active', async () => {
    await expect(
      assertCanManageSecurityPolicy(
        tx,
        academyMembers({ role: 'owner', status: 'inactive' }),
        'academy-1',
        'user-1',
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
