/**
 * OrganizationGatewayCredentialsRepository — `organization_gateway_credentials`
 * (master plan §5.8). Tenant-scoped, RLS-protected.
 *
 * `findForResponse` is the ONLY read method anything on a response path may
 * call — it deliberately omits `encryptedConfig` at the query level (a
 * Prisma `select`, not a post-hoc delete of the field), so a future
 * accidental `console.log`/serialization of the returned object can never
 * leak the encrypted blob. `findWithEncryptedConfig` is a SEPARATE, clearly
 * named method used only inside
 * `OrganizationGatewayCredentialsService.testConnection`, immediately
 * decrypted and never passed to a DTO mapper.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { OrganizationGatewayCredential } from '@prisma/client';

export type OrganizationGatewayCredentialSummary = Omit<
  OrganizationGatewayCredential,
  'encryptedConfig'
>;

const SUMMARY_SELECT = {
  id: true,
  organizationId: true,
  providerKey: true,
  status: true,
  enabled: true,
  lastTestedAt: true,
  lastTestResult: true,
  createdAt: true,
  updatedAt: true,
} as const;

@Injectable()
export class OrganizationGatewayCredentialsRepository {
  /** Response-safe read — never selects `encryptedConfig`. */
  findForResponse(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationGatewayCredentialSummary | null> {
    return tx.organizationGatewayCredential.findUnique({
      where: { organizationId },
      select: SUMMARY_SELECT,
    });
  }

  /** Internal-only — the encrypted blob, for `testConnection`'s decrypt-and-call use only. Never call this from anything that maps a result into an HTTP response. */
  findWithEncryptedConfig(
    tx: Prisma.TransactionClient,
    organizationId: string,
  ): Promise<OrganizationGatewayCredential | null> {
    return tx.organizationGatewayCredential.findUnique({ where: { organizationId } });
  }

  upsert(
    tx: Prisma.TransactionClient,
    organizationId: string,
    data: {
      readonly providerKey: string;
      readonly encryptedConfig: string;
    },
  ): Promise<OrganizationGatewayCredentialSummary> {
    return tx.organizationGatewayCredential.upsert({
      where: { organizationId },
      create: {
        organizationId,
        providerKey: data.providerKey,
        encryptedConfig: data.encryptedConfig,
        status: 'configured',
        enabled: false,
      },
      update: {
        providerKey: data.providerKey,
        encryptedConfig: data.encryptedConfig,
        status: 'configured',
        // Changing the configuration invalidates any prior verification —
        // never carry a stale `verified` status or a stale test result
        // forward across a credential change.
        enabled: false,
        lastTestedAt: null,
        lastTestResult: Prisma.JsonNull,
      },
      select: SUMMARY_SELECT,
    });
  }

  recordTestResult(
    tx: Prisma.TransactionClient,
    organizationId: string,
    result: { readonly success: boolean; readonly message?: string },
  ): Promise<OrganizationGatewayCredentialSummary> {
    return tx.organizationGatewayCredential.update({
      where: { organizationId },
      data: {
        status: result.success ? 'verified' : 'configured',
        lastTestedAt: new Date(),
        lastTestResult: result as unknown as Prisma.InputJsonValue,
      },
      select: SUMMARY_SELECT,
    });
  }

  setEnabled(
    tx: Prisma.TransactionClient,
    organizationId: string,
    enabled: boolean,
  ): Promise<OrganizationGatewayCredentialSummary> {
    return tx.organizationGatewayCredential.update({
      where: { organizationId },
      data: { enabled },
      select: SUMMARY_SELECT,
    });
  }
}
