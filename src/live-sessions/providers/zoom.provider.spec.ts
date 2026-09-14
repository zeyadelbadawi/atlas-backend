/**
 * ZoomProvider — signature verification and the SDK join signature.
 *
 * These are the two places this adapter is a SECURITY boundary rather than
 * an HTTP client, so they are the two tested here. Everything else in the
 * adapter is network I/O against a provider that is not available in this
 * environment, and pretending otherwise with a stubbed `fetch` would prove
 * nothing about whether Zoom accepts the calls.
 */
import { createHmac } from 'node:crypto';
import { ZoomProvider } from './zoom.provider';
import type { LiveProviderCredentials } from './live-provider.interface';

const SECRET = 'webhook-secret-token';

const credentials = (
  over: Partial<LiveProviderCredentials> = {},
): LiveProviderCredentials => ({
  accountId: 'acc',
  clientId: 'cid',
  clientSecret: 'csecret',
  sdkKey: 'sdk-key',
  sdkSecret: 'sdk-secret',
  webhookSecretToken: SECRET,
  ...over,
});

/** Builds the signature Zoom itself would send for a body. */
function sign(rawBody: string, timestamp: string, secret = SECRET): string {
  return (
    'v0=' +
    createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')
  );
}

describe('ZoomProvider.verifyWebhookSignature', () => {
  const provider = new ZoomProvider();
  const rawBody = '{"event":"meeting.started","payload":{"object":{"id":"1"}}}';
  const timestamp = '1789000000';

  it('accepts a genuine signature', () => {
    const ok = provider.verifyWebhookSignature(credentials(), {
      rawBody,
      timestamp,
      signature: sign(rawBody, timestamp),
    });
    expect(ok).toBe(true);
  });

  /* FORGERY. The attacker does not hold the secret. */
  it('REJECTS a forged signature', () => {
    const ok = provider.verifyWebhookSignature(credentials(), {
      rawBody,
      timestamp,
      signature: 'v0=' + 'a'.repeat(64),
    });
    expect(ok).toBe(false);
  });

  /* TAMPERING. A body changed in flight no longer matches its signature. */
  it('REJECTS a body modified after signing', () => {
    const signature = sign(rawBody, timestamp);
    const tampered = rawBody.replace('"id":"1"', '"id":"999"');
    const ok = provider.verifyWebhookSignature(credentials(), {
      rawBody: tampered,
      timestamp,
      signature,
    });
    expect(ok).toBe(false);
  });

  /* REPLAY ACROSS TIME. The timestamp is part of the signed material. */
  it('REJECTS a signature replayed with a different timestamp', () => {
    const ok = provider.verifyWebhookSignature(credentials(), {
      rawBody,
      timestamp: '1789999999',
      signature: sign(rawBody, timestamp),
    });
    expect(ok).toBe(false);
  });

  /* CROSS-TENANT. Signed with academy A's secret, checked with B's. */
  it("REJECTS a signature made with a DIFFERENT academy's secret", () => {
    const ok = provider.verifyWebhookSignature(credentials(), {
      rawBody,
      timestamp,
      signature: sign(rawBody, timestamp, 'another-academys-secret'),
    });
    expect(ok).toBe(false);
  });

  it('REJECTS when no webhook secret is configured, rather than accepting', () => {
    const ok = provider.verifyWebhookSignature(
      credentials({ webhookSecretToken: undefined }),
      { rawBody, timestamp, signature: sign(rawBody, timestamp) },
    );
    expect(ok).toBe(false);
  });

  /* `timingSafeEqual` throws on unequal lengths; a short signature must be a clean false. */
  it('handles a malformed short signature without throwing', () => {
    expect(() =>
      provider.verifyWebhookSignature(credentials(), {
        rawBody,
        timestamp,
        signature: 'v0=short',
      }),
    ).not.toThrow();
  });
});

describe('ZoomProvider.createJoinSignature', () => {
  const provider = new ZoomProvider();

  it('binds the signature to the meeting, the role and the Atlas identity', async () => {
    const result = await provider.createJoinSignature(credentials(), {
      providerMeetingId: '87654321',
      role: 'attendee',
      participantKey: 'atlas_abc123',
    });

    const [, payload] = result.signature.split('.');
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString());

    expect(decoded.mn).toBe('87654321');
    // 0 = attendee. The role is SIGNED, so a student cannot promote
    // themselves to host by editing a client payload.
    expect(decoded.role).toBe(0);
    // The Atlas identity Zoom echoes back on webhooks — the only identity
    // bridge attendance uses.
    expect(decoded.customer_key).toBe('atlas_abc123');
    expect(result.sdkKey).toBe('sdk-key');
  });

  it('signs a host with the host role', async () => {
    const result = await provider.createJoinSignature(credentials(), {
      providerMeetingId: '1',
      role: 'host',
      participantKey: 'atlas_host',
    });
    const decoded = JSON.parse(
      Buffer.from(result.signature.split('.')[1], 'base64url').toString(),
    );
    expect(decoded.role).toBe(1);
  });

  it('NEVER puts the SDK secret in the signature', async () => {
    const result = await provider.createJoinSignature(credentials(), {
      providerMeetingId: '1',
      role: 'attendee',
      participantKey: 'atlas_abc',
    });
    // The secret signs; it is never transported.
    expect(result.signature).not.toContain('sdk-secret');
    expect(JSON.stringify(result)).not.toContain('sdk-secret');
  });

  it('expires — a signature is not a durable key to the room', async () => {
    const result = await provider.createJoinSignature(credentials(), {
      providerMeetingId: '1',
      role: 'attendee',
      participantKey: 'atlas_abc',
    });
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + 60 * 60 * 1000);
  });

  it('refuses when the academy has no Meeting SDK credentials', async () => {
    await expect(
      provider.createJoinSignature(
        credentials({ sdkKey: undefined, sdkSecret: undefined }),
        {
          providerMeetingId: '1',
          role: 'attendee',
          participantKey: 'atlas_abc',
        },
      ),
    ).rejects.toThrow();
  });
});
