/**
 * AssignmentsService — matches `AssignmentService` (atlas frontend)
 * exactly for the student-facing surface (`getAssignments`/
 * `getAssignment`/submission). Assignment authoring (Phase 4, P24) is a
 * separate surface — `createAssignment`/`updateAssignment`/
 * `deleteAssignment`/`getAssignmentsForAuthoring`/
 * `getAssignmentForAuthoring` — gated by `assertCanAuthorCourseContent`.
 * Grading stays out of scope (Instructor Operations, P7, unmodified).
 *
 * `uploadSubmissionAttachment` (Phase 4) is the one exception to "this
 * service only manages the student's own submission ROW" — it wires a
 * student's real file upload through the existing R2 media pipeline
 * (`MediaService`, reused verbatim), replacing the base64-in-database
 * approach `AssignmentPage.tsx` previously used. See that method's own
 * doc comment for the full authorization/resolution chain.
 */
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { assertNoLearnerActivity } from '../../course/services/learner-activity.guard';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademiesRepository } from '../../academy/repositories/academies.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import { ProtectedMediaService } from '../../media/services/protected-media.service';
import { ContentGrantSigner } from './content-grant.signer';
import { CourseCompletionService } from './course-completion.service';
import type { SaveAssignmentDraftDto } from '../dto/save-assignment-draft.dto';
import type { UploadMediaAssetDto } from '../../media/dto/upload-media-asset.dto';

