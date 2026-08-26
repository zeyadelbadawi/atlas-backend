/**
 * `PATCH /platform-commission/global` request (Platform-Owner-only, master
 * plan §4.2). There is deliberately no way to send `null`/unset through
 * this DTO — setting the global default is a one-way transition into
 * configured (matches `AtlasCommissionConfigRepository.setDefault`'s own
 * doc comment); this document does not invent an "unset" product flow.
 */
import { IsInt, Max, Min } from 'class-validator';

export class UpdateAtlasCommissionConfigDto {
  @IsInt()
  @Min(0)
  @Max(10000)
  readonly defaultCommissionBasisPoints!: number;
}
