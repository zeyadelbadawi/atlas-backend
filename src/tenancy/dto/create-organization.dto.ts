/** `POST /organizations` request (Phase P19 — see `OrganizationsService.create`). Slug is server-generated from `name`, never client-supplied — Organization has no dedicated slug-picker UX anywhere in the real frontend contract, unlike Academy's. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateOrganizationDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(120)
  readonly name!: string;
}
