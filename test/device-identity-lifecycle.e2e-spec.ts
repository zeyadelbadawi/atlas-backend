/**
 * Device Identity + Device-Limit fix — the device lifecycle end to end.
 * Real PostgreSQL and Redis, real HTTP; each "browser" below is a cookie
 * jar of its own (`atlas_device` + the session's refresh token).
 *
 * ROOT CAUSE (proven first in a real browser): a browser that signed in
 * while the learner was at their device limit was given no device
 * identity. Removing a device from the limit dialog freed a slot, the next
 * lesson grant registered a row whose cookie it could never send back
 * (announcing "New device added"), and the request after it was refused
 * with `deviceLimit` again. Every retry added another identical row and
 * another notification.
 *
 *   DV-01  first sign-in registers one device and announces it once;
 *          sign-out → sign-in on the same browser is the SAME device
 *   DV-02  many tabs of one browser → one device
 *   DV-03  a different browser is a different device; a different
 *          account on the same browser gets its own device
 *   DV-04  cleared browser storage → a new device (expected), within the cap
 *   DV-05  at the limit: sign-in succeeds and gives the browser an
 *          identity, registers nothing, and content is refused
 *   DV-06  terminate (the one endpoint the dialog AND Settings use) → the
 *          removed device can neither refresh nor use its access token,
 *          and the waiting browser continues as exactly ONE new device
 *   DV-07  a session minted at the limit is bound to the device it then
 *          registers, so removing that device ends it
 *   DV-08  a removed device's stale cookie never revives its old row
 *   DV-09  the server stays authoritative under concurrent registration
 *   DV-10  isolation: another learner cannot remove the device; a device
 *          at one academy is not counted at another
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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
import { sessionTokenFrom } from './utils/session-cookie';
import {
  DEVICE_COOKIE_NAME,
  hashDeviceCookie,
} from '../src/tenancy/services/student-device.service';
import { LearningLeaseService } from '../src/learning/services/learning-lease.service';

jest.setTimeout(240000);
const PASSWORD = 'correct-horse-battery-devices';
const CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const REGISTERED_TITLE = 'notifications:events.deviceRegistered.title';

interface Browser {
  device: string | null;
  accessToken: string | null;
  refreshToken: string | null;
}

describe('Device identity and device-limit lifecycle (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flush();
  });

  const http = () => request(app.getHttpServer());
  const newBrowser = (): Browser => ({
    device: null,
    accessToken: null,
    refreshToken: null,
  });

  function readDevice(res: request.Response): string | null {
    const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
    const cookie = (raw ?? []).find((c) => c.startsWith(`${DEVICE_COOKIE_NAME}=`));
    if (!cookie) return null;
    return decodeURIComponent(cookie.split(';')[0].slice(DEVICE_COOKIE_NAME.length + 1));
  }

  /** Applies a response's cookies to the browser, as a real one would. */
  function absorb(browser: Browser, res: request.Response): void {
    browser.device = readDevice(res) ?? browser.device;
    browser.refreshToken = sessionTokenFrom(res) ?? browser.refreshToken;
  }

  function cookieHeader(browser: Browser): string {
    return browser.device ? `${DEVICE_COOKIE_NAME}=${browser.device}` : '';
  }

  async function world(label: string, maxDevices = 2) {
    const owner = await admin.user.create({
      data: { email: uniqueTestEmail(`${label}-owner`), name: `${label} owner` },
    });
    const org = await seedOrganizationWithOwner(admin, owner.id, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.id, 'owner');
    await admin.accessPolicy.create({
      data: {
        scope: 'academy',
        academyId: academy.id,
        maxDevices,
        maxConcurrentSessions: 1,
      },
    });
    const course = await seedCourse(admin, academy.id, `${label} Course`, {
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
    });
    const section = await seedCourseSection(admin, course.id, `${label}-s`, 0);
    const lesson = await seedCourseLesson(admin, section.id, course.id, `${label}-l`, 0, {
      status: 'published',
      contentType: 'text',
    });
    await admin.lessonContent.create({
      data: {
        lessonId: lesson.id,
        courseId: course.id,
        academyId: academy.id,
        kind: 'text',
        bodyHtml: '<p>lesson</p>',
      },
    });
    return { academy, course, lesson };
  }

  async function learner(w: Awaited<ReturnType<typeof world>>, label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({
        name: 'Device Learner',
        email,
        password: PASSWORD,
        academyId: w.academy.id,
      })
      .expect(201);
    const user = await admin.user.findUniqueOrThrow({ where: { email } });
    await seedEnrollment(admin, user.id, w.course.id, w.academy.id, {
      status: 'enrolled',
    });
    return { email, userId: user.id };
  }

  async function signIn(browser: Browser, email: string, academyId: string) {
    await flush();
    const res = await http()
      .post('/auth/sign-in')
      .set('User-Agent', CHROME)
      .set('Cookie', cookieHeader(browser))
      .send({ email, password: PASSWORD, surface: 'academy', academyId })
      .expect(200);
    absorb(browser, res);
    browser.accessToken = res.body.accessToken as string;
    return res;
  }

  async function grant(browser: Browser, w: Awaited<ReturnType<typeof world>>) {
    const res = await http()
      .get(`/learning/courses/${w.course.id}/lessons/${w.lesson.id}/content`)
      .set('User-Agent', CHROME)
      .set('Authorization', `Bearer ${browser.accessToken}`)
      .set('Cookie', cookieHeader(browser));
    absorb(browser, res);
    return res;
  }

  async function releaseLease(userId: string, academyId: string) {
    // One learning session at a time is a separate rule (the lease); these
    // tests are about devices, so a previous browser's lease is let go.
    await app.get(LearningLeaseService, { strict: false }).revokeAll(userId, academyId);
  }

  const activeDevices = (userId: string, academyId: string) =>
    admin.studentDevice.count({ where: { userId, academyId, revokedAt: null } });
  const allDevices = (userId: string, academyId: string) =>
    admin.studentDevice.count({ where: { userId, academyId } });
  const announcements = (userId: string) =>
    admin.notification.count({ where: { userId, titleKey: REGISTERED_TITLE } });

  function removeDevice(browser: Browser, academyId: string, deviceId: string) {
    return http()
      .delete(`/learning/devices/${deviceId}`)
      .query({ academyId })
      .set('Authorization', `Bearer ${browser.accessToken}`)
      .set('Cookie', cookieHeader(browser));
  }

  async function deviceIdOf(browser: Browser, userId: string, academyId: string) {
    const row = await admin.studentDevice.findFirstOrThrow({
      where: {
        userId,
        academyId,
        cookieHash: hashDeviceCookie(browser.device as string),
      },
    });
    return row.id;
  }

  it('DV-01 — first sign-in is a new device, announced once; sign-out → sign-in is the same device', async () => {
    const w = await world('dv01');
    const l = await learner(w, 'dv01');
    const browser = newBrowser();

    await signIn(browser, l.email, w.academy.id);
    expect(browser.device).toMatch(/^[0-9a-f]{64}$/);
    const firstDevice = browser.device;
    expect(await activeDevices(l.userId, w.academy.id)).toBe(1);
    expect(await announcements(l.userId)).toBe(1);

    await http()
      .post('/auth/sign-out')
      .set('Authorization', `Bearer ${browser.accessToken}`)
      .send({ refreshToken: browser.refreshToken })
      .expect(200);
    const again = await signIn(browser, l.email, w.academy.id);
    expect(readDevice(again)).toBeNull(); // nothing new to give it
    expect(browser.device).toBe(firstDevice);
    expect((await grant(browser, w)).status).toBe(200);

    expect(await allDevices(l.userId, w.academy.id)).toBe(1);
    expect(await announcements(l.userId)).toBe(1);
  });

  it('DV-02 — many tabs of one browser are one device', async () => {
    const w = await world('dv02');
    const l = await learner(w, 'dv02');
    const browser = newBrowser();
    await signIn(browser, l.email, w.academy.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => grant({ ...browser }, w)),
    );
    for (const res of results) expect([200, 409]).toContain(res.status);
    expect(await allDevices(l.userId, w.academy.id)).toBe(1);
    expect(await announcements(l.userId)).toBe(1);
  });

  it('DV-03 — another browser is another device; another account on this browser gets its own', async () => {
    const w = await world('dv03', 3);
    const a = await learner(w, 'dv03-a');
    const b = await learner(w, 'dv03-b');
    const laptop = newBrowser();
    const phone = newBrowser();

    await signIn(laptop, a.email, w.academy.id);
    await signIn(phone, a.email, w.academy.id);
    expect(phone.device).not.toBe(laptop.device);
    expect(await activeDevices(a.userId, w.academy.id)).toBe(2);

    // B signs in on A's laptop: the laptop's identity belongs to A's row, so
    // B is given an identity of its own and A's device is untouched.
    const shared = { ...laptop };
    await signIn(shared, b.email, w.academy.id);
    expect(shared.device).not.toBe(laptop.device);
    expect(await activeDevices(b.userId, w.academy.id)).toBe(1);
    expect(await activeDevices(a.userId, w.academy.id)).toBe(2);
  });

  it('DV-04 — cleared browser storage is a new device, still governed by the cap', async () => {
    const w = await world('dv04');
    const l = await learner(w, 'dv04');
    const browser = newBrowser();
    await signIn(browser, l.email, w.academy.id);
    const before = browser.device;

    const cleared = newBrowser();
    await signIn(cleared, l.email, w.academy.id);
    expect(cleared.device).not.toBe(before);
    expect(await activeDevices(l.userId, w.academy.id)).toBe(2);
    expect(await announcements(l.userId)).toBe(2);
  });

  it('DV-05 — at the limit: sign-in works and gives an identity, registers nothing, content is refused', async () => {
    const w = await world('dv05');
    const l = await learner(w, 'dv05');
    await signIn(newBrowser(), l.email, w.academy.id);
    await signIn(newBrowser(), l.email, w.academy.id);

    const third = newBrowser();
    await signIn(third, l.email, w.academy.id);
    expect(third.device).toMatch(/^[0-9a-f]{64}$/);
    expect(await activeDevices(l.userId, w.academy.id)).toBe(2);

    const refused = await grant(third, w);
    expect(refused.status).toBe(403);
    expect(refused.body.error.messageKey).toBe('errors.learning.deviceLimit');
    expect((await grant(third, w)).status).toBe(403);
    expect(await allDevices(l.userId, w.academy.id)).toBe(2);
    expect(await announcements(l.userId)).toBe(2);
  });

  it('DV-06 — terminating a device from the limit dialog revokes it for real, and the waiting browser continues as ONE new device', async () => {
    const w = await world('dv06');
    const l = await learner(w, 'dv06');
    const first = newBrowser();
    const second = newBrowser();
    await signIn(first, l.email, w.academy.id);
    await signIn(second, l.email, w.academy.id);
    const third = newBrowser();
    await signIn(third, l.email, w.academy.id);
    expect((await grant(third, w)).status).toBe(403);

    // The dialog lists the devices and removes one through the same
    // endpoint the Settings page uses.
    const listed = await http()
      .get('/learning/devices')
      .query({ academyId: w.academy.id })
      .set('Authorization', `Bearer ${third.accessToken}`)
      .expect(200);
    expect(listed.body.devices).toHaveLength(2);
    const firstId = await deviceIdOf(first, l.userId, w.academy.id);
    await removeDevice(third, w.academy.id, firstId).expect(204);

    // The removed device is really out: no refresh, and its access token is
    // refused at once (not after it expires).
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: first.refreshToken })
      .expect(401);
    await http()
      .get('/auth/validate')
      .set('Authorization', `Bearer ${first.accessToken}`)
      .expect(401);

    // The waiting browser: the refetched grant succeeds, registering the
    // identity it already holds — no new cookie, one row, one announcement.
    const identityBefore = third.device;
    const continued = await grant(third, w);
    expect(continued.status).toBe(200);
    expect(readDevice(continued)).toBeNull();
    expect(third.device).toBe(identityBefore);
    // …and a second request (the dialog's own retry, another tab) is the
    // same device, not a fresh refusal.
    expect((await grant(third, w)).status).toBe(200);

    expect(await activeDevices(l.userId, w.academy.id)).toBe(2);
    expect(await allDevices(l.userId, w.academy.id)).toBe(3); // first (revoked), second, third
    expect(await announcements(l.userId)).toBe(3);

    // The untouched device keeps working.
    await releaseLease(l.userId, w.academy.id);
    expect((await grant(second, w)).status).toBe(200);
  });

  it('DV-07 — a session minted at the limit is bound to the device it registers, so removing it ends that session', async () => {
    const w = await world('dv07');
    const l = await learner(w, 'dv07');
    const first = newBrowser();
    await signIn(first, l.email, w.academy.id);
    await signIn(newBrowser(), l.email, w.academy.id);
    const third = newBrowser();
    await signIn(third, l.email, w.academy.id);
    await removeDevice(
      third,
      w.academy.id,
      await deviceIdOf(first, l.userId, w.academy.id),
    ).expect(204);
    expect((await grant(third, w)).status).toBe(200);

    const thirdDeviceId = await deviceIdOf(third, l.userId, w.academy.id);
    const bound = await admin.refreshToken.count({
      where: { userId: l.userId, deviceId: thirdDeviceId, revokedAt: null },
    });
    expect(bound).toBeGreaterThan(0);

    // Removed from somewhere else (Settings on the other device):
    const other = newBrowser();
    other.accessToken = third.accessToken; // same learner, any of their sessions
    await removeDevice(other, w.academy.id, thirdDeviceId).expect(204);
    await http()
      .post('/auth/refresh')
      .send({ refreshToken: third.refreshToken })
      .expect(401);
  });

  it("DV-08 — a removed device's stale cookie never revives its old row", async () => {
    const w = await world('dv08');
    const l = await learner(w, 'dv08');
    const victim = newBrowser();
    const keeper = newBrowser();
    await signIn(victim, l.email, w.academy.id);
    await signIn(keeper, l.email, w.academy.id);
    const victimId = await deviceIdOf(victim, l.userId, w.academy.id);
    await removeDevice(keeper, w.academy.id, victimId).expect(204);

    // The removed browser signs back in presenting its old cookie: a NEW
    // identity and a new row (re-counted against the cap), the old row stays revoked.
    const staleCookie = victim.device;
    await signIn(victim, l.email, w.academy.id);
    expect(victim.device).not.toBe(staleCookie);
    const old = await admin.studentDevice.findUniqueOrThrow({ where: { id: victimId } });
    expect(old.revokedAt).not.toBeNull();
    expect(await activeDevices(l.userId, w.academy.id)).toBe(2);

    // Forcing the stale value on the grant path gets nowhere either.
    const forced = { ...victim, device: staleCookie };
    await releaseLease(l.userId, w.academy.id);
    const res = await grant(forced, w);
    expect(res.status).toBe(403);
    expect(
      (await admin.studentDevice.findUniqueOrThrow({ where: { id: victimId } }))
        .revokedAt,
    ).not.toBeNull();
  });

  it('DV-09 — concurrent registrations never exceed the cap', async () => {
    const w = await world('dv09');
    const l = await learner(w, 'dv09');
    await signIn(newBrowser(), l.email, w.academy.id);
    await signIn(newBrowser(), l.email, w.academy.id);
    const waiting = [newBrowser(), newBrowser(), newBrowser()];
    for (const browser of waiting) await signIn(browser, l.email, w.academy.id);
    // Free exactly one slot, then let three waiting browsers race for it.
    const anyRow = await admin.studentDevice.findFirstOrThrow({
      where: { userId: l.userId, academyId: w.academy.id, revokedAt: null },
    });
    await removeDevice(waiting[0], w.academy.id, anyRow.id).expect(204);

    const results = await Promise.all(waiting.map((browser) => grant(browser, w)));
    const registered = results.filter((r) => r.status !== 403);
    expect(registered).toHaveLength(1);
    expect(await activeDevices(l.userId, w.academy.id)).toBe(2);
  });

  it('DV-10 — another learner cannot remove the device; a device at one academy is not counted at another', async () => {
    const w = await world('dv10');
    const w2 = await world('dv10-b');
    const a = await learner(w, 'dv10-a');
    const b = await learner(w, 'dv10-b');
    const laptop = newBrowser();
    await signIn(laptop, a.email, w.academy.id);
    const intruder = newBrowser();
    await signIn(intruder, b.email, w.academy.id);
    const aDevice = await deviceIdOf(laptop, a.userId, w.academy.id);
    await removeDevice(intruder, w.academy.id, aDevice).expect(404);
    expect(
      (await admin.studentDevice.findUniqueOrThrow({ where: { id: aDevice } })).revokedAt,
    ).toBeNull();

    // The same learner at a second academy starts from zero there.
    const enrolledThere = await admin.user.findUniqueOrThrow({
      where: { email: a.email },
    });
    await admin.academyStudent.create({
      data: {
        academyId: w2.academy.id,
        userId: enrolledThere.id,
        status: 'active',
        source: 'staff_created',
      },
    });
    const there = { ...laptop };
    await signIn(there, a.email, w2.academy.id);
    expect(await activeDevices(a.userId, w2.academy.id)).toBe(1);
    expect(await activeDevices(a.userId, w.academy.id)).toBe(1);
  });
});
