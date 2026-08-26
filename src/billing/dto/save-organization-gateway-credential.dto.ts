/**
 * `PUT organizations/:id/payment-settings/gateway-credentials` request.
 * `config` is an arbitrary, provider-shaped object — this codebase does
 * not invent gateway-specific fields (no real gateway exists yet); it is
 * serialized and encrypted as-is, never inspected for particular keys
 * here. `providerKey` is validated against
 * `PaymentProviderRegistry.listAvailableForOrganizationGateway()` at the
 * service layer, not by this DTO — an empty registry today means every
 * save attempt is correctly rejected regardless of what is sent.
 */
import { IsNotEmpty, IsObject, IsString } from 'class-validator';

export class SaveOrganizationGatewayCredentialDto {
  @IsNotEmpty()
  @IsString()
  readonly providerKey!: string;

  @IsObject()
  readonly config!: Record<string, unknown>;
}
