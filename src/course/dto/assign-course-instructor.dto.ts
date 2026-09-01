/**
 * `POST /academies/:id/courses/:courseId/instructors` request — Phase 3
 * (master plan §22/§23: "Instructor ↔ Course Assignment"). Takes the
 * target's `userId` directly (not `email`, unlike
 * `AddAcademyInstructorDto`) — this endpoint never creates an account or
 * an Academy membership, it only grants an ALREADY-eligible Academy
 * instructor access to one specific course. See
 * `CoursesService.assignInstructor`'s doc comment for the full
 * eligibility rule.
 */
import { IsNotEmpty, IsString } from 'class-validator';

export class AssignCourseInstructorDto {
  @IsNotEmpty()
  @IsString()
  readonly userId!: string;
}
