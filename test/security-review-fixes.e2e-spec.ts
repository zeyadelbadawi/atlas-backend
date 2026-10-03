/**
 * Security review follow-ups (findings 3, 5, 6), end to end against the
 * real AppModule, real Postgres (FORCE RLS) and Redis.
 *
 *   Finding 5 — an INACTIVE academy staff row authorises nothing: an
 *     academy-wide announcement (403), a course announcement (403) and quiz
 *     authoring (404), and the RLS helpers `is_academy_member` /
 *     `can_author_course_content` answer false (20261104000341).
 *   Finding 6 — the RFC 8058 one-click POST is limited per TOKEN subject,
 *     not per IP: one subject is cut off after 10/min while another
 *     person's unsubscribe from the same IP still works.
 *   Finding 3 — a campaign body over the raw byte cap is refused by the DTO
 *     before anything parses it.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedActiveSubscriptionForOrg,
  seedCourse,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { uniqueName } from './utils/unique-name';
import { LinkBuilderService } from '../src/communications/services/link-builder.service';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery-secrev';
const QUESTION = {
  prompt: 'What is 2 + 2?',
  type: 'single_choice' as const,
  options: [
    { label: '3', isCorrect: false },
    { label: '4', isCorrect: true },
  ],
};

describe('Security review follow-ups (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function account(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: uniqueName(label), email, password: PASSWORD })
      .expect(201);
    const signIn = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function managedAcademy(label: string) {
    const owner = await account(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
    const course = await seedCourse(admin, academy.id, uniqueName(`${label}-course`), {
      status: 'published',
      visibility: 'public',
    });
    return { owner, org, academy, course };
  }

  // -------------------------------------------------------------------
  // Finding 5
  // -------------------------------------------------------------------

  describe('inactive academy staff (finding 5)', () => {
    it('a manager is denied announcements and quiz authoring once their membership is inactive', async () => {
      const { academy, course } = await managedAcademy('secrev-inactive');
      const manager = await account('secrev-inactive-manager');
      const membership = await seedAcademyMember(
        admin,
        academy.id,
        manager.userId,
        'manager',
      );

      // Active: allowed (sanity — the same calls are what is refused below).
      await http()
        .post(`/academies/${academy.id}/announcements`)
        .set(bearer(manager.token))
        .send({ title: 'Active manager', body: 'Allowed while active.' })
        .expect(201);
      await http()
        .post(`/courses/${course.id}/quizzes`)
        .set(bearer(manager.token))
        .send({ title: 'Active manager quiz', questions: [QUESTION] })
        .expect(201);

      await admin.academyMember.update({
        where: { id: membership.id },
        data: { status: 'inactive' },
      });

      await http()
        .post(`/academies/${academy.id}/announcements`)
        .set(bearer(manager.token))
        .send({ title: 'Inactive manager', body: 'Must be refused.' })
        .expect(403);
      await http()
        .post(`/courses/${course.id}/announcements`)
        .set(bearer(manager.token))
        .send({ title: 'Inactive manager', body: 'Must be refused.' })
        .expect(403);
      await http()
        .post(`/courses/${course.id}/quizzes`)
        .set(bearer(manager.token))
        .send({ title: 'Inactive manager quiz', questions: [QUESTION] })
        .expect(404);

      const helpers = await admin.$queryRaw<{ member: boolean; author: boolean }[]>`
        SELECT is_academy_member(${academy.id}, ${manager.userId}) AS member,
               can_author_course_content(${course.id}, ${manager.userId}) AS author`;
      expect(helpers[0]).toEqual({ member: false, author: false });

      await admin.academyMember.update({
        where: { id: membership.id },
        data: { status: 'active' },
      });
      const restored = await admin.$queryRaw<{ member: boolean; author: boolean }[]>`
        SELECT is_academy_member(${academy.id}, ${manager.userId}) AS member,
               can_author_course_content(${course.id}, ${manager.userId}) AS author`;
      expect(restored[0]).toEqual({ member: true, author: true });
    });
  });

  // -------------------------------------------------------------------
  // Finding 6
  // -------------------------------------------------------------------

  describe('one-click unsubscribe throttling (finding 6)', () => {
    function unsubscribePath(userId: string): string {
      const url = new URL(
        app.get(LinkBuilderService).unsubscribe(userId, 'engagement') as string,
      );
      return url.pathname.replace(/^\/api\/v1/, '') + url.search;
    }

    it('limits one token subject per minute, not everyone behind the same IP', async () => {
      const first = await account('secrev-unsub-a');
      const second = await account('secrev-unsub-b');
      const path = unsubscribePath(first.userId);

      const statuses: number[] = [];
      for (let i = 0; i < 11; i += 1) {
        const res = await http()
          .post(path)
          .type('form')
          .send('List-Unsubscribe=One-Click');
        statuses.push(res.status);
      }
      expect(statuses.slice(0, 10).every((s) => s === 200)).toBe(true);
      expect(statuses[10]).toBe(429);

      // Same client IP, another person's token: unaffected (the old 30/min
      // per-IP limit would have been the only budget here).
      await http()
        .post(unsubscribePath(second.userId))
        .type('form')
        .send('List-Unsubscribe=One-Click')
        .expect(200);
    });
  });

  // -------------------------------------------------------------------
  // Finding 3
  // -------------------------------------------------------------------

  describe('campaign body byte cap (finding 3)', () => {
    it('refuses a body over 50 KB of UTF-8 at the DTO even under the character cap', async () => {
      const { owner, academy } = await managedAcademy('secrev-bytes');
      const res = await http()
        .post(`/academies/${academy.id}/messages`)
        .set(bearer(owner.token))
        .send({
          idempotencyKey: randomUUID(),
          audience: { type: 'all_learners' },
          channels: { email: true, inApp: true },
          subject: 'Too many bytes',
          // 19 000 characters (under the 20 000 cap), 57 000 bytes.
          bodyHtml: '€'.repeat(19_000),
          expectedRecipientCount: 0,
        });
      expect(res.status).toBe(400);
    });
  });
});
