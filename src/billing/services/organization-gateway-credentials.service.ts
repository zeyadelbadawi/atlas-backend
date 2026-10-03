/**
 * OrganizationGatewayCredentialsService — an Organization's own gateway
 * configuration, for Organization-Owned Gateway mode (master plan
 * §4.1/§5.8, §16). The ONE place `CredentialEncryptionService.decrypt` is
 * ever called for this table (`testConnection`) — the decrypted value
 * lives only inside this method's local scope, passed straight into the
 * resolved `PaymentProviderAdapter.testConnection`, never returned,
 * logged, or attached to any response.
 *
 * Because the `PaymentProviderRegistry` has no real gateway registered
 * today (§4.1/§11.x — only `ManualTransferProvider`, which is not
 * organization-connectable), `saveCredential` correctly rejects every
 * `providerKey` right now — an honest, tested "no provider available yet"
 * outcome, not a bug (mirrors P11's Cloudflare "honest not-configured"
 * precedent, applied here to an entire feature rather than one status
 * field).
 */
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { OrganizationGatewayCredentialsRepository } from '../repositories/organization-gateway-credentials.repository';
import { PaymentProviderRegistry } from '../providers/payment-provider.registry';
import { CredentialEncryptionService } from '../utils/credential-encryption.util';
import {
  toOrganizationGatewayCredentialResponse,
  type AvailablePaymentProviderResponse,
  type OrganizationGatewayCredentialResponse,
} from '../dto/organization-gateway-credential.contract';
import type { SaveOrganizationGatewayCredentialDto } from '../dto/save-organization-gateway-credential.dto';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';

@Injectable()
export class OrganizationGatewayCredentialsService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly organizationGatewayCredentialsRepository: OrganizationGatewayCredentialsRepository,
    private readonly paymentProviderRegistry: PaymentProviderRegistry,
    private readonly credentialEncryptionService: CredentialEncryptionService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  listAvailableProviders(): readonly AvailablePaymentProviderResponse[] {
    return this.paymentProviderRegistry.listAvailableForOrganizationGateway();
  }

  async getCredential(
    organizationId: string,
  ): Promise<OrganizationGatewayCredentialResponse> {
    const credential = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) =>
        this.organizationGatewayCredentialsRepository.findForResponse(tx, organizationId),
    );
    return toOrganizationGatewayCredentialResponse(organizationId, credential);
  }

  /**
   * Task 3 — the audit row records THAT credentials were saved and for which
   * provider. Never the config, encrypted or not: `context` carries only
   * `providerKey` (the catalogue allowlist enforces it at the writer too).
   */
  async saveCredential(
    organizationId: string,
    payload: SaveOrganizationGatewayCredentialDto,
    actorUserId: string,
  ): Promise<OrganizationGatewayCredentialResponse> {
    const available = this.paymentProviderRegistry.listAvailableForOrganizationGateway();
    if (!available.some((provider) => provider.providerKey === payload.providerKey)) {
      throw new ConflictException({ messageKey: 'errors.payment.providerNotAvailable' });
    }

    const encryptedConfig = this.credentialEncryptionService.encrypt(
      JSON.stringify(payload.config),
    );

    const credential = await this.tenancyContextService.runInTenantContext(
      organizationId,
      async (tx) => {
        const saved = await this.organizationGatewayCredentialsRepository.upsert(
          tx,
          organizationId,
          {
            providerKey: payload.providerKey,
            encryptedConfig,
          },
        );
        await this.auditLogWriterService.record(tx, {
          actorUserId,
          organizationId,
          action: 'organization.payment_gateway.credentials_saved',
          targetId: organizationId,
          targetLabel: payload.providerKey,
          context: { providerKey: payload.providerKey },
        });
        return saved;
      },
    );
    return toOrganizationGatewayCredentialResponse(organizationId, credential);
  }

  async testConnection(
    organizationId: string,
    actorUserId: string,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const credential =
        await this.organizationGatewayCredentialsRepository.findWithEncryptedConfig(
          tx,
          organizationId,
        );
      if (!credential || !credential.encryptedConfig) {
        throw new NotFoundException({
          messageKey: 'errors.payment.gatewayNotConfigured',
        });
      }

      const provider = this.paymentProviderRegistry.tryResolve(credential.providerKey);
      const result = provider
        ? await provider.testConnection(
            JSON.parse(
              this.credentialEncryptionService.decrypt(credential.encryptedConfig),
            ),
          )
        : { success: false, message: 'This provider is not available yet.' };

      const updated =
        await this.organizationGatewayCredentialsRepository.recordTestResult(
          tx,
          organizationId,
          result,
        );
      // The provider's message is NOT recorded: it is free text from a
      // third party and may echo configuration back.
      await this.auditLogWriterService.record(tx, {
        actorUserId,
        organizationId,
        action: 'organization.payment_gateway.connection_tested',
        targetId: organizationId,
        targetLabel: credential.providerKey,
        context: { providerKey: credential.providerKey, success: result.success },
      });
      return toOrganizationGatewayCredentialResponse(organizationId, updated);
    });
  }

  async setEnabled(
    organizationId: string,
    enabled: boolean,
    actorUserId: string,
  ): Promise<OrganizationGatewayCredentialResponse> {
    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const credential =
        await this.organizationGatewayCredentialsRepository.findForResponse(
          tx,
          organizationId,
        );
      if (!credential) {
        throw new NotFoundException({
          messageKey: 'errors.payment.gatewayNotConfigured',
        });
      }
      if (enabled && credential.status !== 'verified') {
        throw new ConflictException({ messageKey: 'errors.payment.gatewayNotVerified' });
      }

      const updated = await this.organizationGatewayCredentialsRepository.setEnabled(
        tx,
        organizationId,
        enabled,
      );
      await this.auditLogWriterService.record(tx, {
        actorUserId,
        organizationId,
        action: enabled
          ? 'organization.payment_gateway.enabled'
          : 'organization.payment_gateway.disabled',
        targetId: organizationId,
        targetLabel: credential.providerKey,
        context: { providerKey: credential.providerKey },
      });
      return toOrganizationGatewayCredentialResponse(organizationId, updated);
    });
  }
}
