/**
 * B0-SUP-04 / B0-IAM-08 / B0-ANL-04 (parts 2–3) — consent records,
 * attribution capture and the Platform Owner Growth funnel, end to end
 * against the real `AppModule`, real Postgres (FORCE RLS, `atlas_app`) and
 * real Redis (throttle + dedupe).
 *
 * WHAT IS PROVEN
 *   - every new collection is OFF by default: with the flags off, a client
 *     sending phone/consents/qualification/attribution stores none of it;
 *   - contact form (flag on): each consent combination is stored with its
 *     wording version and timestamp, marketing consent is not given unless
 *     ticked, the number is normalised, qualification is kept for `sales`
 *     only; throttle (6th → 429) and dedupe are unchanged;
 *   - enquiry retention: `dry_run` deletes nothing, `on` deletes only the
 *     enquiries past the period and audits the run;
 *   - organization owner signup (flag on): an opted-in owner's number and
 *     consent version are stored and the Platform Owner console shows it;
 *     an owner who did not opt in is hidden; changing the number withdraws
 *     it; a learner signup never stores a consent even if one is sent;
 *   - attribution (flag on): a tagged signup/enquiry stores the sanitised
 *     source with no email/phone; an untagged one stores nothing;
 *   - Growth: the weekly funnel counts real activation steps and excludes
 *     internal organizations; it is Platform-Owner-only.
 *
 * The live config objects are toggled per test (they are read on every
 * request) and restored afterwards. Fixture identities are obviously fake.
 */
import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
  seedEnrollment,
  seedOrganizationWithOwner,
  seedPayment,
} from './utils/db-admin';
import { uniqueName } from './utils/unique-name';
import type { IdentityConfig, LeadCaptureConfig } from '../src/config/configuration';
import { PlatformContactIntakeService } from '../src/platform-contact/services/platform-contact-intake.service';
import { PlatformContactRetentionService } from '../src/platform-contact/services/platform-contact-retention.service';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsProducer } from '../src/communications/queue/communications.producer';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';

jest.setTimeout(180000);

const PASSWORD = 'correct-horse-battery-consent';
const CONTACT_VERSION = 'contact-consent-2026-10-draft1';
const WHATSAPP_VERSION = 'signup-whatsapp-consent-2026-10-draft1';

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
  return `198.19.${(salt + Math.floor(ipCounter / 250)) % 255}.${(ipCounter % 250) + 1}`;
}

