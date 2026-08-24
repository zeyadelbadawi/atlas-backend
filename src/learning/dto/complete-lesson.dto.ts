/** `POST /courses/:id/progress/complete-lesson` request — matches `CompleteLessonPayload` (`progress.types.ts`) exactly. */
import { IsNotEmpty, IsString } from 'class-validator';

export class CompleteLessonDto {
  @IsNotEmpty()
  @IsString()
  readonly lessonId!: string;
}
