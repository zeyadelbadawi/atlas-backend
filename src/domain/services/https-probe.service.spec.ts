import { HttpsProbeService } from './https-probe.service';

jest.mock('node:dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('node:https', () => ({
  request: jest.fn(),
}));

import { lookup } from 'node:dns/promises';
import { request } from 'node:https';

const lookupMock = lookup as jest.MockedFunction<typeof lookup>;
const requestMock = request as jest.MockedFunction<typeof request>;

describe('HttpsProbeService (P63) — never connects to a non-public address', () => {
  beforeEach(() => {
    lookupMock.mockReset();
    requestMock.mockReset();
  });

  it('refuses an IP-literal hostname without resolving or connecting', async () => {
    const service = new HttpsProbeService();
    const result = await service.probe('169.254.169.254');
    expect(result).toMatchObject({ reachable: false, refused: 'ip_literal' });
    expect(lookupMock).not.toHaveBeenCalled();
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('refuses a hostname that resolves (even partly) to a private address — DNS rebinding cannot reach the network', async () => {
    lookupMock.mockResolvedValue([
      { address: '104.21.42.225', family: 4 },
      { address: '10.0.0.7', family: 4 },
    ] as never);
    const service = new HttpsProbeService();
    const result = await service.probe('rebinding.example.com');
    expect(result).toMatchObject({ reachable: false, refused: 'non_public_address' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('refuses an unresolvable hostname', async () => {
    lookupMock.mockRejectedValue(new Error('ENOTFOUND'));
    const service = new HttpsProbeService();
    const result = await service.probe('nope.example.com');
    expect(result).toMatchObject({ reachable: false, refused: 'unresolvable' });
    expect(requestMock).not.toHaveBeenCalled();
  });

  it('connects only through the pinned, vetted address on port 443, honouring both lookup callback shapes', async () => {
    lookupMock.mockResolvedValue([{ address: '104.21.42.225', family: 4 }] as never);
    let capturedOptions: Record<string, unknown> | undefined;
    requestMock.mockImplementation(((
      options: Record<string, unknown>,
      onResponse: (res: { resume: () => void; statusCode?: number }) => void,
    ) => {
      capturedOptions = options;
      const req = {
        on: jest.fn().mockReturnThis(),
        end: jest.fn(() => onResponse({ resume: jest.fn(), statusCode: 200 })),
        destroy: jest.fn(),
      };
      return req;
    }) as never);

    const service = new HttpsProbeService();
    const result = await service.probe('learn.example.com');
    expect(result).toMatchObject({ reachable: true, statusCode: 200 });
    expect(result.failure).toBeUndefined();
    expect(capturedOptions).toMatchObject({
      host: 'learn.example.com',
      servername: 'learn.example.com',
      port: 443,
      path: '/',
    });

    const pinned = capturedOptions!.lookup as (
      host: string,
      options: { all?: boolean },
      callback: jest.Mock,
    ) => void;
    const single = jest.fn();
    pinned('anything.example.com', {}, single);
    expect(single).toHaveBeenCalledWith(null, '104.21.42.225', 4);
    const all = jest.fn();
    pinned('anything.example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '104.21.42.225', family: 4 }]);
  });

  function respondWith(statusCode: number) {
    requestMock.mockImplementation(((
      _options: Record<string, unknown>,
      onResponse: (res: { resume: () => void; statusCode?: number }) => void,
    ) => ({
      on: jest.fn().mockReturnThis(),
      end: jest.fn(() => onResponse({ resume: jest.fn(), statusCode })),
      destroy: jest.fn(),
    })) as never);
  }

  it('P63d — a 5xx from the edge (Cloudflare 525: origin handshake failed) is NOT reachable, and says so', async () => {
    lookupMock.mockResolvedValue([{ address: '104.21.42.225', family: 4 }] as never);
    respondWith(525);
    const service = new HttpsProbeService();
    const result = await service.probe('rawc.example');
    expect(result).toMatchObject({
      reachable: false,
      statusCode: 525,
      failure: 'origin_error',
    });
  });

  it('P63d — any non-5xx answer is reachable: the website (or its edge) answered the visitor', async () => {
    lookupMock.mockResolvedValue([{ address: '104.21.42.225', family: 4 }] as never);
    const service = new HttpsProbeService();
    for (const statusCode of [200, 301, 404]) {
      respondWith(statusCode);
      const result = await service.probe('learn.example.com');
      expect(result).toMatchObject({ reachable: true, statusCode });
      expect(result.failure).toBeUndefined();
    }
  });

  it('P63d — a handshake/connection failure and a timeout are recorded with distinct reasons', async () => {
    lookupMock.mockResolvedValue([{ address: '104.21.42.225', family: 4 }] as never);
    const service = new HttpsProbeService();

    requestMock.mockImplementation((() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      return {
        on: jest.fn((event: string, handler: (arg?: unknown) => void) => {
          handlers[event] = handler;
          return undefined;
        }),
        end: jest.fn(() => handlers.error?.(new Error('handshake failure'))),
        destroy: jest.fn(),
      };
    }) as never);
    await expect(service.probe('learn.example.com')).resolves.toMatchObject({
      reachable: false,
      failure: 'tls_or_connection_failed',
    });

    requestMock.mockImplementation((() => {
      const handlers: Record<string, (arg?: unknown) => void> = {};
      const req: Record<string, unknown> = {};
      req.on = jest.fn((event: string, handler: (arg?: unknown) => void) => {
        handlers[event] = handler;
        return req;
      });
      req.end = jest.fn(() => handlers.timeout?.());
      req.destroy = jest.fn((error?: Error) => handlers.error?.(error));
      return req;
    }) as never);
    await expect(service.probe('learn.example.com')).resolves.toMatchObject({
      reachable: false,
      failure: 'timeout',
    });
  });
});
