/**
 * PaymentProviderAdapter — the provider-abstraction boundary master plan
 * ADR-010 (2026-08-26 update) requires: a real, mandatory interface every
 * payment provider (manual transfer today, a real gateway later) implements,
 * resolved by `PaymentProviderRegistry`, so `PaymentService`/checkout
 * business logic depends only on this contract — never a gateway-specific
 * `if (provider === 'stripe')` branch. Mirrors `CloudflareProvider`'s
 * (P11, `src/domain/providers/`) identical "interface + concrete
 * implementation, resolved by DI" shape, generalized here to more than one
 * possible implementation via `PaymentProviderRegistry`.
 *
 * Deliberately minimal — only the two capabilities this phase's real
 * callers actually need:
 *
 *   `buildInitialNextAction` — what a caller should do immediately after a
 *   Payment row is created for a method this provider handles (today:
 *   `ManualTransferProvider` returns `{ type: 'awaiting_proof' }` when the
 *   method's own catalog capabilities say so — the exact ternary
 *   `PaymentService.createPayment` used to inline, moved behind this
 *   interface with zero behavior change).
 *
 *   `testConnection` — the real backing operation for §5.8's dashboard
 *   "Test Connection" action on an Organization's own-gateway
 *   configuration. `ManualTransferProvider` implements it trivially (no
 *   external connection exists for manual transfer) purely so the
 *   interface has one real, working implementation today — it is never
 *   surfaced to an Organization as a selectable "own gateway" option (see
 *   `availableForOrganizationGateway`).
 *
 * 2026-08-26 update — Atlas Subscription Payment (Generic Payment Gateway
 * Integration Readiness): two additions, both real callers, neither
 * speculative —
 *
 *   `availableForAtlasSubscription` — the Atlas-side counterpart of
 *   `availableForOrganizationGateway` below, filtering
 *   `PaymentProviderRegistry.listAvailableForAtlasSubscription()` for the
 *   Platform Owner's "Atlas Subscription Payments" provider-selection
 *   dropdown. `true` for `ManualTransferProvider` — it IS the real,
 *   currently-active Atlas subscription payment method, unlike its
 *   Organization-Owned-Gateway counterpart.
 *
 *   `createPaymentIntent` — OPTIONAL (capability-gated, exactly like
 *   `PaymentMethodCapabilities.supportsProof` already gates proof-upload
 *   behavior): the real backing operation for the already-existing,
 *   already-wired `POST organizations/:id/payments/intents` endpoint
 *   (`PaymentService.createPaymentIntent`, P12), which previously always
 *   threw `errors.payment.gatewayNotConnected` unconditionally.
 *   `ManualTransferProvider` deliberately does NOT implement this method —
 *   manual transfer has no payment-intent concept at all (it produces a
 *   `Payment` awaiting proof, never a redirect/checkout URL) — so the
 *   absence itself is the correct, honest signal, not an oversight. A
 *   future real gateway adapter implements this once; the core
 *   subscription payment flow calls it only through this interface.
 */
import type { PaymentMethodCapabilitiesResponse } from '../dto/payment-method.contract';

export interface PaymentProviderTestConnectionResult {
  readonly success: boolean;
  readonly message?: string;
}

/** The minimal context a payment-intent call needs — the fields `PaymentService.createPaymentIntent` already has on hand from the resolved Checkout, never more. */
export interface PaymentIntentContext {
  readonly checkoutId: string;
  readonly organizationId: string;
  readonly amountMinorUnits: bigint;
  readonly currency: string;
  /** Idempotency-safe reference the caller generated for this intent — passed through to the provider so a retried request never creates two intents at a real gateway. */
  readonly clientReference: string;
}

/** Gateway-ready payment-intent result — mirrors the frontend's own `PaymentIntent` contract (`payment.types.ts`) field-for-field; `checkoutUrl` is genuinely provider-supplied, never constructed by core business logic. */
export interface PaymentIntentResult {
  readonly providerReference?: string;
  readonly checkoutUrl?: string;
  readonly expiresAt: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface PaymentProviderAdapter {
  /** Stable key this provider is resolved by — matches `payments.provider`/`payment_methods.provider` (Atlas's own catalog) and `organization_gateway_credentials.provider_key`/`organization_connected_accounts.provider_key` (an Organization's own configuration). */
  readonly providerKey: string;

  /** Human-readable label — surfaced only in a Platform-Owner/Organization-facing provider list, never used for any authorization/business-logic decision. */
  readonly displayName: string;

  /**
   * Whether an Organization may select this provider for its own
   * Organization-Owned Gateway configuration (§4.1/§5.8). `false` for
   * `ManualTransferProvider` — that key is reserved for Atlas's own
   * subscription-billing catalog (`payment_methods`) and is never a
   * meaningful "connect your own gateway" choice for an Organization.
   */
  readonly availableForOrganizationGateway: boolean;

  /** Whether a Platform Owner may select this provider for Atlas's own Subscription Payment configuration — see this file's 2026-08-26 update note above. */
  readonly availableForAtlasSubscription: boolean;

  /**
   * What a caller should do immediately after creating a Payment row this
   * provider will handle — `null` when there is nothing further required
   * of the payer at creation time. Never a hardcoded shape per provider
   * outside this method; the caller (`PaymentService`) treats the result
   * as an opaque `PaymentNextAction`-shaped value.
   */
  buildInitialNextAction(
    capabilities: PaymentMethodCapabilitiesResponse,
  ): Record<string, unknown> | null;

  /**
   * A real, minimal connectivity/credential check — never a fabricated
   * success (matches `CloudflareProvider.verifyToken`'s identical "no fake
   * infrastructure status" rule, master plan §1/§16). `config` is the
   * already-decrypted configuration object for this provider; the caller
   * is responsible for decryption/redaction around this call, never this
   * method itself.
   */
  testConnection(
    config: Record<string, unknown>,
  ): Promise<PaymentProviderTestConnectionResult>;

  /**
   * Creates a gateway-ready payment intent for the given context — OPTIONAL,
   * present only on adapters that actually have an online checkout/redirect
   * concept (see this file's 2026-08-26 update note). `config` is the
   * already-decrypted provider configuration, identical contract to
   * `testConnection`.
   */
  readonly createPaymentIntent?: (
    context: PaymentIntentContext,
    config: Record<string, unknown>,
  ) => Promise<PaymentIntentResult>;
}
