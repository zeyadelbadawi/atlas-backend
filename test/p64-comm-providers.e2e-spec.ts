/**
 * P64 Communications — provider layer (e2e). `EMAIL_PROVIDERS=stub` (the
 * default): no network is ever reached. The Brevo adapter is still
 * registered for INBOUND webhooks, authenticated by `BREVO_WEBHOOK_SECRET`
 * (set below before the app boots), which is what lets this suite drive
 * the real route → queue → processor → deliveries/suppressions path
 * without a real provider.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';
import {
  SuppressionService,
  hashEmail,
} from '../src/communications/services/suppression.service';
import { EmailTransport } from '../src/communications/services/email-transport';
import { COMMUNICATION_SUPPRESSION } from '../src/communications/services/communication-suppression.interface';
import type { CommunicationSuppressionLookup } from '../src/communications/services/communication-suppression.interface';
import { EmailProviderRegistry } from '../src/communications/providers/email-provider.registry';
import { EMAIL_PROVIDER } from '../src/identity/services/email-provider.interface';

const BREVO_SECRET = 'e2e-brevo-webhook-secret-0123456789';

jest.setTimeout(60000);

async function waitFor<T>(
  probe: () => Promise<T | null | undefined>,
  timeoutMs = 15000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for the condition');
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

describe('P64 Communications — email provider layer (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let stub: StubEmailProvider;
  let suppressions: SuppressionService;
  let transport: EmailTransport;
  let suppressionLookup: CommunicationSuppressionLookup;
  let ownerUserId: string;

  beforeAll(async () => {
    process.env.EMAIL_PROVIDERS = 'stub';
    process.env.BREVO_WEBHOOK_SECRET = BREVO_SECRET;
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    stub = testApp.stubEmailProvider;
    suppressions = app.get(SuppressionService);
    transport = app.get(EmailTransport);
    suppressionLookup = app.get(COMMUNICATION_SUPPRESSION);

    // A platform owner must exist: deliveries UPDATE and suppressions SELECT
    // are platform-owner-only under RLS.
    const email = uniqueTestEmail('comm-owner');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Comm Owner', email, password: 'correct-horse-battery' })
      .expect(201);
    const owner = await admin.user.findUniqueOrThrow({ where: { email } });
    await admin.user.update({ where: { id: owner.id }, data: { isPlatformOwner: true } });
    ownerUserId = owner.id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function seedDelivery(providerMessageId: string, recipientUserId: string) {
    const outbox = await admin.communicationOutbox.create({
      data: {
        key: 'e2e.comm.test',
        category: 'transactional',
        recipientUserId,
        channels: { inApp: false, email: 'always' },
      },
    });
    return admin.communicationDelivery.create({
      data: {
        outboxId: outbox.id,
        channel: 'email',
        provider: 'brevo',
        providerMessageId,
        status: 'sent',
        sentAt: new Date(),
      },
    });
  }

  it('EMAIL_PROVIDER resolves to the registry with the stub chain', () => {
    const provider = app.get<EmailProviderRegistry>(EMAIL_PROVIDER);
    expect(provider).toBeInstanceOf(EmailProviderRegistry);
    expect(provider.providerNames()).toEqual(['stub']);
  });

  it('legacy sign-up verification path still records the token in the stub via the registry', async () => {
    const email = uniqueTestEmail('comm-legacy');
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ name: 'Legacy', email, password: 'correct-horse-battery' })
      .expect(201);
    expect(stub.peekLastEmailVerificationToken(email)).toBeDefined();
    expect(stub.peekLastEmailVerificationToken(email)).not.toContain(' ');
  });

  describe('POST /webhooks/email/:provider', () => {
    const body = (event: string, messageId: string, email: string) => ({
      event,
      email,
      'message-id': messageId,
      date: '2026-09-24 10:00:00',
      reason: event === 'hard_bounce' ? 'mailbox does not exist' : undefined,
    });

    it('404s an unknown provider and the webhook-less stub', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/email/nope')
        .send({})
        .expect(404);
      await request(app.getHttpServer())
        .post('/webhooks/email/stub')
        .send({})
        .expect(404);
    });

    it('401s a bad or missing URL secret without touching anything', async () => {
      await request(app.getHttpServer())
        .post('/webhooks/email/brevo')
        .send(body('delivered', 'msg-unauth', 'x@atlas.test'))
        .expect(401);
      await request(app.getHttpServer())
        .post(`/webhooks/email/brevo?secret=${BREVO_SECRET}x`)
        .send(body('delivered', 'msg-unauth', 'x@atlas.test'))
        .expect(401);
    });

    it('202s a good secret, transitions the matched delivery to delivered', async () => {
      const messageId = `<e2e-${Date.now()}-a@smtp-relay.mailin.fr>`;
      const delivery = await seedDelivery(messageId, ownerUserId);

      const res = await request(app.getHttpServer())
        .post(`/webhooks/email/brevo?secret=${BREVO_SECRET}`)
        .send(body('delivered', messageId, 'someone@atlas.test'))
        .expect(202);
      expect(res.body).toEqual({ received: true, events: 1 });

      const updated = await waitFor(async () => {
        const row = await admin.communicationDelivery.findUnique({
          where: { id: delivery.id },
        });
        return row?.status === 'delivered' ? row : null;
      });
      expect(updated.status).toBe('delivered');
    });

    it('hard bounce → delivery bounced + permanent suppression by SHA-256 of the canonical address', async () => {
      const messageId = `<e2e-${Date.now()}-b@smtp-relay.mailin.fr>`;
      const recipient = uniqueTestEmail('comm-bounce');
      const delivery = await seedDelivery(messageId, ownerUserId);

      await request(app.getHttpServer())
        .post(`/webhooks/email/brevo?secret=${BREVO_SECRET}`)
        .send(body('hard_bounce', messageId, recipient.toUpperCase()))
        .expect(202);

      const updated = await waitFor(async () => {
        const row = await admin.communicationDelivery.findUnique({
          where: { id: delivery.id },
        });
        return row?.status === 'bounced' ? row : null;
      });
      expect(updated.errorCode).toBe('mailbox does not exist');

      const suppression = await admin.communicationSuppression.findUnique({
        where: { emailHash: hashEmail(recipient) },
      });
      expect(suppression).toMatchObject({
        reason: 'hard_bounce',
        source: 'webhook:brevo',
        expiresAt: null,
        emailDomain: 'atlas.test',
      });
      expect(await suppressions.isSuppressed(recipient)).toBe(true);
    });

    it('redelivery of the same event is accepted and idempotent', async () => {
      const messageId = `<e2e-${Date.now()}-c@smtp-relay.mailin.fr>`;
      const delivery = await seedDelivery(messageId, ownerUserId);
      for (let i = 0; i < 2; i += 1) {
        await request(app.getHttpServer())
          .post(`/webhooks/email/brevo?secret=${BREVO_SECRET}`)
          .send(body('delivered', messageId, 'dup@atlas.test'))
          .expect(202);
      }
      const updated = await waitFor(async () => {
        const row = await admin.communicationDelivery.findUnique({
          where: { id: delivery.id },
        });
        return row?.status === 'delivered' ? row : null;
      });
      expect(updated.status).toBe('delivered');
    });
  });

  describe('Suppression is wired to the dispatcher', () => {
    /**
     * P17's `EmailService` used to own this rule and was deleted with the
     * outbox: every send now goes through `CommunicationDispatchService`,
     * which consults `COMMUNICATION_SUPPRESSION` before handing anything
     * to the transport. The port ships with a NO-OP default, so the thing
     * most worth asserting is the WIRING — a production build that
     * silently resolved the no-op would mail every hard-bounced address
     * and pass every other test in this file.
     */
    it('resolves the real SuppressionService, not the no-op default', async () => {
      const suppressed = uniqueTestEmail('comm-suppressed');
      expect(await suppressionLookup.isSuppressed(suppressed)).toBe(false);

      await suppressions.suppress({
        email: suppressed,
        reason: 'complaint',
        source: 'e2e',
      });

      // A no-op binding answers `false` here, whatever the list says.
      expect(await suppressionLookup.isSuppressed(suppressed)).toBe(true);
      expect(suppressionLookup).toBe(app.get(SuppressionService));
    });

    it('the transport reaches the registry and flattens tags to the provider contract', async () => {
      const to = uniqueTestEmail('comm-transport');
      const result = await transport.send({
        to,
        subject: 'Transport check',
        text: 'Body',
        tags: { key: 'platform.payment.approved', category: 'transactional' },
        category: 'transactional',
      });

      expect(result.provider).toBe('stub');
      // The dispatcher speaks in `{ key, category }`; the vendors take a
      // FLAT list. If that translation regressed, the stub's own
      // `tags.includes(...)` would throw rather than fail an assertion.
      const [recorded] = stub.recordedSends().slice(-1);
      expect(recorded.tags).toEqual([
        'key:platform.payment.approved',
        'category:transactional',
      ]);
      expect(recorded.category).toBe('transactional');
    });

    it('unsuppress lifts the block; list shows the row while it exists', async () => {
      const email = uniqueTestEmail('comm-unsuppress');
      await suppressions.suppress({
        email,
        reason: 'manual',
        source: 'e2e',
        note: 'test',
      });
      expect(await suppressions.isSuppressed(email)).toBe(true);
      const listed = await suppressions.list({ limit: 200 });
      expect(listed.some((row) => row.emailHash === hashEmail(email))).toBe(true);
      expect(await suppressions.unsuppress(email)).toBe(true);
      expect(await suppressions.isSuppressed(email)).toBe(false);
    });
  });
});
