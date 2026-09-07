/**
 * `GET /enrollments` query contract — the shared `CollectionQueryDto` base
 * plus an optional `academyId` filter, added so the Academy-website-
 * embedded "My Learning" experience can narrow the caller's own
 * enrollments down to one Academy (see `EnrollmentsRepository.
 * findManyForStudent`'s doc comment for why this exists — `studentId` is
 * always resolved from the authenticated caller, never accepted as a
 * parameter, so this filter can only ever narrow a caller's own rows,
 * never widen access to another student's).
 */
import { IsOptional, IsString } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export class ListEnrollmentsQueryDto extends CollectionQueryDto {
  @IsOptional()
  @IsString()
  readonly academyId?: string;
}
