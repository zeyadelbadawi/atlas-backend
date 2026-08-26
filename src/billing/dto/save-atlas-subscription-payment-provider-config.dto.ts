/**
 * `PUT /platform-atlas-payment-provider` request (Platform-Owner-only).
 * `config` is an arbitrary, provider-shaped object — serialized and
 * encrypted as-is, never inspected for particular keys here, matching
 * `SaveOrganizationGatewayCredentialDto`'s identical rule. `providerKey` is
 * validated against `PaymentProviderRegistry.listAvailableForAtlasSubscription()`
 * at the service layer, not by this DTO.
 */
import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class SaveAtlasSubscriptionPaymentProviderConfigDto {
  @IsNotEmpty()
  @IsString()
  readonly providerKey!: string;

  @IsObject()
  readonly config!: Record<string, unknown>;
}
