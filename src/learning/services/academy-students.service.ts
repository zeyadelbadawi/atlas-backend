/**
 * AcademyStudentsService — P64 Phase 1 (Findings F4/F5, master plan Sections
 * H, N, O).
 *
 * The academy's STUDENT roster and the staff-side enrollment lifecycle:
 * list/search/filter students, a per-student detail (enrollments, progress,
 * quiz and assignment outcomes), block/unblock, approve/reject pending
 * registrations, manual enroll, revoke, extend expiry, the registration
 * policy and invite tokens.
 *
 * Authorization (RBAC matrix):
 *   - Client Owner / Manager (and the hidden `administrator`): whole academy.
 *   - Instructor: read-only, students enrolled in a course they teach.
 *   - Registration policy: Client Owner only (D8 — security-sensitive).
 *   - Everyone else: 403.
 * Every read and write runs under `runInTenantAndUserContext`, so the tenant
 * policies on `academy_students`/`enrollments` and the roster policy
 * (`can_view_academy_student`) independently agree with the checks here.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { EntitlementEnforcementService } from '../../plans/services/entitlement-enforcement.service';
import { AcademyRosterRepository } from '../repositories/academy-roster.repository';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { EnrollmentsService } from './enrollments.service';
import {
  assertCanManageSecurityPolicy,
  isEnrollmentActive,
} from './learning-access.util';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import type {
  AcademyRosterQueryDto,
  BlockStudentDto,
  CreateAcademyInviteDto,
  ManualEnrollDto,
  RevokeEnrollmentDto,
  UpdateEnrollmentExpiryDto,
  UpdateRegistrationPolicyDto,
} from '../dto/academy-roster.dto';
import {
  toAcademyInviteResponse,
  toAcademyRosterStudentResponse,
  toRosterEnrollmentResponse,
} from '../dto/academy-roster.contract';
import type {
  AcademyInviteResponse,
  AcademyRegistrationPolicyResponse,
  AcademyRosterStudentDetailResponse,
  AcademyRosterStudentResponse,
  RosterEnrollmentResponse,
} from '../dto/academy-roster.contract';
import {
  generateOpaqueToken,
  hashOpaqueToken,
} from '../../identity/utils/opaque-token.util';
import { RefreshTokensRepository } from '../../identity/repositories/refresh-tokens.repository';
import { SessionRevocationService } from '../../identity/services/session-revocation.service';

const MANAGING_ROLES = new Set(['owner', 'administrator', 'manager']);

interface RosterViewer {
  readonly scope: 'academy' | 'assigned_courses';
  readonly role: string;
  readonly courseIds?: readonly string[];
}

@Injectable()
export class AcademyStudentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly rosterRepository: AcademyRosterRepository,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly enrollmentsService: EnrollmentsService,
    private readonly entitlementEnforcementService: EntitlementEnforcementService,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly refreshTokensRepository: RefreshTokensRepository,
    private readonly sessionRevocationService: SessionRevocationService,
  ) {}

  // ---------------------------------------------------------------------
  // authorization
  // ---------------------------------------------------------------------

  /** Who is looking, and at how much of the roster. */
  private async resolveViewer(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<RosterViewer> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (
      membership &&
      membership.status === 'active' &&
      MANAGING_ROLES.has(membership.role)
    ) {
      return { scope: 'academy', role: membership.role };
    }
    const courseIds = await this.rosterRepository.findCourseIdsTaughtBy(
      tx,
      academyId,
      userId,
    );
    if (courseIds.length > 0) {
      return { scope: 'assigned_courses', role: 'instructor', courseIds };
    }
    throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
  }

  /** Write actions on the roster: owner/administrator/manager only. */
  private async assertCanManageStudents(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<string> {
    const membership = await this.academyMembersRepository.findForUserInAcademy(
      tx,
      academyId,
      userId,
    );
    if (
      !membership ||
      membership.status !== 'active' ||
      !MANAGING_ROLES.has(membership.role)
    ) {
      throw new ForbiddenException({ messageKey: 'errors.academy.insufficientRole' });
    }
    return membership.role;
  }

  // ---------------------------------------------------------------------
  // roster reads
  // ---------------------------------------------------------------------

  async list(
    academyId: string,
    organizationId: string,
    userId: string,
    query: AcademyRosterQueryDto,
  ): Promise<PaginatedResult<AcademyRosterStudentResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;

    const { items, totalItems } =
      await this.tenancyContextService.runInTenantAndUserContext(
        organizationId,
        userId,
        async (tx) => {
          const viewer = await this.resolveViewer(tx, academyId, userId);
          return this.rosterRepository.findManyForAcademy(tx, academyId, {
            search: query.search?.trim() || undefined,
            status: query.status,
            courseId: query.courseId,
            sortBy: query.sortBy ?? 'joinedAt',
            sortDir: query.sortDir ?? 'desc',
            skip: (page - 1) * pageSize,
            take: pageSize,
            restrictToCourseIds:
              viewer.scope === 'assigned_courses' ? viewer.courseIds : undefined,
          });
        },
      );

    return {
      items: items.map(toAcademyRosterStudentResponse),
      pagination: buildPaginationMeta(page, pageSize, totalItems),
    };
  }

  async getDetail(
    academyId: string,
    organizationId: string,
    userId: string,
    studentUserId: string,
  ): Promise<AcademyRosterStudentDetailResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const viewer = await this.resolveViewer(tx, academyId, userId);
        const membership = await this.rosterRepository.findMembership(
          tx,
          academyId,
          studentUserId,
        );
        if (!membership) throw new NotFoundException({ messageKey: 'errors.notFound' });

        const enrollments = await this.rosterRepository.findEnrollmentsForStudent(
          tx,
          academyId,
          studentUserId,
          viewer.scope === 'assigned_courses' ? viewer.courseIds : undefined,
        );
        if (viewer.scope === 'assigned_courses' && enrollments.length === 0) {
          // An instructor only ever sees students of their own courses;
          // anyone else on the roster looks like they do not exist.
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const courseIds = enrollments.map((row) => row.courseId);
        const [attempts, submissions, activeSessionCount] = await Promise.all([
          this.rosterRepository.findQuizAttemptsForStudent(tx, studentUserId, courseIds),
          this.rosterRepository.findSubmissionsForStudent(tx, studentUserId, courseIds),
          this.rosterRepository.countDevicesForStudent(tx, studentUserId),
        ]);

        const counts = {
          enrollmentCount: enrollments.length,
          activeEnrollmentCount: enrollments.filter((row) => isEnrollmentActive(row))
            .length,
        };
        return {
          student: toAcademyRosterStudentResponse({ ...membership, ...counts }),
          enrollments: enrollments.map((row) =>
            toRosterEnrollmentResponse(row, isEnrollmentActive(row)),
          ),
          quizOutcomes: attempts.map((attempt) => ({
            attemptId: attempt.id,
            quizId: attempt.quizId,
            quizTitle: attempt.quiz.title,
            courseId: attempt.quiz.courseId,
            attemptNumber: attempt.attemptNumber,
            status: attempt.status,
            score: attempt.score === null ? null : Number(attempt.score),
            passed: attempt.passed,
            submittedAt: attempt.submittedAt?.toISOString() ?? null,
          })),
          assignmentOutcomes: submissions.map((submission) => ({
            submissionId: submission.id,
            assignmentId: submission.assignmentId,
            assignmentTitle: submission.assignment.title,
            courseId: submission.assignment.courseId,
            status: submission.status,
            gradingStatus: submission.gradingStatus,
            score: submission.score === null ? null : Number(submission.score),
            hasFeedback: !!submission.feedback,
            submittedAt: submission.submittedAt?.toISOString() ?? null,
            gradedAt: submission.gradedAt?.toISOString() ?? null,
          })),
          activeSessionCount,
          viewerScope: viewer.scope,
        };
      },
    );
  }

  // ---------------------------------------------------------------------
  // membership lifecycle: block / unblock / approve / reject
  // ---------------------------------------------------------------------

  async block(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
    payload: BlockStudentDto,
  ): Promise<AcademyRosterStudentResponse> {
    const result = await this.mutateMembership(
      academyId,
      organizationId,
      actingUserId,
      studentUserId,
      { blockedAt: new Date(), blockedReason: payload.reason ?? null },
      'academy.student.blocked',
    );

    // Blocking must END the sessions this learner already holds on THIS
    // academy, not merely refuse the next sign-in. Every content read
    // re-checks the membership, so nothing leaks either way — but a
    // blocked learner who stays signed in on the academy site until their
    // access token expires is not what "blocked" means to the staff member
    // who just clicked it.
    //
    // Deliberately AFTER the membership transaction has committed: the
    // block is the durable outcome, and a Redis or session-store failure
    // here must not roll it back. `markRevoked` already swallows Redis
    // failures and the guard falls back to the database rows this just
    // revoked, so the worst case is a slower, not a missed, revocation.
    // Scoped to this academy — a learner blocked by one academy stays
    // signed in on any other academy they belong to.
    const sessionIds = await this.refreshTokensRepository.revokeSessionsForUserInAcademy(
      studentUserId,
      academyId,
    );
    await Promise.all(
      sessionIds.map((id) => this.sessionRevocationService.markRevoked(id)),
    );

    return result;
  }

  async unblock(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
  ): Promise<AcademyRosterStudentResponse> {
    return this.mutateMembership(
      academyId,
      organizationId,
      actingUserId,
      studentUserId,
      { blockedAt: null, blockedReason: null },
      'academy.student.unblocked',
    );
  }

  async approve(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
  ): Promise<AcademyRosterStudentResponse> {
    return this.mutateMembership(
      academyId,
      organizationId,
      actingUserId,
      studentUserId,
      { status: 'active' },
      'academy.student.approved',
      (row) => {
        if (row.status !== 'pending') {
          throw new ConflictException({ messageKey: 'errors.academy.studentNotPending' });
        }
      },
    );
  }

  async reject(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
  ): Promise<AcademyRosterStudentResponse> {
    return this.mutateMembership(
      academyId,
      organizationId,
      actingUserId,
      studentUserId,
      { status: 'inactive' },
      'academy.student.rejected',
      (row) => {
        if (row.status !== 'pending') {
          throw new ConflictException({ messageKey: 'errors.academy.studentNotPending' });
        }
      },
    );
  }

  private async mutateMembership(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
    data: Prisma.AcademyStudentUpdateInput,
    action: string,
    precondition?: (row: { status: string }) => void,
  ): Promise<AcademyRosterStudentResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, actingUserId);
        const membership = await this.rosterRepository.findMembership(
          tx,
          academyId,
          studentUserId,
        );
        if (!membership) throw new NotFoundException({ messageKey: 'errors.notFound' });
        precondition?.(membership);

        await this.rosterRepository.updateMembership(tx, membership.id, data);
        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          academyId,
          role,
          action,
          targetType: 'user',
          targetId: studentUserId,
          targetLabel: membership.user.email,
        });

        const fresh = await this.rosterRepository.findMembership(
          tx,
          academyId,
          studentUserId,
        );
        const enrollments = await this.rosterRepository.findEnrollmentsForStudent(
          tx,
          academyId,
          studentUserId,
        );
        return toAcademyRosterStudentResponse({
          ...fresh!,
          enrollmentCount: enrollments.length,
          activeEnrollmentCount: enrollments.filter((row) => isEnrollmentActive(row))
            .length,
        });
      },
    );
  }

  // ---------------------------------------------------------------------
  // enrollment lifecycle: manual enroll / revoke / extend
  // ---------------------------------------------------------------------

  async enrollManually(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    studentUserId: string,
    payload: ManualEnrollDto,
  ): Promise<RosterEnrollmentResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, actingUserId);
        const membership = await this.rosterRepository.findMembership(
          tx,
          academyId,
          studentUserId,
        );
        if (!membership) throw new NotFoundException({ messageKey: 'errors.notFound' });
        if (membership.blockedAt) {
          throw new ConflictException({ messageKey: 'errors.academy.studentBlocked' });
        }
        const course = await this.coursesRepository.findById(tx, payload.courseId);
        if (!course || course.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
        if (expiresAt && expiresAt.getTime() <= Date.now()) {
          throw new BadRequestException({ messageKey: 'errors.enrollment.expiryInPast' });
        }

        const existing = await this.enrollmentsRepository.findByStudentAndCourse(
          tx,
          studentUserId,
          course.id,
        );
        let enrollmentId: string;
        if (existing) {
          if (isEnrollmentActive(existing)) {
            throw new ConflictException({
              messageKey: 'errors.enrollment.alreadyEnrolled',
            });
          }
          // Re-grant: the row keeps its history; lifecycle columns reset.
          await this.enrollmentsRepository.update(tx, existing.id, {
            status: 'enrolled',
            enrolledAt: new Date(),
            revokedAt: null,
            revokeReason: null,
            expiresAt,
            accessSource: 'manual',
          });
          enrollmentId = existing.id;
        } else {
          const alreadyCounted =
            await this.enrollmentsRepository.countActiveForStudentInOrganization(
              tx,
              organizationId,
              studentUserId,
            );
          await this.entitlementEnforcementService.assertWithinLimit(
            tx,
            organizationId,
            'students',
            alreadyCounted > 0 ? 0 : 1,
          );
          const created = await this.enrollmentsService.createEnrollmentInTransaction(
            tx,
            studentUserId,
            course,
            { accessSource: 'manual', expiresAt },
          );
          enrollmentId = created.id;
        }

        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          academyId,
          role,
          action: 'enrollment.granted',
          targetType: 'enrollment',
          targetId: enrollmentId,
          targetLabel: `${membership.user.email} → ${course.title}`,
        });

        const rows = await this.rosterRepository.findEnrollmentsForStudent(
          tx,
          academyId,
          studentUserId,
        );
        const row = rows.find((r) => r.id === enrollmentId)!;
        return toRosterEnrollmentResponse(row, isEnrollmentActive(row));
      },
    );
  }

  async revoke(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    enrollmentId: string,
    payload: RevokeEnrollmentDto,
  ): Promise<RosterEnrollmentResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, actingUserId);
        const enrollment = await this.enrollmentsRepository.findById(tx, enrollmentId);
        if (!enrollment || enrollment.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        if (!enrollment.revokedAt) {
          const reason = payload.reason ?? 'manual';
          await this.enrollmentsRepository.update(tx, enrollment.id, {
            status: 'unavailable',
            revokedAt: new Date(),
            revokeReason: reason,
          });
          // The label names WHO lost access to WHAT, exactly like
          // `enrollment.granted` — an audit line reading only "manual" says
          // nothing without re-reading the enrollment row it points at.
          const [student, course] = await Promise.all([
            this.rosterRepository.findMembership(tx, academyId, enrollment.studentId),
            this.coursesRepository.findById(tx, enrollment.courseId),
          ]);
          await this.auditLogWriterService.write(tx, {
            actorUserId: actingUserId,
            organizationId,
            academyId,
            role,
            action: 'enrollment.revoked',
            targetType: 'enrollment',
            targetId: enrollment.id,
            targetLabel: `${student?.user.email ?? enrollment.studentId} → ${
              course?.title ?? enrollment.courseId
            } · ${reason}`,
          });
        }
        return this.readEnrollment(tx, academyId, enrollment.studentId, enrollment.id);
      },
    );
  }

  async updateExpiry(
    academyId: string,
    organizationId: string,
    actingUserId: string,
    enrollmentId: string,
    payload: UpdateEnrollmentExpiryDto,
  ): Promise<RosterEnrollmentResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      actingUserId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, actingUserId);
        const enrollment = await this.enrollmentsRepository.findById(tx, enrollmentId);
        if (!enrollment || enrollment.academyId !== academyId) {
          throw new NotFoundException({ messageKey: 'errors.notFound' });
        }
        const expiresAt = payload.expiresAt ? new Date(payload.expiresAt) : null;
        if (expiresAt && expiresAt.getTime() <= Date.now()) {
          throw new BadRequestException({ messageKey: 'errors.enrollment.expiryInPast' });
        }
        await this.enrollmentsRepository.update(tx, enrollment.id, { expiresAt });
        await this.auditLogWriterService.write(tx, {
          actorUserId: actingUserId,
          organizationId,
          academyId,
          role,
          action: 'enrollment.expiry_updated',
          targetType: 'enrollment',
          targetId: enrollment.id,
          targetLabel: expiresAt ? expiresAt.toISOString() : 'cleared',
        });
        return this.readEnrollment(tx, academyId, enrollment.studentId, enrollment.id);
      },
    );
  }

  private async readEnrollment(
    tx: Prisma.TransactionClient,
    academyId: string,
    studentUserId: string,
    enrollmentId: string,
  ): Promise<RosterEnrollmentResponse> {
    const rows = await this.rosterRepository.findEnrollmentsForStudent(
      tx,
      academyId,
      studentUserId,
    );
    const row = rows.find((r) => r.id === enrollmentId);
    if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toRosterEnrollmentResponse(row, isEnrollmentActive(row));
  }

  // ---------------------------------------------------------------------
  // registration policy (D3, owner-only per D8) and invites
  // ---------------------------------------------------------------------

  async getRegistrationPolicy(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<AcademyRegistrationPolicyResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManageStudents(tx, academyId, userId);
        const academy = await tx.academy.findUnique({ where: { id: academyId } });
        if (!academy) throw new NotFoundException({ messageKey: 'errors.notFound' });
        return { academyId, registrationPolicy: academy.registrationPolicy };
      },
    );
  }

  async updateRegistrationPolicy(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: UpdateRegistrationPolicyDto,
  ): Promise<AcademyRegistrationPolicyResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await assertCanManageSecurityPolicy(
          tx,
          this.academyMembersRepository,
          academyId,
          userId,
        );
        const academy = await this.academiesRepository.update(tx, academyId, {
          registrationPolicy: payload.registrationPolicy,
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role: 'owner',
          action: 'academy.registration_policy.updated',
          targetType: 'academy',
          targetId: academyId,
          targetLabel: payload.registrationPolicy,
        });
        return { academyId, registrationPolicy: academy.registrationPolicy };
      },
    );
  }

  async listInvites(
    academyId: string,
    organizationId: string,
    userId: string,
  ): Promise<readonly AcademyInviteResponse[]> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        await this.assertCanManageStudents(tx, academyId, userId);
        const rows = await tx.academyInvite.findMany({
          where: { academyId },
          orderBy: { createdAt: 'desc' },
          take: 200,
        });
        return rows.map((row) => toAcademyInviteResponse(row));
      },
    );
  }

  async createInvite(
    academyId: string,
    organizationId: string,
    userId: string,
    payload: CreateAcademyInviteDto,
  ): Promise<AcademyInviteResponse> {
    return this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, userId);
        const rawToken = generateOpaqueToken();
        const days = payload.expiresInDays ?? 14;
        const row = await tx.academyInvite.create({
          data: {
            academyId,
            tokenHash: hashOpaqueToken(rawToken),
            createdBy: userId,
            email: payload.email?.toLowerCase() ?? null,
            maxUses: payload.maxUses ?? 1,
            expiresAt: new Date(Date.now() + days * 24 * 60 * 60 * 1000),
          },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'academy.invite.created',
          targetType: 'academy_invite',
          targetId: row.id,
          targetLabel: payload.email ?? `${row.maxUses} uses`,
        });
        return toAcademyInviteResponse(row, rawToken);
      },
    );
  }

  async revokeInvite(
    academyId: string,
    organizationId: string,
    userId: string,
    inviteId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInTenantAndUserContext(
      organizationId,
      userId,
      async (tx) => {
        const role = await this.assertCanManageStudents(tx, academyId, userId);
        const row = await tx.academyInvite.findFirst({
          where: { id: inviteId, academyId },
        });
        if (!row) throw new NotFoundException({ messageKey: 'errors.notFound' });
        await tx.academyInvite.update({
          where: { id: row.id },
          data: { revokedAt: new Date() },
        });
        await this.auditLogWriterService.write(tx, {
          actorUserId: userId,
          organizationId,
          academyId,
          role,
          action: 'academy.invite.revoked',
          targetType: 'academy_invite',
          targetId: row.id,
        });
      },
    );
  }
}
