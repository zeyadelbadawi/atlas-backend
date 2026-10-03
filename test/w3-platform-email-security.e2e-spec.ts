/**
 * W3 (Atlas Large-Scale Initiative) — Platform Owner email & security
 * monitoring, the email-safe academy logo, and authentication-secret
 * hygiene, end to end against real Postgres (FORCE RLS as `atlas_app`),
 * real Redis and the real S3-compatible store.
 *
 *   W3-LOGO-*  `GET public/websites/:academyId/logo` — PNG only, versioned
 *              immutable cache, CORP cross-origin, 404 for unknown /
 *              archived / unusable, no tenant data in any response; the
 *              email branding links it on the platform host.
 *   W3-ACT-*   `GET platform-communications/email-activity[/summary]` —
 *              Platform Owner only, masked recipients, closed error
 *              categories, never `values`, keyset pagination, filters.
 *   W3-SEC-*   `GET platform-security/{summary,events}` — Platform Owner
 *              only; OTP instrumentation writes hashed, code-free events.
 *   W3-RET-*   retention: OTP/deletion challenges (24 h), security events
 *              (90 d), and the outbox prune's leftover-code safety net.
 *
 * The communications processor and scheduler are inert so the background
 * worker never races these assertions (the `p64-comm-outbox` precedent).
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { CommunicationBrandingService } from '../src/communications/services/communication-branding.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import {
  MEDIA_STORAGE_PROVIDER,
  type MediaStorageProvider,
} from '../src/media/storage/media-storage.interface';
import { emailLogoVersion } from '../src/communications/utils/email-logo.util';
import { SecurityEventsService } from '../src/security-events/services/security-events.service';
import { SecurityMaintenanceService } from '../src/security-events/services/security-maintenance.service';
import { EmailOtpService } from '../src/identity/services/email-otp.service';
import { AuthChallengeCipher } from '../src/identity/services/auth-challenge-cipher.service';
import { CommunicationService } from '../src/communications/services/communication.service';

jest.setTimeout(120000);

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PASSWORD = 'correct-horse-battery-w3';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Account {
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

describe('W3 — platform email & security monitoring (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  let po: Account;
  let orgOwner: Account;
  let academyAdmin: Account;
  let learner: Account;
  let academyA: string;
  let academyB: string;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signUp(label: string): Promise<Account> {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function reSignIn(account: Account): Promise<Account> {
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  async function activeAcademy(ownerUserId: string, label: string): Promise<string> {
    const org = await seedOrganizationWithOwner(admin, ownerUserId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await admin.academy.update({ where: { id: academy.id }, data: { status: 'active' } });
    await seedAcademyMember(admin, academy.id, ownerUserId, 'owner');
    return academy.id;
  }

  const binary = (req: request.Test) =>
    req.buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();

    const poAccount = await signUp('w3-po');
    await admin.user.update({
      where: { id: poAccount.userId },
      data: { isPlatformOwner: true },
    });
    po = await reSignIn(poAccount);

    orgOwner = await signUp('w3-owner');
    academyA = await activeAcademy(orgOwner.userId, 'w3-a');
    orgOwner = await reSignIn(orgOwner);

    academyAdmin = await signUp('w3-staff');
    await seedAcademyMember(admin, academyA, academyAdmin.userId, 'administrator');
    academyAdmin = await reSignIn(academyAdmin);

    learner = await signUp('w3-learner');

    const otherOwner = await signUp('w3-other');
    academyB = await activeAcademy(otherOwner.userId, 'w3-b');
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  // ---------------------------------------------------------------------
  // Email logo
  // ---------------------------------------------------------------------

  describe('email logo route', () => {
    const logo = (academyId: string, version?: string) =>
      binary(
        http()
          .get(`/public/websites/${academyId}/logo`)
          .query(version ? { v: version } : {}),
      );

    it('W3-LOGO-01 — a WebP data-URI logo is served as a bounded PNG with versioned immutable caching and CORP cross-origin', async () => {
      const webp = await sharp({
        create: {
          width: 900,
          height: 300,
          channels: 3,
          background: { r: 10, g: 90, b: 200 },
        },
      })
        .webp()
        .toBuffer();
      const stored = `data:image/webp;base64,${webp.toString('base64')}`;
      await admin.academy.update({ where: { id: academyA }, data: { logoUrl: stored } });
      const version = emailLogoVersion(stored);

      const res = await logo(academyA, version).expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      const body = res.body as Buffer;
      expect(body.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(body).metadata();
      expect(meta.format).toBe('png');
      expect(meta.height).toBeLessThanOrEqual(160);
      expect(meta.width).toBeLessThanOrEqual(480);

      // Any other (or no) version: same bytes, short cache only.
      const stale = await logo(academyA, '0000000000000000').expect(200);
      expect(stale.headers['cache-control']).toBe('public, max-age=300');
      const unversioned = await logo(academyA).expect(200);
      expect(unversioned.headers['cache-control']).toBe('public, max-age=300');
    });

    it('W3-LOGO-02 — an uploaded media-asset logo is read from the public store and served as PNG', async () => {
      const storage = app.get<MediaStorageProvider>(MEDIA_STORAGE_PROVIDER, {
        strict: false,
      });
      const objectId = randomUUID();
      const jpeg = await sharp({
        create: {
          width: 200,
          height: 100,
          channels: 3,
          background: { r: 250, g: 200, b: 0 },
        },
      })
        .jpeg()
        .toBuffer();
      await storage.putObject(
        `academies/${academyA}/${objectId}.jpg`,
        jpeg,
        'image/jpeg',
      );
      const stored = `/api/v1/public/media/academies/${academyA}/${objectId}.jpg`;
      await admin.academy.update({ where: { id: academyA }, data: { logoUrl: stored } });

      const res = await logo(academyA, emailLogoVersion(stored)).expect(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect((res.body as Buffer).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      const meta = await sharp(res.body as Buffer).metadata();
      expect([meta.width, meta.height]).toEqual([200, 100]);
    });

    it('W3-LOGO-03 — unknown, malformed and archived academies are a plain 404 that leaks nothing', async () => {
      const unknown = await http()
        .get(`/public/websites/${randomUUID()}/logo`)
        .expect(404);
      await http().get('/public/websites/not-a-uuid/logo').expect(404);

      const archivedOwner = await signUp('w3-arch');
      const archived = await activeAcademy(archivedOwner.userId, 'w3-arch');
      const png = await sharp({
        create: { width: 40, height: 40, channels: 3, background: { r: 0, g: 0, b: 0 } },
      })
        .png()
        .toBuffer();
      await admin.academy.update({
        where: { id: archived },
        data: { logoUrl: `data:image/png;base64,${png.toString('base64')}` },
      });
      await http().get(`/public/websites/${archived}/logo`).expect(200);
      await admin.academy.update({
        where: { id: archived },
        data: { status: 'archived' },
      });
      const gone = await http().get(`/public/websites/${archived}/logo`).expect(404);

      // Identical, generic bodies: no name, id, logo value or storage detail.
      const withoutRequestId = (body: { error: Record<string, unknown> }) =>
        Object.fromEntries(Object.entries(body.error).filter(([k]) => k !== 'requestId'));
      expect(withoutRequestId(gone.body)).toEqual(withoutRequestId(unknown.body));
      const text = JSON.stringify(gone.body);
      expect(text).not.toContain(archived);
      expect(text).not.toContain('data:image');
      expect(text).not.toContain('w3-arch');
    });

    it('W3-LOGO-04 — a remote URL, another academy’s asset or no logo is a 404 (the email shows the name instead)', async () => {
      await admin.academy.update({
        where: { id: academyA },
        data: { logoUrl: 'https://cdn.example.com/logo.png' },
      });
      await http().get(`/public/websites/${academyA}/logo`).expect(404);

      await admin.academy.update({
        where: { id: academyA },
        data: {
          logoUrl: `/api/v1/public/media/academies/${academyB}/${randomUUID()}.png`,
        },
      });
      await http().get(`/public/websites/${academyA}/logo`).expect(404);

      await admin.academy.update({ where: { id: academyA }, data: { logoUrl: null } });
      await http().get(`/public/websites/${academyA}/logo`).expect(404);
    });

    it('W3-LOGO-05 — email branding links the logo on the platform host with display size, and that URL serves the PNG', async () => {
      const png = await sharp({
        create: {
          width: 300,
          height: 100,
          channels: 3,
          background: { r: 1, g: 2, b: 3 },
        },
      })
        .png()
        .toBuffer();
      const stored = `data:image/png;base64,${png.toString('base64')}`;
      await admin.academy.update({ where: { id: academyA }, data: { logoUrl: stored } });

      const branding = app.get(CommunicationBrandingService, { strict: false });
      const tenancy = app.get(TenancyContextService, { strict: false });
      const resolved = await tenancy.runInUserContext(po.userId, (tx) =>
        branding.resolve(tx, 'platform', academyA, 'academy'),
      );
      const url = resolved.branding.academyLogoUrl!;
      expect(url).toMatch(
        new RegExp(
          `/api/v1/public/websites/${academyA}/logo\\?v=${emailLogoVersion(stored)}$`,
        ),
      );
      expect(url).not.toContain('data:');
      expect(resolved.branding.academyLogoWidth).toBe(120);
      expect(resolved.branding.academyLogoHeight).toBe(40);
      // Links still follow the catalogue's host rule.
      expect(resolved.host).toBeNull();

      const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
      const served = await binary(
        http()
          .get(path)
          .query({ v: new URL(url).searchParams.get('v')! }),
      ).expect(200);
      expect(served.headers['cache-control']).toBe('public, max-age=31536000, immutable');
    });
  });

  // ---------------------------------------------------------------------
  // Academy Email Activity
  // ---------------------------------------------------------------------

  describe('Academy Email Activity', () => {
    const LEGACY_CODE = '402913';
    let rowIds: Record<string, string>;

    beforeAll(async () => {
      const base = {
        category: 'transactional' as const,
        recipientUserId: learner.userId,
        locale: 'en',
        branding: 'academy',
        channels: { inApp: false, email: 'always' },
      };
      const now = Date.now();
      const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000);
      const delivered = await admin.communicationOutbox.create({
        data: {
          ...base,
          key: 'enrollment.granted',
          academyId: academyA,
          state: 'dispatched',
          attempts: 1,
          createdAt: at(5),
          values: { courseTitle: 'Secret course title' },
        },
      });
      await admin.communicationDelivery.create({
        data: {
          outboxId: delivered.id,
          channel: 'email',
          provider: 'brevo',
          providerMessageId: `w3-${randomUUID()}`,
          status: 'delivered',
          errorCode: null,
          attempts: 1,
        },
      });
      const failed = await admin.communicationOutbox.create({
        data: {
          ...base,
          key: 'course.order.paid',
          academyId: academyA,
          state: 'failed',
          attempts: 6,
          lastError: 'brevo: HTTP 400 (invalid_parameter)',
          createdAt: at(4),
        },
      });
      await admin.communicationDelivery.create({
        data: {
          outboxId: failed.id,
          channel: 'email',
          provider: 'brevo',
          status: 'failed',
          errorCode: '550 5.1.1 <victim@example.com> rejected',
          attempts: 6,
        },
      });
      const bounced = await admin.communicationOutbox.create({
        data: {
          ...base,
          key: 'certificate.issued',
          academyId: academyA,
          state: 'dispatched',
          attempts: 1,
          createdAt: at(3),
        },
      });
      await admin.communicationDelivery.create({
        data: {
          outboxId: bounced.id,
          channel: 'email',
          provider: 'brevo',
          providerMessageId: `w3-${randomUUID()}`,
          status: 'bounced',
          errorCode: `550 mailbox ${learner.email} unknown`,
          attempts: 1,
        },
      });
      // A pre-fix OTP row still holding its plaintext code.
      const otp = await admin.communicationOutbox.create({
        data: {
          ...base,
          category: 'security',
          key: 'auth.email.otp',
          academyId: academyA,
          // Settled (so no worker sharing this database can claim it) but
          // still holding a pre-fix plaintext code.
          state: 'suppressed',
          attempts: 1,
          lastError: 'address_suppressed',
          createdAt: at(2),
          values: { code: LEGACY_CODE, expiresInMinutes: 10 },
        },
      });
      const other = await admin.communicationOutbox.create({
        data: {
          ...base,
          key: 'enrollment.granted',
          academyId: academyB,
          state: 'dispatched',
          createdAt: at(1),
        },
      });
      rowIds = {
        delivered: delivered.id,
        failed: failed.id,
        bounced: bounced.id,
        otp: otp.id,
        other: other.id,
      };
    });

    const activity = (token: string, query: Record<string, string | number> = {}) =>
      http()
        .get('/platform-communications/email-activity')
        .set(bearer(token))
        .query(query);

    it('W3-ACT-01 — the Platform Owner sees one academy’s rows with honest statuses, masked recipients and error categories only', async () => {
      const res = await activity(po.token, { academyId: academyA }).expect(200);
      const ids = res.body.items.map((i: { id: string }) => i.id);
      expect(ids).toEqual(
        expect.arrayContaining([
          rowIds.delivered,
          rowIds.failed,
          rowIds.bounced,
          rowIds.otp,
        ]),
      );
      expect(ids).not.toContain(rowIds.other);
      for (const item of res.body.items) expect(item.academy.id).toBe(academyA);

      const byId = new Map<string, Record<string, unknown>>(
        res.body.items.map((i: Record<string, unknown>) => [i.id as string, i]),
      );
      expect(byId.get(rowIds.delivered)).toMatchObject({
        status: 'delivered',
        deliveryStatus: 'delivered',
        provider: 'brevo',
        errorCategory: null,
      });
      expect(byId.get(rowIds.failed)).toMatchObject({
        status: 'failed',
        errorCategory: 'provider_rejected',
      });
      expect(byId.get(rowIds.bounced)).toMatchObject({
        status: 'bounced',
        errorCategory: 'bounce_hard',
      });
      expect(byId.get(rowIds.otp)).toMatchObject({
        status: 'suppressed',
        security: true,
        errorCategory: 'address_suppressed',
      });

      const masked = (byId.get(rowIds.delivered)!.recipient as { maskedEmail: string })
        .maskedEmail;
      expect(masked).toBe(
        `${learner.email[0]}•••${learner.email.slice(learner.email.indexOf('@'))}`,
      );

      // Never: values, codes, raw provider/MTA text, full addresses.
      const text = JSON.stringify(res.body);
      expect(text).not.toContain('"values"');
      expect(text).not.toContain(LEGACY_CODE);
      expect(text).not.toContain('Secret course title');
      expect(text).not.toContain('invalid_parameter');
      expect(text).not.toContain('victim@example.com');
      expect(text).not.toContain(learner.email);
    });

    it('W3-ACT-02 — status and catalogue-key filters narrow the list', async () => {
      const failed = await activity(po.token, {
        academyId: academyA,
        status: 'failed',
      }).expect(200);
      expect(failed.body.items.map((i: { id: string }) => i.id)).toEqual([rowIds.failed]);

      const byKey = await activity(po.token, {
        academyId: academyA,
        key: 'certificate.issued',
      }).expect(200);
      expect(byKey.body.items.map((i: { id: string }) => i.id)).toEqual([rowIds.bounced]);

      await activity(po.token, { academyId: academyA, status: 'nonsense' }).expect(400);
      await activity(po.token, { academyId: 'not-a-uuid' }).expect(400);
      await activity(po.token, { key: 'not.a.catalogue.key' }).expect(400);
    });

    it('W3-ACT-03 — keyset pagination walks newest-first without overlap', async () => {
      const first = await activity(po.token, { academyId: academyA, limit: 2 }).expect(
        200,
      );
      expect(first.body.items).toHaveLength(2);
      expect(first.body.nextCursor).toEqual(expect.any(String));
      const second = await activity(po.token, {
        academyId: academyA,
        limit: 2,
        cursor: first.body.nextCursor,
      }).expect(200);
      const a = first.body.items.map((i: { id: string }) => i.id);
      const b = second.body.items.map((i: { id: string }) => i.id);
      expect(a.filter((id: string) => b.includes(id))).toEqual([]);
      expect(a).toEqual([rowIds.otp, rowIds.bounced]);
      expect(b).toEqual([rowIds.failed, rowIds.delivered]);
      await activity(po.token, { academyId: academyA, cursor: 'garbage!!' }).expect(400);
    });

    it('W3-ACT-04 — the summary counts honest statuses for the academy', async () => {
      const res = await http()
        .get('/platform-communications/email-activity/summary')
        .set(bearer(po.token))
        .query({ academyId: academyA })
        .expect(200);
      expect(res.body.byStatus).toMatchObject({
        delivered: 1,
        failed: 1,
        bounced: 1,
        suppressed: 1,
      });
      expect(res.body.total).toBe(4);
      expect(res.body.academies).toHaveLength(1);
      expect(res.body.academies[0]).toMatchObject({ academyId: academyA, total: 4 });
      expect(res.body.deliveryWebhooksObserved).toBe(true);
    });

    it('W3-ACT-05 — organisation owners, academy staff and anonymous callers are refused', async () => {
      for (const path of [
        '/platform-communications/email-activity',
        '/platform-communications/email-activity/summary',
      ]) {
        await http()
          .get(path)
          .set(bearer(orgOwner.token))
          .query({ academyId: academyA })
          .expect(403);
        await http()
          .get(path)
          .set(bearer(academyAdmin.token))
          .query({ academyId: academyA })
          .expect(403);
        await http().get(path).set(bearer(learner.token)).expect(403);
        await http().get(path).expect(401);
      }
    });
  });

  // ---------------------------------------------------------------------
  // OTP & Security Monitoring
  // ---------------------------------------------------------------------

  describe('OTP & Security Monitoring', () => {
    // Unique per run: the e2e database is shared and never cleaned, and IP
    // hashes are stable within a month, so a fixed IP would match the
    // events of every earlier run.
    const IP = `2001:db8::${Date.now().toString(16).slice(-4)}:${Math.floor(Math.random() * 0xffff).toString(16)}`;
    let subject: Account;
    let issuedCode = '';

    beforeAll(async () => {
      subject = await signUp('w3-sec');
      const otp = app.get(EmailOtpService, { strict: false });
      const cipher = app.get(AuthChallengeCipher, { strict: false });

      // A real issue: writes the challenge, the outbox row and `otp_sent`.
      // The code is captured at emit time — the shared dev worker may settle
      // (and, correctly, scrub) the outbox row before this spec reads it.
      const communications = app.get(CommunicationService, { strict: false });
      const emitSpy = jest.spyOn(communications, 'emit');
      const issued = await otp.issue({
        user: { id: subject.userId, email: subject.email },
        surface: 'management',
        context: { ipAddress: IP },
      });
      issuedCode = String(
        (emitSpy.mock.calls.at(-1)?.[1]?.values as { code?: string } | undefined)?.code,
      );
      emitSpy.mockRestore();
      expect(issuedCode).toMatch(/^\d{6}$/);
      expect(cipher.openChallengeRef(issued.challengeId)?.userId).toBe(subject.userId);
      // A real wrong guess: `otp_failed` with attempts remaining.
      const wrong = issuedCode === '000000' ? '111111' : '000000';
      await expect(
        otp.verify(issued.challengeId, wrong, { ipAddress: IP }),
      ).rejects.toMatchObject({
        status: 401,
      });

      // Three rate-limit hits inside one minute fold into one row.
      const events = app.get(SecurityEventsService, { strict: false });
      for (let i = 0; i < 3; i += 1) {
        await events.record({
          type: 'otp_rate_limited',
          surface: 'management',
          email: subject.email,
          ipAddress: IP,
          reason: 'account_budget',
        });
      }
    });

    it('W3-SEC-01 — instrumentation stores hashes only: no code, no address, no IP', async () => {
      const code = issuedCode;
      const rows = await admin.securityEvent.findMany({
        where: { OR: [{ userId: subject.userId }, { ipHash: { not: null } }] },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      const mine = rows.filter((r) => r.userId === subject.userId);
      expect(mine.map((r) => r.eventType).sort()).toEqual(['otp_failed', 'otp_sent']);
      const failed = mine.find((r) => r.eventType === 'otp_failed')!;
      expect(failed.reason).toBe('invalid_code');
      expect(failed.attemptsRemaining).toBe(4);
      const text = JSON.stringify(rows);
      expect(text).not.toContain(code);
      expect(text).not.toContain(subject.email);
      expect(text).not.toContain(IP);
      for (const row of mine) {
        expect(row.ipHash).toMatch(/^[0-9a-f]{64}$/);
      }
    });

    it('W3-SEC-02 — the summary, filtered by address, counts exactly this account’s events', async () => {
      const res = await http()
        .get('/platform-security/summary')
        .set(bearer(po.token))
        .query({ days: 1, email: subject.email.toUpperCase() })
        .expect(200);
      expect(res.body.totals).toMatchObject({
        otpSent: 1,
        otpFailed: 1,
        otpVerified: 0,
        otpRateLimited: 3,
      });
      expect(res.body.verifyRate).toBe(0);
      expect(res.body.series.length).toBeGreaterThanOrEqual(1);
      const today = res.body.series[res.body.series.length - 1];
      expect(today).toMatchObject({ sent: 1, failed: 1, rateLimited: 3 });
      expect(JSON.stringify(res.body)).not.toContain(subject.email.toLowerCase());
    });

    it('W3-SEC-03 — recent events are masked, filterable by IP, and paginate', async () => {
      const res = await http()
        .get('/platform-security/events')
        .set(bearer(po.token))
        .query({ days: 1, ip: IP })
        .expect(200);
      const types = res.body.items.map((i: { type: string }) => i.type);
      expect(types).toEqual(
        expect.arrayContaining(['otp_sent', 'otp_failed', 'otp_rate_limited']),
      );
      const bucket = res.body.items.find(
        (i: { type: string }) => i.type === 'otp_rate_limited',
      );
      expect(bucket.occurrences).toBe(3);
      const sent = res.body.items.find((i: { type: string }) => i.type === 'otp_sent');
      expect(sent.maskedEmail).toBe(
        `${subject.email[0]}•••${subject.email.slice(subject.email.indexOf('@'))}`,
      );
      expect(sent.ipRef).toMatch(/^[0-9a-f]{8}$/);
      const text = JSON.stringify(res.body);
      expect(text).not.toContain(IP);
      expect(text).not.toContain(subject.email);

      const typed = await http()
        .get('/platform-security/events')
        .set(bearer(po.token))
        .query({ days: 1, ip: IP, type: 'otp_failed' })
        .expect(200);
      expect(typed.body.items.map((i: { type: string }) => i.type)).toEqual([
        'otp_failed',
      ]);

      const page = await http()
        .get('/platform-security/events')
        .set(bearer(po.token))
        .query({ days: 1, ip: IP, limit: 1 })
        .expect(200);
      expect(page.body.items).toHaveLength(1);
      const next = await http()
        .get('/platform-security/events')
        .set(bearer(po.token))
        .query({ days: 1, ip: IP, limit: 1, cursor: page.body.nextCursor })
        .expect(200);
      expect(next.body.items[0].id).not.toBe(page.body.items[0].id);
    });

    it('W3-SEC-04 — organisation owners, academy staff, learners and anonymous callers are refused', async () => {
      for (const path of ['/platform-security/summary', '/platform-security/events']) {
        await http().get(path).set(bearer(orgOwner.token)).expect(403);
        await http().get(path).set(bearer(academyAdmin.token)).expect(403);
        await http().get(path).set(bearer(learner.token)).expect(403);
        await http().get(path).expect(401);
      }
    });

    it('W3-SEC-05 — RLS: the runtime role cannot read security events without a platform-owner context', async () => {
      const tenancy = app.get(TenancyContextService, { strict: false });
      const asLearner = await tenancy.runInUserContext(learner.userId, (tx) =>
        tx.securityEvent.count(),
      );
      expect(asLearner).toBe(0);
      const asOwner = await tenancy.runInUserContext(po.userId, (tx) =>
        tx.securityEvent.count({ where: { userId: subject.userId } }),
      );
      expect(asOwner).toBe(2);
    });
  });

  // ---------------------------------------------------------------------
  // Retention and the outbox safety net
  // ---------------------------------------------------------------------

  describe('retention', () => {
    it('W3-RET-01 — the security sweep prunes day-old challenges and 90-day-old events, and keeps fresh ones', async () => {
      const user = await signUp('w3-ret');
      const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
      const fresh = new Date();
      const challenge = (createdAt: Date) =>
        admin.authEmailChallenge.create({
          data: {
            userId: user.userId,
            surface: 'management',
            codeHash: 'x'.repeat(64),
            salt: 'salt',
            ipAddress: '192.0.2.44',
            expiresAt: new Date(createdAt.getTime() + 600_000),
            createdAt,
          },
        });
      const oldChallenge = await challenge(old);
      const freshChallenge = await challenge(fresh);
      const deletion = (createdAt: Date) =>
        admin.accountDeletionChallenge.create({
          data: {
            userId: user.userId,
            sessionId: randomUUID(),
            codeHash: 'y'.repeat(64),
            salt: 'salt',
            expiresAt: new Date(createdAt.getTime() + 600_000),
            createdAt,
          },
        });
      const oldDeletion = await deletion(old);
      const freshDeletion = await deletion(fresh);
      const oldEvent = await admin.securityEvent.create({
        data: {
          eventType: 'otp_sent',
          userId: user.userId,
          createdAt: new Date(Date.now() - 91 * 24 * 60 * 60 * 1000),
        },
      });
      const freshEvent = await admin.securityEvent.create({
        data: { eventType: 'otp_sent', userId: user.userId },
      });

      const result = await app.get(SecurityMaintenanceService, { strict: false }).run();
      expect(result.authEmailChallenges).toBeGreaterThanOrEqual(1);
      expect(result.accountDeletionChallenges).toBeGreaterThanOrEqual(1);
      expect(result.securityEvents).toBeGreaterThanOrEqual(1);

      expect(
        await admin.authEmailChallenge.findUnique({ where: { id: oldChallenge.id } }),
      ).toBeNull();
      expect(
        await admin.authEmailChallenge.findUnique({ where: { id: freshChallenge.id } }),
      ).not.toBeNull();
      expect(
        await admin.accountDeletionChallenge.findUnique({
          where: { id: oldDeletion.id },
        }),
      ).toBeNull();
      expect(
        await admin.accountDeletionChallenge.findUnique({
          where: { id: freshDeletion.id },
        }),
      ).not.toBeNull();
      expect(
        await admin.securityEvent.findUnique({ where: { id: oldEvent.id } }),
      ).toBeNull();
      expect(
        await admin.securityEvent.findUnique({ where: { id: freshEvent.id } }),
      ).not.toBeNull();
    });

    it('W3-RET-02 — the outbox prune strips a code left on a stuck row older than an hour, and nothing else', async () => {
      const user = await signUp('w3-stuck');
      const base = {
        key: 'auth.email.otp',
        category: 'security' as const,
        recipientUserId: user.userId,
        locale: 'en',
        branding: 'academy',
        channels: { inApp: false, email: 'always' },
        state: 'pending' as const,
      };
      const stuck = await admin.communicationOutbox.create({
        data: {
          ...base,
          values: { code: '771144', expiresInMinutes: 10 },
          createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
        },
      });
      const inFlight = await admin.communicationOutbox.create({
        data: { ...base, values: { code: '771145', expiresInMinutes: 10 } },
      });
      const settledLegacy = await admin.communicationOutbox.create({
        data: {
          ...base,
          key: 'auth.password.reset',
          state: 'dispatched',
          values: { token: 'legacy-token', expiresInMinutes: 45 },
        },
      });

      const result = await app
        .get(CommunicationDispatchService, { strict: false })
        .prune();
      expect(result.scrubbedCredentials).toBeGreaterThanOrEqual(2);

      const after = async (id: string) =>
        (await admin.communicationOutbox.findUniqueOrThrow({ where: { id } })).values;
      expect(await after(stuck.id)).toEqual({ expiresInMinutes: 10 });
      expect(await after(inFlight.id)).toEqual({ code: '771145', expiresInMinutes: 10 });
      expect(await after(settledLegacy.id)).toEqual({ expiresInMinutes: 45 });
    });
  });
});
