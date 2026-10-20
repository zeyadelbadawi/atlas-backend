/**
 * Fix round (20 Oct 2026, team) — the roster decisions that must agree
 * with what a learner can actually do:
 *   - a REJECTED registration can still be approved later (the reject
 *     dialog promises it is not final); a rejected-and-blocked row cannot,
 *     and an active row has nothing to approve;
 *   - a manual enrollment is refused for a learner who is not an ACTIVE
 *     member (pending or rejected): learning access needs an active
 *     membership, so "Student enrolled" would have opened nothing.
 */
import { ConflictException } from '@nestjs/common';
import { AcademyStudentsService } from './academy-students.service';
import { isRejectedRegistration } from '../../tenancy/repositories/academy-students.repository';

const ACADEMY_ID = 'academy-1';
const ORG_ID = 'org-1';
const OWNER_ID = 'owner-1';
const STUDENT_ID = 'student-1';
const at = new Date('2026-10-01T00:00:00.000Z');

function membershipRow(overrides: { status?: string; blockedAt?: Date | null } = {}) {
  return {
    id: 'membership-1',
    academyId: ACADEMY_ID,
    userId: STUDENT_ID,
    status: overrides.status ?? 'pending',
    blockedAt: overrides.blockedAt ?? null,
    blockedReason: null,
    source: 'self_signup',
    joinedAt: at,
    lastActivityAt: null,
    user: {
      id: STUDENT_ID,
      name: 'Fixture Learner',
      email: 'learner@example.com',
      avatarUrl: null,
      status: 'active',
      emailVerifiedAt: at,
    },
  };
}

function build(row: ReturnType<typeof membershipRow>) {
  const tx = {};
  const tenancyContextService = {
    runInTenantAndUserContext: jest.fn(
      async (_o: string, _u: string, work: (client: unknown) => unknown) => work(tx),
    ),
  };
  const academyMembersRepository = { findManagingRole: jest.fn(async () => 'manager') };
  const rosterRepository = {
    findMembership: jest.fn(async () => row),
    updateMembership: jest.fn(async () => row),
    findEnrollmentsForStudent: jest.fn(async () => []),
  };
  const coursesRepository = {
    findById: jest.fn(async () => ({ id: 'course-1', academyId: ACADEMY_ID })),
  };
  const enrollmentsRepository = { findByStudentAndCourse: jest.fn() };
  const enrollmentsService = { createEnrollmentInTransaction: jest.fn() };
  const auditLogWriterService = { write: jest.fn(async () => undefined) };
  const academiesRepository = {
    findById: jest.fn(async () => ({ id: ACADEMY_ID, name: 'Fixture Academy' })),
  };
  const communicationService = {
    emit: jest.fn(async () => ({ created: true, outboxId: 'outbox-1' })),
    enqueueAfterCommit: jest.fn(async () => undefined),
  };
  const service = new AcademyStudentsService(
    tenancyContextService as never,
    academyMembersRepository as never,
    academiesRepository as never,
    coursesRepository as never,
    rosterRepository as never,
    enrollmentsRepository as never,
    enrollmentsService as never,
    {} as never, // entitlementEnforcementService
    auditLogWriterService as never,
    {} as never, // refreshTokensRepository
    {} as never, // sessionRevocationService
    {} as never, // learningLeaseService
    {} as never, // emailRiskService
    communicationService as never,
  );
  return {
    service,
    rosterRepository,
    coursesRepository,
    enrollmentsRepository,
    enrollmentsService,
    auditLogWriterService,
    communicationService,
  };
}

async function messageKeyOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ConflictException);
    return ((error as ConflictException).getResponse() as { messageKey?: string })
      .messageKey;
  }
  throw new Error('expected the call to be refused');
}

describe('isRejectedRegistration', () => {
  it('is an inactive, unblocked membership — never a blocked, pending or active one', () => {
    expect(isRejectedRegistration({ status: 'inactive', blockedAt: null })).toBe(true);
    expect(isRejectedRegistration({ status: 'inactive', blockedAt: at })).toBe(false);
    expect(isRejectedRegistration({ status: 'pending', blockedAt: null })).toBe(false);
    expect(isRejectedRegistration({ status: 'active', blockedAt: null })).toBe(false);
  });
});

describe('AcademyStudentsService.approve', () => {
  it.each(['pending', 'inactive'])(
    'admits a %s (pending or rejected) registration, audited and told',
    async (status) => {
      const t = build(membershipRow({ status }));
      await t.service.approve(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID);
      expect(t.rosterRepository.updateMembership).toHaveBeenCalledWith(
        expect.anything(),
        'membership-1',
        { status: 'active' },
      );
      expect(t.auditLogWriterService.write).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'academy.student.approved', role: 'manager' }),
      );
      expect(t.communicationService.emit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ key: 'roster.student.approved' }),
      );
    },
  );

  it('refuses a rejected learner who is also blocked — the block stays effective', async () => {
    const t = build(membershipRow({ status: 'inactive', blockedAt: at }));
    expect(
      await messageKeyOf(t.service.approve(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID)),
    ).toBe('errors.academy.studentNotPending');
    expect(t.rosterRepository.updateMembership).not.toHaveBeenCalled();
  });

  it('refuses an active learner (nothing to approve)', async () => {
    const t = build(membershipRow({ status: 'active' }));
    expect(
      await messageKeyOf(t.service.approve(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID)),
    ).toBe('errors.academy.studentNotPending');
    expect(t.rosterRepository.updateMembership).not.toHaveBeenCalled();
  });
});

describe('AcademyStudentsService.reject', () => {
  it('still decides pending registrations only', async () => {
    const t = build(membershipRow({ status: 'inactive' }));
    expect(
      await messageKeyOf(t.service.reject(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID)),
    ).toBe('errors.academy.studentNotPending');
  });
});

describe('AcademyStudentsService.enrollManually', () => {
  const payload = { courseId: 'course-1' };

  it.each(['pending', 'inactive'])(
    'refuses a %s learner with studentNotApproved and writes nothing',
    async (status) => {
      const t = build(membershipRow({ status }));
      expect(
        await messageKeyOf(
          t.service.enrollManually(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID, payload),
        ),
      ).toBe('errors.academy.studentNotApproved');
      expect(t.enrollmentsRepository.findByStudentAndCourse).not.toHaveBeenCalled();
      expect(t.enrollmentsService.createEnrollmentInTransaction).not.toHaveBeenCalled();
      expect(t.auditLogWriterService.write).not.toHaveBeenCalled();
      expect(t.communicationService.emit).not.toHaveBeenCalled();
    },
  );

  it('keeps refusing a blocked learner with studentBlocked (checked first)', async () => {
    const t = build(membershipRow({ status: 'pending', blockedAt: at }));
    expect(
      await messageKeyOf(
        t.service.enrollManually(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID, payload),
      ),
    ).toBe('errors.academy.studentBlocked');
  });

  it('lets an active learner through to the course checks', async () => {
    const t = build(membershipRow({ status: 'active' }));
    t.enrollmentsRepository.findByStudentAndCourse.mockResolvedValue({
      id: 'enrollment-1',
      status: 'enrolled',
      revokedAt: null,
      expiresAt: null,
    });
    // An already-active enrollment: the next refusal proves the membership
    // gate let the call through.
    expect(
      await messageKeyOf(
        t.service.enrollManually(ACADEMY_ID, ORG_ID, OWNER_ID, STUDENT_ID, payload),
      ),
    ).toBe('errors.enrollment.alreadyEnrolled');
    expect(t.coursesRepository.findById).toHaveBeenCalled();
  });
});
