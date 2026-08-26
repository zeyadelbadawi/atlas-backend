import {
  buildWebhookCanonicalPayload,
  signWebhookPayload,
  verifyWebhookSignature,
} from './webhook-signature.util';
import type { PaymentWebhookEventDto } from '../dto/payment-webhook-event.dto';

const SECRET = 'test-webhook-secret-at-least-32-chars-long';

const EVENT: PaymentWebhookEventDto = {
  id: 'evt-1',
  type: 'payment.succeeded',
  paymentId: 'pay-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
};

describe('webhook signature verification', () => {
  it('buildWebhookCanonicalPayload is a stable, explicit string — never JSON.stringify', () => {
    expect(buildWebhookCanonicalPayload(EVENT)).toBe(
      'evt-1.payment.succeeded.pay-1.2026-01-01T00:00:00.000Z',
    );
  });

  it('a correctly signed payload verifies successfully', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    const signature = signWebhookPayload(payload, SECRET);
    expect(verifyWebhookSignature(payload, signature, SECRET)).toBe(true);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    const signature = signWebhookPayload(payload, 'a-completely-different-secret-value');
    expect(verifyWebhookSignature(payload, signature, SECRET)).toBe(false);
  });

  it('rejects a signature computed over a tampered payload (event id changed after signing)', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    const signature = signWebhookPayload(payload, SECRET);
    const tamperedPayload = buildWebhookCanonicalPayload({ ...EVENT, id: 'evt-2' });
    expect(verifyWebhookSignature(tamperedPayload, signature, SECRET)).toBe(false);
  });

  it('rejects a missing signature', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    expect(verifyWebhookSignature(payload, undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed (non-hex) signature without throwing', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    expect(() => verifyWebhookSignature(payload, 'not-hex-!!!', SECRET)).not.toThrow();
    expect(verifyWebhookSignature(payload, 'not-hex-!!!', SECRET)).toBe(false);
  });

  it('rejects a signature of the wrong length (never throws on the timing-safe comparison)', () => {
    const payload = buildWebhookCanonicalPayload(EVENT);
    expect(verifyWebhookSignature(payload, 'ab', SECRET)).toBe(false);
  });
});
