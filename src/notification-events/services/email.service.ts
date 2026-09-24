/**
 * EmailService — the middle layer of `NotificationService → EmailService →
 * EmailProvider (registry) → Provider API` (master plan §21 Phase P17's
 * own architecture instruction). Owns template rendering and the
 * observability/failure-isolation contract; the ONLY caller of
 * `EmailProvider.send` for every P17 event (P1's own
 * `sendPasswordResetEmail` path is untouched — see
 * `email-provider.interface.ts`'s own doc comment for why that stays
 * separate).
 *
 * P64 Communications: consults `SuppressionService` BEFORE sending — an
 * address that hard-bounced or complained is never mailed again, whatever
 * the template — and passes the caller's `category` through so the
 * registry reserves the right quota line.
 *
 * Never throws. A failed send is logged (never with email body/secrets)
 * and swallowed — master plan §21 P17's own explicit rule: "Email
 * provider failure must not corrupt the primary business transaction."
 * Every caller of this service has, by construction, already committed
 * its own business transaction before this runs (see
 * `NotificationFanoutService`'s own doc comment on the two-step "write
 * the row inside the transaction, send the email after it commits"
 * discipline) — so there is no transaction left for a thrown error here
 * to roll back anyway, but this method still never throws, as a second,
 * independent safety net.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EMAIL_PROVIDER } from '../../identity/services/email-provider.interface';
import type {
  EmailCategory,
  EmailProvider,
} from '../../identity/services/email-provider.interface';
import { SuppressionService } from '../../communications/services/suppression.service';
import { renderEmailTemplate } from '../templates/email-templates';
import type { EmailTemplateKey } from '../templates/email-templates';

export interface SendTemplatedOptions {
  /** Quota class the send reserves against; defaults to `transactional`. */
  readonly category?: EmailCategory;
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    private readonly suppressions: SuppressionService,
  ) {}

  async sendTemplated(
    to: string,
    template: EmailTemplateKey,
    values: Record<string, unknown> = {},
    options: SendTemplatedOptions = {},
  ): Promise<void> {
    const category = options.category ?? 'transactional';
    try {
      if (await this.suppressions.isSuppressed(to)) {
        this.logger.log(
          { template, category },
          'Transactional email skipped — address is suppressed',
        );
        return;
      }
    } catch (error) {
      // A suppression lookup failure must not block a security/transactional
      // email; it is logged and the send proceeds.
      this.logger.warn(
        { template, error: error instanceof Error ? error.message : String(error) },
        'Suppression lookup failed — sending anyway',
      );
    }
    const { subject, text } = renderEmailTemplate(template, values);
    try {
      await this.emailProvider.send({ to, subject, text, category });
    } catch (error) {
      this.logger.error(
        {
          template,
          category,
          error: error instanceof Error ? error.message : String(error),
        },
        'Transactional email send failed — not rethrown (business operation already completed)',
      );
    }
  }
}
