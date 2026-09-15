/**
 * Attach an existing course-level quiz/assignment to a unit (P52).
 *
 * Only quizzes and assignments are *attached*: lessons are created inside a
 * unit already, and Live Sessions remain deferred (Coming Soon) so they are
 * never attached through this path. `type` is required so the server updates
 * the right table; `itemId` is the existing entity's id.
 */
import { IsIn, IsString, IsNotEmpty } from 'class-validator';

export class AttachCurriculumItemDto {
  @IsIn(['quiz', 'assignment'])
  readonly type!: 'quiz' | 'assignment';

  @IsString()
  @IsNotEmpty()
  readonly itemId!: string;
}