import { AssignmentsRepository } from '../repositories/assignments.repository';
import { CourseSequenceService } from './course-sequence.service';
import { toAssignmentResponse } from '../dto/assignment.contract';
import type { AssignmentResponse } from '../dto/assignment.contract';
import { toAssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type {
  AssignmentSubmissionResponse,
  SubmissionAttachmentResponse,
} from '../dto/assignment-submission.contract';

export interface SubmissionAttachmentUploadResponse {
  readonly assetId: string;
  readonly fileName: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}
import type { CreateAssignmentSubmissionDto } from '../dto/create-assignment-submission.dto';
import type { CreateAssignmentDto } from '../dto/create-assignment.dto';
import type { UpdateAssignmentDto } from '../dto/update-assignment.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import {
  assertActiveEnrollment,
  assertCanAuthorCourseContent,
  assertCourseReadAccess,
} from './learning-access.util';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly courseInstructorsRepository: CourseInstructorsRepository,
    private readonly coursesRepository: CoursesRepository,
    private readonly academyMembersRepository: AcademyMembersRepository,
    private readonly academiesRepository: AcademiesRepository,
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly protectedMediaService: ProtectedMediaService,
    private readonly contentGrantSigner: ContentGrantSigner,
    private readonly courseCompletionService: CourseCompletionService,
    private readonly assignmentsRepository: AssignmentsRepository,
    private readonly auditLogWriterService: AuditLogWriterService,
    private readonly courseSequence: CourseSequenceService,
  ) {}

  /**
   * Sequential progression, enforced on the server. An assignment stays
   * locked until everything before it in the CURRENT curriculum order is
   * finished, decided by the one live derivation the player sidebar uses so
   * a reorder can never leave the two disagreeing. A submission or draft
   * already in progress is never `locked` in the sequence, so this only ever
   * blocks the first touch of an assignment whose prerequisites are unmet.
   */
  private async assertAssignmentUnlocked(
    tx: Prisma.TransactionClient,
    userId: string,
    courseId: string,
    assignmentId: string,
  ): Promise<void> {
    const sequence = await this.courseSequence.getSequenceItems(tx, userId, courseId);
    const item = sequence.find((entry) => entry.id === assignmentId);
    if (item?.state === 'locked') {
      throw new ForbiddenException({ messageKey: 'errors.assignment.locked' });
    }
  }

  /**
   * Phase 8 — this service runs entirely under `runInUserContext`, so
   * `organizationId`/`role` (unlike `academyId`, already returned by
   * `assertCanAuthorCourseContent`) have no tenant context to read from.
   * `role` re-queries the SAME `academy_members` row
   * `assertCanAuthorCourseContent` already checked — a real membership
   * role when the caller manages the academy, or the literal
   * `'instructor'` when they hold no such membership (the only other way
   * that assertion passes is a `course_instructors` row).
   */
  private async resolveAuditAttribution(
    tx: Prisma.TransactionClient,
    academyId: string,
    userId: string,
  ): Promise<{ organizationId: string | undefined; role: string }> {
    const [organizationId, membership] = await Promise.all([
      this.academiesRepository.resolveOrganizationId(academyId),
      this.academyMembersRepository.findForUserInAcademy(tx, academyId, userId),
    ]);
    return {
      organizationId: organizationId ?? undefined,
      role: membership?.role ?? 'instructor',
    };
  }

  async getAssignments(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<AssignmentResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
        {
          coursesRepository: this.coursesRepository,
          academyMembersRepository: this.academyMembersRepository,
        },
        this.academyStudentsRepository,
      );
      const assignments = await this.assignmentsRepository.findManyPublishedForCourse(
        tx,
        courseId,
      );
      const items = assignments.map(toAssignmentResponse);
      return {
        items,
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
      };
    });
  }

  async getAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCourseReadAccess(
        tx,
        this.enrollmentsRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
        {
          coursesRepository: this.coursesRepository,
          academyMembersRepository: this.academyMembersRepository,
        },
        this.academyStudentsRepository,
      );
      const assignment = await this.assignmentsRepository.findPublishedById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toAssignmentResponse(assignment);
    });
  }

  /** Returns `null` (never 404) when the student hasn't submitted yet — matches `AssignmentService.getSubmission`'s own `AssignmentSubmission | null` return type exactly. */
  async getSubmission(
    userId: string,
    courseId: string,
    assignmentId: string,
  ): Promise<AssignmentSubmissionResponse | null> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const assignment = await this.assignmentsRepository.findPublishedById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      const submission = await this.assignmentsRepository.findSubmission(
        tx,
        assignmentId,
        userId,
      );
      if (!submission) return null;
      return toAssignmentSubmissionResponse(
        submission,
        await this.signAttachment(tx, submission.attachmentAssetId),
      );
    });
  }

  /**
   * P64 Phase 3 (§D.4) — draft autosave. A draft never changes a
   * submitted answer: while a submission is `submitted`/graded and
   * resubmission is off, the draft is refused; with resubmission on, the
   * draft is kept beside the submitted text until the learner resubmits.
   */
  async saveDraft(
    userId: string,
    courseId: string,
    assignmentId: string,
    payload: SaveAssignmentDraftDto,
  ): Promise<AssignmentSubmissionResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const assignment = await this.assignmentsRepository.findPublishedById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      await this.assertAssignmentUnlocked(tx, userId, courseId, assignmentId);
      const existing = await this.assignmentsRepository.findSubmission(
        tx,
        assignmentId,
        userId,
      );
      if (existing && existing.status === 'submitted' && !assignment.allowResubmission) {
        throw new ConflictException({ messageKey: 'errors.assignment.alreadySubmitted' });
      }
      if (payload.attachmentAssetId) {
        await this.assertOwnedProtectedAttachment(
          tx,
          payload.attachmentAssetId,
          userId,
          enrollment.academyId,
        );
      }
      const draftFields = {
        draftResponse: payload.response ?? null,
        draftSavedAt: now,
      };
      // `null` detaches — meaningful only on an existing row. A brand-new
      // draft with no attachment simply has none (Prisma's `create` has no
      // `disconnect`; sending one was a 500 the first time a learner typed
      // into an assignment they had never opened before).
      const attach =
        payload.attachmentAssetId !== undefined && payload.attachmentAssetId !== null
          ? { attachmentAsset: { connect: { id: payload.attachmentAssetId } } }
          : {};
      const detach =
        payload.attachmentAssetId === null
          ? { attachmentAsset: { disconnect: true } }
          : {};
      const row = existing
        ? await this.assignmentsRepository.updateSubmission(tx, existing.id, {
            ...draftFields,
            ...attach,
            ...detach,
          })
        : await this.assignmentsRepository.createSubmission(tx, {
            assignment: { connect: { id: assignmentId } },
            student: { connect: { id: userId } },
            status: 'draft',
            gradingStatus: 'ungraded',
            ...draftFields,
            ...attach,
          });
      return toAssignmentSubmissionResponse(
        row,
        await this.signAttachment(tx, row.attachmentAssetId),
      );
    });
  }

  async submitAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
    payload: CreateAssignmentSubmissionDto,
  ): Promise<AssignmentSubmissionResponse> {
    const now = new Date();
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const enrollment = await assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      );
      const assignment = await this.assignmentsRepository.findPublishedById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      await this.assertAssignmentUnlocked(tx, userId, courseId, assignmentId);
      const existing = await this.assignmentsRepository.findSubmission(
        tx,
        assignmentId,
        userId,
      );
      // The submitted content: the payload, else the saved draft.
      const response = payload.response?.trim()
        ? payload.response
        : (existing?.draftResponse ?? undefined);
      const attachmentAssetId =
        payload.attachmentAssetId ??
        (payload.attachmentUrl ? undefined : (existing?.attachmentAssetId ?? undefined));
      if (!response?.trim() && !payload.attachmentUrl && !attachmentAssetId) {
        throw new BadRequestException({
          messageKey: 'errors.assignment.responseRequired',
        });
      }
      if (attachmentAssetId) {
        await this.assertOwnedProtectedAttachment(
          tx,
          attachmentAssetId,
          userId,
          enrollment.academyId,
        );
      }
      // S12 — the due date is enforced by policy.
      const isLate =
        assignment.dueAt !== null && now.getTime() > assignment.dueAt.getTime();
      if (isLate && assignment.latePolicy === 'block') {
        throw new ForbiddenException({
          messageKey: 'errors.assignment.pastDue',
          details: { dueAt: assignment.dueAt },
        });
      }
      const wasSubmitted =
        existing?.status === 'submitted' || existing?.gradingStatus === 'graded';
      if (wasSubmitted && !assignment.allowResubmission) {
        throw new ConflictException({ messageKey: 'errors.assignment.alreadySubmitted' });
      }
      const submittedData = {
        status: 'submitted' as const,
        response,
        attachmentUrl: attachmentAssetId
          ? null
          : (payload.attachmentUrl ?? existing?.attachmentUrl ?? null),
        ...(attachmentAssetId !== undefined
          ? {
              attachmentAsset: attachmentAssetId
                ? { connect: { id: attachmentAssetId } }
                : { disconnect: true },
            }
          : {}),
        submittedAt: now,
        isLate,
        draftResponse: null,
        draftSavedAt: null,
        submittedRevision: (existing?.submittedRevision ?? 0) + 1,
        gradingStatus: 'ungraded' as const,
        score: null,
        feedback: null,
        gradedAt: null,
      };
      const row = existing
        ? await this.assignmentsRepository.updateSubmission(tx, existing.id, {
            ...submittedData,
            ...(existing.gradedBy ? { grader: { disconnect: true } } : {}),
          })
        : await this.assignmentsRepository.createSubmission(tx, {
            assignment: { connect: { id: assignmentId } },
            student: { connect: { id: userId } },
            ...submittedData,
          });
      // AD-11: a submission moves the course to "in progress" at least, and
      // a graded resubmission back to ungraded may un-complete it.
      await this.courseCompletionService.recompute(tx, enrollment, now);
      return toAssignmentSubmissionResponse(
        row,
        await this.signAttachment(tx, row.attachmentAssetId),
      );
    });
  }

  /** S12 — the attachment must be a PROTECTED asset this student uploaded into this academy. */
  private async assertOwnedProtectedAttachment(
    tx: Prisma.TransactionClient,
    assetId: string,
    userId: string,
    academyId: string,
  ): Promise<void> {
    const asset = await tx.mediaAsset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        access: true,
        academyId: true,
        uploadedByUserId: true,
        status: true,
      },
    });
    if (
      !asset ||
      asset.access !== 'protected' ||
      asset.academyId !== academyId ||
      asset.uploadedByUserId !== userId ||
      asset.status !== 'active'
    ) {
      throw new BadRequestException({
        messageKey: 'errors.assignment.attachmentNotOwned',
      });
    }
  }

  private async signAttachment(
    tx: Prisma.TransactionClient,
    assetId: string | null,
  ): Promise<SubmissionAttachmentResponse | null> {
    if (!assetId) return null;
    const asset = await tx.mediaAsset.findUnique({ where: { id: assetId } });
    if (!asset) return null;
    const signed = await this.contentGrantSigner.signFile(asset);
    return {
      assetId: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sizeBytes: Number(asset.sizeBytes),
      url: signed.url,
      expiresAt: signed.expiresAt.toISOString(),
    };
  }

  /**
   * P64 Phase 3 (S12) — submission attachments go to the PROTECTED tier,
   * owned by the student. The response deliberately carries no durable
   * URL: the learner's submission view signs a short-lived link per read.
   */
  async uploadSubmissionAttachment(
    userId: string,
    courseId: string,
    payload: UploadMediaAssetDto,
  ): Promise<SubmissionAttachmentUploadResponse> {
    const enrollment = await this.tenancyContextService.runInUserContext(userId, (tx) =>
      assertActiveEnrollment(
        tx,
        this.enrollmentsRepository,
        userId,
        courseId,
        this.academyStudentsRepository,
      ),
    );
    const academyId = enrollment.academyId;
    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });
    const asset = await this.protectedMediaService.uploadSubmissionAttachment(
      academyId,
      organizationId,
      userId,
      courseId,
      { fileName: payload.fileName, file: payload.dataUrl, courseId },
    );
    return {
      assetId: asset.id,
      fileName: asset.fileName,
      mimeType: asset.mimeType,
      sizeBytes: Number(asset.sizeBytes),
    };
  }

  async getAssignmentsForAuthoring(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<AssignmentResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const assignments = await this.assignmentsRepository.findManyForCourseAnyStatus(
        tx,
        courseId,
      );
      const items = assignments.map(toAssignmentResponse);
      return {
        items,
        pagination: buildPaginationMeta(1, Math.max(items.length, 1), items.length),
      };
    });
  }

  async getAssignmentForAuthoring(
    userId: string,
    courseId: string,
    assignmentId: string,
  ): Promise<AssignmentResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const assignment = await this.assignmentsRepository.findAnyById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });
      return toAssignmentResponse(assignment);
    });
  }

  async createAssignment(
    userId: string,
    courseId: string,
    payload: CreateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const created = await this.assignmentsRepository.create(tx, {
        course: { connect: { id: courseId } },
        title: payload.title,
        description: payload.description,
        instructions: payload.instructions,
        section: payload.sectionId ? { connect: { id: payload.sectionId } } : undefined,
        lessonId: payload.lessonId,
        status: payload.status,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
        allowResubmission: payload.allowResubmission,
        latePolicy: payload.latePolicy,
        requiredForCompletion: payload.requiredForCompletion,
      });

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'assignment.created',
        targetType: 'assignment',
        targetId: created.id,
        targetLabel: created.title,
        context: { courseId },
      });

      return toAssignmentResponse(created);
    });
  }

  async updateAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
    payload: UpdateAssignmentDto,
  ): Promise<AssignmentResponse> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const existing = await this.assignmentsRepository.findAnyById(
        tx,
        courseId,
        assignmentId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const updated = await this.assignmentsRepository.update(tx, assignmentId, {
        title: payload.title,
        description: payload.description,
        instructions: payload.instructions,
        section: payload.sectionId ? { connect: { id: payload.sectionId } } : undefined,
        lessonId: payload.lessonId,
        status: payload.status,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
        allowResubmission: payload.allowResubmission,
        latePolicy: payload.latePolicy,
        requiredForCompletion: payload.requiredForCompletion,
      });

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'assignment.updated',
        targetType: 'assignment',
        targetId: assignmentId,
        targetLabel: updated.title,
        context: { courseId },
      });

      return toAssignmentResponse(updated);
    });
  }

  async deleteAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
  ): Promise<void> {
    await this.tenancyContextService.runInUserContext(userId, async (tx) => {
      const academyId = await assertCanAuthorCourseContent(
        tx,
        this.coursesRepository,
        this.academyMembersRepository,
        this.courseInstructorsRepository,
        userId,
        courseId,
      );
      const existing = await this.assignmentsRepository.findAnyById(
        tx,
        courseId,
        assignmentId,
      );
      if (!existing) throw new NotFoundException({ messageKey: 'errors.notFound' });

      // Refused once any learner has a record against it — the FK cascade
      // would erase it (see `learner-activity.guard.ts`). Counted in the
      // owning organization's TENANT context, where every learner row is
      // visible; this transaction's user context could see only some.
      const owningOrganizationId =
        await this.academiesRepository.resolveOrganizationId(academyId);
      if (!owningOrganizationId)
        throw new NotFoundException({ messageKey: 'errors.notFound' });
      await this.tenancyContextService.runInTenantContext(
        owningOrganizationId,
        (tenantTx) =>
          assertNoLearnerActivity(tenantTx, { kind: 'assignment', id: assignmentId }),
      );

      await this.assignmentsRepository.delete(tx, assignmentId);

      const { organizationId, role } = await this.resolveAuditAttribution(
        tx,
        academyId,
        userId,
      );
      await this.auditLogWriterService.write(tx, {
        actorUserId: userId,
        organizationId,
        academyId,
        role,
        action: 'assignment.deleted',
        targetType: 'assignment',
        targetId: assignmentId,
        targetLabel: existing.title,
        context: { courseId },
      });
    });
  }
}
