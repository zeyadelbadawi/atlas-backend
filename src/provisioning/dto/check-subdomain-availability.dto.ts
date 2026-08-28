/** `GET /subdomains/availability?subdomain=` query — matches `checkSubdomainAvailability`'s real query param (`ProvisioningService`, atlas frontend). */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';
import { MAX_SUBDOMAIN_LENGTH } from './provisioning.constants';

export class CheckSubdomainAvailabilityDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(MAX_SUBDOMAIN_LENGTH)
  readonly subdomain!: string;
}
