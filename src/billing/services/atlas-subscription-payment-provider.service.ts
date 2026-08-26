/**
 * AtlasSubscriptionPaymentProviderService — Atlas Subscription Payment,
 * Generic Payment Gateway Integration Readiness (2026-08-26). Platform-
 * Owner-only configuration of which `PaymentProviderAdapter` Atlas
 * Subscription Billing (Organization → Atlas, P12) currently uses.
 *
 * `resolveEffectiveProvider` is the ONE method that matters architecturally
 * — it is what `PaymentService.createPaymentIntent` calls, and it is the
 * single place "what provider is Atlas Subscription Payment actually
 * running on right now" is decided. No row / no `providerKey` / disabled
 * all resolve to `ManualTransferProvider` — today's real, unchanged P12
 * default — never a second hardcoded default anywhere else in this
 * codebase.
 *
 * The ONE place `CredentialEncryptionService.decrypt` is ever called for
 * this table (`testConnection`) — the decrypted value lives only inside
 * that method's local scope, passed straight into the resolved adapter,
 * never returned, logged, or attached to any response. Mirrors
 * `OrganizationGatewayCredentialsService`'s identical discipline, applied
 * to the Atlas/Platform-owned side instead of the Organization side.
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { AtlasSubscriptionPaymentProviderConfigRepository } from '../repositories/atlas-subscription-payment-provider-config.repository';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import { MANUAL_TRANSFER_PROVIDER_KEY } from '../providers/manual-transfer.provider';
import { CredentialEncryptionService } from '../utils/credential-encryption.util';
import {
  toAtlasSubscriptionPaymentProviderConfigResponse,
  type AtlasSubscriptionPaymentProviderConfigResponse,
  type AvailableAtlasSubscriptionPaymentProviderResponse,
} from '../dto/atlas-subscription-payment-provider.contract';
import type { SaveAtlasSubscriptionPaymentProviderConfigDto } from '../dto/save-atlas-subscription-payment-provider-config.dto';
import type { PaymentProviderAdapter } from '../providers/payment-provider.interface';

@Injectable()
export class AtlasSubscriptionPaymentProviderService {
  constructor(
    private readonly configRepository: AtlasSubscriptionPaymentProviderConfigRepository,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly credentialEncryptionService: CredentialEncryptionService,
  ) {}

  listAvailableProviders(): readonly AvailableAtlasSubscriptionPaymentProviderResponse[] {
    return this.paymentProviderRegistry.listAvailableForAtlasSubscription();
  }

  async getConfig(): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    const config = await this.configRepository.findForResponse();
    const effective = this.resolveEffectiveProviderFrom(
      config.providerKey,
      config.enabled,
    );
    return toAtlasSubscriptionPaymentProviderConfigResponse(
      config,
      effective.providerKey,
      effective.displayName,
    );
  }

  async saveConfig(
    platformOwnerUserId: string,
    payload: SaveAtlasSubscriptionPaymentProviderConfigDto,
  ): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    const available = this.paymentProviderRegistry.listAvailableForAtlasSubscription();
    if (!available.some((provider) => provider.providerKey === payload.providerKey)) {
      throw new ConflictException({ messageKey: 'errors.payment.providerNotAvailable' });
    }

    const encryptedConfig = this.credentialEncryptionService.encrypt(
      JSON.stringify(payload.config),
    );
    const config = await this.configRepository.upsertProvider({
      providerKey: payload.providerKey,
      encryptedConfig,
      updatedBy: platformOwnerUserId,
    });
    const effective = this.resolveEffectiveProviderFrom(
      config.providerKey,
      config.enabled,
    );
    return toAtlasSubscriptionPaymentProviderConfigResponse(
      config,
      effective.providerKey,
      effective.displayName,
    );
  }

  async testConnection(): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    const config = await this.configRepository.findWithEncryptedConfig();
    if (!config.providerKey || !config.encryptedConfig) {
      throw new NotFoundException({
        messageKey: 'errors.payment.atlasProviderNotConfigured',
      });
    }

    const adapter = this.paymentProviderRegistry.tryResolve(config.providerKey);
    const result = adapter
      ? await adapter.testConnection(
          JSON.parse(this.credentialEncryptionService.decrypt(config.encryptedConfig)),
        )
      : { success: false, message: 'This provider is not available yet.' };

    const updated = await this.configRepository.recordTestResult(result);
    const effective = this.resolveEffectiveProviderFrom(
      updated.providerKey,
      updated.enabled,
    );
    return toAtlasSubscriptionPaymentProviderConfigResponse(
      updated,
      effective.providerKey,
      effective.displayName,
    );
  }

  async setEnabled(
    platformOwnerUserId: string,
    enabled: boolean,
  ): Promise<AtlasSubscriptionPaymentProviderConfigResponse> {
    const current = await this.configRepository.findForResponse();
    if (enabled && current.status !== 'verified') {
      throw new ConflictException({
        messageKey: 'errors.payment.atlasProviderNotVerified',
      });
    }

    const updated = await this.configRepository.setEnabled(enabled, platformOwnerUserId);
    const effective = this.resolveEffectiveProviderFrom(
      updated.providerKey,
      updated.enabled,
    );
    return toAtlasSubscriptionPaymentProviderConfigResponse(
      updated,
      effective.providerKey,
      effective.displayName,
    );
  }

  /**
   * The real integration point — `PaymentService.createPaymentIntent`
   * calls this, resolves through it, and never branches on a provider
   * name itself (master plan §13: "Avoid provider-specific branching in
   * the core payment business logic"). Returns the adapter AND the
   * already-decrypted config together, since a caller that actually wants
   * to invoke `createPaymentIntent` on the adapter needs both — decryption
   * happens here, once, not duplicated at each call site.
   */
  async resolveEffectiveProviderForPaymentIntent(): Promise<{
    readonly adapter: PaymentProviderAdapter;
    readonly config: Record<string, unknown>;
  } | null> {
    const config = await this.configRepository.findWithEncryptedConfig();
    if (!config.providerKey || !config.enabled || config.status !== 'verified') {
      return null;
    }
    const adapter = this.paymentProviderRegistry.tryResolve(config.providerKey);
    if (!adapter?.createPaymentIntent) return null;
    if (!config.encryptedConfig) return null;

    return {
      adapter,
      config: JSON.parse(
        this.credentialEncryptionService.decrypt(config.encryptedConfig),
      ),
    };
  }

  /** Pure resolution for display purposes — never decrypts, never touches the adapter's actual capability. */
  private resolveEffectiveProviderFrom(
    providerKey: string | null,
    enabled: boolean,
  ): { readonly providerKey: string; readonly displayName: string } {
    const effectiveKey =
      providerKey && enabled ? providerKey : MANUAL_TRANSFER_PROVIDER_KEY;
    const adapter = this.paymentProviderRegistry.tryResolve(effectiveKey);
    return {
      providerKey: effectiveKey,
      displayName: adapter?.displayName ?? effectiveKey,
    };
  }
}
