import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { API_PERMISSIONS_POLICY, installSecurityHeaders } from './helmet.options';

/** The same wiring `main.ts` performs, on a bare Express app. */
function appWithSecurityHeaders(): express.Express {
  const app = express();
  installSecurityHeaders(app, 'atlas.test', helmet);
  app.get('/probe', (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('installSecurityHeaders', () => {
  // W14 — helmet sets no Permissions-Policy; an API response rendered as a
  // document must still not be able to reach any powerful feature.
  it('denies every powerful browser feature on API responses (Permissions-Policy)', async () => {
    const res = await request(appWithSecurityHeaders()).get('/probe').expect(200);
    const header = res.headers['permissions-policy'];
    expect(header).toBe(API_PERMISSIONS_POLICY);
    for (const feature of [
      'camera',
      'microphone',
      'geolocation',
      'payment',
      'usb',
      'serial',
      'hid',
      'display-capture',
    ]) {
      expect(header).toContain(`${feature}=()`);
    }
    // Every directive is a deny: no allowlist sneaks in.
    for (const directive of header.split(', ')) {
      expect(directive).toMatch(/^[a-z-]+=\(\)$/);
    }
  });

  it('keeps the existing helmet and per-host HSTS headers', async () => {
    const res = await request(appWithSecurityHeaders())
      .get('/probe')
      .set('Host', 'academy.atlas.test')
      .expect(200);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['strict-transport-security']).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });
});
