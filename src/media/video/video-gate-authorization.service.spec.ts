/**
 * Workstream D — the parts of the delivery gate's re-authorization that
 * need no database: the Worker's HMAC, and every refusal decided from the
 * signed token alone (which must happen BEFORE any read, so a forged or
 * re-scoped token never reaches RLS-scoped queries). The database half is
 * exercised against real Postgres in `test/video-gate-authorization.e2e-spec.ts`.
 */
import { createHmac } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { BasicVideoProvider } from './basic-video.provider';
import {
  GATE_AUTHZ_MAX_CACHE_SECONDS,
  VideoGateAuthorizationService,
} from './video-gate-authorization.service';
import type { BasicVideoConfig } from '../../config/configuration';
import type { ProtectedMediaStorage } from '../storage/protected-media-storage.provider';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { LearningMetricsService } from '../../observability/metrics/learning-metrics.service';

const AUTHZ_SECRET = 'unit-test-gate-authz-secret-0123456789abcdef';
const CONFIG: BasicVideoConfig = {
  deliveryHost: 'video.atlas.test',
  signingSecret: 'unit-test-gate-signing-secret',
  playbackTtlSeconds: 600,
  allowedOriginsConfigured: false,
  gateAuthzSecret: AUTHZ_SECRET,
};
const KEY = 'academies/a1/courses/c1/asset-1.mp4';

function build(overrides: Partial<BasicVideoConfig> = {}) {
  const config = { ...CONFIG, ...overrides };
  const configService = { getOrThrow: () => config } as unknown as ConfigService;
  const gate = new BasicVideoProvider(configService, {} as ProtectedMediaStorage);
  const contextCalls: string[] = [];
  // Any database read from these tests is a bug: every refusal below must
  // be decided from the signed token alone.
  const tenancy = {
    runInUserContext: (userId: string) => {
      contextCalls.push(userId);
      return Promise.reject(new Error('no database in this test'));
    },
    runWithoutContext: () => {
      contextCalls.push('none');
      return Promise.reject(new Error('no database in this test'));
    },
  } as unknown as TenancyContextService;
  const decisions: string[] = [];
  const metrics = {
    recordGateAuthorization: (decision: string) => decisions.push(decision),
  } as unknown as LearningMetricsService;
  const service = new VideoGateAuthorizationService(
    configService,
    gate,
    tenancy,
    metrics,
  );
  return { service, gate, contextCalls, decisions };
}

async function token(
  gate: BasicVideoProvider,
  scope: { academyId: string; courseId: string; lessonId: string } | null = {
    academyId: 'a1',
    courseId: 'c1',
    lessonId: 'l1',
  },
  providerId = KEY,
): Promise<string> {
  const descriptor = await gate.issuePlaybackToken({
    providerId,
    expiresAt: new Date(Date.now() + 600_000),
    binding: { userId: 'u1', sessionId: 's1', deviceId: 'd1' },
    ...(scope ? { scope } : {}),
    allowedOrigins: [],
  });
  return descriptor.token!;
}

function sign(timestamp: string, body: string, secret = AUTHZ_SECRET): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
}

describe('VideoGateAuthorizationService — caller authentication', () => {
  const body = JSON.stringify({ token: 't', objectKey: KEY });
  const now = 1_800_000_000_000;
  const ts = String(now / 1000);

  it('accepts a fresh call signed with the shared secret', () => {
    expect(build().service.verifyCaller(ts, sign(ts, body), body, now)).toBe(true);
  });

  it('refuses a wrong secret, a tampered body, a stale or future timestamp, and malformed headers', () => {
    const { service } = build();
    expect(service.verifyCaller(ts, sign(ts, body, 'x'.repeat(40)), body, now)).toBe(
      false,
    );
    expect(service.verifyCaller(ts, sign(ts, body), `${body} `, now)).toBe(false);
    const stale = String(now / 1000 - 61);
    expect(service.verifyCaller(stale, sign(stale, body), body, now)).toBe(false);
    const future = String(now / 1000 + 61);
    expect(service.verifyCaller(future, sign(future, body), body, now)).toBe(false);
    expect(service.verifyCaller(undefined, sign(ts, body), body, now)).toBe(false);
    expect(service.verifyCaller(ts, undefined, body, now)).toBe(false);
    expect(service.verifyCaller(ts, 'ABC', body, now)).toBe(false);
    expect(service.verifyCaller(ts, sign(ts, body).toUpperCase(), body, now)).toBe(false);
  });

  it('is disabled — and refuses every caller — without the authorization secret', () => {
    const { service } = build({ gateAuthzSecret: undefined });
    expect(service.isEnabled).toBe(false);
    expect(service.verifyCaller(ts, sign(ts, body), body, now)).toBe(false);
  });
});

describe('VideoGateAuthorizationService — refusals decided from the token alone', () => {
  it('refuses a forged, tampered or expired token', async () => {
    const { service, gate, contextCalls, decisions } = build();
    const good = await token(gate);
    const [payload, sig] = good.split('.');
    const forged = `${Buffer.from(
      JSON.stringify({
        k: KEY,
        e: 9_999_999_999,
        u: 'u1',
        s: 's1',
        d: 'd1',
        a: 'a1',
        c: 'c1',
        l: 'l1',
      }),
    ).toString('base64url')}.${sig}`;
    expect(await service.authorize(forged, KEY)).toMatchObject({
      allow: false,
      reason: 'invalid_token',
    });
    expect(await service.authorize(`${payload}.${'0'.repeat(64)}`, KEY)).toMatchObject({
      allow: false,
      reason: 'invalid_token',
    });
    const later = new Date(Date.now() + 2 * 60 * 60 * 1000);
    expect(await service.authorize(good, KEY, later)).toMatchObject({
      allow: false,
      reason: 'invalid_token',
    });
    expect(contextCalls).toEqual([]);
    expect(decisions).toEqual(['invalid_token', 'invalid_token', 'invalid_token']);
  });

  it('refuses a token presented for a different object', async () => {
    const { service, gate, contextCalls } = build();
    const other = 'academies/a1/courses/c1/asset-2.mp4';
    expect(await service.authorize(await token(gate), other)).toMatchObject({
      allow: false,
      reason: 'key_mismatch',
    });
    expect(contextCalls).toEqual([]);
  });

  it('refuses a token minted without a grant scope', async () => {
    const { service, gate } = build();
    expect(await service.authorize(await token(gate, null), KEY)).toMatchObject({
      allow: false,
      reason: 'unscoped_token',
      ttlSeconds: GATE_AUTHZ_MAX_CACHE_SECONDS,
    });
  });

  it('refuses a scope that disagrees with the object key: another academy, another course', async () => {
    const { service, gate, contextCalls } = build();
    const otherAcademy = await token(gate, {
      academyId: 'a2',
      courseId: 'c1',
      lessonId: 'l1',
    });
    expect(await service.authorize(otherAcademy, KEY)).toMatchObject({
      allow: false,
      reason: 'academy_mismatch',
    });
    const otherCourse = await token(gate, {
      academyId: 'a1',
      courseId: 'c2',
      lessonId: 'l1',
    });
    expect(await service.authorize(otherCourse, KEY)).toMatchObject({
      allow: false,
      reason: 'course_mismatch',
    });
    expect(contextCalls).toEqual([]);
  });

  it('reaches the database — in the token user’s own context — only for a well-formed, in-scope token', async () => {
    const { service, gate, contextCalls } = build();
    await expect(service.authorize(await token(gate), KEY)).rejects.toThrow(
      'no database in this test',
    );
    expect(contextCalls).toEqual(['u1']);
  });
});
