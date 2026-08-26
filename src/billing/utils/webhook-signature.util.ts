/**
 * Payment webhook HMAC signing/verification (master plan §16: "HMAC
 * signature verification on every inbound payment/provider webhook").
 *
 * No real gateway is connected in this phase (§21 P12), so there is no
 * specific external provider's exact signing algorithm to replicate (each
 * real gateway — Stripe, Paymob, etc. — defines its own). This is a real,
 * deterministic, testable HMAC-SHA256 scheme Atlas itself defines and
 * fully controls both ends of — a concrete `GatewayPaymentProviderAdapter`
 * integration later would translate that provider's own signature into
 * this verification call (an adapter swap, not a redesign), exactly the
 * same "no fake external integration presented as real" discipline P11's
 * Cloudflare provider abstraction already established.
 *
 * The signed payload is a stable, explicit canonical string built from the
 * event's own validated fields — never `JSON.stringify(body)` (which is
 * ambiguous across differing key order/whitespace and would make a
 * signature fragile to something that isn't a real content change).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentWebhookEventDto } from '../dto/payment-webhook-event.dto';

export function buildWebhookCanonicalPayload(event: PaymentWebhookEventDto): string {
  return `${event.id}.${event.type}.${event.paymentId}.${event.occurredAt}`;
}

export function signWebhookPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('hex');
}

/** Constant-time comparison — never `===` on a secret-derived value (timing side-channel). */
export function verifyWebhookSignature(
  payload: string,
  providedSignatureHex: string | undefined,
  secret: string,
): boolean {
  if (!providedSignatureHex) return false;

  const expectedHex = signWebhookPayload(payload, secret);
  const expected = Buffer.from(expectedHex, 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(providedSignatureHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}
