/**
 * Checkout request validation — `CheckoutTarget`'s discriminated union
 * (`checkout.types.ts`: `{type: 'plan_subscription', planKey} | {type:
 * 'add_on', addOnKey}`) has no clean class-validator shape (nested
 * discriminated unions), so — matching P9/P10's own precedent for the
 * identical problem (`src/website/validation/*.schemas.ts`) — this is
 * real, backend-owned Zod validation, bridged into the same
 * `NormalizedApiError` shape via `common/validation/zod-violations.util.ts`
 * every other Zod-validated payload in this codebase already uses.
 */
import { z } from 'zod';

export const checkoutTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('plan_subscription'),
    planKey: z.string().min(1, 'validation:required'),
  }),
  z.object({
    type: z.literal('add_on'),
    addOnKey: z.string().min(1, 'validation:required'),
  }),
]);

export type CheckoutTargetInput = z.infer<typeof checkoutTargetSchema>;

export const createCheckoutSchema = z.object({
  target: checkoutTargetSchema,
  billingCycle: z.enum(['monthly', 'yearly']).optional(),
  idempotencyKey: z
    .string()
    .min(1, 'validation:required')
    .max(255, 'validation:maxLength'),
});

export type CreateCheckoutInput = z.infer<typeof createCheckoutSchema>;
