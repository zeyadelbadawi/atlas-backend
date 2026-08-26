/**
 * `OrganizationGatewayCredential` response contract (master plan §4.1/§5.8,
 * §16). NEVER carries `encryptedConfig` or any decrypted equivalent — this
 * type has no field capable of holding one, so a future accidental
 * `...credential` spread can't leak it either. Matches this task's explicit
 * requirement: no frontend secret-management UX/contract is invented here
 * beyond a masked status view.
 */
import type { OrganizationGatewayCredentialSummary } from '../repositories/organization-gateway-credentials.repository';

export interface OrganizationGatewayCredentialResponse {
  readonly organizationId: string;
  readonly providerKey: string | null;
  readonly status: 'not_configured' | 'configured' | 'verified' | 'disabled';
  readonly enabled: boolean;
  readonly lastTestedAt?: string;
  readonly lastTestResult?: { readonly success: boolean; readonly message?: string };
  readonly updatedAt?: string;
}

export function toOrganizationGatewayCredentialResponse(
  organizationId: string,
  credential: OrganizationGatewayCredentialSummary | null,
): OrganizationGatewayCredentialResponse {
  if (!credential) {
    return {
      organizationId,
      providerKey: null,
      status: 'not_configured',
      enabled: false,
    };
  }
  return {
    organizationId,
    providerKey: credential.providerKey,
    status: credential.status,
    enabled: credential.enabled,
    lastTestedAt: credential.lastTestedAt?.toISOString(),
    lastTestResult: credential.lastTestResult as unknown as
      { readonly success: boolean; readonly message?: string } | undefined,
    updatedAt: credential.updatedAt.toISOString(),
  };
}

export interface AvailablePaymentProviderResponse {
  readonly providerKey: string;
  readonly displayName: string;
}
