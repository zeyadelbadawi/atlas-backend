/**
 * P63g — the adapter's safety rules, against a mocked `fetch` with real
 * Cloudflare envelope shapes. No network.
 */
import {
  CloudflareApiProvider,
  classifyCloudflareError,
  isDuplicateHostnameError,
} from './cloudflare-api.provider';
import { CloudflareProviderError } from './cloudflare-provider.interface';

type Reply = { status?: number; json?: unknown; text?: string; throws?: Error };

function build(replies: Reply[]) {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchMock = jest.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const reply = replies.shift();
    if (!reply) throw new Error('unexpected fetch');
    if (reply.throws) throw reply.throws;
    return {
      status: reply.status ?? 200,
      json: async () => {
        if (reply.text !== undefined) throw new SyntaxError('not json');
        return reply.json;
      },
    } as unknown as Response;
  });
  global.fetch = fetchMock as never;
  const provider = new CloudflareApiProvider({
    get: () => ({ apiToken: 'tok', zoneId: 'a'.repeat(32) }),
  } as never);
  return { provider, calls };
}

const raw = (hostname: string, id = 'cfh_1') => ({
  id,
  hostname,
  status: 'pending',
  ssl: { status: 'pending_validation', method: 'http' },
});

describe('CloudflareApiProvider (P63g)', () => {
  afterEach(() => {
    // @ts-expect-error restore
    delete global.fetch;
  });

  it('asks for HTTP validation, and adopts an existing resource ONLY on a duplicate refusal', async () => {
    const { provider, calls } = build([
      {
        json: {
          success: false,
          errors: [{ code: 1406, message: 'Duplicate custom hostname found.' }],
          result: null,
        },
      },
      {
        json: {
          success: true,
          errors: [],
          result: [raw('learn.example.com', 'cfh_existing')],
        },
      },
    ]);
    const resource = await provider.createCustomHostname('learn.example.com');
    expect(calls[0].body).toEqual({
      hostname: 'learn.example.com',
      ssl: { method: 'http', type: 'dv' },
    });
    expect(resource.id).toBe('cfh_existing');
  });

  it('does NOT adopt on a permission error — it is reported as a refusal', async () => {
    const { provider, calls } = build([
      {
        json: {
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          result: null,
        },
      },
    ]);
    await expect(
      provider.createCustomHostname('learn.example.com'),
    ).rejects.toBeInstanceOf(CloudflareProviderError);
    expect(calls).toHaveLength(1); // no lookup, no adoption
  });

  it('never adopts a resource whose hostname differs from the one asked for', async () => {
    const { provider } = build([
      {
        json: {
          success: false,
          errors: [{ code: 1406, message: 'duplicate' }],
          result: null,
        },
      },
      {
        json: {
          success: true,
          errors: [],
          result: [raw('other.example.com', 'cfh_other')],
        },
      },
    ]);
    await expect(
      provider.createCustomHostname('learn.example.com'),
    ).rejects.toBeInstanceOf(CloudflareProviderError);
  });

  it('lookup by hostname returns only the exact match, never result[0]', async () => {
    const { provider } = build([
      {
        json: {
          success: true,
          errors: [],
          result: [raw('learn.example.com.evil', 'x'), raw('LEARN.example.com', 'y')],
        },
      },
    ]);
    const found = await provider.getCustomHostnameByHostname('learn.example.com');
    expect(found?.id).toBe('y');
  });

  it('a transport failure on lookup by id THROWS instead of answering "not found"', async () => {
    const { provider } = build([
      { throws: new Error('ECONNRESET') },
      { throws: new Error('ECONNRESET') },
    ]);
    await expect(provider.getCustomHostnameById('cfh_1')).rejects.toThrow();
  });

  it('a positive 404 on lookup by id is null (the provider says it is gone)', async () => {
    const { provider } = build([
      {
        status: 404,
        json: {
          success: false,
          errors: [{ code: 1436, message: 'Custom hostname not found' }],
          result: null,
        },
      },
    ]);
    await expect(provider.getCustomHostnameById('cfh_1')).resolves.toBeNull();
  });

  it('delete reports deleted / not_found / failed instead of being fire-and-forget', async () => {
    const { provider } = build([
      { json: { success: true, errors: [], result: { id: 'cfh_1' } } },
      {
        status: 404,
        json: {
          success: false,
          errors: [{ code: 1436, message: 'not found' }],
          result: null,
        },
      },
      {
        json: {
          success: false,
          errors: [{ code: 10000, message: 'Authentication error' }],
          result: null,
        },
      },
    ]);
    await expect(provider.deleteCustomHostname('a')).resolves.toBe('deleted');
    await expect(provider.deleteCustomHostname('b')).resolves.toBe('not_found');
    await expect(provider.deleteCustomHostname('c')).resolves.toBe('failed');
  });

  it('retries once on a 5xx and on a non-JSON edge error page treats the request as failed', async () => {
    const { provider, calls } = build([
      { status: 502, json: { success: false, errors: [], result: null } },
      { json: { success: true, errors: [], result: { status: 'active' } } },
    ]);
    await expect(provider.verifyToken()).resolves.toBe(true);
    expect(calls).toHaveLength(2);

    const second = build([{ status: 520, text: '<html>error</html>' }]);
    await expect(second.provider.verifyToken()).resolves.toBe(false);
  });

  it('classifies by the error that decided the category, and recognises duplicates', () => {
    expect(
      classifyCloudflareError([
        { code: 1000, message: 'generic' },
        { code: 9109, message: 'Invalid access token' },
      ]),
    ).toEqual({ code: 9109, category: 'permission' });
    expect(isDuplicateHostnameError([{ code: 1406, message: 'x' }])).toBe(true);
    expect(
      isDuplicateHostnameError([{ code: 1400, message: 'Hostname already exists' }]),
    ).toBe(true);
    expect(
      isDuplicateHostnameError([{ code: 10000, message: 'Authentication error' }]),
    ).toBe(false);
  });
});
