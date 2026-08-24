/**
 * AssignmentsService — matches `AssignmentService` (atlas frontend)
 * exactly. Assignment authoring and grading stay out of scope (frontend's
 * own doc comment; grading is Instructor Operations, P7) — this service
 * only reads published assignments and manages the current student's own
 * submission.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { EnrollmentsRepository } from '../repositories/enrollments.repository';
import { AssignmentsRepository } from '../repositories/assignments.repository';
import { toAssignmentResponse } from '../dto/assignment.contract';
import type { AssignmentResponse } from '../dto/assignment.contract';
import { toAssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type { AssignmentSubmissionResponse } from '../dto/assignment-submission.contract';
import type { CreateAssignmentSubmissionDto } from '../dto/create-assignment-submission.dto';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { assertActiveEnrollment } from './learning-access.util';

@Injectable()
export class AssignmentsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly enrollmentsRepository: EnrollmentsRepository,
    private readonly assignmentsRepository: AssignmentsRepository,
  ) {}

  async getAssignments(
    userId: string,
    courseId: string,
  ): Promise<PaginatedResult<AssignmentResponse>> {
    return this.tenancyContextService.runInUserContext(userId, async (tx) => {
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
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
      await assertActiveEnrollment(tx, this.enrollmentsRepository, userId, courseId);
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
}
