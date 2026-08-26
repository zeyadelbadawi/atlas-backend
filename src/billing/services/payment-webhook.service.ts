/**
 * PaymentWebhookService — real webhook infrastructure, "ready for a future
 * gateway adapter, not yet connected" (master plan §21 P12). Two halves:
 *
 * `verifySignature` runs synchronously on the inbound HTTP request
 * (`PaymentWebhookController`), before anything is queued — an invalid
 * signature is rejected immediately, never enqueued (master plan §16:
 * "HMAC signature verification on every inbound payment/provider
 * webhook").
 *
 * `processEvent` is the async half (`PaymentWebhookProcessor`, BullMQ),
 * exactly matching master plan §12's own `payment-webhook-worker` row:
 * "Must be idempotent per event id — a webhook received twice must never
 * double-apply... Unique constraint on (provider, event_id)." The
 * `resolve_payment_organization` `SECURITY DEFINER` lookup is the one
 * legitimate no-context read this service needs (an inbound webhook
 * carries no session at all) — see the P12 migration's own RLS header
 * comment.
 */
import { Injectable, Logger } from '@nestjs/common';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { PaymentsRepository } from '../repositories/payments.repository';
import { PaymentWebhookEventsRepository } from '../repositories/payment-webhook-events.repository';
import { PaymentApplicationService } from './payment-application.service';
import { verifyWebhookSignature } from '../utils/webhook-signature.util';
import type { PaymentWebhookEventDto } from '../dto/payment-webhook-event.dto';
import type { BillingConfig } from '../../config/configuration';
import type { ProcessWebhookEventJobPayload } from '../queue/payment-webhook.types';

const PROVIDER = 'atlas_manual';

@Injectable()
export class PaymentWebhookService {
  private readonly logger = new Logger(PaymentWebhookService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly paymentWebhookEventsRepository: PaymentWebhookEventsRepository,
    private readonly paymentApplicationService: PaymentApplicationService,
  ) {}

  verifySignature(
    canonicalPayload: string,
    providedSignature: string | undefined,
    config: BillingConfig,
  ): boolean {
    return verifyWebhookSignature(
      canonicalPayload,
      providedSignature,
      config.webhookSecret,
    );
  }

  /** Resolves the event's Payment → organization, so the controller can decide whether to accept (200, enqueued) or reject (404, unknown payment) before ever touching the queue. */
  async resolveOrganizationForEvent(
    event: PaymentWebhookEventDto,
  ): Promise<string | null> {
    return this.paymentsRepository.resolvePaymentOrganization(event.paymentId);
  }

  /** The real, idempotent apply step — called only by `PaymentWebhookProcessor`. */
  async processEvent(payload: ProcessWebhookEventJobPayload): Promise<void> {
    const organizationId = await this.paymentsRepository.resolvePaymentOrganization(
      payload.paymentId,
    );
    if (!organizationId) {
      this.logger.warn(
        { paymentId: payload.paymentId },
        'Payment webhook event references an unknown payment — dropping.',
      );
      return;
    }

    await this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const inserted = await this.paymentWebhookEventsRepository.tryInsert(tx, {
        organization: { connect: { id: organizationId } },
        provider: payload.provider,
        eventId: payload.eventId,
        eventType: payload.eventType,
        payment: { connect: { id: payload.paymentId } },
      });
      if (!inserted) {
        // Already processed — the exact §18 scenario 8 guarantee: this
        // event id has already produced exactly one state transition, and
        // this redelivery produces none.
        this.logger.log(
          { eventId: payload.eventId },
          'Payment webhook event already processed — no-op.',
        );
        return;
      }

      const payment = await this.paymentsRepository.findById(
        tx,
        organizationId,
        payload.paymentId,
      );
      if (!payment) return;

      switch (payload.eventType) {
        case 'payment.succeeded':
          await this.paymentApplicationService.applySuccessfulPayment(tx, payment);
          break;
        case 'payment.failed':
          await this.paymentApplicationService.applyFailedPayment(
            tx,
            payment,
            'errors.payment.webhookFailed',
          );
          break;
        case 'payment.cancelled':
          await this.paymentsRepository.update(tx, payment.id, { status: 'cancelled' });
          break;
        case 'payment.expired':
          await this.paymentsRepository.update(tx, payment.id, { status: 'expired' });
          break;
        case 'payment.processing':
          await this.paymentsRepository.update(tx, payment.id, { status: 'processing' });
          break;
        case 'payment.requires_action':
          await this.paymentsRepository.update(tx, payment.id, {
            status: 'requires_action',
          });
          break;
        default:
          // 'payment.created' / 'refund.*' — no state transition this
          // phase defines a handler for (no refund flow exists yet, master
          // plan §24). Recorded in `payment_webhook_events` above (so a
          // redelivery of THIS event still no-ops), applied as a no-op.
          break;
      }
    });
  }

  static readonly PROVIDER = PROVIDER;
}
