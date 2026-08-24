/** `POST /enrollments` request — matches `CreateEnrollmentPayload` (`enrollment.types.ts`) exactly. */
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateEnrollmentDto {
  @IsNotEmpty()
  @IsString()
  readonly courseId!: string;
}
