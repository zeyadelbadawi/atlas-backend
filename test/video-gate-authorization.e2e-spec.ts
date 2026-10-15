/**
 * Workstream D — the Normal tier's delivery Worker re-authorizing a
 * playback token (`POST /video-gate/authorize`), against the real
 * application: real Postgres with FORCE RLS and the `atlas_app` role, real
 * Redis, the real grant path minting the token, and the real revocation
 * paths (sign-out, device removal, account deletion, enrollment revocation,
 * block). Every call is signed exactly as `deploy/video-gate-worker/src/authz.js`
 * signs it. No object storage is touched: the grant only signs a URL.
 *
 *   VGA-01  an entitled learner's token is allowed; the grant reports
 *           `revocableBeforeExpiry: true`; the call must be HMAC-signed and
 *           fresh, and its body well-formed
 *   VGA-02  sign-out / revoke-session → denied on the very next call; the
 *           learner's OTHER session keeps playing
 *   VGA-03  device removed → denied immediately
 *   VGA-04  account deleted → denied immediately
 *   VGA-05  enrollment revoked → denied for that course only; blocked
 *           membership → denied
 *   VGA-06  tenant isolation: another academy's key, a scope naming another
 *           academy or course, a lesson of another course, and a learner of
 *           academy A holding a correctly signed token for academy B's
 *           lesson are all denied
 *   VGA-07  staff-preview and open-preview tokens are honoured exactly as
 *           long as the preview is; an anonymous hosted-video token (which
 *           the grant never mints) is refused
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createHmac, randomUUID } from 'node:crypto';
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
import { LearnerSessionService } from '../src/learning/services/learner-session.service';
import { AcademyStudentsService } from '../src/learning/services/academy-students.service';
import { BasicVideoProvider } from '../src/media/video/basic-video.provider';
import { hashDeviceCookie } from '../src/tenancy/services/student-device.service';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery-vga';
const SIGNING_SECRET = 'vga-basic-video-signing-secret-not-real';
const AUTHZ_SECRET = 'vga-gate-authz-secret-not-real-0123456789abcdef';
const DELIVERY_HOST = 'video.vga.test';

const MUTATED_ENV = {
  BASIC_VIDEO_DELIVERY_HOST: DELIVERY_HOST,
  BASIC_VIDEO_SIGNING_SECRET: SIGNING_SECRET,
  BASIC_VIDEO_GATE_AUTHZ_SECRET: AUTHZ_SECRET,
  BASIC_VIDEO_PLAYBACK_TTL_SECONDS: '600',
} as const;
const ENV_BEFORE = new Map<string, string | undefined>(
  Object.keys(MUTATED_ENV).map((key) => [key, process.env[key]]),
);

describe('Workstream D — video gate re-authorization (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let content: LessonContentService;
  let leases: LearningLeaseService;
  let learnerSessions: LearnerSessionService;
  let roster: AcademyStudentsService;
  let gate: BasicVideoProvider;
  let flush: () => Promise<void>;

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // Real configuration path: the gate, its token signer and the
    // authorization secret all come from the environment, as in production.
    Object.assign(process.env, MUTATED_ENV);
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    content = app.get(LessonContentService, { strict: false });
    leases = app.get(LearningLeaseService, { strict: false });
    learnerSessions = app.get(LearnerSessionService, { strict: false });
    roster = app.get(AcademyStudentsService, { strict: false });
    gate = app.get(BasicVideoProvider, { strict: false });
  });

  afterAll(async () => {
    for (const [key, value] of ENV_BEFORE) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  // --- the Worker's call ---------------------------------------------------

  function authorize(
    token: string,
    objectKey: string,
    options: { secret?: string; timestamp?: number; rawBody?: string } = {},
  ) {
    const body = options.rawBody ?? JSON.stringify({ token, objectKey });
    const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
    const signature = createHmac('sha256', options.secret ?? AUTHZ_SECRET)
      .update(`${timestamp}.${body}`)
      .digest('hex');
    return http()
      .post('/video-gate/authorize')
      .set('Content-Type', 'application/json')
      .set('x-atlas-gate-timestamp', timestamp)
      .set('x-atlas-gate-signature', signature)
      .send(body);
  }

  async function expectAllowed(token: string, objectKey: string) {
    const response = await authorize(token, objectKey).expect(200);
    expect(response.body).toMatchObject({ allow: true });
    expect(response.body.ttlSeconds).toBeGreaterThan(0);
    expect(response.body.ttlSeconds).toBeLessThanOrEqual(30);
  }

  async function expectDenied(token: string, objectKey: string, reasons: string[]) {
    const response = await authorize(token, objectKey).expect(200);
    expect(response.body.allow).toBe(false);
    expect(reasons).toContain(response.body.reason);
  }

  // --- fixtures ------------------------------------------------------------

  async function signedIn(label: string) {
    await flush();
    const email = uniqueTestEmail(label);
    const registered = await http()
      .post('/auth/register')
      .send({ name: `VGA ${label}`, email, password: PASSWORD });
    if (registered.status !== 201) throw new Error(JSON.stringify(registered.body));
    return signInAgain(email);
  }

  async function signInAgain(email: string, academyId?: string) {
    await flush();
    const signIn = await http()
      .post('/auth/sign-in')
      .send({
        email,
        password: PASSWORD,
        ...(academyId ? { surface: 'academy', academyId } : {}),
      });
    if (signIn.status !== 200) throw new Error(JSON.stringify(signIn.body));
    const userId = signIn.body.user.id as string;
    const session = await admin.refreshToken.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
    return {
      email,
      userId,
      sessionId: session.sessionId,
      token: signIn.body.accessToken as string,
    };
  }

  async function hostedVideoLesson(
    academyId: string,
    courseId: string,
    sectionId: string,
    label: string,
    order: number,
    preview = false,
  ) {
    const assetId = randomUUID();
    const asset = await admin.mediaAsset.create({
      data: {
        id: assetId,
        academyId,
        courseId,
        type: 'video',
        fileName: `${assetId}.mp4`,
        storageKey: '',
        url: '',
        mimeType: 'video/mp4',
        sizeBytes: BigInt(0),
        access: 'protected',
        provider: 'r2_worker',
        providerId: `academies/${academyId}/courses/${courseId}/${assetId}.mp4`,
        processingStatus: 'ready',
        durationSeconds: 120,
        durationSource: 'parsed',
        securityTier: 'normal',
      },
    });
    const lesson = await seedCourseLesson(admin, sectionId, courseId, label, order, {
      status: 'published',
      contentType: 'video',
      videoAssetId: asset.id,
    });
    if (preview) {
      await admin.courseLesson.update({
        where: { id: lesson.id },
        data: { isPreview: true },
      });
    }
    return { lesson, key: asset.providerId! };
  }

  /** An academy with two courses of hosted video, an owner and an enrolled learner on a registered device. */
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
    const otherCourse = await seedCourse(admin, academy.id, `${label} Other`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    const otherSection = await seedCourseSection(admin, otherCourse.id, `${label}-s2`, 0);
    const video = await hostedVideoLesson(
      academy.id,
      course.id,
      section.id,
      `${label} v`,
      0,
    );
    const preview = await hostedVideoLesson(
      academy.id,
      course.id,
      section.id,
      `${label} p`,
      1,
      true,
    );
    const otherVideo = await hostedVideoLesson(
      academy.id,
      otherCourse.id,
      otherSection.id,
      `${label} o`,
      0,
    );

    await admin.academyStudent.create({
      data: {
        academyId: academy.id,
        userId: learner.userId,
        status: 'active',
        source: 'staff_created',
      },
    });
    const enrollment = await seedEnrollment(admin, learner.userId, course.id, academy.id);
    const otherEnrollment = await seedEnrollment(
      admin,
      learner.userId,
      otherCourse.id,
      academy.id,
    );
    const deviceCookie = randomUUID();
    const device = await admin.studentDevice.create({
      data: {
        userId: learner.userId,
        academyId: academy.id,
        cookieHash: hashDeviceCookie(deviceCookie),
        label: 'Chrome on macOS',
      },
    });
    return {
      owner,
      learner,
      org,
      academy,
      course,
      otherCourse,
      video,
      preview,
      otherVideo,
      enrollment,
      otherEnrollment,
      deviceCookie,
      device,
    };
  }
  type World = Awaited<ReturnType<typeof world>>;

  function learnerContext(
    w: World,
    learner: { userId: string; sessionId: string } = w.learner,
  ): ContentRequestContext {
    return {
      userId: learner.userId,
      sessionId: learner.sessionId,
      hostAcademyId: w.academy.id,
      deviceCookie: w.deviceCookie,
      userAgent: 'Mozilla/5.0 (Macintosh) Chrome/126.0',
      clientIp: '203.0.113.20',
      country: 'EG',
      requestHost: 'learn.vga.test',
    };
  }

  /** A real grant through `LessonContentService`, returning the token the Worker would see. */
  async function grantToken(
    w: World,
    lessonId: string,
    courseId: string,
    context: ContentRequestContext,
  ) {
    const grant = await content.getContent(courseId, lessonId, context);
    if (grant.playbackLease?.leaseId && context.userId) {
      await leases.release(context.userId, w.academy.id, grant.playbackLease.leaseId);
    }
    const url = new URL(grant.video!.url);
    expect(url.host).toBe(DELIVERY_HOST);
    return { token: url.searchParams.get('t')!, grant };
  }

  // --- tests ---------------------------------------------------------------

  it('VGA-01 — an entitled learner is allowed; the call must be signed, fresh and well-formed', async () => {
    const w = await world('vga01');
    const { token, grant } = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w),
    );
    // Honest now: the gate can withdraw this credential before it expires.
    expect(grant.protection).toMatchObject({
      tier: 'normal',
      revocableBeforeExpiry: true,
    });
    const claims = gate.verifyGateToken(token).claims!;
    expect(claims).toMatchObject({
      a: w.academy.id,
      c: w.course.id,
      l: w.video.lesson.id,
      u: w.learner.userId,
      s: w.learner.sessionId,
      d: w.device.id,
    });

    await expectAllowed(token, w.video.key);

    // Caller authentication.
    await authorize(token, w.video.key, { secret: 'x'.repeat(48) }).expect(401);
    await authorize(token, w.video.key, {
      timestamp: Math.floor(Date.now() / 1000) - 120,
    }).expect(401);
    await http()
      .post('/video-gate/authorize')
      .send({ token, objectKey: w.video.key })
      .expect(401);
    // Body shape, once authenticated.
    await authorize(token, w.video.key, { rawBody: JSON.stringify({ token }) }).expect(
      400,
    );
    await authorize(token, w.video.key, { rawBody: 'not json' }).expect(400);
    // A tampered token.
    const [payload] = token.split('.');
    await expectDenied(`${payload}.${'0'.repeat(64)}`, w.video.key, ['invalid_token']);
  });

  it('VGA-02 — sign-out and revoke-session deny on the next call; the other session keeps playing', async () => {
    const w = await world('vga02');
    const second = await signInAgain(w.learner.email, w.academy.id);
    const first = await grantToken(w, w.video.lesson.id, w.course.id, learnerContext(w));
    const other = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w, second),
    );
    await expectAllowed(first.token, w.video.key);
    await expectAllowed(other.token, w.video.key);

    await http().post('/auth/sign-out').set(bearer(w.learner.token)).expect(200);
    await expectDenied(first.token, w.video.key, ['session_revoked']);
    // Per session: the learner's other browser is untouched.
    await expectAllowed(other.token, w.video.key);

    // Revoking that one from a third session (the settings page).
    const third = await signInAgain(w.learner.email, w.academy.id);
    await http()
      .delete(`/auth/sessions/${second.sessionId}`)
      .set(bearer(third.token))
      .expect(204);
    await expectDenied(other.token, w.video.key, ['session_revoked']);
  });

  it('VGA-03 — removing the device denies its token immediately', async () => {
    const w = await world('vga03');
    const { token } = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w),
    );
    await expectAllowed(token, w.video.key);

    await learnerSessions.removeDevice(w.learner.userId, w.academy.id, w.device.id);
    expect(
      (await admin.studentDevice.findUniqueOrThrow({ where: { id: w.device.id } }))
        .revokedAt,
    ).not.toBeNull();
    // The removal revokes the sessions bound to the device too; whichever
    // check meets it first, the token is refused.
    await expectDenied(token, w.video.key, ['device_revoked', 'session_revoked']);
  });

  it('VGA-04 — deleting the account denies its tokens immediately', async () => {
    const w = await world('vga04');
    const { token } = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w),
    );
    await expectAllowed(token, w.video.key);

    const { challengeId, code } = await deletionCodeFor(app, admin, w.learner.token);
    await http()
      .post('/users/me/delete')
      .set(bearer(w.learner.token))
      .send({ confirm: true, challengeId, code })
      .expect(200);
    await expectDenied(token, w.video.key, ['account_inactive']);
  });

  it('VGA-05 — a revoked enrollment denies that course only; a block denies the academy', async () => {
    const w = await world('vga05');
    const course1 = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w),
    );
    const course2 = await grantToken(
      w,
      w.otherVideo.lesson.id,
      w.otherCourse.id,
      learnerContext(w),
    );
    await expectAllowed(course1.token, w.video.key);
    await expectAllowed(course2.token, w.otherVideo.key);

    await roster.revoke(w.academy.id, w.org.id, w.owner.userId, w.enrollment.id, {});
    await expectDenied(course1.token, w.video.key, [
      'access_ended',
      'lesson_unavailable',
    ]);
    // Scoped to the course whose entitlement ended.
    await expectAllowed(course2.token, w.otherVideo.key);

    await roster.block(w.academy.id, w.org.id, w.owner.userId, w.learner.userId, {});
    await expectDenied(course2.token, w.otherVideo.key, [
      'session_revoked',
      'access_ended',
      'lesson_unavailable',
    ]);
  });

  it('VGA-06 — tenant and course isolation', async () => {
    const w = await world('vga06');
    const foreign = await world('vga06-foreign');
    const { token } = await grantToken(
      w,
      w.video.lesson.id,
      w.course.id,
      learnerContext(w),
    );

    // The same token for another academy's object, or another course's.
    await expectDenied(token, foreign.video.key, ['key_mismatch']);
    await expectDenied(token, w.otherVideo.key, ['key_mismatch']);

    // Correctly signed tokens whose scope disagrees with the bytes.
    const mint = (
      providerId: string,
      scope: { academyId: string; courseId: string; lessonId: string },
      who = {
        userId: w.learner.userId,
        sessionId: w.learner.sessionId,
        deviceId: w.device.id,
      },
    ) =>
      gate
        .issuePlaybackToken({
          providerId,
          expiresAt: new Date(Date.now() + 600_000),
          binding: who,
          scope,
          allowedOrigins: [],
        })
        .then((descriptor) => descriptor.token!);

    await expectDenied(
      await mint(w.video.key, {
        academyId: foreign.academy.id,
        courseId: w.course.id,
        lessonId: w.video.lesson.id,
      }),
      w.video.key,
      ['academy_mismatch'],
    );
    await expectDenied(
      await mint(w.video.key, {
        academyId: w.academy.id,
        courseId: w.otherCourse.id,
        lessonId: w.video.lesson.id,
      }),
      w.video.key,
      ['course_mismatch'],
    );
    // A lesson that belongs to another course than the one named.
    await expectDenied(
      await mint(w.otherVideo.key, {
        academyId: w.academy.id,
        courseId: w.otherCourse.id,
        lessonId: w.video.lesson.id,
      }),
      w.otherVideo.key,
      ['lesson_unavailable'],
    );
    // A lesson whose video is not these bytes (same academy and course).
    await expectDenied(
      await mint(w.preview.key, {
        academyId: w.academy.id,
        courseId: w.course.id,
        lessonId: w.video.lesson.id,
      }),
      w.preview.key,
      ['asset_mismatch'],
    );
    // A learner of academy A holding a properly signed token for academy
    // B's lesson: RLS and the entitlement checks refuse it.
    await expectDenied(
      await mint(foreign.video.key, {
        academyId: foreign.academy.id,
        courseId: foreign.course.id,
        lessonId: foreign.video.lesson.id,
      }),
      foreign.video.key,
      ['lesson_unavailable', 'device_revoked', 'access_ended'],
    );
  });

  it('VGA-07 — staff and anonymous preview tokens are honoured exactly as long as the preview is', async () => {
    const w = await world('vga07');

    // Staff preview: the owner's own session, no device.
    const staff = await grantToken(w, w.video.lesson.id, w.course.id, {
      userId: w.owner.userId,
      sessionId: w.owner.sessionId,
      hostAcademyId: w.academy.id,
      clientIp: '203.0.113.21',
      requestHost: 'learn.vga.test',
    });
    expect(gate.verifyGateToken(staff.token).claims?.d).toBe('anonymous');
    await expectAllowed(staff.token, w.video.key);
    // No longer staff of this academy.
    await admin.academyMember.deleteMany({
      where: { academyId: w.academy.id, userId: w.owner.userId },
    });
    await expectDenied(staff.token, w.video.key, [
      'device_revoked',
      'lesson_unavailable',
    ]);

    // A signed-in visitor who is NOT enrolled, on an open preview lesson:
    // honoured while the lesson is a preview, refused once it is not.
    const visitor = await signedIn('vga07-visitor');
    const visitorCookie = randomUUID();
    await admin.studentDevice.create({
      data: {
        userId: visitor.userId,
        academyId: w.academy.id,
        cookieHash: hashDeviceCookie(visitorCookie),
        label: 'Firefox on Linux',
      },
    });
    const previewGrant = await grantToken(w, w.preview.lesson.id, w.course.id, {
      ...learnerContext(w, visitor),
      deviceCookie: visitorCookie,
    });
    await expectAllowed(previewGrant.token, w.preview.key);
    await admin.courseLesson.update({
      where: { id: w.preview.lesson.id },
      data: { isPreview: false },
    });
    await expectDenied(previewGrant.token, w.preview.key, ['access_ended']);

    // An anonymous visitor is never granted a hosted (`r2_worker`) video —
    // RLS hides the protected asset from the anonymous context, so the
    // grant answers `noContent` — and the gate agrees with the grant: an
    // anonymous token for one (only mintable with the signing secret) is
    // refused.
    await expect(
      content.getContent(w.course.id, w.video.lesson.id, {
        userId: null,
        sessionId: null,
        hostAcademyId: w.academy.id,
        clientIp: '203.0.113.22',
      }),
    ).rejects.toThrow();
    const anonymousToken = (
      await gate.issuePlaybackToken({
        providerId: w.video.key,
        expiresAt: new Date(Date.now() + 600_000),
        binding: { userId: 'anonymous', sessionId: 'anonymous', deviceId: 'anonymous' },
        scope: {
          academyId: w.academy.id,
          courseId: w.course.id,
          lessonId: w.video.lesson.id,
        },
        allowedOrigins: [],
      })
    ).token!;
    await expectDenied(anonymousToken, w.video.key, [
      'asset_mismatch',
      'lesson_unavailable',
      'preview_ended',
    ]);
  });
});
