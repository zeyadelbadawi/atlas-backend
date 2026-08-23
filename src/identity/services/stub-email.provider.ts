/**
 * StubEmailProvider.
 *
 * P1's stand-in for real transactional email (master plan §12/§21 P1: "A
 * stub email provider is acceptable... Real transactional email provider
 * integration belongs to P17"). Never logs the raw token or any URL built
 * from it — only that a send was attempted, for a masked address.
 *
 * Testability without logging a secret: rather than writing the raw token
 * anywhere observable, this keeps the single most recent token per
 * (normalized) email address in an in-memory map for the lifetime of the
 * process. Nothing HTTP-reachable exposes it — it's a plain injectable
 * service `peekLastPasswordResetToken` that integration/e2e tests read
 * directly off the Nest testing module, exactly the "test-only mechanism"
 * the P1 spec allows as an alternative to logging.
 */
import { Injectable, Logger } from '@nestjs/common';
import type { EmailProvider } from './email-provider.interface';
import { normalizeEmail } from '../utils/email.util';

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1);
  return `${visible}***@${domain}`;
}

@Injectable()
export class StubEmailProvider implements EmailProvider {
  private readonly logger = new Logger(StubEmailProvider.name);
  private readonly lastPasswordResetTokens = new Map<string, string>();

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    const normalized = normalizeEmail(to);
    this.lastPasswordResetTokens.set(normalized, rawToken);
    this.logger.log(
      { to: maskEmail(normalized) },
      'Stub email provider: password reset email would be sent (no real provider configured — Phase P17)',
    );
  }

  /** Test-only accessor — never called from any controller/HTTP path. */
  peekLastPasswordResetToken(email: string): string | undefined {
    return this.lastPasswordResetTokens.get(normalizeEmail(email));
  }
}
