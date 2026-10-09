/**
 * Forensic video watermark (docs/FORENSIC_WATERMARK.md) — against real
 * Postgres (FORCE RLS, the `atlas_app` role) and Redis.
 *
 *   WM-01  a learner's video grant carries a code; the record is written with
 *          an ENCRYPTED snapshot (no plaintext name/email/phone in the row)
 *          that decrypts to the identity at issue time, phone included
 *   WM-02  the same session + lesson reuses the code; a new session gets a new one
 *   WM-03  a staff preview is watermarked with the staff member's identity
 *   WM-04  an anonymous preview (YouTube embed, over HTTP) gets a preview code
 *          with no identity, and the record keeps IP/UA
 *   WM-05  the academy PATCH accepts `watermark:false` / `watermarkText` from
 *          the deployed frontend, and changes nothing
 *   WM-06  a live-class redeem carries a watermark, issued before the SDK signature
 *   WM-07  the lookup is Platform-Owner-only (403 otherwise), OCR-normalised
 *          input finds the row, every lookup is audited without PII, misreads
 *          are told apart from misses, and it is rate limited
 *   WM-08  after account deletion the lookup still returns the snapshot
 *   WM-09  retention removes only rows past the window; the 90-day floor holds
 *          even for a zero cutoff
 *   WM-10  fail closed: when issuance fails no playable video is returned
 *   WM-11  RLS: no learner, tenant or anonymous context can read or write the
 *          table directly; tamper reports count only on the caller's own code
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedCourseLesson,
  seedCourseSection,
  seedEnrollment,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { deletionCodeFor } from './utils/account-deletion';
import {
  LessonContentService,
  type ContentRequestContext,
} from '../src/learning/services/lesson-content.service';
import { LearningLeaseService } from '../src/learning/services/learning-lease.service';
import { Phase2MaintenanceService } from '../src/learning/services/phase2-maintenance.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { hashDeviceCookie } from '../src/tenancy/services/student-device.service';
import { WatermarkSnapshotCipher } from '../src/forensic-watermark/services/watermark-snapshot-cipher.service';
import { RedisService } from '../src/redis/redis.service';
import { GRANT_LIMIT_PER_WINDOW } from '../src/learning/services/content-grant.rate-limiter';
import { ForensicWatermarkService } from '../src/forensic-watermark/services/forensic-watermark.service';
import {
  generateWatermarkCode,
  normalizeWatermarkCode,
} from '../src/forensic-watermark/utils/watermark-code.util';
import { AddOnAccessService } from '../src/live-sessions/services/add-on-access.service';
import { ZoomProvider } from '../src/live-sessions/providers/zoom.provider';

jest.setTimeout(180000);
const PASSWORD = 'correct-horse-battery-watermark';
const LOOKUP_LIMIT = 8;
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';

describe('Forensic video watermark (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let content: LessonContentService;
  let leases: LearningLeaseService;
  let tenancy: TenancyContextService;
  let cipher: WatermarkSnapshotCipher;
  let watermarks: ForensicWatermarkService;
  let maintenance: Phase2MaintenanceService;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    process.env.WATERMARK_LOOKUP_RATE_LIMIT_MAX = String(LOOKUP_LIMIT);
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder.overrideProvider(AddOnAccessService).useValue({
          assertUsable: async () => undefined,
          describe: async () => ({ usable: true, entitled: true }),
        }),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    content = app.get(LessonContentService, { strict: false });
    leases = app.get(LearningLeaseService, { strict: false });
    tenancy = app.get(TenancyContextService, { strict: false });
    cipher = app.get(WatermarkSnapshotCipher, { strict: false });
    watermarks = app.get(ForensicWatermarkService, { strict: false });
    maintenance = app.get(Phase2MaintenanceService, { strict: false });
  });

  afterAll(async () => {
    delete process.env.WATERMARK_LOOKUP_RATE_LIMIT_MAX;
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signedIn(label: string) {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({
        name: `Watermark ${label}`,
        email,
        password: PASSWORD,
        phoneNumber: '01001234567',
        phoneCountry: 'EG',
      })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .set(
        'User-Agent',
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile Safari/604.1',
      )
      .send({ email, password: PASSWORD })
      .expect(200);
    const userId = signIn.body.user.id as string;
    const session = await admin.refreshToken.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      email,
      name: `Watermark ${label}`,
      userId,
      sessionId: session.sessionId,
      token: signIn.body.accessToken as string,
    };
  }

  async function platformOwner(label: string) {
    const account = await signedIn(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    const again = await http()
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: again.body.accessToken as string };
  }

  /** An academy with a hosted-video lesson, a YouTube preview lesson, an owner and an enrolled learner. */
  async function world(label: string) {
    const owner = await signedIn(`${label}-owner`);
    const learner = await signedIn(`${label}-learner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);

    const assetId = randomUUID();
    const asset = await admin.mediaAsset.create({
      data: {
        id: assetId,
        academyId: academy.id,
        courseId: course.id,
        type: 'video',
        fileName: `${assetId}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider: 'r2_worker',
        providerId: `academies/${academy.id}/courses/${course.id}/${assetId}.mp4`,
        processingStatus: 'ready',
        durationSeconds: 600,
        durationSource: 'parsed',
        securityTier: 'normal',
      },
    });
    const videoLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label} video`,
      0,
      {
        status: 'published',
        contentType: 'video',
        videoAssetId: asset.id,
      },
    );
    const previewLesson = await seedCourseLesson(
      admin,
      section.id,
      course.id,
      `${label} preview`,
      1,
      { status: 'published', contentType: 'video', contentUrl: YOUTUBE_URL },
    );
    await admin.courseLesson.update({
      where: { id: previewLesson.id },
      data: { isPreview: true },
    });

    await admin.academyStudent.create({
      data: {
        academyId: academy.id,
        userId: learner.userId,
        status: 'active',
        source: 'staff_created',
      },
    });
    await seedEnrollment(admin, learner.userId, course.id, academy.id);
    const deviceCookie = randomUUID();
    await admin.studentDevice.create({
      data: {
        userId: learner.userId,
        academyId: academy.id,
        cookieHash: hashDeviceCookie(deviceCookie),
        label: 'Safari on iOS',
      },
    });
    return {
      owner,
      learner,
      org,
      academy,
      course,
      videoLesson,
      previewLesson,
      deviceCookie,
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  function learnerContext(
    w: World,
    overrides: Partial<ContentRequestContext> = {},
  ): ContentRequestContext {
    return {
      userId: w.learner.userId,
      sessionId: w.learner.sessionId,
      hostAcademyId: w.academy.id,
      deviceCookie: w.deviceCookie,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Mobile Safari/604.1',
      clientIp: '203.0.113.7',
      country: 'EG',
      requestHost: 'learn.example.test',
      ...overrides,
    };
  }

  async function releaseLease(w: World, leaseId: string | undefined) {
    if (leaseId) await leases.release(w.learner.userId, w.academy.id, leaseId);
  }

  const rowFor = (displayCode: string) =>
    admin.forensicWatermark.findUniqueOrThrow({
      where: { code: displayCode.replace('-', '') },
    });

  it('WM-01 — a learner video grant carries a code; the row holds an encrypted snapshot only', async () => {
    const w = await world('wm01');
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);

    expect(grant.video).toBeDefined();
    expect(grant.protection.watermark).toBe(true);
    expect(grant.watermark).toMatchObject({ enabled: true, kind: 'account', host: null });
    expect(grant.watermark.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(grant.watermark.maskedIdentity).toBe(
      `${w.learner.email[0]}•••@${w.learner.email.split('@')[1]}`,
    );
    // The legacy field the deployed player draws now carries the code too.
    expect(grant.watermark.text).toBe(
      `${grant.watermark.code} · ${grant.watermark.maskedIdentity}`,
    );

    const row = await rowFor(grant.watermark.code!);
    expect(row).toMatchObject({
      surface: 'lesson_video',
      userId: w.learner.userId,
      academyId: w.academy.id,
      courseId: w.course.id,
      lessonId: w.videoLesson.id,
      sessionId: w.learner.sessionId,
      clientIp: '203.0.113.7',
      country: 'EG',
      deviceLabel: 'Safari on iOS',
      tamperEventCount: 0,
    });
    expect(row.deviceId).not.toBeNull();
    expect(row.sessionStartedAt).not.toBeNull();
    const serialised = JSON.stringify(row);
    expect(serialised).not.toContain(w.learner.email);
    expect(serialised).not.toContain('1001234567');
    expect(serialised).not.toContain(w.learner.name);
    expect(row.identitySnapshot?.startsWith('v1.')).toBe(true);

    const snapshot = cipher.decrypt(row.identitySnapshot!, row.code);
    expect(snapshot).toMatchObject({
      name: w.learner.name,
      email: w.learner.email,
      phoneE164: '+201001234567',
      phoneCountry: 'EG',
      target: { courseTitle: w.course.title, lessonTitle: w.videoLesson.title },
    });
  });

  it('WM-02 — same session + lesson reuses the code; a new session gets a new one', async () => {
    const w = await world('wm02');
    const first = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, first.playbackLease?.leaseId);
    const again = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, again.playbackLease?.leaseId);
    expect(again.watermark.code).toBe(first.watermark.code);

    const second = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w, { sessionId: randomUUID() }),
    );
    await releaseLease(w, second.playbackLease?.leaseId);
    expect(second.watermark.code).not.toBe(first.watermark.code);
    expect(
      await admin.forensicWatermark.count({ where: { userId: w.learner.userId } }),
    ).toBe(2);
  });

  it('WM-03 — a staff preview is watermarked with the staff member identity', async () => {
    const w = await world('wm03');
    const grant = await content.getContent(w.course.id, w.videoLesson.id, {
      userId: w.owner.userId,
      sessionId: w.owner.sessionId,
      hostAcademyId: null,
      deviceCookie: null,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/124',
    });
    expect(grant.video).toBeDefined();
    expect(grant.playbackLease).toBeNull();
    expect(grant.watermark).toMatchObject({ enabled: true, kind: 'account' });
    const row = await rowFor(grant.watermark.code!);
    expect(row.userId).toBe(w.owner.userId);
    expect(cipher.decrypt(row.identitySnapshot!, row.code).email).toBe(w.owner.email);
  });

  it('WM-04 — an anonymous YouTube preview over HTTP gets a preview code with no identity', async () => {
    const w = await world('wm04');
    const response = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/content`)
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/124 Mobile')
      .expect(200);
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.body.externalEmbed).toMatchObject({ provider: 'youtube' });
    expect(response.body.protection.watermark).toBe(true);
    expect(response.body.watermark).toMatchObject({
      enabled: true,
      kind: 'preview',
      maskedIdentity: null,
    });
    expect(response.body.watermark.host).toBeTruthy();
    const row = await rowFor(response.body.watermark.code);
    expect(row).toMatchObject({
      surface: 'course_preview',
      userId: null,
      identitySnapshot: null,
      lessonId: w.previewLesson.id,
    });
    expect(row.userAgent).toContain('Android 14');
    expect(row.clientIp).toBeTruthy();

    // The same visitor refreshing the grant keeps the same code.
    const again = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/content`)
      .set('User-Agent', 'Mozilla/5.0 (Linux; Android 14) Chrome/124 Mobile')
      .expect(200);
    expect(again.body.watermark.code).toBe(response.body.watermark.code);
  });

  it('WM-04b — anonymous preview grants share the grant ceiling per client IP; no record past it', async () => {
    const w = await world('wm04b');
    // A documentation-range address of its own, so no other test shares the budget.
    const ip = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
    const redis = app.get(RedisService, { strict: false }).getClient();
    const key = `content_grants:anon:${ip}`;
    await redis.del(key);
    await redis.set(key, String(GRANT_LIMIT_PER_WINDOW), 'EX', 60);
    try {
      const before = await admin.forensicWatermark.count({
        where: { lessonId: w.previewLesson.id },
      });
      // A fresh device cookie each time changes nothing: the budget is the address's.
      const refused = await http()
        .get(`/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/content`)
        .set('X-Real-IP', ip)
        .set('Cookie', `atlas_device=${randomUUID()}`)
        .expect(403);
      expect(refused.body.error).toMatchObject({
        messageKey: 'errors.learning.grantRateLimited',
      });
      expect(
        await admin.forensicWatermark.count({ where: { lessonId: w.previewLesson.id } }),
      ).toBe(before);

      // Once the window resets, the same address is served again.
      await redis.del(key);
      await http()
        .get(`/learning/courses/${w.course.id}/lessons/${w.previewLesson.id}/content`)
        .set('X-Real-IP', ip)
        .expect(200);
    } finally {
      await redis.del(key);
    }
  });

  it('WM-05 — the academy PATCH accepts watermark:false and custom text, and changes nothing', async () => {
    const w = await world('wm05');
    const patched = await http()
      .patch(`/academies/${w.academy.id}/content-protection`)
      .set(bearer(w.owner.token))
      .send({
        contentProtection: {
          watermark: false,
          watermarkText: 'Atlas Academy',
          disableDownload: true,
          disablePip: true,
          disableContextMenu: true,
        },
      })
      .expect(200);
    expect(patched.body).toMatchObject({ watermark: true, watermarkText: null });
    const stored = await admin.academy.findUniqueOrThrow({ where: { id: w.academy.id } });
    expect(stored.contentProtection).toMatchObject({
      watermark: true,
      watermarkText: null,
    });

    // Even a blob written by an older release is not honoured.
    await admin.academy.update({
      where: { id: w.academy.id },
      data: { contentProtection: { watermark: false, watermarkText: 'Hidden' } },
    });
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);
    expect(grant.watermark.enabled).toBe(true);
    expect(grant.watermark.text).not.toContain('Hidden');
    expect(grant.watermark.code).toBeTruthy();
  });

  it('WM-06 — a live-class redeem carries a watermark', async () => {
    const w = await world('wm06');
    const zoom = app.get(ZoomProvider, { strict: false });
    const signature = jest.spyOn(zoom, 'createJoinSignature').mockResolvedValue({
      sdkKey: 'sdk-key',
      signature: 'signed',
      providerMeetingId: '123456789',
      expiresAt: new Date(Date.now() + 3600_000),
    } as never);
    try {
      await admin.academyLiveProviderConnection.create({
        data: { academyId: w.academy.id, status: 'connected' },
      });
      const live = await admin.liveSession.create({
        data: {
          courseId: w.course.id,
          academyId: w.academy.id,
          title: 'Live revision class',
          status: 'live',
          scheduledStartAt: new Date(Date.now() - 5 * 60_000),
          scheduledEndAt: new Date(Date.now() + 55 * 60_000),
          hostUserId: w.owner.userId,
          providerMeetingId: '123456789',
        },
      });
      const join = await http()
        .post(`/live-sessions/${live.id}/join`)
        .set(bearer(w.learner.token))
        .expect(200);
      const redeem = await http()
        .post(`/live-sessions/${live.id}/join/redeem`)
        .set(bearer(w.learner.token))
        .send({ token: join.body.token })
        .expect(200);
      expect(redeem.body).toMatchObject({ joinable: true, signature: 'signed' });
      expect(redeem.body.watermark).toMatchObject({ kind: 'account' });
      const row = await rowFor(redeem.body.watermark.code);
      expect(row).toMatchObject({
        surface: 'live_session',
        liveSessionId: live.id,
        userId: w.learner.userId,
        organizationId: w.org.id,
      });
    } finally {
      signature.mockRestore();
    }
  });

  it('WM-07 — lookup: Platform Owner only, OCR-normalised, audited without PII, misreads told apart', async () => {
    const w = await world('wm07');
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);
    const code = grant.watermark.code!;
    const po = await platformOwner('wm07-po');

    // Not a Platform Owner: refused, whoever it is.
    await http()
      .get(`/platform/watermarks/${code}`)
      .set(bearer(w.owner.token))
      .expect(403);
    await http()
      .get(`/platform/watermarks/${code}`)
      .set(bearer(w.learner.token))
      .expect(403);
    await http().get(`/platform/watermarks/${code}`).expect(401);

    // Typed the way a person reads a recording: lower case, spaces, O for 0, l for 1.
    const messy = code
      .toLowerCase()
      .replace('-', ' ')
      .replace(/0/g, 'o')
      .replace(/1/g, 'l');
    const found = await http()
      .get(`/platform/watermarks/${encodeURIComponent(messy)}`)
      .set(bearer(po.token))
      .expect(200);
    expect(found.headers['cache-control']).toContain('no-store');
    expect(found.body).toMatchObject({
      code,
      surface: 'lesson_video',
      tamperEvents: 0,
      snapshotStatus: 'ok',
      account: {
        userId: w.learner.userId,
        state: 'active',
        currentEmail: w.learner.email,
      },
      identityAtIssue: {
        name: w.learner.name,
        email: w.learner.email,
        phone: '+201001234567',
        phoneCountry: 'EG',
      },
      content: {
        organization: { id: w.org.id },
        academy: { id: w.academy.id, name: w.academy.name },
        course: { id: w.course.id, title: w.course.title },
        lesson: { id: w.videoLesson.id, title: w.videoLesson.title },
        liveSession: null,
      },
      session: { id: w.learner.sessionId },
      device: { label: 'Safari on iOS', type: 'mobile' },
      network: { ip: '203.0.113.7', country: 'EG' },
    });
    expect(found.body.session.startedAt).toBeTruthy();

    const audit = await admin.auditLogEntry.findFirstOrThrow({
      where: { actorUserId: po.userId, action: 'platform.watermark.looked_up' },
      orderBy: { occurredAt: 'desc' },
    });
    expect(audit.context).toMatchObject({
      found: true,
      surface: 'lesson_video',
      accountLinked: true,
    });
    const auditText = JSON.stringify(audit);
    expect(auditText).not.toContain(w.learner.email);
    expect(auditText).not.toContain('1001234567');

    // A misread symbol is a checksum problem (400), not a miss.
    const normalized = normalizeWatermarkCode(code);
    if (!normalized.ok) throw new Error('unexpected');
    const misread =
      normalized.code.slice(0, 2) +
      (normalized.code[2] === 'A' ? 'B' : 'A') +
      normalized.code.slice(3);
    const bad = await http()
      .get(`/platform/watermarks/${misread}`)
      .set(bearer(po.token))
      .expect(400);
    expect(bad.body.error?.messageKey ?? bad.body.messageKey).toBe(
      'errors.watermark.checksumMismatch',
    );

    // A well-formed code nobody was issued: 404, and still audited.
    let unknown = '';
    do {
      unknown = generateWatermarkCode();
    } while (await admin.forensicWatermark.findUnique({ where: { code: unknown } }));
    await http().get(`/platform/watermarks/${unknown}`).set(bearer(po.token)).expect(404);
    expect(
      await admin.auditLogEntry.count({
        where: { actorUserId: po.userId, action: 'platform.watermark.looked_up' },
      }),
    ).toBe(2);
  });

  it('WM-07 — the lookup is rate limited per Platform Owner', async () => {
    const w = await world('wm07rl');
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);
    const po = await platformOwner('wm07rl-po');
    for (let i = 0; i < LOOKUP_LIMIT; i += 1) {
      await http()
        .get(`/platform/watermarks/${grant.watermark.code}`)
        .set(bearer(po.token))
        .expect(200);
    }
    await http()
      .get(`/platform/watermarks/${grant.watermark.code}`)
      .set(bearer(po.token))
      .expect(429);
  });

  it('WM-08 — after account deletion the lookup still returns the snapshot', async () => {
    const w = await world('wm08');
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);

    const { challengeId, code } = await deletionCodeFor(app, admin, w.learner.token);
    await http()
      .post('/users/me/delete')
      .set(bearer(w.learner.token))
      .send({ confirm: true, challengeId, code })
      .expect(200);
    expect(
      await admin.userPhone.findUnique({ where: { userId: w.learner.userId } }),
    ).toBeNull();

    const po = await platformOwner('wm08-po');
    const found = await http()
      .get(`/platform/watermarks/${grant.watermark.code}`)
      .set(bearer(po.token))
      .expect(200);
    expect(found.body.account).toMatchObject({
      userId: w.learner.userId,
      state: 'deleted',
      currentName: null,
      currentEmail: null,
    });
    expect(found.body.account.deletedAt).toBeTruthy();
    expect(found.body.identityAtIssue).toEqual({
      name: w.learner.name,
      email: w.learner.email,
      phone: '+201001234567',
      phoneCountry: 'EG',
    });
  });

  it('WM-09 — retention removes only rows past the window; the 90-day floor always holds', async () => {
    const w = await world('wm09');
    const day = 24 * 60 * 60 * 1000;
    const seed = async (ageDays: number) => {
      const code = generateWatermarkCode();
      const at = new Date(Date.now() - ageDays * day);
      return admin.forensicWatermark.create({
        data: {
          code,
          sessionKey: randomUUID().replace(/-/g, '').padEnd(64, '0'),
          surface: 'lesson_video',
          userId: w.learner.userId,
          academyId: w.academy.id,
          courseId: w.course.id,
          lessonId: w.videoLesson.id,
          issuedAt: at,
          lastSeenAt: at,
        },
      });
    };
    const ancient = await seed(800);
    const old = await seed(120);
    const fresh = await seed(10);

    await maintenance.pruneForensicWatermarks();
    expect(
      await admin.forensicWatermark.findUnique({ where: { id: ancient.id } }),
    ).toBeNull();
    expect(
      await admin.forensicWatermark.findUnique({ where: { id: old.id } }),
    ).not.toBeNull();
    expect(
      await admin.forensicWatermark.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();

    // A cutoff of "now" (a misconfiguration) still cannot erase the last 90 days.
    const po = await platformOwner('wm09-po');
    await tenancy.runInUserContext(po.userId, (tx) =>
      watermarks.pruneOlderThan(tx, new Date()),
    );
    expect(
      await admin.forensicWatermark.findUnique({ where: { id: old.id } }),
    ).toBeNull();
    expect(
      await admin.forensicWatermark.findUnique({ where: { id: fresh.id } }),
    ).not.toBeNull();
  });

  it('WM-10 — fail closed: no playable video when issuance fails', async () => {
    const w = await world('wm10');
    const before = await admin.contentAccessLog.count({
      where: { lessonId: w.videoLesson.id, result: 'granted' },
    });
    const broken = jest.spyOn(cipher, 'encrypt').mockImplementation(() => {
      throw new Error('KMS unavailable');
    });
    try {
      await expect(
        content.getContent(w.course.id, w.videoLesson.id, learnerContext(w)),
      ).rejects.toMatchObject({
        status: 503,
        response: expect.objectContaining({
          messageKey: 'errors.learning.watermarkUnavailable',
        }),
      });
    } finally {
      broken.mockRestore();
    }
    expect(
      await admin.contentAccessLog.count({
        where: { lessonId: w.videoLesson.id, result: 'granted' },
      }),
    ).toBe(before);
    expect(
      await admin.contentAccessLog.findFirst({
        where: {
          lessonId: w.videoLesson.id,
          result: 'refused',
          reason: 'watermarkUnavailable',
        },
      }),
    ).not.toBeNull();
    expect(
      await admin.forensicWatermark.count({ where: { lessonId: w.videoLesson.id } }),
    ).toBe(0);
    // No lease was left behind by the refused grant.
    expect(await leases.current(w.learner.userId, w.academy.id)).toBeNull();
  });

  it('WM-11 — RLS: nobody but a Platform Owner reads it; nobody writes it directly; tamper counts only your own code', async () => {
    const w = await world('wm11');
    const grant = await content.getContent(
      w.course.id,
      w.videoLesson.id,
      learnerContext(w),
    );
    await releaseLease(w, grant.playbackLease?.leaseId);
    const code = grant.watermark.code!.replace('-', '');

    const learnerSees = await tenancy.runInUserContext(w.learner.userId, (tx) =>
      tx.forensicWatermark.count(),
    );
    const tenantSees = await tenancy.runInTenantAndUserContext(
      w.org.id,
      w.owner.userId,
      (tx) => tx.forensicWatermark.count(),
    );
    const anonymousSees = await tenancy.runWithoutContext((tx) =>
      tx.forensicWatermark.count(),
    );
    expect([learnerSees, tenantSees, anonymousSees]).toEqual([0, 0, 0]);

    await expect(
      tenancy.runInUserContext(w.learner.userId, (tx) =>
        tx.forensicWatermark.create({
          data: {
            code: 'ZZZZZZZZZ0',
            sessionKey: 'f'.repeat(64),
            surface: 'lesson_video',
            userId: w.learner.userId,
            academyId: w.academy.id,
            courseId: w.course.id,
            lessonId: w.videoLesson.id,
          },
        }),
      ),
    ).rejects.toThrow();
    await expect(
      tenancy.runInUserContext(
        w.learner.userId,
        (tx) => tx.$executeRaw`UPDATE forensic_watermarks SET tamper_event_count = 0`,
      ),
    ).resolves.toBe(0);

    // Somebody else's tamper report never lands on this code.
    await http()
      .post('/learning/watermarks/tamper')
      .set(bearer(w.owner.token))
      .send({ code })
      .expect(204);
    expect((await rowFor(code)).tamperEventCount).toBe(0);
    // The viewer's own player reporting tampering is counted, and throttled.
    await http()
      .post('/learning/watermarks/tamper')
      .set(bearer(w.learner.token))
      .send({ code })
      .expect(204);
    await http()
      .post('/learning/watermarks/tamper')
      .set(bearer(w.learner.token))
      .send({ code })
      .expect(204);
    expect((await rowFor(code)).tamperEventCount).toBe(1);

    // The heartbeat refreshes last-seen through its own narrow function.
    await admin.forensicWatermark.update({
      where: { code },
      data: { lastSeenAt: new Date(Date.now() - 10 * 60_000) },
    });
    await watermarks.touchFromHeartbeat({
      userId: w.learner.userId,
      sessionId: w.learner.sessionId,
      lessonId: w.videoLesson.id,
    });
    expect((await rowFor(code)).lastSeenAt.getTime()).toBeGreaterThan(
      Date.now() - 60_000,
    );
  });
});
