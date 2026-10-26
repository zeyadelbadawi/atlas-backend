/**
 * G1 — season capacity plan + CAC per channel (e2e), against the real
 * `AppModule`, Postgres (FORCE RLS, the `atlas_app` role) and Redis.
 *
 *  - Platform Owner only: no token → 401, an organization owner → 403 on
 *    every `platform-growth/*` route; responses are `private, no-store`.
 *  - Signup and contact form store `heardFrom` / `heardFromOther` with the
 *    attribution flag OFF; the free text is scrubbed (an email is dropped);
 *    an unknown value is a 400; a plain (non-organization) signup stores
 *    nothing.
 *  - Settings and spend CRUD with optimistic versions (409) and audits.
 *  - The channel override and the `acquisition` block on the PO
 *    organization detail.
 *  - CAC smoke on seeded data in a fixed past window (Feb–Apr 2021, Cairo
 *    UTC+2): signup-month cohort at the Cairo month boundary, founding
 *    subset, null CAC, blended CAC including unknown, internal and archived
 *    organizations excluded.
 *  - Capacity smoke: this week's signups / onboardings / paid conversions
 *    move by exactly the seeded non-internal organization, open requests,
 *    paying organizations, alerts from the settings.
 *  - RLS, proved directly as the application role: a context-less read and
 *    a non-owner user context see no spend or settings rows and cannot
 *    write.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedOrganizationWithOwner,
  seedPlan,
  seedTenantSubscription,
} from './utils/db-admin';
import { uniqueName } from './utils/unique-name';
import type { IdentityConfig, LeadCaptureConfig } from '../src/config/configuration';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { PlatformContactIntakeService } from '../src/platform-contact/services/platform-contact-intake.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsProducer } from '../src/communications/queue/communications.producer';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery-growth';
const NIL = '00000000-0000-4000-8000-000000000000';

class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}
class InertCommunicationsProducer {
  async enqueueDispatch(): Promise<boolean> {
    return true;
  }
}

let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  const salt = Math.floor(Math.random() * 200);
  return `198.18.${(salt + Math.floor(ipCounter / 250)) % 255}.${(ipCounter % 250) + 1}`;
}

describe('G1 growth & capacity (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let tenancy: TenancyContextService;
  let intake: PlatformContactIntakeService;
  let flush: () => Promise<void>;
  let lead: LeadCaptureConfig;
  let identity: { signupOrganizationMode: IdentityConfig['signupOrganizationMode'] };
  let originalSignupMode: IdentityConfig['signupOrganizationMode'];
  let po: { userId: string; token: string };
  let tenant: { userId: string; token: string; organizationId: string };
  const tag = `g1${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const createdOrgIds: string[] = [];

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function signIn(email: string) {
    const res = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return res.body as {
      accessToken: string;
      user: { id: string; organizations: { organizationId: string }[] };
    };
  }

  async function ownerSignup(extra: Record<string, unknown> = {}) {
    const email = uniqueTestEmail('g1-owner');
    await http()
      .post('/auth/register')
      .send({
        name: 'Owner Example',
        email,
        password: PASSWORD,
        organizationName: uniqueName('G1 Org'),
        ...extra,
      })
      .expect(201);
    const session = await signIn(email);
    const organizationId = session.user.organizations[0]?.organizationId as string;
    createdOrgIds.push(organizationId);
    return { email, userId: session.user.id, token: session.accessToken, organizationId };
  }

  beforeAll(async () => {
    const testApp = await createTestApp({
      fieldViolations: true,
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler)
          .overrideProvider(CommunicationsProducer)
          .useClass(InertCommunicationsProducer),
    });
    app = testApp.app;
    flush = testApp.flushRateLimitKeys;
    admin = createAdminPrisma();
    tenancy = app.get(TenancyContextService);
    intake = app.get(PlatformContactIntakeService, { strict: false });
    const config = app.get(ConfigService);
    lead = config.getOrThrow<LeadCaptureConfig>('leadCapture');
    identity = config.getOrThrow<IdentityConfig>('identity') as never;
    originalSignupMode = identity.signupOrganizationMode;
    identity.signupOrganizationMode = 'on';
    await flush();

    const poEmail = uniqueTestEmail('g1-po');
    await http()
      .post('/auth/register')
      .send({ name: 'G1 PO', email: poEmail, password: PASSWORD })
      .expect(201);
    const first = await signIn(poEmail);
    await admin.user.update({
      where: { id: first.user.id },
      data: { isPlatformOwner: true },
    });
    const again = await signIn(poEmail);
    po = { userId: again.user.id, token: again.accessToken };

    tenant = await ownerSignup();
  });

  beforeEach(async () => {
    await flush();
    identity.signupOrganizationMode = 'on';
  });

  afterAll(async () => {
    identity.signupOrganizationMode = originalSignupMode;
    await intake.drainNotifications();
    await admin.marketingSpendEntry.deleteMany({
      where: {
        OR: [
          { description: { contains: tag } },
          { month: { lt: new Date('2022-01-01') } },
        ],
      },
    });
    await admin.organization.deleteMany({ where: { name: { contains: tag } } });
    await admin.$disconnect();
    await app.close();
  });

  // -------------------------------------------------------------------------
  describe('Platform Owner only', () => {
    const routes: [string, string][] = [
      ['get', '/platform-growth/settings'],
      ['patch', '/platform-growth/settings'],
      ['get', '/platform-growth/spend'],
      ['post', '/platform-growth/spend'],
      ['patch', `/platform-growth/spend/${NIL}`],
      ['delete', `/platform-growth/spend/${NIL}`],
      ['get', '/platform-growth/cac'],
      ['get', '/platform-growth/capacity'],
      ['patch', `/platform-growth/organizations/${NIL}/channel`],
    ];

    it.each(routes)('%s %s → 401 without a session', async (method, path) => {
      const res = await (
        http() as unknown as Record<string, (p: string) => request.Test>
      )[method](path);
      expect(res.status).toBe(401);
      expect(res.headers['cache-control']).toBe('private, no-store');
    });

    it.each(routes)('%s %s → 403 for an organization owner', async (method, path) => {
      const res = await (http() as unknown as Record<string, (p: string) => request.Test>)
        [method](path)
        .set(bearer(tenant.token))
        .send({});
      expect(res.status).toBe(403);
    });

    it('a Platform Owner gets private, no-store on every read', async () => {
      for (const path of [
        '/platform-growth/settings',
        '/platform-growth/spend',
        '/platform-growth/cac',
        '/platform-growth/capacity',
      ]) {
        const res = await http().get(path).set(bearer(po.token)).expect(200);
        expect(res.headers['cache-control']).toBe('private, no-store');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('heardFrom on signup and contact (attribution flag OFF)', () => {
    it('ships with the attribution flag off', () => {
      expect(lead.attributionCaptureMode).toBe('off');
    });

    it('an organization signup stores heardFrom; the free text only with other', async () => {
      const a = await ownerSignup({
        heardFrom: 'teacher_referral',
        heardFromOther: 'ignored',
      });
      const b = await ownerSignup({
        heardFrom: 'other',
        heardFromOther: '  A   Telegram group ',
      });
      const rows = await admin.organization.findMany({
        where: { id: { in: [a.organizationId, b.organizationId] } },
        select: {
          id: true,
          heardFrom: true,
          heardFromOther: true,
          signupAttribution: true,
        },
      });
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(a.organizationId)).toMatchObject({
        heardFrom: 'teacher_referral',
        heardFromOther: null,
        signupAttribution: null,
      });
      expect(byId.get(b.organizationId)).toMatchObject({
        heardFrom: 'other',
        heardFromOther: 'A Telegram group',
      });
    });

    it('personal data in the free text is dropped, never a failure', async () => {
      const signup = await ownerSignup({
        heardFrom: 'other',
        heardFromOther: 'ask ahmed@example.test',
      });
      const org = await admin.organization.findUniqueOrThrow({
        where: { id: signup.organizationId },
      });
      expect(org.heardFrom).toBe('other');
      expect(org.heardFromOther).toBeNull();
    });

    it('an unknown value is a 400 with a messageKey; nothing is created', async () => {
      const email = uniqueTestEmail('g1-bad');
      const res = await http()
        .post('/auth/register')
        .send({
          name: 'Owner Example',
          email,
          password: PASSWORD,
          organizationName: uniqueName('G1 Bad'),
          heardFrom: 'google_ads',
        })
        .expect(400);
      expect(res.body.error.messageKey).toBe('errors.validation.failed');
      expect(res.body.error.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'heardFrom',
            messageKey: 'validation:invalid',
          }),
        ]),
      );
      expect(await admin.user.findUnique({ where: { email } })).toBeNull();
      await http()
        .post('/auth/register')
        .send({
          name: 'Owner Example',
          email,
          password: PASSWORD,
          heardFrom: 'other',
          heardFromOther: 'x'.repeat(101),
        })
        .expect(400);
    });

    it('a plain account signup ignores it (no organization, nothing stored)', async () => {
      const email = uniqueTestEmail('g1-plain');
      await http()
        .post('/auth/register')
        .send({ name: 'Plain Example', email, password: PASSWORD, heardFrom: 'facebook' })
        .expect(201);
      const user = await admin.user.findUniqueOrThrow({ where: { email } });
      expect(await admin.organization.count({ where: { ownerUserId: user.id } })).toBe(0);
    });

    it('the contact form stores heardFrom; unknown → 400; the PO inbox shows it', async () => {
      const body = {
        name: 'Visitor Example',
        email: `g1-${randomUUID()}@example.test`,
        topic: 'sales',
        message: `Please tell us more about Atlas for our centre. ${tag}`,
        locale: 'en',
        startedAt: Date.now() - 30_000,
        heardFrom: 'other',
        heardFromOther: 'call me on 0100 123 4567',
      };
      await http()
        .post('/public/contact')
        .set('X-Real-IP', freshIp())
        .send(body)
        .expect(201);
      const row = await admin.platformContactSubmission.findFirstOrThrow({
        where: { email: body.email },
      });
      expect(row).toMatchObject({
        heardFrom: 'other',
        heardFromOther: null,
        attribution: null,
      });

      const second = {
        ...body,
        email: `g1-${randomUUID()}@example.test`,
        heardFrom: 'youtube',
      };
      await http()
        .post('/public/contact')
        .set('X-Real-IP', freshIp())
        .send(second)
        .expect(201);
      const list = await http()
        .get(`/platform/contact-submissions?search=${encodeURIComponent(second.email)}`)
        .set(bearer(po.token))
        .expect(200);
      expect(list.body.items[0]).toMatchObject({
        heardFrom: 'youtube',
        heardFromOther: null,
      });

      const bad = await http()
        .post('/public/contact')
        .set('X-Real-IP', freshIp())
        .send({ ...body, email: `g1-${randomUUID()}@example.test`, heardFrom: 'unknown' })
        .expect(400);
      expect(bad.body.error.messageKey).toBe('errors.validation.failed');
      await admin.platformContactSubmission.deleteMany({
        where: { email: { in: [body.email, second.email] } },
      });
    });
  });

  // -------------------------------------------------------------------------
  describe('settings', () => {
    it('reads the seeded defaults, saves with a version, refuses a stale one', async () => {
      const current = await http()
        .get('/platform-growth/settings')
        .set(bearer(po.token))
        .expect(200);
      expect(current.body).toMatchObject({
        weeklyOwnerHours: expect.any(Number),
        onboardingCapPerWeek: expect.any(Number),
        version: expect.any(Number),
      });
      const version = current.body.version as number;
      const original = current.body as Record<string, unknown>;

      const saved = await http()
        .patch('/platform-growth/settings')
        .set(bearer(po.token))
        .send({ version, weeklyOwnerHours: 14.5 })
        .expect(200);
      expect(saved.body).toMatchObject({
        weeklyOwnerHours: 14.5,
        version: version + 1,
        updatedByName: 'G1 PO',
      });

      const stale = await http()
        .patch('/platform-growth/settings')
        .set(bearer(po.token))
        .send({ version, weeklyOwnerHours: 13 })
        .expect(409);
      expect(stale.body.error).toMatchObject({
        messageKey: 'errors.growth.settingsStale',
        code: 'GROWTH_SETTINGS_STALE',
      });

      const badOrder = await http()
        .patch('/platform-growth/settings')
        .set(bearer(po.token))
        .send({ version: version + 1, hireNowPayingOrgs: 1, hireWarnPayingOrgs: 2 })
        .expect(400);
      expect(badOrder.body.error.messageKey).toBe('errors.growth.hireThresholdsInvalid');

      await http()
        .patch('/platform-growth/settings')
        .set(bearer(po.token))
        .send({ version: version + 1, weeklyOwnerHours: original.weeklyOwnerHours })
        .expect(200);

      const audits = await admin.auditLogEntry.count({
        where: { action: 'platform.growth.settings_updated', actorUserId: po.userId },
      });
      expect(audits).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  describe('spend', () => {
    it('create → list → stale 409 → update → delete, with audits', async () => {
      const created = await http()
        .post('/platform-growth/spend')
        .set(bearer(po.token))
        .send({
          month: '2021-02',
          channel: 'meta_ads',
          amountMinorUnits: 12_345,
          description: `Boost ${tag}`,
        })
        .expect(201);
      expect(created.body).toMatchObject({
        month: '2021-02',
        channel: 'meta_ads',
        amountMinorUnits: 12_345,
        currency: 'EGP',
        version: 1,
        createdByName: 'G1 PO',
      });
      const id = created.body.id as string;

      const list = await http()
        .get('/platform-growth/spend?from=2021-01&to=2021-03')
        .set(bearer(po.token))
        .expect(200);
      expect(list.body.from).toBe('2021-01');
      expect(list.body.items.map((e: { id: string }) => e.id)).toContain(id);

      const updated = await http()
        .patch(`/platform-growth/spend/${id}`)
        .set(bearer(po.token))
        .send({ version: 1, amountMinorUnits: 20_000 })
        .expect(200);
      expect(updated.body).toMatchObject({ amountMinorUnits: 20_000, version: 2 });

      const stale = await http()
        .patch(`/platform-growth/spend/${id}`)
        .set(bearer(po.token))
        .send({ version: 1, amountMinorUnits: 1 })
        .expect(409);
      expect(stale.body.error).toMatchObject({
        messageKey: 'errors.growth.spendStale',
        code: 'MARKETING_SPEND_STALE',
      });

      await http()
        .post('/platform-growth/spend')
        .set(bearer(po.token))
        .send({ month: '2021-02', channel: 'unknown', amountMinorUnits: 1 })
        .expect(400);
      const tooLong = await http()
        .get('/platform-growth/spend?from=2021-01&to=2024-01')
        .set(bearer(po.token))
        .expect(400);
      expect(tooLong.body.error.messageKey).toBe('errors.growth.monthRangeTooLong');

      await http()
        .delete(`/platform-growth/spend/${id}`)
        .set(bearer(po.token))
        .expect(204);
      const gone = await http()
        .delete(`/platform-growth/spend/${id}`)
        .set(bearer(po.token))
        .expect(404);
      expect(gone.body.error.messageKey).toBe('errors.growth.spendNotFound');

      const actions = await admin.auditLogEntry.findMany({
        where: { targetId: id },
        select: { action: true },
        orderBy: { occurredAt: 'asc' },
      });
      expect(actions.map((a) => a.action)).toEqual([
        'platform.growth.spend_created',
        'platform.growth.spend_updated',
        'platform.growth.spend_deleted',
      ]);
    });
  });

  // -------------------------------------------------------------------------
  describe('channel override and the organization detail', () => {
    it('resolves, overrides, clears; audited; tenant never sees it', async () => {
      const signup = await ownerSignup({ heardFrom: 'tiktok' });
      const detail = await http()
        .get(`/organizations/${signup.organizationId}`)
        .set(bearer(po.token))
        .expect(200);
      expect(detail.body.acquisition).toEqual({
        resolvedChannel: 'tiktok',
        decidedBy: 'self_reported',
        override: null,
        heardFrom: 'tiktok',
        heardFromOther: null,
        attribution: null,
      });

      const set = await http()
        .patch(`/platform-growth/organizations/${signup.organizationId}/channel`)
        .set(bearer(po.token))
        .send({ channel: 'whatsapp', note: 'Founder call' })
        .expect(200);
      expect(set.body).toMatchObject({
        resolvedChannel: 'whatsapp',
        decidedBy: 'override',
        override: { channel: 'whatsapp', note: 'Founder call', updatedByName: 'G1 PO' },
        heardFrom: 'tiktok',
      });

      const own = await http()
        .get(`/organizations/${signup.organizationId}`)
        .set(bearer(signup.token))
        .expect(200);
      expect(own.body.acquisition).toBeUndefined();

      const cleared = await http()
        .patch(`/platform-growth/organizations/${signup.organizationId}/channel`)
        .set(bearer(po.token))
        .send({ channel: null })
        .expect(200);
      expect(cleared.body).toMatchObject({
        resolvedChannel: 'tiktok',
        decidedBy: 'self_reported',
        override: null,
      });
      // Clearing again changes nothing and writes no audit.
      await http()
        .patch(`/platform-growth/organizations/${signup.organizationId}/channel`)
        .set(bearer(po.token))
        .send({ channel: null })
        .expect(200);
      const audits = await admin.auditLogEntry.findMany({
        where: {
          action: 'platform.growth.organization_channel_set',
          targetId: signup.organizationId,
        },
        orderBy: { occurredAt: 'asc' },
      });
      expect(audits.map((a) => a.context)).toEqual([
        { channel: 'whatsapp', previousChannel: null },
        { channel: null, previousChannel: 'whatsapp' },
      ]);

      await http()
        .patch(`/platform-growth/organizations/${NIL}/channel`)
        .set(bearer(po.token))
        .send({ channel: 'event' })
        .expect(404);
      await http()
        .patch(`/platform-growth/organizations/${signup.organizationId}/channel`)
        .set(bearer(po.token))
        .send({ channel: 'linkedin' })
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('CAC (seeded Feb–Apr 2021, Cairo UTC+2)', () => {
    async function seedOrg(
      label: string,
      createdAt: Date,
      options: {
        heardFrom?: 'facebook' | 'tiktok';
        attribution?: Record<string, string>;
        paying?: boolean;
        founding?: boolean;
        internal?: boolean;
        archived?: boolean;
      } = {},
    ) {
      const org = await seedOrganizationWithOwner(admin, po.userId, `${tag}-${label}`);
      await admin.organization.update({
        where: { id: org.id },
        data: {
          createdAt,
          heardFrom: options.heardFrom ?? null,
          signupAttribution: options.attribution ?? undefined,
          status: options.archived ? 'archived' : 'active',
        },
      });
      if (options.internal) {
        await admin.organizationPlatformFlags.create({
          data: { organizationId: org.id, isInternal: true },
        });
      }
      if (options.paying) {
        const checkout = await admin.checkout.create({
          data: {
            organizationId: org.id,
            targetType: 'plan_subscription',
            targetKey: 'growth-plan',
            snapshot: {},
            status: 'completed',
            expiresAt: new Date(createdAt.getTime() + 86_400_000),
            idempotencyKey: randomUUID(),
          },
        });
        await admin.payment.create({
          data: {
            organizationId: org.id,
            checkoutId: checkout.id,
            methodKey: 'manual_bank_transfer',
            methodType: 'manual_bank_transfer',
            provider: 'atlas_manual',
            amountMinorUnits: 100_000n,
            currency: 'EGP',
            status: 'succeeded',
            // Paid a month after signing up: still counts in the signup month.
            createdAt: new Date(createdAt.getTime() + 30 * 86_400_000),
          },
        });
        // A non-plan (add-on) succeeded payment alone never makes an org paying.
      }
      if (options.founding) {
        const plan = await seedPlan(admin, `${tag}-founding-plan`);
        const taken = await admin.foundingMembership.findMany({
          where: { status: { not: 'revoked' } },
          select: { seatNumber: true },
        });
        const used = new Set(taken.map((row) => row.seatNumber));
        const seat = Array.from({ length: 20 }, (_, i) => i + 1).find(
          (n) => !used.has(n),
        );
        if (seat === undefined) throw new Error('no free founding seat for the fixture');
        await admin.foundingMembership.create({
          data: {
            organizationId: org.id,
            seatNumber: seat,
            planId: plan.id,
            lockedAmount: 1000,
            lockedCurrency: 'EGP',
            lockStartsAt: createdAt,
            lockEndsAt: new Date(createdAt.getTime() + 730 * 86_400_000),
            status: 'ended',
            createdByUserId: po.userId,
            updatedByUserId: po.userId,
          },
        });
      }
      return org;
    }

    beforeAll(async () => {
      // Anything a previous, interrupted run left in the window.
      await admin.marketingSpendEntry.deleteMany({
        where: { month: { gte: new Date('2021-02-01'), lte: new Date('2021-04-01') } },
      });
      const stale = await admin.organization.findMany({
        where: {
          name: { startsWith: 'g1' },
          createdAt: {
            gte: new Date('2021-01-31T00:00:00Z'),
            lt: new Date('2021-05-01'),
          },
        },
        select: { id: true },
      });
      await admin.foundingMembership.deleteMany({
        where: { organizationId: { in: stale.map((o) => o.id) } },
      });
      await admin.organization.deleteMany({
        where: { id: { in: stale.map((o) => o.id) } },
      });

      await seedOrg('a', new Date('2021-03-10T10:00:00Z'), {
        heardFrom: 'facebook',
        paying: true,
        founding: true,
      });
      // 23:30 Cairo on 31 March → a March signup.
      await seedOrg('b', new Date('2021-03-31T21:30:00Z'), { heardFrom: 'facebook' });
      // 00:30 Cairo on 1 April → an April signup (Google Ads by UTM).
      await seedOrg('c', new Date('2021-03-31T22:30:00Z'), {
        attribution: { utmSource: 'google', utmMedium: 'cpc' },
        paying: true,
      });
      // No signal at all → unknown, but paying: in the blended CAC.
      await seedOrg('d', new Date('2021-03-15T10:00:00Z'), { paying: true });
      // Excluded from every number.
      await seedOrg('e', new Date('2021-03-12T10:00:00Z'), {
        heardFrom: 'facebook',
        paying: true,
        internal: true,
      });
      await seedOrg('f', new Date('2021-03-13T10:00:00Z'), {
        heardFrom: 'facebook',
        paying: true,
        archived: true,
      });
      // Self-reported tiktok, overridden to WhatsApp through the API.
      const g = await seedOrg('g', new Date('2021-03-20T10:00:00Z'), {
        heardFrom: 'tiktok',
      });
      await http()
        .patch(`/platform-growth/organizations/${g.id}/channel`)
        .set(bearer(po.token))
        .send({ channel: 'whatsapp' })
        .expect(200);

      for (const [month, channel, amountMinorUnits] of [
        ['2021-03', 'facebook', 100_000],
        ['2021-03', 'google_ads', 50_000],
        ['2021-04', 'google_ads', 30_000],
      ] as const) {
        await http()
          .post('/platform-growth/spend')
          .set(bearer(po.token))
          .send({ month, channel, amountMinorUnits, description: `cac ${tag}` })
          .expect(201);
      }
    });

    it('computes cohorts, CAC, founding subset, blended and coverage', async () => {
      const res = await http()
        .get('/platform-growth/cac?from=2021-02&to=2021-04')
        .set(bearer(po.token))
        .expect(200);
      const body = res.body as {
        from: string;
        to: string;
        currency: string;
        months: {
          month: string;
          channels: { channel: string; [k: string]: unknown }[];
          totals: Record<string, unknown>;
        }[];
        overall: Record<string, unknown> & { channels: { channel: string }[] };
        coverage: Record<string, unknown>;
      };
      expect(body).toMatchObject({ from: '2021-02', to: '2021-04', currency: 'EGP' });
      expect(body.months.map((m) => m.month)).toEqual(['2021-02', '2021-03', '2021-04']);
      const [feb, mar, apr] = body.months;
      const row = (m: (typeof body.months)[number], channel: string) =>
        m.channels.find((c) => c.channel === channel);

      expect(feb.totals).toMatchObject({
        signups: 0,
        paying: 0,
        blendedCacMinorUnits: null,
      });
      expect(mar.channels.map((c) => c.channel)).not.toContain('unknown');
      expect(row(mar, 'facebook')).toEqual({
        channel: 'facebook',
        signups: 2,
        paying: 1,
        foundingPaying: 1,
        spendMinorUnits: 100_000,
        cacMinorUnits: 100_000,
      });
      expect(row(mar, 'whatsapp')).toMatchObject({
        signups: 1,
        paying: 0,
        cacMinorUnits: null,
      });
      expect(row(mar, 'tiktok')).toMatchObject({ signups: 0 });
      expect(row(mar, 'google_ads')).toEqual({
        channel: 'google_ads',
        signups: 0,
        paying: 0,
        foundingPaying: 0,
        spendMinorUnits: 50_000,
        cacMinorUnits: null,
      });
      expect(mar.totals).toEqual({
        signups: 4,
        paying: 2,
        foundingPaying: 1,
        spendMinorUnits: 150_000,
        blendedCacMinorUnits: 75_000,
        attributedSignups: 3,
      });
      expect(row(apr, 'google_ads')).toMatchObject({
        signups: 1,
        paying: 1,
        spendMinorUnits: 30_000,
        cacMinorUnits: 30_000,
      });
      expect(apr.totals).toMatchObject({
        signups: 1,
        paying: 1,
        blendedCacMinorUnits: 30_000,
      });
      expect(body.overall).toMatchObject({
        signups: 5,
        paying: 3,
        foundingPaying: 1,
        spendMinorUnits: 180_000,
        blendedCacMinorUnits: 60_000,
        attributedSignups: 4,
      });
      expect(body.coverage).toEqual({ signups: 5, attributedSignups: 4, ratio: 0.8 });
    });

    it('validates the window', async () => {
      const bad = await http()
        .get('/platform-growth/cac?from=2021-05&to=2021-04')
        .set(bearer(po.token))
        .expect(400);
      expect(bad.body.error.messageKey).toBe('errors.growth.monthRangeInvalid');
      await http()
        .get('/platform-growth/cac?from=2021-13')
        .set(bearer(po.token))
        .expect(400);
    });
  });

  // -------------------------------------------------------------------------
  describe('capacity', () => {
    type Capacity = {
      timezone: string;
      week: Record<string, number | string>;
      weeks: { start: string }[];
      load: Record<string, number>;
      requests: { open: number; oldestOpenHours: number | null };
      hiring: Record<string, number | string>;
      alerts: { key: string; severity: string }[];
      season: Record<string, unknown>;
    };

    async function capacity(): Promise<Capacity> {
      const res = await http()
        .get('/platform-growth/capacity')
        .set(bearer(po.token))
        .expect(200);
      return res.body as Capacity;
    }

    async function onboardedPayingOrg(label: string, internal: boolean) {
      const org = await seedOrganizationWithOwner(admin, po.userId, `${tag}-${label}`);
      if (internal) {
        await admin.organizationPlatformFlags.create({
          data: { organizationId: org.id, isInternal: true },
        });
      }
      await admin.provisioningRequest.create({
        data: {
          organizationId: org.id,
          requestedByUserId: po.userId,
          requestedAcademyName: `${label} academy`,
          requestedSubdomain: `${tag}-${label}`.slice(0, 40),
          idempotencyKey: randomUUID(),
          status: 'ready',
          completedAt: new Date(),
        },
      });
      const plan = await seedPlan(admin, `${tag}-cap-plan`);
      await seedTenantSubscription(admin, org.id, plan.id, { status: 'active' });
      const checkout = await admin.checkout.create({
        data: {
          organizationId: org.id,
          targetType: 'plan_subscription',
          targetKey: plan.key,
          snapshot: {},
          status: 'completed',
          expiresAt: new Date(Date.now() + 86_400_000),
          idempotencyKey: randomUUID(),
        },
      });
      const payment = await admin.payment.create({
        data: {
          organizationId: org.id,
          checkoutId: checkout.id,
          methodKey: 'manual_bank_transfer',
          methodType: 'manual_bank_transfer',
          provider: 'atlas_manual',
          amountMinorUnits: 100_000n,
          currency: 'EGP',
          status: 'succeeded',
          reviewStatus: 'approved',
        },
      });
      await admin.paymentReview.create({
        data: { paymentId: payment.id, status: 'approved', reviewedBy: po.userId },
      });
      return org;
    }

    it('counts this week by the non-internal organization only', async () => {
      const before = await capacity();
      expect(before.timezone).toBe('Africa/Cairo');
      expect(before.weeks).toHaveLength(12);
      expect(before.weeks[11].start).toBe(before.week.start);

      await onboardedPayingOrg('cap-real', false);
      await onboardedPayingOrg('cap-internal', true);
      const trial = await seedOrganizationWithOwner(admin, po.userId, `${tag}-cap-trial`);
      const trialPlan = await seedPlan(admin, `${tag}-trial-plan`);
      await seedTenantSubscription(admin, trial.id, trialPlan.id, { status: 'trialing' });

      const after = await capacity();
      expect(after.week.start).toBe(before.week.start);
      expect({
        signups: (after.week.signups as number) - (before.week.signups as number),
        onboardings:
          (after.week.onboardings as number) - (before.week.onboardings as number),
        paidConversions:
          (after.week.paidConversions as number) -
          (before.week.paidConversions as number),
        payingOrgs: after.load.payingOrgs - before.load.payingOrgs,
        activeTrials: after.load.activeTrials - before.load.activeTrials,
      }).toEqual({
        signups: 2,
        onboardings: 1,
        paidConversions: 1,
        payingOrgs: 1,
        activeTrials: 1,
      });
      expect(after.hiring.payingOrgs).toBe(after.load.payingOrgs);
    });

    it('open requests and alerts follow the settings', async () => {
      const before = await capacity();
      const id = randomUUID();
      await admin.platformContactSubmission.create({
        data: {
          id,
          name: 'Visitor Example',
          email: `g1-${id}@example.test`,
          topic: 'sales',
          message: `Old enquiry ${tag}`,
          locale: 'en',
          ipHash: 'x'.repeat(64),
          createdAt: new Date(Date.now() - 72 * 3_600_000),
        },
      });
      const settings = await http()
        .get('/platform-growth/settings')
        .set(bearer(po.token))
        .expect(200);
      const payingNow = before.load.payingOrgs;
      await http()
        .patch('/platform-growth/settings')
        .set(bearer(po.token))
        .send({
          version: settings.body.version,
          hireWarnPayingOrgs: Math.max(1, payingNow),
          hireNowPayingOrgs: payingNow + 1000,
        })
        .expect(200);
      try {
        const after = await capacity();
        expect(after.requests.open).toBe(before.requests.open + 1);
        expect(after.requests.oldestOpenHours).toBeGreaterThanOrEqual(72);
        const keys = after.alerts.map((a) => `${a.key}:${a.severity}`);
        expect(keys).toContain('requests_backlog:warning');
        if (payingNow >= 1) {
          expect(after.hiring.state).toBe('warn');
          expect(keys).toContain('hire_warn:warning');
        }
      } finally {
        const current = await http()
          .get('/platform-growth/settings')
          .set(bearer(po.token))
          .expect(200);
        await http()
          .patch('/platform-growth/settings')
          .set(bearer(po.token))
          .send({
            version: current.body.version,
            hireWarnPayingOrgs: settings.body.hireWarnPayingOrgs,
            hireNowPayingOrgs: settings.body.hireNowPayingOrgs,
          })
          .expect(200);
        await admin.platformContactSubmission.delete({ where: { id } });
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('RLS (as the application role)', () => {
    it('a context-less read sees no spend or settings and cannot write', async () => {
      await http()
        .post('/platform-growth/spend')
        .set(bearer(po.token))
        .send({
          month: '2021-02',
          channel: 'event',
          amountMinorUnits: 500,
          description: `rls ${tag}`,
        })
        .expect(201);
      const seen = await tenancy.runWithoutContext(async (tx) => ({
        spend: await tx.marketingSpendEntry.count(),
        settings: await tx.growthSettings.count(),
        spendUpdate:
          await tx.$executeRaw`UPDATE marketing_spend_entries SET amount_minor_units = 1`,
        settingsUpdate:
          await tx.$executeRaw`UPDATE growth_settings SET onboarding_cap_per_week = 50`,
      }));
      expect(seen).toEqual({ spend: 0, settings: 0, spendUpdate: 0, settingsUpdate: 0 });
      await expect(
        tenancy.runWithoutContext((tx) =>
          tx.marketingSpendEntry.create({
            data: {
              month: new Date('2021-02-01'),
              channel: 'event',
              amountMinorUnits: 1n,
              createdByUserId: po.userId,
              updatedByUserId: po.userId,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('a signed-in non-owner sees nothing and writes nothing; the PO sees the rows', async () => {
      const rows = await tenancy.runInUserContext(tenant.userId, async (tx) => ({
        spend: await tx.marketingSpendEntry.count(),
        settings: await tx.growthSettings.count(),
        spendDelete: await tx.$executeRaw`DELETE FROM marketing_spend_entries`,
        settingsUpdate:
          await tx.$executeRaw`UPDATE growth_settings SET version = version + 1`,
        flagsUpdate:
          await tx.$executeRaw`UPDATE organization_platform_flags SET acquisition_channel_override = 'event'`,
      }));
      expect(rows).toEqual({
        spend: 0,
        settings: 0,
        spendDelete: 0,
        settingsUpdate: 0,
        flagsUpdate: 0,
      });
      await expect(
        tenancy.runInUserContext(tenant.userId, (tx) =>
          tx.marketingSpendEntry.create({
            data: {
              month: new Date('2021-02-01'),
              channel: 'event',
              amountMinorUnits: 1n,
              createdByUserId: tenant.userId,
              updatedByUserId: tenant.userId,
            },
          }),
        ),
      ).rejects.toThrow();
      const asPo = await tenancy.runInUserContext(po.userId, async (tx) => ({
        settings: await tx.growthSettings.count(),
        spend: await tx.marketingSpendEntry.count({
          where: { description: `rls ${tag}` },
        }),
      }));
      expect(asPo).toEqual({ settings: 1, spend: 1 });
    });

    it('the CHECKs hold even for the table owner', async () => {
      await expect(
        admin.$executeRaw`INSERT INTO marketing_spend_entries (id, month, channel, amount_minor_units, created_by_user_id, updated_by_user_id, updated_at)
          VALUES (${randomUUID()}, '2021-02-02', 'event', 1, ${po.userId}, ${po.userId}, now())`,
      ).rejects.toThrow();
      await expect(
        admin.$executeRaw`INSERT INTO marketing_spend_entries (id, month, channel, amount_minor_units, created_by_user_id, updated_by_user_id, updated_at)
          VALUES (${randomUUID()}, '2021-02-01', 'unknown', 1, ${po.userId}, ${po.userId}, now())`,
      ).rejects.toThrow();
      await expect(
        admin.$executeRaw`INSERT INTO growth_settings (id) VALUES (2)`,
      ).rejects.toThrow();
      await expect(
        admin.$executeRaw`UPDATE organizations SET heard_from = 'google_ads' WHERE id = ${tenant.organizationId}`,
      ).rejects.toThrow();
    });
  });
});
