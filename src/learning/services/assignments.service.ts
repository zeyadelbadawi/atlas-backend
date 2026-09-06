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
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { CourseInstructorsRepository } from '../../course/repositories/course-instructors.repository';
import { CoursesRepository } from '../../course/repositories/courses.repository';
import { AcademyMembersRepository } from '../../academy/repositories/academy-members.repository';
import { AcademyStudentsRepository } from '../../tenancy/repositories/academy-students.repository';
import { MediaService } from '../../media/services/media.service';
import type { UploadMediaAssetDto } from '../../media/dto/upload-media-asset.dto';
import type { MediaAssetResponse } from '../../media/dto/media-asset.contract';
import { AssignmentsRepository } from '../repositories/assignments.repository';
import { toAssignmentResponse } from '../dto/assignment.contract';
import type { AssignmentResponse } from '../dto/assignment.contract';
import { toAssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type { AssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
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
    private readonly academyStudentsRepository: AcademyStudentsRepository,
    private readonly mediaService: MediaService,
    private readonly assignmentsRepository: AssignmentsRepository,
  ) {}

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
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
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
      return submission ? toAssignmentSubmissionResponse(submission) : null;
    });
  }

  async submitAssignment(
    userId: string,
    courseId: string,
    assignmentId: string,
    payload: CreateAssignmentSubmissionDto,
  ): Promise<AssignmentSubmissionResponse> {
    // Mirrors the frontend's own `assignmentSubmissionSchema` `.refine()`
    // (`learning.schemas.ts`) — never trust the client-side check alone.
    if (!payload.response?.trim() && !payload.attachmentUrl) {
      throw new BadRequestException({ messageKey: 'errors.assignment.responseRequired' });
    }

    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
      const assignment = await this.assignmentsRepository.findPublishedById(
        tx,
        courseId,
        assignmentId,
      );
      if (!assignment) throw new NotFoundException({ messageKey: 'errors.notFound' });

      const existing = await this.assignmentsRepository.findSubmission(
        tx,
        assignmentId,
        userId,
      );

      if (existing) {
        if (!assignment.allowResubmission) {
          throw new ConflictException({
            messageKey: 'errors.assignment.alreadySubmitted',
          });
        }
        // "Keep the latest row" — master plan §5.4's explicit instruction
        // (no `assignment_submission_history` table; see
        // `schema.prisma`'s P6 header comment). A resubmission also
        // clears any prior grade — a grade against superseded content
        // would be misleading, and no P6 endpoint writes these fields
        // anyway (grading is P7 scope).
        const updated = await this.assignmentsRepository.updateSubmission(
          tx,
          existing.id,
          {
            status: 'submitted',
            response: payload.response,
            attachmentUrl: payload.attachmentUrl,
            submittedAt: new Date(),
            gradingStatus: 'ungraded',
            score: null,
            feedback: null,
            gradedAt: null,
            grader: { disconnect: true },
          },
        );
        return toAssignmentSubmissionResponse(updated);
      }

      const created = await this.assignmentsRepository.createSubmission(tx, {
        assignment: { connect: { id: assignmentId } },
        student: { connect: { id: userId } },
        status: 'submitted',
        response: payload.response,
        attachmentUrl: payload.attachmentUrl,
        submittedAt: new Date(),
        gradingStatus: 'ungraded',
      });
      return toAssignmentSubmissionResponse(created);
    });
  }

  /**
   * Phase 4 (P24) — uploads a real file for the current student's
   * upcoming submission and returns its real, permanent R2 URL, to be
   * passed as `attachmentUrl` in the normal `submitAssignment` call that
   * follows — the same two-step "upload, then reference the resulting
   * URL in an otherwise-ordinary form submission" flow
   * `LessonFormDialog`'s own `MediaLibraryDialog` integration (Phase 0)
   * already established, not a new upload pattern.
   *
   * Resolution chain mirrors `EnrollmentsService.createEnrollment`'s own
   * precedent exactly: `resolveAcademyIdForPublishedCourse`/
   * `resolveOrganizationId` are both real, context-free reads (safe to
   * call with no tenant/user context yet), used here to reach the
   * organization id `MediaService.uploadForSubmission`'s own
   * `runInTenantContext` calls need. The enrollment check runs first,
   * under a bare `runInUserContext` — the same authorization
   * `getAssignments`/`submitAssignment` already use — so an unenrolled
   * caller is rejected before any of that resolution work, let alone any
   * real R2 I/O, ever happens.
   */
  async uploadSubmissionAttachment(
    userId: string,
    courseId: string,
    payload: UploadMediaAssetDto,
  ): Promise<MediaAssetResponse> {
    await this.tenancyContextService.runInUserContext(userId, (tx) =>
      assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId),
    );

    const academyId =
      await this.coursesRepository.resolveAcademyIdForPublishedCourse(courseId);
    if (!academyId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    const organizationId =
      await this.academyStudentsRepository.resolveOrganizationId(academyId);
    if (!organizationId) throw new NotFoundException({ messageKey: 'errors.notFound' });

    return this.mediaService.uploadForSubmission(academyId, organizationId, payload);
  }

  // -------------------------------------------------------------------
  // Phase 4 (P24) — authoring.
  // -------------------------------------------------------------------

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
      await assertCanAuthorCourseContent(
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
        sectionId: payload.sectionId,
        lessonId: payload.lessonId,
        status: payload.status,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
        allowResubmission: payload.allowResubmission,
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
      await assertCanAuthorCourseContent(
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
        sectionId: payload.sectionId,
        lessonId: payload.lessonId,
        status: payload.status,
        dueAt: payload.dueAt ? new Date(payload.dueAt) : undefined,
        allowResubmission: payload.allowResubmission,
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
      await assertCanAuthorCourseContent(
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

      await this.assignmentsRepository.delete(tx, assignmentId);
    });
  }
}
