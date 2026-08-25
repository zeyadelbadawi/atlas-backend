/**
 * Blog Posts e2e suite (master plan §21 Phase P7, §5.5, §10). Exercises
 * `BlogPostsController`'s real, flat `blog-posts` HTTP surface, matching
 * `BlogService`'s (frontend) contract exactly.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

describe('Blog Posts (e2e)', () => {
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

  async function seedAcademyStaff(label: string) {
    const staff = await signUpAndSignIn(app, label);
    const org = await seedOrganizationWithOwner(admin, staff.userId, `${label}-org`);
    const academy = await seedAcademy(admin, org.id, `${label}-academy`);
    await seedAcademyMember(admin, academy.id, staff.userId, 'owner');
    return { staff, academy };
  }

  it('academy staff create, update, publish, and delete their own post; a user with no staff role anywhere cannot create one', async () => {
    const { staff } = await seedAcademyStaff('blog-crud');
    const slug = `blog-crud-${Date.now()}`;

    const created = await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ title: 'My First Post', slug, content: 'Hello, world.' })
      .expect(201);
    expect(created.body.status).toBe('draft');
    expect(created.body.academyId).toBeTruthy();

    const updated = await request(app.getHttpServer())
      .patch(`/blog-posts/${created.body.id}`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ title: 'My Updated Post' })
      .expect(200);
    expect(updated.body.title).toBe('My Updated Post');

    const published = await request(app.getHttpServer())
      .post(`/blog-posts/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(201);
    expect(published.body.status).toBe('published');

    await request(app.getHttpServer())
      .delete(`/blog-posts/${created.body.id}`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(204);

    const noRole = await signUpAndSignIn(app, 'blog-crud-norole');
    await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${noRole.accessToken}`)
      .send({ title: 'Should fail', slug: `should-fail-${Date.now()}`, content: 'x' })
      .expect(403);
  });

  it('another staff member of the SAME academy can see a published post but cannot update or archive it — visible ≠ owned', async () => {
    const { staff, academy } = await seedAcademyStaff('blog-owner-only');
    const otherStaff = await signUpAndSignIn(app, 'blog-owner-only-other');
    await seedAcademyMember(admin, academy.id, otherStaff.userId, 'administrator');

    const created = await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ title: 'Owned', slug: `owned-${Date.now()}`, content: 'Mine.' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/blog-posts/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(201);

    // Visible — same academy, published.
    const asOther = await request(app.getHttpServer())
      .get(`/blog-posts/${created.body.id}`)
      .set('Authorization', `Bearer ${otherStaff.accessToken}`)
      .expect(200);
    expect(asOther.body.title).toBe('Owned');

    // Not owned — every write is still rejected.
    await request(app.getHttpServer())
      .patch(`/blog-posts/${created.body.id}`)
      .set('Authorization', `Bearer ${otherStaff.accessToken}`)
      .send({ title: 'Hijacked' })
      .expect(403);

    await request(app.getHttpServer())
      .post(`/blog-posts/${created.body.id}/archive`)
      .set('Authorization', `Bearer ${otherStaff.accessToken}`)
      .expect(403);
  });

  it('a published post is visible to any academy member; a draft is not', async () => {
    const { staff, academy } = await seedAcademyStaff('blog-visibility');
    const member = await signUpAndSignIn(app, 'blog-visibility-member');
    await seedAcademyMember(admin, academy.id, member.userId, 'staff');

    const created = await request(app.getHttpServer())
      .post('/blog-posts')
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .send({ title: 'Draft Post', slug: `draft-post-${Date.now()}`, content: 'x' })
      .expect(201);

    const beforePublish = await request(app.getHttpServer())
      .get('/blog-posts')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(beforePublish.body.items.map((p: { id: string }) => p.id)).not.toContain(
      created.body.id,
    );

    await request(app.getHttpServer())
      .post(`/blog-posts/${created.body.id}/publish`)
      .set('Authorization', `Bearer ${staff.accessToken}`)
      .expect(201);

    const afterPublish = await request(app.getHttpServer())
      .get('/blog-posts')
      .set('Authorization', `Bearer ${member.accessToken}`)
      .expect(200);
    expect(afterPublish.body.items.map((p: { id: string }) => p.id)).toContain(
      created.body.id,
    );
  });
});
