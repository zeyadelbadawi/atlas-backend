/** A message on a request — from the academy, or a team reply / internal note. */
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { Transform } from 'class-transformer';

export class CustomerRequestMessageDto {
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  readonly body!: string;
}

export class TeamCustomerRequestMessageDto extends CustomerRequestMessageDto {
  /** `true` → an internal note the academy never sees. */
  @IsOptional()
  @IsBoolean()
  readonly internal?: boolean;
}
