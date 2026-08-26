/**
 * Commission response contracts (master plan §4.2). Three shapes:
 *
 *   `AtlasCommissionConfigResponse` — the global default, Platform-Owner
 *   readable/writable, world-readable to any authenticated caller (mirrors
 *   `PlatformDomainConfigurationResponse`'s identical "GET open, PATCH
 *   Platform-Owner-gated" precedent — a percentage is not a secret).
 *
 *   `OrganizationCommissionResponse` — an Organization's own override
 *   configuration plus its currently-resolved effective rate. Read-only
 *   from the Organization side, by construction: this file defines no
 *   Organization-facing write DTO for it at all (§4.2: "an Organization
 *   must not be able to grant itself a commission exemption or modify its
 *   own rate").
 *
 *   `EffectiveCommissionResolution` — the discriminated result of §4.2's
 *   resolution rule (`Organization override → global default → no
 *   effective rate`), never a silent fallback value.
 */
import type {
  OrganizationCommissionSettings,
  AtlasCommissionConfig,
} from '@prisma/client';

export interface AtlasCommissionConfigResponse {
  readonly defaultCommissionBasisPoints: number | null;
  readonly updatedAt: string;
}

export function toAtlasCommissionConfigResponse(
  config: AtlasCommissionConfig,
): AtlasCommissionConfigResponse {
  return {
    defaultCommissionBasisPoints: config.defaultCommissionBasisPoints,
    updatedAt: config.updatedAt.toISOString(),
  };
}

export type EffectiveCommissionResolution =
  | {
      readonly resolved: true;
      readonly basisPoints: number;
      readonly source: 'custom' | 'exempt' | 'default';
    }
  | { readonly resolved: false };

export interface OrganizationCommissionResponse {
  readonly organizationId: string;
  readonly commissionMode: OrganizationCommissionSettings['commissionMode'];
  readonly customPercentageBasisPoints: number | null;
  readonly effective: EffectiveCommissionResolution;
}

export function toOrganizationCommissionResponse(
  organizationId: string,
  settings: OrganizationCommissionSettings | null,
  effective: EffectiveCommissionResolution,
): OrganizationCommissionResponse {
  return {
    organizationId,
    commissionMode: settings?.commissionMode ?? 'default',
    customPercentageBasisPoints: settings?.customPercentageBasisPoints ?? null,
    effective,
  };
}
