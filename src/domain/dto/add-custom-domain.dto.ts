/** `POST academies/:id/website/domain/custom-domain` request — matches `AddCustomDomainPayload` (`domain.types.ts`) exactly. Normalized identically to the frontend's own `addCustomDomainSchema` (`.trim().toLowerCase()`) so the same hostname string always compares equal regardless of case/whitespace the client sent. */
import { Transform } from 'class-transformer';
import { Matches, MaxLength, MinLength } from 'class-validator';
import {
  HOSTNAME_REGEX,
  MAX_HOSTNAME_LENGTH,
  MIN_HOSTNAME_LENGTH,
  NOT_IP_LITERAL_REGEX,
} from '../constants/domain.constants';

export class AddCustomDomainDto {
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  @MinLength(MIN_HOSTNAME_LENGTH)
  @MaxLength(MAX_HOSTNAME_LENGTH)
  @Matches(HOSTNAME_REGEX, { message: 'errors.domain.invalidHostname' })
  // P63 — a dotted quad satisfies the hostname shape; it is never a
  // domain a customer owns and must never reach the provider or the probe.
  @Matches(NOT_IP_LITERAL_REGEX, { message: 'errors.domain.invalidHostname' })
  readonly hostname!: string;
}
