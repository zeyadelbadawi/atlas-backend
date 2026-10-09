import express from 'express';
import request from 'supertest';
import { collectDeclaredRoutes } from '../testing/route-inventory.fixture-spec';
import {
  DEFAULT_JSON_BODY_LIMIT_BYTES,
  ROUTE_BODY_LIMITS,
  bodyLimitTierFor,
  createJsonBodyParser,
} from './body-limits';

const UPLOAD_LIMIT = 3 * 1024 * 1024;

function appWithParser(): express.Express {
  const app = express();
  app.use(createJsonBodyParser({ uploadLimitBytes: UPLOAD_LIMIT }));
  app.use((req, res) => {
    const raw = (req as { rawBody?: Buffer }).rawBody;
    res.json({ received: JSON.stringify(req.body).length, raw: raw?.length ?? null });
  });
  // body-parser's 413 surfaces as an error with `status`.
  app.use(
    (
      err: { status?: number },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(err.status ?? 500).json({ error: true });
    },
  );
  return app;
}

/** A JSON body of roughly `bytes` bytes. */
function bodyOf(bytes: number): { blob: string } {
  return { blob: 'a'.repeat(bytes) };
}

describe('per-route JSON body limits (W3)', () => {
  it('every larger limit names a route that exists, with its real method', () => {
    const declared = new Set(collectDeclaredRoutes().map((route) => route.key));
    const stale = ROUTE_BODY_LIMITS.map((e) => `${e.method} ${e.path}`).filter(
      (key) => !declared.has(key),
    );
    expect(stale).toEqual([]);
  });

  it('resolves tiers with and without the global /api/v1 prefix', () => {
    expect(bodyLimitTierFor('POST', '/api/v1/academies/abc/media')).toBe('upload');
    expect(bodyLimitTierFor('post', '/academies/abc/media?x=1')).toBe('upload');
    expect(bodyLimitTierFor('PATCH', '/api/v1/courses/c/quizzes/q')).toBe('content');
    expect(bodyLimitTierFor('POST', '/api/v1/webhooks/email/resend')).toBe('webhook');
    // Same path, wrong method / an unlisted route: the 100 KB default.
    expect(bodyLimitTierFor('GET', '/api/v1/academies/abc/media')).toBeNull();
    expect(bodyLimitTierFor('POST', '/api/v1/auth/sign-in')).toBeNull();
    expect(bodyLimitTierFor('POST', '/api/v1/academies/abc/media/extra')).toBeNull();
  });

  it('refuses more than 100 KB on an unlisted route before anything else runs', async () => {
    await request(appWithParser())
      .post('/api/v1/auth/sign-in')
      .send(bodyOf(DEFAULT_JSON_BODY_LIMIT_BYTES + 1024))
      .expect(413);
    await request(appWithParser())
      .post('/api/v1/auth/sign-in')
      .send(bodyOf(50 * 1024))
      .expect(200);
  });

  it('still accepts a large payload on an upload route', async () => {
    const res = await request(appWithParser())
      .post('/api/v1/academies/abc/media')
      .send(bodyOf(2 * 1024 * 1024))
      .expect(200);
    expect(res.body.received).toBeGreaterThan(2 * 1024 * 1024);
    await request(appWithParser())
      .post('/api/v1/academies/abc/media')
      .send(bodyOf(UPLOAD_LIMIT + 1024))
      .expect(413);
  });

  it('keeps the raw bytes for signed webhooks only', async () => {
    const hook = await request(appWithParser())
      .post('/api/v1/webhooks/email/resend')
      .send({ a: 1 })
      .expect(200);
    expect(hook.body.raw).toBe(JSON.stringify({ a: 1 }).length);
    const plain = await request(appWithParser())
      .post('/api/v1/auth/sign-in')
      .send({ a: 1 })
      .expect(200);
    expect(plain.body.raw).toBeNull();
  });

  it('is named jsonParser so Nest does not stack its own default parser on top', () => {
    expect(createJsonBodyParser({ uploadLimitBytes: UPLOAD_LIMIT }).name).toBe(
      'jsonParser',
    );
  });
});
