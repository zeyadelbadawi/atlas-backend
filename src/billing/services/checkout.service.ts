/**
 * CheckoutService — `organizations/:id/checkouts`. Matches `CheckoutService`
 * (atlas frontend) exactly: `createCheckout`/`getCheckout`, no more.
 *
 * `createCheckout` is idempotent on `(organizationId, idempotencyKey)` —
 * master plan §10: "every financial mutation... accepts and enforces a
 * client-supplied idempotency key via a unique constraint" — checked
 * BEFORE attempting a create, and again via a `P2002` catch as a race-safe
 * fallback (two concurrent retries of the exact same network call), never
 * relying on the first check alone.
 *
 * `Checkout.snapshot` is computed here, once, from the LIVE catalog
 * (`plans`/`add_ons`) and then frozen — nothing else in this codebase ever
 * recomputes it afterward (master plan §5.7).
 */
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Checkout } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { CheckoutsRepository } from '../repositories/checkouts.repository';
import { PlansRepository } from '../../plans/repositories/plans.repository';
import { AddOnsRepository } from '../../plans/repositories/add-ons.repository';
import { createCheckoutSchema } from '../validation/checkout.schemas';
import type { CreateCheckoutInput } from '../validation/checkout.schemas';
import { parseOrThrow } from '../../common/validation/zod-violations.util';
import { toMinorUnits } from '../utils/money.util';
import { CHECKOUT_EXPIRY_MINUTES } from '../dto/billing.constants';
import { toCheckoutResponse } from '../dto/checkout.contract';
import type {
  CheckoutResponse,
  CheckoutSnapshotResponse,
} from '../dto/checkout.contract';
import type { CreateCheckoutDto } from '../dto/create-checkout.dto';

function isUniqueConstraintViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class CheckoutService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly checkoutsRepository: CheckoutsRepository,
    private readonly plansRepository: PlansRepository,
    private readonly addOnsRepository: AddOnsRepository,
  ) {}

  async createCheckout(
    organizationId: string,
    payload: CreateCheckoutDto,
  ): Promise<CheckoutResponse> {
    const input = parseOrThrow(createCheckoutSchema, payload);

    const snapshot = await this.buildSnapshot(input);

    return this.tenancyContextService.runInTenantContext(organizationId, async (tx) => {
      const existing = await this.checkoutsRepository.findByIdempotencyKey(
        tx,
        organizationId,
        input.idempotencyKey,
      );
      if (existing) return toCheckoutResponse(existing);

      const now = new Date();
      const expiresAt = new Date(now.getTime() + CHECKOUT_EXPIRY_MINUTES * 60_000);

      try {
        const created = await this.checkoutsRepository.create(tx, {
          organization: { connect: { id: organizationId } },
          targetType: input.target.type,
          targetKey:
            input.target.type === 'plan_subscription'
              ? input.target.planKey
              : input.target.addOnKey,
          billingCycle: input.billingCycle,
          snapshot: snapshot as unknown as Prisma.InputJsonValue,
          status: 'draft',
          expiresAt,
          idempotencyKey: input.idempotencyKey,
        });
        return toCheckoutResponse(created);
      } catch (error) {
        // Two concurrent requests replaying the same idempotency key raced
        // the check above — the unique constraint is the real authority;
        // re-read and return the row the OTHER request created, never a
        // duplicate.
        if (isUniqueConstraintViolation(error)) {
          const raced = await this.checkoutsRepository.findByIdempotencyKey(
            tx,
            organizationId,
            input.idempotencyKey,
          );
          if (raced) return toCheckoutResponse(raced);
        }
        throw error;
      }
    });
  }

  async getCheckout(
    organizationId: string,
    checkoutId: string,
  ): Promise<CheckoutResponse> {
    const checkout = await this.tenancyContextService.runInTenantContext(
      organizationId,
      (tx) => this.checkoutsRepository.findById(tx, organizationId, checkoutId),
    );
    if (!checkout) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return toCheckoutResponse(checkout);
  }

  /** Exposed for `PaymentService.createPayment`, which needs the raw row (not the response DTO) inside its own tenant-context transaction. */
  async findCheckoutOrThrow(
    tx: Prisma.TransactionClient,
    organizationId: string,
    checkoutId: string,
  ): Promise<Checkout> {
    const checkout = await this.checkoutsRepository.findById(
      tx,
      organizationId,
      checkoutId,
    );
    if (!checkout) throw new NotFoundException({ messageKey: 'errors.notFound' });
    return checkout;
  }

  private async buildSnapshot(
    input: CreateCheckoutInput,
  ): Promise<CheckoutSnapshotResponse> {
    if (input.target.type === 'plan_subscription') {
      const plan = await this.plansRepository.findByKey(input.target.planKey);
      if (!plan || plan.status !== 'active') {
        throw new NotFoundException({ messageKey: 'errors.checkout.planNotFound' });
      }
      const pricing = plan.pricing as unknown as {
        amount?: number;
        currency?: string;
        billingCycle?: 'monthly' | 'yearly';
      } | null;
      // `amount` can be a real `0` (a free plan's own honest price) — the
      // check is deliberately "field present", never a truthiness check,
      // so a free plan is never mistaken for "pricing not configured".
      if (pricing?.amount === undefined || pricing.amount === null || !pricing.currency) {
        throw new BadRequestException({
          messageKey: 'errors.checkout.pricingUnavailable',
        });
      }
      return {
        target: { type: 'plan_subscription', planKey: plan.key },
        billingCycle: input.billingCycle ?? pricing.billingCycle,
        displayName: plan.name,
        price: {
          amountMinorUnits: Number(toMinorUnits(pricing.amount)),
          currency: pricing.currency,
        },
        capturedAt: new Date().toISOString(),
      };
    }

    const addOn = await this.addOnsRepository.findByKey(input.target.addOnKey);
    if (!addOn) {
      throw new NotFoundException({ messageKey: 'errors.checkout.addOnNotFound' });
    }
    const pricing = addOn.pricing as unknown as {
      amount?: number;
      currency?: string;
      billingCycle?: 'monthly' | 'yearly';
    } | null;
    if (pricing?.amount === undefined || pricing.amount === null || !pricing.currency) {
      throw new BadRequestException({ messageKey: 'errors.checkout.pricingUnavailable' });
    }
    return {
      target: { type: 'add_on', addOnKey: addOn.key },
      billingCycle: input.billingCycle ?? pricing.billingCycle,
      displayName: addOn.name,
      price: {
        amountMinorUnits: Number(toMinorUnits(pricing.amount)),
        currency: pricing.currency,
      },
      capturedAt: new Date().toISOString(),
    };
  }
}
