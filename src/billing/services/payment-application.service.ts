/**
 * PaymentApplicationService — the ONE place a Payment's success or failure
 * is actually applied to `payments`/`checkouts`/`tenant_subscriptions`/
 * `tenant_add_ons`. Both `PlatformPaymentService.approvePayment` (a human
 * reviewer) and `PaymentWebhookService` (a future gateway's
 * `payment.succeeded` event) call this SAME method — never two parallel
 * "apply success" implementations — matching master plan §10's own
 * transaction rule: "any mutation touching more than one table that must
 * be atomic... runs inside one database transaction."
 *
 * Every method here takes an already-open `Prisma.TransactionClient` — it
 * never opens its own `runInTenantContext`/`runInUserContext`, because the
 * whole point is to run as one step of a LARGER atomic transaction the
 * caller already established (payment update + checkout update +
 * subscription/add-on update all succeed or all roll back together).
 *
 * "Payment is not Subscription" (frontend `Reports/ARCHITECTURE.md`,
 * Prompt 7): this is the one and only server-side trigger that turns a
 * successful Payment into a real `tenant_subscriptions`/`tenant_add_ons`
 * change — the frontend never performs this mutation itself, only reacts
 * to `Payment.status === 'succeeded'` afterward.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Checkout, Payment, SubscriptionBillingCycle } from '@prisma/client';
import { CheckoutsRepository } from '../repositories/checkouts.repository';
import { PaymentsRepository } from '../repositories/payments.repository';
import { PlansRepository } from '../../plans/repositories/plans.repository';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import { TenantSubscriptionsRepository } from '../../plans/repositories/tenant-subscriptions.repository';
import { TenantAddOnsRepository } from '../../plans/repositories/tenant-add-ons.repository';

function addPeriod(start: Date, billingCycle: SubscriptionBillingCycle | null): Date {
  const end = new Date(start);
  if (billingCycle === 'yearly') {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    // 'monthly', or no billing cycle recorded on the snapshot — the
    // narrower, safer default (a shorter period is never a correctness
    // problem for a Tenant, only a longer one would be).
    end.setMonth(end.getMonth() + 1);
  }
  return end;
}

@Injectable()
export class PaymentApplicationService {
  constructor(
    private readonly checkoutsRepository: CheckoutsRepository,
    private readonly paymentsRepository: PaymentsRepository,
    private readonly plansRepository: PlansRepository,
    private readonly addOnsRepository: AddOnsRepository,
    private readonly tenantSubscriptionsRepository: TenantSubscriptionsRepository,
    private readonly tenantAddOnsRepository: TenantAddOnsRepository,
  ) {}

  /**
   * Applies a successful Payment: marks it `succeeded`, completes its
   * Checkout, and — the real commercial effect — updates
   * `tenant_subscriptions`/`tenant_add_ons` from the Checkout's frozen
   * `snapshot.target`, never the live catalog. Throws (rolling back the
   * whole caller transaction) if there is no `tenant_subscriptions` row to
   * update yet — real subscription CREATION is Phase P14 provisioning, not
   * this phase's job (see `TenantSubscriptionsRepository.
   * updateForPlanPurchase`'s own doc comment).
   */
  async applySuccessfulPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
  ): Promise<Payment> {
    const updated = await this.paymentsRepository.update(tx, payment.id, {
      status: 'succeeded',
      failureReason: null,
      nextAction: Prisma.JsonNull,
    });

    if (!payment.checkoutId) return updated;

    const checkout = await tx.checkout.findUnique({ where: { id: payment.checkoutId } });
    if (!checkout) return updated;

    await this.checkoutsRepository.updateStatus(tx, checkout.id, 'completed');
    await this.applyCommercialEffect(tx, checkout);

    return updated;
  }

  async applyFailedPayment(
    tx: Prisma.TransactionClient,
    payment: Payment,
    failureReasonKey: string,
  ): Promise<Payment> {
    return this.paymentsRepository.update(tx, payment.id, {
      status: 'failed',
      failureReason: failureReasonKey,
      nextAction: Prisma.JsonNull,
    });
  }

  /**
   * Always re-resolves the catalog row by `checkout.targetKey` — the
   * commercial effect (which Plan/AddOn gets activated) is never taken
   * from `checkout.snapshot`, which is display/audit data frozen at
   * Checkout-creation time (master plan §5.7) and could be stale by the
   * time a manual review completes.
   */
  private async applyCommercialEffect(
    tx: Prisma.TransactionClient,
    checkout: Checkout,
  ): Promise<void> {
    if (checkout.targetType === 'plan_subscription') {
      const plan = await this.plansRepository.findByKey(checkout.targetKey);
      if (!plan) {
        throw new NotFoundException({ messageKey: 'errors.checkout.planNoLongerExists' });
      }

      const now = new Date();
      // Phase P19 (`Reports/DEVELOPMENT_E2E_FLOW_AUDIT.md` P0-3):
      // `upsertForPlanPurchase` now creates the Organization's first-ever
      // `tenant_subscriptions` row itself when none exists yet, rather
      // than this call site catching `P2025` and refusing — see that
      // method's own doc comment for the full reasoning. This IS still
      // "the one and only server-side trigger that turns a successful
      // Payment into a real subscription change" (this file's own header
      // comment) for both the create and update cases now.
      await this.tenantSubscriptionsRepository.upsertForPlanPurchase(
        tx,
        checkout.organizationId,
        {
          planId: plan.id,
          billingCycle: checkout.billingCycle,
          currentPeriodStart: now,
          currentPeriodEnd: addPeriod(now, checkout.billingCycle),
        },
      );
      return;
    }

    // add_on
    const addOn = await this.addOnsRepository.findByKey(checkout.targetKey);
    if (!addOn) {
      throw new NotFoundException({ messageKey: 'errors.checkout.addOnNoLongerExists' });
    }
    await this.tenantAddOnsRepository.activate(tx, checkout.organizationId, addOn.id);
  }
}
