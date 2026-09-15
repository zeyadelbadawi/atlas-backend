/**
 * The deauthorization endpoint's refusal surface.
 *
 * WHAT THIS FILE IS ABOUT: nothing signed by anyone other than Zoom, and
 * nothing naming an application other than Atlas's, may reach the code
 * that clears a customer's authorization. Every test here calls the
 * controller the way curl would — the real HMAC, the real extractor, the
 * real replay window; only the service beneath is a spy, so that "did it
 * mutate?" is answerable.
 *
 * The refusals are deliberately indistinguishable from each other. A
 * caller must not be able to tell a forged signature from a stale
 * timestamp from an account Atlas has never seen.
 */
import { Test } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { createHmac } from 'node:crypto';
import type { Request } from 'express';
import { LiveProviderDeauthorizationController } from './live-provider-deauthorization.controller';
import { LiveProviderDeauthorizationService } from '../services/live-provider-deauthorization.service';
import { ZoomProvider } from '../providers/zoom.provider';

const SECRET = 'test-webhook-secret-token';
const CLIENT_ID = 'atlas-zoom-client-id';
const ACCOUNT_ID = 'zoom-account-abc';

describe('LiveProviderDeauthorizationController', () => {
  let controller: LiveProviderDeauthorizationController;
  let handle: jest.Mock;

  beforeEach(async () => {
    handle = jest.fn().mockResolvedValue('invalidated');

    const moduleRef = await Test.createTestingModule({
      controllers: [LiveProviderDeauthorizationController],
      providers: [
        {
          provide: ConfigService,
          useValue: {
            get: () => ({ webhookSecretToken: SECRET, clientId: CLIENT_ID }),
          },
        },
        // The REAL provider — the signature check is the thing under test,
        // so stubbing it would test nothing.
        ZoomProvider,
        {
          provide: LiveProviderDeauthorizationService,
          useValue: { handle },
        },
      ],
    })
      .overrideProvider(ZoomProvider)
      .useValue(new ZoomProvider())
      .compile();

    controller = moduleRef.get(LiveProviderDeauthorizationController);
  });

  const validBody = (over: Record<string, unknown> = {}) => ({
    event: 'app_deauthorized',
    event_ts: Date.now(),
    payload: {
      account_id: ACCOUNT_ID,
      user_id: 'zoom-user-1',
      client_id: CLIENT_ID,
      deauthorization_time: '2026-09-15T10:00:00.000Z',
      signature: 'zoom-legacy-per-payload-signature',
      ...over,
    },
  });

  /** Exactly how Zoom signs: v0=HMAC_SHA256(secret, "v0:"+ts+":"+rawBody). */
  const sign = (rawBody: string, timestamp: string) =>
    'v0=' +
    createHmac('sha256', SECRET).update(`v0:${timestamp}:${rawBody}`).digest('hex');

  const call = (
    body: unknown,
    opts: {
      signature?: string;
      timestamp?: string;
      rawBody?: string | null;
    } = {},
  ) => {
    const rawBody =
      opts.rawBody === null ? undefined : (opts.rawBody ?? JSON.stringify(body));
    const timestamp = opts.timestamp ?? String(Math.floor(Date.now() / 1000));
    const signature = opts.signature ?? (rawBody ? sign(rawBody, timestamp) : 'v0=x');
    const request = {
      rawBody: rawBody === undefined ? undefined : Buffer.from(rawBody, 'utf8'),
    } as unknown as Request & { rawBody?: Buffer };
    return controller.handle(request, body, signature, timestamp);
  };

  describe('accepts a genuine notification', () => {
    it('verifies and forwards a correctly signed deauthorization', async () => {
      const body = validBody();
      await expect(call(body)).resolves.toEqual({ received: true });

      expect(handle).toHaveBeenCalledTimes(1);
      expect(handle).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: ACCOUNT_ID,
          clientId: CLIENT_ID,
          zoomUserId: 'zoom-user-1',
          deauthorizedAt: new Date('2026-09-15T10:00:00.000Z'),
        }),
      );
    });

    /*
      THE RESPONSE IS A CONSTANT. Whatever the service concluded, the body
      is identical — otherwise the endpoint becomes an oracle for which
      Zoom accounts have Atlas installed.
    */
    it.each(['invalidated', 'already_invalidated', 'unknown_account', 'stale_ignored'])(
      'returns an identical body when the outcome is %s',
      async (outcome) => {
        handle.mockResolvedValue(outcome);
        await expect(call(validBody())).resolves.toEqual({ received: true });
      },
    );
  });

  describe('refuses anything unverified', () => {
    it('REJECTS a forged signature without touching the service', async () => {
      await expect(
        call(validBody(), { signature: 'v0=' + 'a'.repeat(64) }),
      ).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    it('REJECTS a signature computed with the wrong secret', async () => {
      const body = validBody();
      const rawBody = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      const wrong =
        'v0=' +
        createHmac('sha256', 'not-the-real-secret')
          .update(`v0:${timestamp}:${rawBody}`)
          .digest('hex');

      await expect(call(body, { signature: wrong, timestamp })).rejects.toMatchObject({
        status: 401,
      });
      expect(handle).not.toHaveBeenCalled();
    });

    /*
      REPLAY. A signature captured once must not stay valid forever — the
      timestamp is inside the signed string, so an attacker cannot move it
      without invalidating the signature, and the window bounds how long
      the original stays usable.
    */
    it('REJECTS a replayed request outside the timestamp window', async () => {
      const body = validBody();
      const rawBody = JSON.stringify(body);
      const stale = String(Math.floor(Date.now() / 1000) - 10 * 60);

      await expect(
        call(body, { timestamp: stale, signature: sign(rawBody, stale) }),
      ).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    it('REJECTS a far-future timestamp', async () => {
      const body = validBody();
      const rawBody = JSON.stringify(body);
      const future = String(Math.floor(Date.now() / 1000) + 10 * 60);

      await expect(
        call(body, { timestamp: future, signature: sign(rawBody, future) }),
      ).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    it.each([
      ['no signature header', { signature: '' }],
      ['no timestamp header', { timestamp: '' }],
      ['a non-numeric timestamp', { timestamp: 'not-a-number' }],
    ])('REJECTS a request with %s', async (_label, opts) => {
      await expect(call(validBody(), opts)).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    /*
      TAMPERING. The body is signed, so changing one byte after signing
      must invalidate it — this is what stops an attacker swapping in a
      different victim's account_id.
    */
    it('REJECTS a body altered after signing', async () => {
      const original = validBody();
      const timestamp = String(Math.floor(Date.now() / 1000));
      const signature = sign(JSON.stringify(original), timestamp);
      const tampered = validBody({ account_id: 'some-other-victim-account' });

      await expect(
        call(tampered, { signature, timestamp, rawBody: JSON.stringify(tampered) }),
      ).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    /* Without the raw bytes nothing is verifiable. Fail closed. */
    it('REFUSES when the raw body was not captured', async () => {
      await expect(call(validBody(), { rawBody: null })).rejects.toMatchObject({
        status: 400,
      });
      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('refuses anything not addressed to this Atlas app', () => {
    /*
      A correctly signed notification naming another application is not
      ours to act on. Without this check, anyone holding the Secret Token
      of a different integration could clear an Atlas connection.
    */
    it('REJECTS a valid signature naming a different client_id', async () => {
      await expect(
        call(validBody({ client_id: 'some-other-zoom-app' })),
      ).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('refuses malformed payloads', () => {
    it.each([
      ['a different event type', { event: 'meeting.started' }],
      ['no event at all', { event: undefined }],
    ])('REJECTS %s', async (_label, over) => {
      const body = { ...validBody(), ...over };
      await expect(call(body)).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    it.each([
      ['no account_id', { account_id: undefined }],
      ['no client_id', { client_id: undefined }],
      ['no deauthorization_time', { deauthorization_time: undefined }],
      ['an unparseable deauthorization_time', { deauthorization_time: 'not-a-date' }],
    ])('REJECTS a payload with %s', async (_label, over) => {
      await expect(call(validBody(over))).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });

    it('REJECTS a payload that is not an object', async () => {
      await expect(call('just a string')).rejects.toMatchObject({ status: 401 });
      expect(handle).not.toHaveBeenCalled();
    });
  });

  /*
    NO SECRET, NO TOKEN, NO RAW PAYLOAD comes back out — the response is a
    fixed acknowledgement and nothing else.
  */
  it('never returns anything beyond a bare acknowledgement', async () => {
    const result = await call(validBody());
    expect(Object.keys(result)).toEqual(['received']);
    expect(JSON.stringify(result)).not.toMatch(
      new RegExp(`${SECRET}|${ACCOUNT_ID}|${CLIENT_ID}|token|secret`, 'i'),
    );
  });
});
