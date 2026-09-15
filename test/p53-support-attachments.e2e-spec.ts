/**
 * P53 — support-ticket image attachments (P53-ATT-001..015).
 *
 * WHY THESE RUN AGAINST A REAL DATABASE. The authorization for an
 * attachment is not a check in a service — it is the
 * `support_case_message_attachments_requester_select` /
 * `_requester_insert` / `_platform_select` policies. A mocked Prisma would
 * happily return another tenant's row and prove nothing. Every isolation
 * assertion below therefore asserts the OUTCOME against live Postgres with
 * FORCE RLS on, exactly as the Phase 11.8 support suite already does.
 *
 * The bytes are real too: `MEDIA_STORAGE_PROVIDER` is the actual
 * `R2StorageProvider` pointed at local MinIO in tests, so "the image comes
 * back" means an object was genuinely written and genuinely read — not
 * that a stub remembered a buffer.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import type { PrismaClient } from '@prisma/client';

const PASSWORD = 'correct-horse-battery';

/**
 * A real 1x1 PNG. The magic bytes matter — `detectFileKind` sniffs the
 * decoded buffer, so a fake payload would be refused (which is itself one
 * of the cases below).
 */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

/** A real GIF87a, used to prove the allowlist is not PNG-only. */
const GIF_DATA_URL =
  'data:image/gif;base64,R0lGODdhAQABAIAAAP///////ywAAAAAAQABAAACAkQBADs=';

/** A real PDF header. Inside the media allowlist, but NOT an image. */
const PDF_DATA_URL = `data:application/pdf;base64,${Buffer.from(
  '%PDF-1.4\nnot really a document',
).toString('base64')}`;

