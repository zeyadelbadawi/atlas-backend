/**
 * PaymentProviderRegistry — resolves a `PaymentProviderAdapter` by its
 * `providerKey` (ADR-010, 2026-08-26 update; master plan §5.8/§11.x).
 * `PaymentService`/checkout business logic depends on THIS class and the
 * `PaymentProviderAdapter` interface — never on a concrete provider class,
 * never on a gateway-specific branch.
 *
 * Adding a future real gateway is exactly the "one-time developer work"
 * the master plan describes: implement `PaymentProviderAdapter`, add one
 * constructor parameter here, done — no change to any resolver/consumer of
 * this registry. Deliberately a plain constructor-parameter list rather
 * than a generic multi-bind DI mechanism (e.g. a Nest `multi: true`-style
 * token array) — this codebase has no precedent for that pattern anywhere
 * else, and a one-adapter-today registry doesn't yet justify introducing
 * one; revisit if/when a second real provider makes the list unwieldy.
 *
 * Ships with exactly one entry today — `ManualTransferProvider`. No
 * gateway (Paymob, Stripe, Tap, Telr, HyperPay, or otherwise) is
 * registered here.
 */
import { Injectable, NotFoundException } from '@nestjs/common';
import { ManualTransferProvider } from './manual-transfer.provider';
import type { PaymentProviderAdapter } from './payment-provider.interface';

export interface RegisteredPaymentProviderSummary {
  readonly providerKey: string;
  readonly displayName: string;
}

@Injectable()
export class PaymentProviderRegistry {
  private readonly adaptersByKey: ReadonlyMap<string, PaymentProviderAdapter>;

  constructor(manualTransferProvider: ManualTransferProvider) {
    this.adaptersByKey = new Map(
      [manualTransferProvider].map((adapter) => [adapter.providerKey, adapter]),
    );
  }

  /** Resolves an adapter by key, or `null` if `providerKey` is not registered — the caller decides whether that is a hard failure or an honest "not available" state (matches `CloudflareProvider`'s "absent config → false/null, never throw for an unconfigured/unknown state" precedent). */
  tryResolve(providerKey: string): PaymentProviderAdapter | null {
    return this.adaptersByKey.get(providerKey) ?? null;
  }

  /** Resolves an adapter by key, throwing when unknown — for the one caller (`PaymentService`, resolving Atlas's own catalog `provider` value) where an unresolvable key is a genuine backend-data-integrity bug, never an expected outcome. */
  resolveOrThrow(providerKey: string): PaymentProviderAdapter {
    const adapter = this.tryResolve(providerKey);
    if (!adapter) {
      throw new NotFoundException({ messageKey: 'errors.payment.providerNotAvailable' });
    }
    return adapter;
  }

  /**
   * The providers an Organization may select for its own Organization-
   * Owned Gateway configuration (§4.1/§5.8) — empty today, since
   * `ManualTransferProvider` is not organization-connectable and no real
   * gateway is registered. An honestly empty list, never a fabricated
   * option (matches P11's Cloudflare "honest not-configured" rule).
   */
  listAvailableForOrganizationGateway(): readonly RegisteredPaymentProviderSummary[] {
    return Array.from(this.adaptersByKey.values())
      .filter((adapter) => adapter.availableForOrganizationGateway)
      .map((adapter) => ({
        providerKey: adapter.providerKey,
        displayName: adapter.displayName,
      }));
  }

  /**
   * The providers a Platform Owner may select for Atlas's own Subscription
   * Payment configuration (2026-08-26, Generic Payment Gateway Integration
   * Readiness) — includes `ManualTransferProvider` (today's real, active
   * method) and, once one is ever registered, any future gateway adapter.
   * Never fabricates an entry for an unregistered gateway.
   */
  listAvailableForAtlasSubscription(): readonly RegisteredPaymentProviderSummary[] {
    return Array.from(this.adaptersByKey.values())
      .filter((adapter) => adapter.availableForAtlasSubscription)
      .map((adapter) => ({
        providerKey: adapter.providerKey,
        displayName: adapter.displayName,
      }));
  }
}
