/**
 * Fix round (20 Oct 2026, team) — a learner whose registration the academy
 * REJECTED cannot start a checkout there: the purchase would produce an
 * enrollment that opens nothing. A pending learner still can (access
 * follows approval), an active one is unaffected, and someone with no
 * membership is admitted by the purchase as before. A blocked learner is
 * not this rule's business (unchanged).
 */
import { ForbiddenException } from '@nestjs/common';
import { CourseOrdersService } from './course-orders.service';

const STUDENT_ID = 'student-1';
const ACADEMY_ID = 'academy-1';
const at = new Date('2026-10-01T00:00:00.000Z');

function build(membership: { status: string; blockedAt: Date | null } | null) {
  const tx = {};
  const tenancyContextService = {
    runInUserContext: jest.fn(async (_u: string, work: (client: unknown) => unknown) =>
      work(tx),
    ),
  };
  const coursesRepository = {
    findPublishedById: jest.fn(async () => ({
      id: 'course-1',
      academyId: ACADEMY_ID,
      pricingType: 'paid',
      pricingAmountMinorUnits: 150000n,
      pricingCurrency: 'EGP',
    })),
  };
  const courseOrdersRepository = {
    findByIdempotencyKey: jest.fn(async () => null),
    findActiveForStudentAndCourse: jest.fn(async () => null),
    create: jest.fn(),
  };
  const enrollmentsRepository = { findByStudentAndCourse: jest.fn(async () => null) };
  // Stops the flow right after the membership gate, so a test can tell
  // "refused by the gate" from "let through".
  const academiesRepository = {
    resolveOrganizationId: jest.fn(async () => {
      throw new Error('past the membership gate');
    }),
  };
  const academyStudentsRepository = {
    findForUserInAcademy: jest.fn(async () => membership),
  };
  const service = new CourseOrdersService(
    tenancyContextService as never,
    coursesRepository as never,
    academiesRepository as never,
    enrollmentsRepository as never,
    {} as never, // organizationPaymentSettingsService
    courseOrdersRepository as never,
    { recordCheckoutOrderState: jest.fn() } as never,
    { emit: jest.fn(), enqueueAfterCommit: jest.fn() } as never,
    {} as never, // academyPaymentMethodsRepository
    {} as never, // entitlementEnforcementService
    academyStudentsRepository as never,
  );
  return { service, academyStudentsRepository, courseOrdersRepository };
}

const order = (service: CourseOrdersService) =>
  service.createOrder(STUDENT_ID, 'course-1', { idempotencyKey: 'k-1' } as never);

describe('CourseOrdersService — rejected learners cannot check out', () => {
  it('refuses a rejected (inactive, unblocked) learner with registrationRejected', async () => {
    const t = build({ status: 'inactive', blockedAt: null });
    const error = await order(t.service).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as ForbiddenException).getResponse()).toEqual({
      messageKey: 'errors.academy.registrationRejected',
    });
    expect(t.academyStudentsRepository.findForUserInAcademy).toHaveBeenCalledWith(
      expect.anything(),
      ACADEMY_ID,
      STUDENT_ID,
    );
    expect(t.courseOrdersRepository.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a pending learner', { status: 'pending', blockedAt: null }],
    ['an active learner', { status: 'active', blockedAt: null }],
    ['a blocked learner (not this rule)', { status: 'inactive', blockedAt: at }],
    ['someone with no membership yet', null],
  ])('lets %s through to the next checks', async (_label, membership) => {
    const t = build(membership);
    await expect(order(t.service)).rejects.toThrow('past the membership gate');
  });
});
