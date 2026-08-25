/** `PATCH /platform-domain` request — matches `UpdatePlatformDomainConfigurationPayload` (`domain.types.ts`) exactly. */
import { Transform } from 'class-transformer';
import { Matches, MaxLength, MinLength } from 'class-validator';
import {
  HOSTNAME_REGEX,
  MAX_HOSTNAME_LENGTH,
  MIN_HOSTNAME_LENGTH,
} from '../constants/domain.constants';

export class UpdatePlatformDomainConfigurationDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @MinLength(MIN_HOSTNAME_LENGTH)
  @MaxLength(MAX_HOSTNAME_LENGTH)
  @Matches(HOSTNAME_REGEX, { message: 'errors.domain.invalidHostname' })
  readonly baseDomain!: string;
}
