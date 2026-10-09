import express from 'express';
import request from 'supertest';
import { trustedRequestHost } from './google-auth.controller';

/**
 * W7 — the Google flow's return origin is built from the same trusted host
 * Express derives `request.hostname` from (the host allowlist is decided
 * on `hostname`), never from the raw `Host` header on its own.
 */
function probeApp(trustProxy: string | false): express.Express {
  const app = express();
  app.set('trust proxy', trustProxy);
  app.get('/probe', (req, res) => {
    res.json({ host: trustedRequestHost(req) ?? null, hostname: req.hostname });
  });
  return app;
}

describe('trustedRequestHost (W7)', () => {
  it('uses X-Forwarded-Host from a trusted proxy, exactly as request.hostname does', async () => {
    const res = await request(probeApp('loopback'))
      .get('/probe')
      .set('Host', 'internal-upstream:3000')
      .set('X-Forwarded-Host', 'academy.atlas.test');
    // The raw Host header ("internal-upstream:3000") is what the origin
    // used to be built from, while the allowlist checked "academy.atlas.test".
    expect(res.body).toEqual({
      host: 'academy.atlas.test',
      hostname: 'academy.atlas.test',
    });
  });

  it('ignores X-Forwarded-Host from an untrusted peer and keeps the port of Host', async () => {
    const res = await request(probeApp(false))
      .get('/probe')
      .set('Host', 'localhost:3001')
      .set('X-Forwarded-Host', 'evil.example');
    expect(res.body).toEqual({ host: 'localhost:3001', hostname: 'localhost' });
  });

  it('takes the first X-Forwarded-Host entry and supports IPv6 literals', async () => {
    const first = await request(probeApp('loopback'))
      .get('/probe')
      .set('X-Forwarded-Host', 'a.atlas.test:8443, b.atlas.test');
    expect(first.body).toEqual({ host: 'a.atlas.test:8443', hostname: 'a.atlas.test' });

    const v6 = await request(probeApp(false)).get('/probe').set('Host', '[::1]:3000');
    expect(v6.body).toEqual({ host: '[::1]:3000', hostname: '[::1]' });
  });
});
