/** `GET /learning/results` query (Phase 9). `academyId` only ever narrows the caller's OWN enrollments — see `StudentResultsController`'s doc comment for why it cannot widen access. */
import { IsOptional, IsString } from 'class-validator';

export class StudentResultsQueryDto {
  @IsOptional()
  @IsString()
  readonly academyId?: string;
}