describe('P53 support ticket attachments (e2e) — P53-ATT-001..015', () => {
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

  async function signUp(label: string) {
    const email = uniqueTestEmail(label);
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: `${label} user`, email, password: PASSWORD })
      .expect(201);
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: signIn.body.user.id as string,
      token: signIn.body.accessToken as string,
    };
  }

  async function seedRequester(label: string) {
    const account = await signUp(label);
    const org = await seedOrganizationWithOwner(admin, account.userId, `${label}-org`);
    return { ...account, organizationId: org.id };
  }

  async function seedPlatformOwner(label: string) {
    const account = await signUp(label);
    await admin.user.update({
      where: { id: account.userId },
      data: { isPlatformOwner: true },
    });
    // The role is read from the JWT's subject at request time, but the
    // token was minted before the flag was set — sign in again so the
    // session reflects it.
    const signIn = await request(app.getHttpServer())
      .post('/auth/sign-in')
      .send({ email: account.email, password: PASSWORD })
      .expect(200);
    return { ...account, token: signIn.body.accessToken as string };
  }

  function createTicket(
    token: string,
    organizationId: string,
    body: Record<string, unknown>,
  ) {
    return request(app.getHttpServer())
      .post(`/organizations/${organizationId}/support-cases`)
      .set('Authorization', `Bearer ${token}`)
      .send({ subject: 'Attachment ticket', description: 'What I am seeing.', ...body });
  }

  const attachment = (dataUrl = PNG_DATA_URL, fileName = 'screenshot.png') => ({
    fileName,
    mimeType: 'image/png',
    sizeBytes: 100,
    dataUrl,
  });

  // ---------------- the text-only path must not change ----------------

  it('P53-ATT-001 — a text-only ticket still works and reports no attachments', async () => {
    const requester = await seedRequester('p53-001');

    const created = await createTicket(
      requester.token,
      requester.organizationId,
      {},
    ).expect(201);

    expect(created.body.messages).toHaveLength(1);
    expect(created.body.messages[0].attachments).toEqual([]);
  });

  it('P53-ATT-002 — a text-only reply still works', async () => {
    const requester = await seedRequester('p53-002');
    const ticket = await createTicket(
      requester.token,
      requester.organizationId,
      {},
    ).expect(201);

    const replied = await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.body.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'Still broken.' })
      .expect(201);

    expect(replied.body.messages).toHaveLength(2);
    expect(replied.body.messages[1].attachments).toEqual([]);
  });

  // ---------------- creating with an image ----------------

  it('P53-ATT-003 — a ticket can be created with an image, returned on its first message', async () => {
    const requester = await seedRequester('p53-003');

    const created = await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(),
    }).expect(201);

    const [message] = created.body.messages;
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0].fileName).toBe('screenshot.png');
    expect(message.attachments[0].mimeType).toBe('image/png');
    // A relative Atlas path, never an object-storage URL.
    expect(message.attachments[0].url).toBe(
      `/support-cases/attachments/${message.attachments[0].id}`,
    );
    // The storage key is never exposed to a client.
    expect(message.attachments[0].storageKey).toBeUndefined();
  });

  it('P53-ATT-004 — the attachment survives a refresh and stays on its own message', async () => {
    const requester = await seedRequester('p53-004');
    const created = await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(),
    }).expect(201);

    await request(app.getHttpServer())
      .post(`/support-cases/mine/${created.body.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({ body: 'A second, text-only message.' })
      .expect(201);

    const reread = await request(app.getHttpServer())
      .get(`/support-cases/mine/${created.body.id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(reread.body.messages).toHaveLength(2);
    // Association is per-message, not per-ticket: only the first carries it.
    expect(reread.body.messages[0].attachments).toHaveLength(1);
    expect(reread.body.messages[1].attachments).toEqual([]);
  });

  it('P53-ATT-005 — a reply can carry an image', async () => {
    const requester = await seedRequester('p53-005');
    const ticket = await createTicket(
      requester.token,
      requester.organizationId,
      {},
    ).expect(201);

    const replied = await request(app.getHttpServer())
      .post(`/support-cases/mine/${ticket.body.id}/messages`)
      .set('Authorization', `Bearer ${requester.token}`)
      .send({
        body: 'Here is the error.',
        attachment: attachment(GIF_DATA_URL, 'err.gif'),
      })
      .expect(201);

    expect(replied.body.messages[1].attachments).toHaveLength(1);
    // The REAL kind wins over the declared `image/png` in the payload.
    expect(replied.body.messages[1].attachments[0].mimeType).toBe('image/gif');
  });

  // ---------------- serving the bytes ----------------

  it('P53-ATT-006 — the owner can fetch the real bytes back', async () => {
    const requester = await seedRequester('p53-006');
    const created = await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(),
    }).expect(201);
    const { id } = created.body.messages[0].attachments[0];

    const served = await request(app.getHttpServer())
      .get(`/support-cases/attachments/${id}`)
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(200);

    expect(served.headers['content-type']).toContain('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    // Private, so it must never land in a shared cache.
    expect(served.headers['cache-control']).toContain('no-store');
    // Byte-identical to what was uploaded — proof the object round-tripped.
    expect(
      Buffer.from(served.body).equals(Buffer.from(PNG_DATA_URL.split(',')[1], 'base64')),
    ).toBe(true);
  });

  it('P53-ATT-007 — an UNAUTHENTICATED request for an attachment is refused', async () => {
    const requester = await seedRequester('p53-007');
    const created = await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(),
    }).expect(201);
    const { id } = created.body.messages[0].attachments[0];

    // This is the security difference from `PublicMediaController`: media
    // is a public capability URL, a ticket attachment is not.
    await request(app.getHttpServer())
      .get(`/support-cases/attachments/${id}`)
      .expect(401);
  });

  it('P53-ATT-008 — ANOTHER TENANT cannot fetch the attachment (RLS, not a service check)', async () => {
    const owner = await seedRequester('p53-008a');
    const stranger = await seedRequester('p53-008b');

    const created = await createTicket(owner.token, owner.organizationId, {
      attachment: attachment(),
    }).expect(201);
    const { id } = created.body.messages[0].attachments[0];

    // 404, never 403 — a 403 would confirm the id names a real attachment.
    await request(app.getHttpServer())
      .get(`/support-cases/attachments/${id}`)
      .set('Authorization', `Bearer ${stranger.token}`)
      .expect(404);
  });

  it('P53-ATT-009 — a COLLEAGUE in the same organization cannot fetch it either', async () => {
    const owner = await seedRequester('p53-009a');
    const colleague = await signUp('p53-009b');
    // A real member of the SAME organization — the case that would leak if
    // attachments had been modelled as academy media.
    await admin.organizationMembership.create({
      data: {
        organizationId: owner.organizationId,
        userId: colleague.userId,
        role: 'administrator',
      },
    });

    const created = await createTicket(owner.token, owner.organizationId, {
      attachment: attachment(),
    }).expect(201);
    const { id } = created.body.messages[0].attachments[0];

    await request(app.getHttpServer())
      .get(`/support-cases/attachments/${id}`)
      .set('Authorization', `Bearer ${colleague.token}`)
      .expect(404);
  });

  it('P53-ATT-010 — a Platform Owner CAN read a customer attachment (support side)', async () => {
    const requester = await seedRequester('p53-010a');
    const platformOwner = await seedPlatformOwner('p53-010b');

    const created = await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(),
    }).expect(201);
    const { id } = created.body.messages[0].attachments[0];

    await request(app.getHttpServer())
      .get(`/support-cases/attachments/${id}`)
      .set('Authorization', `Bearer ${platformOwner.token}`)
      .expect(200);

    // And it is visible in the agent's own view of the thread.
    const agentView = await request(app.getHttpServer())
      .get(`/support-cases/${created.body.id}`)
      .set('Authorization', `Bearer ${platformOwner.token}`)
      .expect(200);
    expect(agentView.body.messages[0].attachments).toHaveLength(1);
  });

  // ---------------- validation ----------------

  it('P53-ATT-011 — a payload whose BYTES are not an image is refused', async () => {
    const requester = await seedRequester('p53-011');

    // Declares `image/png`, but the decoded bytes are plain text. The
    // declared mime type is never trusted.
    const notAnImage = `data:image/png;base64,${Buffer.from('totally not a png').toString(
      'base64',
    )}`;

    await createTicket(requester.token, requester.organizationId, {
      attachment: attachment(notAnImage),
    }).expect(400);
  });

  it('P53-ATT-012 — a real PDF is refused: this feature is images only', async () => {
    const requester = await seedRequester('p53-012');

    // Inside `detectFileKind`'s allowlist (media accepts PDFs), but not an
    // image — so the narrower support rule must refuse it.
    await createTicket(requester.token, requester.organizationId, {
      attachment: { ...attachment(PDF_DATA_URL), fileName: 'invoice.pdf' },
    }).expect(400);
  });

  it('P53-ATT-013 — an oversized image is refused', async () => {
    const requester = await seedRequester('p53-013');

    // A genuine PNG header followed by more bytes than
    // `MEDIA_MAX_UPLOAD_BYTES` allows. The ceiling is applied to the real
    // decoded buffer, never to the claimed `sizeBytes`.
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const huge = Buffer.concat([pngHeader, Buffer.alloc(11 * 1024 * 1024, 0)]);
    const oversized = `data:image/png;base64,${huge.toString('base64')}`;

    const response = await createTicket(requester.token, requester.organizationId, {
      attachment: { ...attachment(oversized), sizeBytes: 10 },
    });
    expect(response.status).toBe(413);
  });

  it('P53-ATT-014 — a malformed data URL is refused', async () => {
    const requester = await seedRequester('p53-014');

    await createTicket(requester.token, requester.organizationId, {
      attachment: attachment('this-is-not-a-data-url'),
    }).expect(400);
  });

  it('P53-ATT-015 — an unknown attachment id is a 404, and a malformed one a 400', async () => {
    const requester = await seedRequester('p53-015');

    await request(app.getHttpServer())
      .get('/support-cases/attachments/1e6f6b1e-0000-4000-8000-000000000000')
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(404);

    // Path traversal / key manipulation cannot even be expressed: the
    // parameter must be a UUID, and the storage key is rebuilt from the
    // stored row, never from the URL.
    await request(app.getHttpServer())
      .get('/support-cases/attachments/..%2F..%2Fetc%2Fpasswd')
      .set('Authorization', `Bearer ${requester.token}`)
      .expect(400);
  });
});