/** A random, valid Egyptian mobile number (national form) — fake, never a real person's. */
function fakeMobile(): string {
  return `010${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

describe('Lead consent and attribution (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flush: () => Promise<void>;
  let intake: PlatformContactIntakeService;
  let retention: PlatformContactRetentionService;
  let lead: LeadCaptureConfig;
  let identity: { signupOrganizationMode: IdentityConfig['signupOrganizationMode'] };
  let originalLead: LeadCaptureConfig;
  let owner: { userId: string; token: string };

  const http = () => request(app.getHttpServer());
  const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const testApp = await createTestApp({
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
    intake = app.get(PlatformContactIntakeService, { strict: false });
    retention = app.get(PlatformContactRetentionService, { strict: false });
    const config = app.get(ConfigService);
    lead = config.getOrThrow<LeadCaptureConfig>('leadCapture');
    identity = config.getOrThrow<IdentityConfig>('identity') as never;
    originalLead = { ...lead };
    await flush();
    owner = await seedPlatformOwner('lead-po');
  });

  beforeEach(async () => {
    await flush();
    Object.assign(lead, originalLead);
    identity.signupOrganizationMode = 'on';
  });

  afterAll(async () => {
    Object.assign(lead, originalLead);
    identity.signupOrganizationMode = 'off';
    await intake.drainNotifications();
    await admin.$disconnect();
    await app.close();
  });

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

  async function seedPlatformOwner(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const first = await signIn(email);
    await admin.user.update({
      where: { id: first.user.id },
      data: { isPlatformOwner: true },
    });
    const again = await signIn(email);
    return { userId: again.user.id, token: again.accessToken };
  }

  /** A plain management account (no organization). */
  async function seedPlatformlessAccount(label: string) {
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name: label, email, password: PASSWORD })
      .expect(201);
    const session = await signIn(email);
    return { email, userId: session.user.id };
  }

  /** Organization owner signup on the management surface. */
  async function ownerSignup(extra: Record<string, unknown> = {}) {
    const email = uniqueTestEmail('lead-owner');
    await http()
      .post('/auth/register')
      .send({
        name: 'Owner Example',
        email,
        password: PASSWORD,
        organizationName: uniqueName('Lead Org'),
        ...extra,
      })
      .expect(201);
    const session = await signIn(email);
    return {
      email,
      userId: session.user.id,
      token: session.accessToken,
      organizationId: session.user.organizations[0]?.organizationId as string,
    };
  }

  function orgDetail(organizationId: string) {
    return http()
      .get(`/organizations/${organizationId}`)
      .set(bearer(owner.token))
      .expect(200);
  }

  function enquiry(overrides: Record<string, unknown> = {}) {
    const tag = randomUUID();
    return {
      name: 'Visitor Example',
      email: `lead-${tag}@example.test`,
      topic: 'sales',
      message: `Please tell us more about Atlas for our centre. Ref ${tag}`,
      locale: 'en',
      startedAt: Date.now() - 30_000,
      ...overrides,
    };
  }

  function submit(body: Record<string, unknown>, ip = freshIp()) {
    return http().post('/public/contact').set('X-Real-IP', ip).send(body);
  }

  async function storedEnquiry(overrides: Record<string, unknown> = {}) {
    const body = enquiry(overrides);
    await submit(body).expect(201);
    const rows = await admin.platformContactSubmission.findMany({
      where: { email: body.email },
    });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  // ---------------------------------------------------------------------
  // Defaults: everything off
  // ---------------------------------------------------------------------

  it('ships every collection OFF: nothing new is stored even when a client sends it', async () => {
    expect(originalLead).toMatchObject({
      contactConsentMode: 'off',
      signupWhatsappConsentMode: 'off',
      attributionCaptureMode: 'off',
      contactRetentionMode: 'dry_run',
      contactRetentionMonths: 24,
    });
    const row = await storedEnquiry({
      phoneNumber: fakeMobile(),
      phoneCountry: 'EG',
      contactConsent: true,
      marketingConsent: true,
      requesterRole: 'teacher',
      studentBand: 'under_50',
      attribution: { utmSource: 'facebook' },
    });
    expect(row).toMatchObject({
      phoneE164: null,
      contactConsentAt: null,
      contactConsentVersion: null,
      marketingConsentAt: null,
      marketingConsentVersion: null,
      requesterRole: null,
      studentBand: null,
      attribution: null,
    });

    const signup = await ownerSignup({
      phoneNumber: fakeMobile(),
      phoneCountry: 'EG',
      whatsappConsent: true,
      attribution: { utmSource: 'facebook' },
    });
    const phone = await admin.userPhone.findUnique({ where: { userId: signup.userId } });
    expect(phone?.whatsappConsentAt).toBeNull();
    expect(phone?.whatsappConsentVersion).toBeNull();
    const org = await admin.organization.findUnique({
      where: { id: signup.organizationId },
    });
    expect(org?.signupAttribution).toBeNull();
    const detail = await orgDetail(signup.organizationId);
    expect(detail.body.ownerPhone).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // B0-SUP-04 — contact form
  // ---------------------------------------------------------------------

  describe('contact form consents (FLAG_CONTACT_CONSENT_MODE=on)', () => {
    beforeEach(() => {
      lead.contactConsentMode = 'on';
    });

    it.each([
      [false, false],
      [true, false],
      [false, true],
      [true, true],
    ])(
      'stores contact=%s / marketing=%s with wording version and timestamp',
      async (contactConsent, marketingConsent) => {
        const before = Date.now();
        const row = await storedEnquiry({ contactConsent, marketingConsent });
        for (const [given, at, version] of [
          [contactConsent, row.contactConsentAt, row.contactConsentVersion],
          [marketingConsent, row.marketingConsentAt, row.marketingConsentVersion],
        ] as const) {
          if (given) {
            expect(version).toBe(CONTACT_VERSION);
            expect(at).toBeInstanceOf(Date);
            expect((at as Date).getTime()).toBeGreaterThanOrEqual(before - 1000);
          } else {
            expect(version).toBeNull();
            expect(at).toBeNull();
          }
        }
      },
    );

    it('treats an omitted marketing consent as not given (false by default)', async () => {
      const row = await storedEnquiry();
      expect(row.marketingConsentAt).toBeNull();
      expect(row.marketingConsentVersion).toBeNull();
      expect(row.contactConsentAt).toBeNull();
    });

    it('normalises the WhatsApp number and keeps qualification for sales only', async () => {
      const national = fakeMobile();
      const sales = await storedEnquiry({
        phoneNumber: national,
        phoneCountry: 'EG',
        requesterRole: 'academy_owner',
        subject: '  Physics  ',
        studentBand: '200_1000',
        preferredChannel: 'whatsapp',
      });
      expect(sales).toMatchObject({
        phoneE164: `+20${national.slice(1)}`,
        phoneCountry: 'EG',
        requesterRole: 'academy_owner',
        subject: 'Physics',
        studentBand: '200_1000',
        preferredChannel: 'whatsapp',
      });
      const support = await storedEnquiry({
        topic: 'support',
        requesterRole: 'teacher',
        studentBand: 'under_50',
      });
      expect(support.requesterRole).toBeNull();
      expect(support.studentBand).toBeNull();
    });

    it('shows the consents to the Platform Owner inbox', async () => {
      const row = await storedEnquiry({ marketingConsent: true });
      const res = await http()
        .get(`/platform/contact-submissions/${row.id}`)
        .set(bearer(owner.token))
        .expect(200);
      expect(res.body.marketingConsent).toMatchObject({
        given: true,
        version: CONTACT_VERSION,
      });
      expect(res.body.contactConsent).toEqual({ given: false, at: null, version: null });
    });

    it('keeps the throttle (6th request from one IP is a 429) and the dedupe', async () => {
      const ip = freshIp();
      for (let i = 0; i < 5; i += 1) {
        await submit(enquiry({ marketingConsent: true }), ip).expect(201);
      }
      await submit(enquiry({ marketingConsent: true }), ip).expect(429);

      const body = enquiry({ contactConsent: true });
      await submit(body).expect(201);
      await submit(body).expect(201);
      const rows = await admin.platformContactSubmission.findMany({
        where: { email: body.email },
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('enquiry retention', () => {
    async function agedEnquiry(monthsAgo: number) {
      const row = await storedEnquiry();
      const createdAt = new Date();
      createdAt.setUTCMonth(createdAt.getUTCMonth() - monthsAgo);
      await admin.platformContactSubmission.update({
        where: { id: row.id },
        data: { createdAt },
      });
      return row.id;
    }

    it('dry_run deletes nothing; on deletes only enquiries past the period and audits it', async () => {
      const old = await agedEnquiry(25);
      const recent = await agedEnquiry(23);

      lead.contactRetentionMode = 'dry_run';
      const dry = await retention.run();
      expect(dry.mode).toBe('dry_run');
      expect(dry.eligible).toBeGreaterThanOrEqual(1);
      expect(dry.deleted).toBe(0);
      expect(await admin.platformContactSubmission.count({ where: { id: old } })).toBe(1);

      lead.contactRetentionMode = 'on';
      const real = await retention.run();
      expect(real.deleted).toBeGreaterThanOrEqual(1);
      expect(await admin.platformContactSubmission.count({ where: { id: old } })).toBe(0);
      expect(await admin.platformContactSubmission.count({ where: { id: recent } })).toBe(
        1,
      );
      const audit = await admin.auditLogEntry.findFirst({
        where: { action: 'platform.contact_submission.retention_purged' },
        orderBy: { occurredAt: 'desc' },
      });
      expect(audit?.context).toMatchObject({ retentionMonths: 24 });

      lead.contactRetentionMode = 'off';
      await expect(retention.run()).resolves.toMatchObject({ eligible: 0, deleted: 0 });
    });
  });

  // ---------------------------------------------------------------------
  // B0-IAM-08 — organization owner WhatsApp opt-in
  // ---------------------------------------------------------------------

  describe('owner WhatsApp opt-in (FLAG_SIGNUP_WHATSAPP_CONSENT_MODE=on)', () => {
    beforeEach(() => {
      lead.signupWhatsappConsentMode = 'on';
    });

    it('stores the consent version and shows an opted-in owner phone to the Platform Owner', async () => {
      const national = fakeMobile();
      const signup = await ownerSignup({
        phoneNumber: national,
        phoneCountry: 'EG',
        whatsappConsent: true,
      });
      const phone = await admin.userPhone.findUnique({
        where: { userId: signup.userId },
      });
      expect(phone?.whatsappConsentVersion).toBe(WHATSAPP_VERSION);
      expect(phone?.whatsappConsentAt).toBeInstanceOf(Date);

      const detail = await orgDetail(signup.organizationId);
      expect(detail.body.ownerPhone).toMatchObject({
        e164: `+20${national.slice(1)}`,
        country: 'EG',
        whatsappConsentVersion: WHATSAPP_VERSION,
      });

      // The opt-in was for that number: changing it withdraws the visibility.
      await http()
        .put('/users/me/phone')
        .set(bearer(signup.token))
        .send({ phoneNumber: fakeMobile(), phoneCountry: 'EG' })
        .expect(200);
      const after = await orgDetail(signup.organizationId);
      expect(after.body.ownerPhone).toBeUndefined();
      const changed = await admin.userPhone.findUnique({
        where: { userId: signup.userId },
      });
      expect(changed?.whatsappConsentAt).toBeNull();
    });

    it('hides an owner who did not opt in', async () => {
      const signup = await ownerSignup({ phoneNumber: fakeMobile(), phoneCountry: 'EG' });
      const phone = await admin.userPhone.findUnique({
        where: { userId: signup.userId },
      });
      expect(phone?.whatsappConsentAt).toBeNull();
      const detail = await orgDetail(signup.organizationId);
      expect(detail.body.ownerPhone).toBeUndefined();
      expect(detail.body.ownerEmail).toBe(signup.email);
    });

    it('never stores a consent on a learner signup, even if one is sent', async () => {
      // An academy owned through a fixture organization (not a signup one,
      // which already carries its own subscription row).
      const academyOwner = await seedPlatformlessAccount('lead-acad-owner');
      const org = await seedOrganizationWithOwner(
        admin,
        academyOwner.userId,
        'lead-acad-org',
      );
      await seedActiveSubscriptionForOrg(admin, org.id);
      const academy = await seedAcademy(admin, org.id, 'lead-acad');
      await admin.academy.update({
        where: { id: academy.id },
        data: { status: 'active', registrationPolicy: 'open' },
      });
      await seedAcademyMember(admin, academy.id, academyOwner.userId, 'owner');
      const host = `lead-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.consent.test`;
      await admin.domainConnection.create({
        data: { academyId: academy.id, hostname: host, status: 'connected' },
      });

      const email = uniqueTestEmail('lead-learner');
      await http()
        .post('/auth/register')
        .set('Host', host)
        .send({
          name: uniqueName('Learner'),
          email,
          password: PASSWORD,
          academyId: academy.id,
          phoneNumber: fakeMobile(),
          phoneCountry: 'EG',
          whatsappConsent: true,
          attribution: { utmSource: 'facebook' },
        })
        .expect(201);
      const learner = await admin.user.findUniqueOrThrow({ where: { email } });
      const phone = await admin.userPhone.findUnique({ where: { userId: learner.id } });
      expect(phone).not.toBeNull();
      expect(phone?.whatsappConsentAt).toBeNull();
      expect(phone?.whatsappConsentVersion).toBeNull();
    });
  });

  // ---------------------------------------------------------------------
  // B0-ANL-04 part 2 — attribution
  // ---------------------------------------------------------------------

  describe('attribution capture (FLAG_ATTRIBUTION_CAPTURE_MODE=on)', () => {
    beforeEach(() => {
      lead.attributionCaptureMode = 'on';
    });

    it('stores the sanitised source of a tagged signup, with no personal data', async () => {
      const signup = await ownerSignup({
        attribution: {
          utmSource: 'facebook',
          utmCampaign: 'launch-oct',
          utmContent: 'owner@example.test',
          utmTerm: '+20 100 000 0000',
          referrerDomain: 'https://news.example.org/some/path?q=1',
          landingTemplate: 'pricing',
        },
      });
      const org = await admin.organization.findUniqueOrThrow({
        where: { id: signup.organizationId },
      });
      expect(org.signupAttribution).toEqual({
        utmSource: 'facebook',
        utmCampaign: 'launch-oct',
        referrerDomain: 'news.example.org',
        landingTemplate: 'pricing',
      });
      const serialized = JSON.stringify(org.signupAttribution);
      expect(serialized).not.toContain('@');
      expect(serialized).not.toMatch(/\d{9,}/);
      const detail = await orgDetail(signup.organizationId);
      expect(detail.body.signupAttribution).toEqual(org.signupAttribution);
    });

    it('stores nothing for an untagged signup or enquiry', async () => {
      const signup = await ownerSignup({ attribution: { landingTemplate: 'home' } });
      const org = await admin.organization.findUniqueOrThrow({
        where: { id: signup.organizationId },
      });
      expect(org.signupAttribution).toBeNull();
      const plain = await ownerSignup();
      const plainOrg = await admin.organization.findUniqueOrThrow({
        where: { id: plain.organizationId },
      });
      expect(plainOrg.signupAttribution).toBeNull();
      const row = await storedEnquiry();
      expect(row.attribution).toBeNull();
    });

    it('stores a tagged enquiry source without personal data', async () => {
      const row = await storedEnquiry({
        attribution: {
          utmSource: 'google',
          utmMedium: 'cpc',
          utmTerm: 'me@example.test',
        },
      });
      expect(row.attribution).toEqual({ utmSource: 'google', utmMedium: 'cpc' });
    });
  });

  // ---------------------------------------------------------------------
  // B0-ANL-04 part 3 — Growth
  // ---------------------------------------------------------------------

  describe('GET /platform-metrics/growth', () => {
    type Growth = {
      timeZone: string;
      cohorts: {
        weekStart: string;
        signups: number;
        academyCreated: number;
        coursePublished: number;
        firstEnrolment: number;
        firstPayment: number;
      }[];
      totals: Record<string, number>;
      sources: { source: string | null; signups: number }[];
      excludesInternalOrganizations: boolean;
    };

    async function growth(): Promise<Growth> {
      const res = await http()
        .get('/platform-metrics/growth?weeks=4')
        .set(bearer(owner.token))
        .expect(200);
      return res.body as Growth;
    }

    async function activatedOrg(label: string, internal: boolean) {
      const org = await seedOrganizationWithOwner(admin, owner.userId, label);
      const academy = await seedAcademy(admin, org.id, `${label}-acad`);
      const course = await seedCourse(admin, academy.id, `${label} course`, {
        status: 'published',
      });
      await admin.course.update({
        where: { id: course.id },
        data: { publishedAt: new Date() },
      });
      await seedEnrollment(admin, owner.userId, course.id, academy.id);
      await seedPayment(admin, {
        organizationId: org.id,
        amountMinorUnits: 10000n,
        currency: 'EGP',
        status: 'succeeded',
      });
      if (internal) {
        await admin.organizationPlatformFlags.create({
          data: { organizationId: org.id, isInternal: true },
        });
      }
      return org;
    }

    it('counts each activation step for this week and excludes internal organizations', async () => {
      const before = await growth();
      expect(before.timeZone).toBe('Africa/Cairo');
      expect(before.cohorts).toHaveLength(4);
      expect(before.excludesInternalOrganizations).toBe(true);

      await activatedOrg('growth-full', false);
      const academyOnly = await seedOrganizationWithOwner(
        admin,
        owner.userId,
        'growth-acad',
      );
      await seedAcademy(admin, academyOnly.id, 'growth-acad-only');
      await activatedOrg('growth-internal', true);

      const after = await growth();
      const b = before.cohorts[before.cohorts.length - 1];
      const a = after.cohorts[after.cohorts.length - 1];
      expect(a.weekStart).toBe(b.weekStart);
      expect({
        signups: a.signups - b.signups,
        academyCreated: a.academyCreated - b.academyCreated,
        coursePublished: a.coursePublished - b.coursePublished,
        firstEnrolment: a.firstEnrolment - b.firstEnrolment,
        firstPayment: a.firstPayment - b.firstPayment,
      }).toEqual({
        signups: 2,
        academyCreated: 2,
        coursePublished: 1,
        firstEnrolment: 1,
        firstPayment: 1,
      });
      expect(after.totals.signups - before.totals.signups).toBe(2);
    });

    it('groups signups by stored source', async () => {
      lead.attributionCaptureMode = 'on';
      // Letters only: a long digit run would be dropped as phone-like.
      const source = `e2esrc-${Math.random()
        .toString(36)
        .replace(/[^a-z]/g, '')
        .slice(0, 8)}`;
      await ownerSignup({ attribution: { utmSource: source } });
      const res = await http()
        .get('/platform-metrics/growth?weeks=1')
        .set(bearer(owner.token))
        .expect(200);
      const sources = (res.body as Growth).sources;
      expect(sources.length).toBeLessThanOrEqual(10);
      // Top 10 only: on a busy shared database a fresh one-signup source can
      // be outranked, so its count is asserted whenever the list has room.
      if (sources.length < 10) {
        expect(sources.find((row) => row.source === source)?.signups).toBe(1);
      }
    });

    it('is Platform-Owner-only and bounds the window', async () => {
      const tenant = await ownerSignup();
      await http().get('/platform-metrics/growth').set(bearer(tenant.token)).expect(403);
      await http()
        .get('/platform-metrics/growth?weeks=27')
        .set(bearer(owner.token))
        .expect(400);
    });
  });
});
