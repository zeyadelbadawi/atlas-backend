import { generateKeyPairSync } from 'node:crypto';
import { FcmPushProvider } from './fcm-push.provider';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const message = {
  token: 'device-token-1234567890',
  title: 'Ziadd',
  body: 'You have a new announcement.',
  data: { kind: 'notification', path: '/my/notifications' },
};

function fakeFetch(
  sendStatus: number,
  sendBody: unknown = { name: 'projects/p/messages/1' },
) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return new Response(JSON.stringify({ access_token: 'at-1', expires_in: 3600 }), {
        status: 200,
      });
    }
    return new Response(
      typeof sendBody === 'string' ? sendBody : JSON.stringify(sendBody),
      { status: sendStatus },
    );
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const provider = (impl: typeof fetch) =>
  new FcmPushProvider(
    // As it arrives from an env file: newlines escaped.
    {
      projectId: 'atlas-test',
      clientEmail: 'push@atlas-test.iam.gserviceaccount.com',
      privateKey: pem.replace(/\n/g, '\\n'),
    },
    impl,
  );

describe('FcmPushProvider', () => {
  it('exchanges a signed JWT once, then sends the v1 message', async () => {
    const { impl, calls } = fakeFetch(200);
    const fcm = provider(impl);
    await expect(fcm.send(message)).resolves.toEqual({
      ok: true,
      providerMessageId: 'projects/p/messages/1',
    });
    await fcm.send(message);

    const tokenCalls = calls.filter((c) => c.url.includes('oauth2'));
    expect(tokenCalls).toHaveLength(1);
    const assertion = new URLSearchParams(String(tokenCalls[0].init.body)).get(
      'assertion',
    )!;
    const claims = JSON.parse(
      Buffer.from(assertion.split('.')[1], 'base64url').toString(),
    );
    expect(claims).toMatchObject({
      iss: 'push@atlas-test.iam.gserviceaccount.com',
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
    });

    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(send.url).toBe(
      'https://fcm.googleapis.com/v1/projects/atlas-test/messages:send',
    );
    expect((send.init.headers as Record<string, string>).Authorization).toBe(
      'Bearer at-1',
    );
    const body = JSON.parse(String(send.init.body));
    expect(body.message).toMatchObject({
      token: message.token,
      notification: { title: 'Ziadd', body: message.body },
      data: message.data,
      android: { priority: 'high' },
    });
  });

  it('reports a dead token on 404 UNREGISTERED', async () => {
    const { impl } = fakeFetch(404, {
      error: { status: 'NOT_FOUND', details: [{ errorCode: 'UNREGISTERED' }] },
    });
    await expect(provider(impl).send(message)).resolves.toEqual({
      ok: false,
      reason: 'invalid_token',
    });
  });

  it('a bare 404 (wrong project) is rejected, never a dead token', async () => {
    const { impl } = fakeFetch(404, {
      error: {
        code: 404,
        status: 'NOT_FOUND',
        message: 'Requested entity was not found.',
      },
    });
    await expect(provider(impl).send(message)).resolves.toMatchObject({
      ok: false,
      reason: 'rejected',
    });
  });

  it('treats 5xx and 429 as transient, other 4xx as rejected', async () => {
    await expect(
      provider(fakeFetch(503, 'down').impl).send(message),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'transient',
    });
    await expect(
      provider(fakeFetch(429, 'slow').impl).send(message),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'transient',
    });
    await expect(
      provider(fakeFetch(403, 'no permission').impl).send(message),
    ).resolves.toMatchObject({
      ok: false,
      reason: 'rejected',
    });
  });

  it('a network failure is transient, never thrown', async () => {
    const impl = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    await expect(provider(impl).send(message)).resolves.toMatchObject({
      ok: false,
      reason: 'transient',
    });
  });
});
