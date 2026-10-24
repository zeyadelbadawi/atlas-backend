/**
 * Keeps and revokes the Apple refresh token (B2). Apple requires apps that
 * offer Sign in with Apple to revoke the user's tokens when the account is
 * deleted; `revokeBeforeDeletion` runs at the start of account deletion and
 * never blocks it.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { PaymentConfigurationConfig } from '../../config/configuration';
import { AppleRestClient } from './apple-rest.client';
import { AppleTokenCipher } from './apple-token.cipher';

@Injectable()
export class AppleTokenService {
  private readonly logger = new Logger(AppleTokenService.name);
  readonly rest: AppleRestClient;
  private readonly cipher: AppleTokenCipher;

  constructor(
    config: ConfigService,
    private readonly tenancy: TenancyContextService,
  ) {
    const teamId = config.get<string>('APPLE_TEAM_ID');
    const keyId = config.get<string>('APPLE_KEY_ID');
    const privateKey = config.get<string>('APPLE_PRIVATE_KEY');
    this.rest = new AppleRestClient(
      teamId && keyId && privateKey ? { teamId, keyId, privateKey } : null,
    );
    const { credentialEncryptionKeyHex } =
      config.getOrThrow<PaymentConfigurationConfig>('paymentConfiguration');
    this.cipher = new AppleTokenCipher(credentialEncryptionKeyHex);
  }

  /** Exchanges the app's one-time code; the sealed refresh token, or null. */
  async sealedTokenFor(
    clientId: string,
    authorizationCode?: string,
  ): Promise<string | null> {
    if (!authorizationCode) return null;
    const token = await this.rest.exchangeCode(clientId, authorizationCode);
    return token ? this.cipher.seal(token) : null;
  }

  /** Inside the caller's own-account transaction. */
  async store(
    tx: Prisma.TransactionClient,
    userId: string,
    clientId: string,
    sealedToken: string | null,
  ): Promise<void> {
    if (!sealedToken) return;
    await tx.appleRefreshToken.upsert({
      where: { userId },
      create: { userId, clientId, sealedToken },
      update: { clientId, sealedToken },
    });
  }

  async storeOwn(
    userId: string,
    clientId: string,
    sealedToken: string | null,
  ): Promise<void> {
    if (!sealedToken) return;
    await this.tenancy.runInUserContext(userId, (tx) =>
      this.store(tx, userId, clientId, sealedToken),
    );
  }

  /** Best effort: Apple unreachable or not configured never stops a deletion. */
  async revokeBeforeDeletion(userId: string): Promise<void> {
    try {
      const row = await this.tenancy.runInUserContext(userId, (tx) =>
        tx.appleRefreshToken.findUnique({ where: { userId } }),
      );
      if (!row) return;
      const token = this.cipher.open(row.sealedToken);
      const revoked = token ? await this.rest.revoke(row.clientId, token) : false;
      if (!revoked) {
        this.logger.warn({ userId }, 'Apple token not revoked at account deletion');
      }
    } catch (error) {
      this.logger.warn(
        { userId, error: error instanceof Error ? error.message : String(error) },
        'Apple token revoke failed at account deletion',
      );
    }
  }
}
