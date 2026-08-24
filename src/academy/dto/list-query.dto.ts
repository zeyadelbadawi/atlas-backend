/**
 * `GET /academies` query contract. Base pagination fields
 * (`page`/`pageSize`/`sortBy`/`sortDirection`/`search`) live in
 * `common/dto/collection-query.dto.ts`, shared with every other paginated
 * list endpoint in this codebase.
 */
import { IsNotEmpty, IsString } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export {
  CollectionQueryDto,
  DEFAULT_PAGE,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
} from '../../common/dto/collection-query.dto';

/** See `CreateAcademyDto`'s doc comment for why `organizationId` is a required explicit field here too. */
export class ListAcademiesQueryDto extends CollectionQueryDto {
  @IsNotEmpty()
  @IsString()
  readonly organizationId!: string;
}
