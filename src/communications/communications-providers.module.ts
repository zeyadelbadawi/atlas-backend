/**
 * CommunicationsProvidersModule — P64 Communications provider layer.
 *
 * Owns the vendor adapters, the registry the `EMAIL_PROVIDER` token
 * resolves to (so `AuthService`, `PasswordResetEmailProcessor` and
 * `EmailService` keep injecting the same token unchanged), the Redis
 * quota, the suppression list, and the inbound delivery-webhook route +
 * worker. `IdentityModule` imports this module and re-exports
 * `EMAIL_PROVIDER`/`StubEmailProvider`, which keeps every existing import
 * site working. Depends on `TenancyModule` only (one-directional; tenancy
 * never depends on communications). `RedisModule`, `DatabaseModule` and
 * `MetricsModule` are global.
 */
import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { EmailConfig } from '../config/configuration';
import { EMAIL_PROVIDER } from '../identity/services/email-provider.interface';
import type { EmailProviderAdapter } from '../identity/services/email-provider.interface';
import { TenancyModule } from '../tenancy/tenancy.module';
import {
  EMAIL_WEBHOOK_ADAPTERS,
  EmailWebhookController,
} from './controllers/email-webhook.controller';
import { BrevoEmailProvider } from './providers/brevo-email.provider';
import { EmailProviderRegistry } from './providers/email-provider.registry';
import { ResendEmailProvider } from './providers/resend-email.provider';
import { StubEmailProvider } from './providers/stub-email.provider';
import { COMMUNICATIONS_QUEUE } from './queue/communications-queue.types';
import { CommunicationsWebhookProcessor } from './queue/communications-webhook.processor';
import { CommunicationsWebhookProducer } from './queue/communications-webhook.producer';
import { DeliveryEventService } from './services/delivery-event.service';
import { EmailQuotaService } from './services/email-quota.service';
import { SuppressionService } from './services/suppression.service';
import { CommunicationMetricsService } from './services/communication-metrics.service';

@Module({
  imports: [TenancyModule, BullModule.registerQueue({ name: COMMUNICATIONS_QUEUE })],
  controllers: [EmailWebhookController],
  providers: [
    // All three adapters are registered unconditionally (construction is
    // free; nothing touches the network until `send`) so a test can inject
    // `StubEmailProvider` directly and see the exact singleton the chain
    // holds — the same "one singleton, never two" guarantee P17 kept.
    StubEmailProvider,
    BrevoEmailProvider,
    ResendEmailProvider,
    EmailQuotaService,
    SuppressionService,
    DeliveryEventService,
    CommunicationsWebhookProducer,
    CommunicationsWebhookProcessor,
    {
      provide: EmailProviderRegistry,
      useFactory: (
        configService: ConfigService,
        quota: EmailQuotaService,
        metrics: CommunicationMetricsService,
        stub: StubEmailProvider,
        brevo: BrevoEmailProvider,
        resend: ResendEmailProvider,
      ) => {
        const email = configService.getOrThrow<EmailConfig>('email');
        const byName: Record<string, EmailProviderAdapter> = {
          [stub.name]: stub,
          [brevo.name]: brevo,
          [resend.name]: resend,
        };
        const chain = email.providers
          .map((name) => byName[name])
          .filter((adapter): adapter is EmailProviderAdapter => Boolean(adapter));
        return new EmailProviderRegistry(chain, quota, metrics);
      },
      inject: [
        ConfigService,
        EmailQuotaService,
        CommunicationMetricsService,
        StubEmailProvider,
        BrevoEmailProvider,
        ResendEmailProvider,
      ],
    },
    { provide: EMAIL_PROVIDER, useExisting: EmailProviderRegistry },
    // Every webhook-capable adapter, whether or not it is in the current
    // send chain: a provider removed from `EMAIL_PROVIDERS` after an
    // incident still reports on messages it already accepted.
    {
      provide: EMAIL_WEBHOOK_ADAPTERS,
      useFactory: (brevo: BrevoEmailProvider, resend: ResendEmailProvider) =>
        [brevo, resend].filter((adapter) => adapter.capabilities().supportsWebhooks),
      inject: [BrevoEmailProvider, ResendEmailProvider],
    },
  ],
  exports: [
    EMAIL_PROVIDER,
    EmailProviderRegistry,
    StubEmailProvider,
    EmailQuotaService,
    SuppressionService,
    CommunicationsWebhookProducer,
  ],
})
export class CommunicationsProvidersModule {}
