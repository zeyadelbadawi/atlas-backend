/**
 * W2 — Academy provisioning: server-side branding, honest progress and a
 * resilient, idempotent flow. Real HTTP, real Postgres (FORCE RLS), real
 * BullMQ worker.
 *
 *   W2-1  the brand chosen in the form (hex palette) is applied by the
 *         worker's `branding` step and survives as the website brand;
 *   W2-2  no theme picked → the platform default theme, and starter pages
 *         are generated;
 *   W2-3  a BullMQ job that exhausted its attempts no longer swallows
 *         "Retry": the failed job is replaced (real BullMQ, private
 *         prefix) and a request with nothing driving it resumes on Retry;
 *   W2-4  `stalled` / `lastProgressAt` / `stage` on the status endpoint;
 *         Retry resumes a stalled request;
 *   W2-5  two tabs, one address: exactly one request wins, the other gets
 *         409 with the winner's id; a same-key double submit is one request;
 *   W2-6  validation: data: URIs, bad colours, unknown keys, taken address;
 *   W2-7  a branding failure does not block `ready`; Retry re-applies it;
 *   W2-8  the logo is attached by media-asset reference only;
 *   W2-9  authorization: only the organization's members read status; only
 *         the owner attaches a logo; another org's request is 404.
 */
import { INestApplication } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import {
  createAdminPrisma,
  seedActiveSubscriptionForOrg,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { WebsiteConfigurationService } from '../src/website/services/website-configuration.service';
import { ProvisioningOrchestratorService } from '../src/provisioning/services/provisioning-orchestrator.service';
import {
  PROVISIONING_QUEUE,
  type ProcessProvisioningJobPayload,
} from '../src/provisioning/queue/provisioning.types';
import {
  ProvisioningProducer,
  provisioningJobId,
} from '../src/provisioning/queue/provisioning.producer';
import { bullConnectionFromRedisUrl } from '../src/config/bull-connection.util';

jest.setTimeout(60000);

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

const BRAND = {
  palette: { seeds: { primary: '#2563eb' }, status: 'confirmed', source: 'manual' },
};

/** Academy names are unique platform-wide (W4), so every run uses fresh ones. */
function uniqueName(label: string): string {
  return `${label} Academy ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function uniqueSubdomain(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

describe('W2 — provisioning progress, branding and resilience (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let websiteConfigurationService: WebsiteConfigurationService;
  let orchestrator: ProvisioningOrchestratorService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    websiteConfigurationService = app.get(WebsiteConfigurationService, { strict: false });
    orchestrator = app.get(ProvisioningOrchestratorService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  async function signUp(label: string): Promise<{ userId: string; accessToken: string }> {
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

  async function arrangeOrg(label: string) {
    const owner = await signUp(`${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    await seedActiveSubscriptionForOrg(admin, org.id, label);
    return { owner, org };
  }

  function post(token: string, orgId: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post(`/organizations/${orgId}/provisioning-requests`)
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  async function getStatus(token: string, orgId: string, requestId: string) {
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgId}/provisioning-requests/${requestId}`)
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    return res.body;
  }

  async function waitForReady(token: string, orgId: string, requestId: string) {
    return waitForAsync(
      async () => {
        const body = await getStatus(token, orgId, requestId);
        return ['ready', 'failed', 'cancelled'].includes(body.status) ? body : undefined;
      },
      { timeoutMs: 30000 },
    );
  }

  const stepStatus = (body: { steps: { key: string; status: string }[] }, key: string) =>
    body.steps.find((step) => step.key === key)?.status;

  /** A request row + its seven pending steps, seeded directly — no job enqueued. */
  async function seedRequest(
    orgId: string,
    userId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const subdomain = uniqueSubdomain('w2-seeded');
    const seeded = await admin.provisioningRequest.create({
      data: {
        organizationId: orgId,
        requestedByUserId: userId,
        requestedAcademyName: uniqueName('Seeded'),
        requestedSubdomain: subdomain,
        selectedThemeKey: 'modern-education',
        idempotencyKey: `w2-${subdomain}`,
        ...overrides,
      },
    });
    await admin.provisioningStep.createMany({
      data: (
        [
          'tenant',
          'academy',
          'theme',
          'branding',
          'subdomain',
          'domain',
          'finalization',
        ] as const
      ).map((key) => ({ provisioningRequestId: seeded.id, key })),
    });
    return seeded;
  }

  it('W2-1: the palette chosen in the form is applied by the worker and stored as the website brand', async () => {
    const { owner, org } = await arrangeOrg('w2-brand');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Brand'),
      requestedSubdomain: uniqueSubdomain('w2-brand'),
      websiteSetupMode: 'complete',
      brand: BRAND,
      idempotencyKey: `w2-brand-${Date.now()}`,
    }).expect(201);
    expect(created.body.requestedBrand).toEqual({ palette: true, logo: 'none' });

    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    expect(ready.status).toBe('ready');
    expect(stepStatus(ready, 'branding')).toBe('completed');
    expect(ready.stage).toBe('ready');
    expect(ready.stalled).toBe(false);

    const configuration = await admin.websiteConfiguration.findUnique({
      where: { academyId: ready.academyId },
    });
    const brand = configuration!.brand as {
      primaryColor: string;
      palette: { seeds: { primary: string }; source: string };
    };
    // Hex in, the stored triplet out — and the legacy colour kept in step.
    expect(brand.palette.seeds.primary).toBe('221 83% 53%');
    expect(brand.palette.source).toBe('manual');
    expect(brand.primaryColor).toBe('221 83% 53%');
  });

  it('W2-2: no theme picked → the default theme is applied and starter pages are generated', async () => {
    const { owner, org } = await arrangeOrg('w2-default-theme');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Default Theme'),
      requestedSubdomain: uniqueSubdomain('w2-default'),
      websiteSetupMode: 'complete',
      idempotencyKey: `w2-default-${Date.now()}`,
    }).expect(201);
    expect(created.body.selectedThemeKey).toBe('modern-education');

    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    expect(ready.status).toBe('ready');
    expect(stepStatus(ready, 'theme')).toBe('completed');
    // Nothing chosen for the brand → skipped, as before (theme default colours).
    expect(stepStatus(ready, 'branding')).toBe('skipped');
    expect(ready.requestedBrand).toBeUndefined();

    const configuration = await admin.websiteConfiguration.findUnique({
      where: { academyId: ready.academyId },
    });
    expect(configuration?.themeKey).toBe('modern-education');
    const pages = await admin.websitePage.count({
      where: { academyId: ready.academyId },
    });
    expect(pages).toBeGreaterThan(0);
  });

  it('W2-3: Retry after a BullMQ job exhausted its attempts replaces the failed job (real BullMQ), and the request resumes', async () => {
    // Part 1 — the queue mechanics, against real Redis, on a PRIVATE
    // prefix with its own worker: no other process can pick these jobs up,
    // so "the job failed" is deterministic. The worker always throws: an
    // infrastructure failure outside `executeStep`, with `attempts: 1`.
    const connection = bullConnectionFromRedisUrl(process.env.REDIS_URL!);
    const prefix = `w2-retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const privateQueue = new Queue<ProcessProvisioningJobPayload>(PROVISIONING_QUEUE, {
      connection,
      prefix,
    });
    let failing = true;
    const processed: string[] = [];
    const worker = new Worker<ProcessProvisioningJobPayload>(
      PROVISIONING_QUEUE,
      async (job) => {
        if (failing) throw new Error('simulated infrastructure outage');
        processed.push(job.id!);
      },
      { connection, prefix },
    );
    try {
      const payload = { provisioningRequestId: 'w2-req', organizationId: 'w2-org' };
      const jobId = provisioningJobId(payload.provisioningRequestId);
      await privateQueue.add('process-provisioning-request', payload, {
        jobId,
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: false,
      });
      await waitForAsync(async () => {
        const job = await privateQueue.getJob(jobId);
        return job && (await job.getState()) === 'failed' ? true : undefined;
      });

      // What BullMQ does with a plain re-add under the same id: nothing.
      // (This is the bug: the pre-W2 producer only ever did this.)
      await privateQueue.add('process-provisioning-request', payload, { jobId });
      expect(await (await privateQueue.getJob(jobId))!.getState()).toBe('failed');

      // The W2 producer removes the failed job first, then re-adds it.
      failing = false;
      const producer = new ProvisioningProducer(privateQueue);
      await producer.enqueue(payload);
      await waitForAsync(async () => (processed.includes(jobId) ? true : undefined));
      // A second retry while nothing is held is harmless (idempotent).
      await producer.enqueue(payload);
      await producer.enqueue(payload);
    } finally {
      await worker.close();
      await privateQueue.obliterate({ force: true });
      await privateQueue.close();
    }

    // Part 2 — end to end through the API: a request left with nothing
    // driving it (its job gone) resumes from its current step on Retry.
    const { owner, org } = await arrangeOrg('w2-retry-job');
    const seeded = await seedRequest(org.id, owner.userId);
    const stuck = await getStatus(owner.accessToken, org.id, seeded.id);
    expect(stuck.status).toBe('payment_success');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    const ready = await waitForReady(owner.accessToken, org.id, seeded.id);
    expect(ready.status).toBe('ready');
    expect(stepStatus(ready, 'academy')).toBe('completed');

    // A Retry on the ready request is refused (nothing to retry).
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  it('W2-4: the status endpoint reports stalled/lastProgressAt/stage, and Retry resumes a stalled request', async () => {
    const { owner, org } = await arrangeOrg('w2-stall');
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
    const stalledRow = await seedRequest(org.id, owner.userId, {
      status: 'academy_created',
      startedAt: tenMinutesAgo,
      lastProgressAt: tenMinutesAgo,
      currentStepKey: 'academy',
    });
    const fresh = await seedRequest(org.id, owner.userId, {
      startedAt: new Date(),
      lastProgressAt: new Date(),
    });

    const stalled = await getStatus(owner.accessToken, org.id, stalledRow.id);
    expect(stalled.stalled).toBe(true);
    expect(stalled.stage).toBe('academy');
    expect(stalled.lastProgressAt).toBe(tenMinutesAgo.toISOString());
    expect(stalled.stallThresholdSeconds).toBe(120);

    const notStalled = await getStatus(owner.accessToken, org.id, fresh.id);
    expect(notStalled.stalled).toBe(false);
    expect(notStalled.stage).toBe('academy');

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${stalledRow.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    const ready = await waitForReady(owner.accessToken, org.id, stalledRow.id);
    expect(ready.status).toBe('ready');
    expect(ready.stalled).toBe(false);
    expect(new Date(ready.lastProgressAt).getTime()).toBeGreaterThan(
      tenMinutesAgo.getTime(),
    );
  });

  it('W2-5: two tabs, one address — exactly one request wins; the other gets 409 with the winner id', async () => {
    const { owner, org } = await arrangeOrg('w2-race');
    const subdomain = uniqueSubdomain('w2-race');
    const body = (key: string, requestedSubdomain = subdomain) => ({
      academyName: uniqueName('Race'),
      requestedSubdomain,
      idempotencyKey: key,
    });

    const [a, b] = await Promise.all([
      post(owner.accessToken, org.id, body(`tab-a-${subdomain}`)),
      post(owner.accessToken, org.id, body(`tab-b-${subdomain}`)),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const winner = a.status === 201 ? a : b;
    const loser = a.status === 201 ? b : a;
    expect(loser.body.error.messageKey).toBe(
      'errors.provisioning.subdomainRequestInProgress',
    );
    expect(loser.body.error.code).toBe('subdomain_request_in_progress');
    expect(loser.body.error.details).toEqual({ requestId: winner.body.id });

    const ready = await waitForReady(owner.accessToken, org.id, winner.body.id);
    expect(ready.status).toBe('ready');
    expect(
      await admin.provisioningRequest.count({ where: { requestedSubdomain: subdomain } }),
    ).toBe(1);
    expect(await admin.academy.count({ where: { slug: subdomain } })).toBe(1);

    // A refresh (a new form, a new key) after it is ready: the address is taken.
    const after = await post(
      owner.accessToken,
      org.id,
      body(`tab-c-${subdomain}`),
    ).expect(409);
    expect(after.body.error.messageKey).toBe('errors.provisioning.subdomainUnavailable');

    // Same key twice at once (a double click) is ONE request.
    const doubleSub = uniqueSubdomain('w2-double');
    const [c, d] = await Promise.all([
      post(owner.accessToken, org.id, body(`dbl-${doubleSub}`, doubleSub)),
      post(owner.accessToken, org.id, body(`dbl-${doubleSub}`, doubleSub)),
    ]);
    expect([c.status, d.status]).toEqual([201, 201]);
    expect(c.body.id).toBe(d.body.id);
  });

  it('W2-6: validation refuses data: URIs, bad colours and unknown brand keys, creating nothing', async () => {
    const { owner, org } = await arrangeOrg('w2-validate');
    const base = () => ({
      academyName: uniqueName('Validate'),
      requestedSubdomain: uniqueSubdomain('w2-val'),
      idempotencyKey: `w2-val-${Date.now()}-${Math.random()}`,
    });

    const dataUri = await post(owner.accessToken, org.id, {
      ...base(),
      brand: { logo: 'data:image/png;base64,AAAA' },
    }).expect(400);
    expect(dataUri.body.error.violations[0]).toEqual({
      field: 'brand.logo',
      messageKey: 'errors.provisioning.brandDataUriRejected',
    });

    const badColor = await post(owner.accessToken, org.id, {
      ...base(),
      brand: { palette: { ...BRAND.palette, seeds: { primary: 'not-a-colour' } } },
    }).expect(400);
    expect(badColor.body.error.violations[0]).toEqual({
      field: 'brand.palette.seeds.primary',
      messageKey: 'validation:invalidColor',
    });

    const unknown = await post(owner.accessToken, org.id, {
      ...base(),
      brand: { logoUrl: 'https://example.com/logo.png' },
    }).expect(400);
    expect(unknown.body.error.violations[0].messageKey).toBe(
      'errors.provisioning.brandUnknownField',
    );

    const notObject = await post(owner.accessToken, org.id, { ...base(), brand: 'red' });
    expect(notObject.status).toBe(400);

    // Nothing was created by any refused call.
    expect(
      await admin.provisioningRequest.count({ where: { organizationId: org.id } }),
    ).toBe(0);
  });

  it('W2-7: a branding failure does not block ready; Retry re-applies the brand', async () => {
    const { owner, org } = await arrangeOrg('w2-brand-fail');
    // Driven in-process (not through the shared queue), so the spy below is
    // guaranteed to be the code that runs.
    const seeded = await seedRequest(org.id, owner.userId, {
      requestedBrand: {
        palette: {
          seeds: { primary: '221 83% 53%' },
          status: 'confirmed',
          source: 'manual',
        },
      },
    });
    const created = { body: { id: seeded.id } };
    const original = websiteConfigurationService.saveVisualIdentity.bind(
      websiteConfigurationService,
    );
    const spy = jest
      .spyOn(websiteConfigurationService, 'saveVisualIdentity')
      .mockImplementation(() =>
        Promise.reject(new Error('simulated brand write failure')),
      );
    await orchestrator.runToCompletion(seeded.id, org.id);

    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    expect(ready.status).toBe('ready');
    expect(ready.lastError).toBeUndefined();
    expect(stepStatus(ready, 'branding')).toBe('failed');
    const brandingStep = ready.steps.find((s: { key: string }) => s.key === 'branding');
    expect(brandingStep.error.messageKey).toBe('errors.provisioning.stepFailed');
    expect(stepStatus(ready, 'finalization')).toBe('completed');
    // A non-blocking failure never auto-opens a support case.
    const row = await admin.provisioningRequest.findUnique({
      where: { id: created.body.id },
    });
    expect(row?.autoSupportCaseId).toBeNull();

    spy.mockImplementation(original);
    const retried = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${created.body.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(stepStatus(retried.body, 'branding')).toBe('completed');
    expect(retried.body.status).toBe('ready');

    const configuration = await admin.websiteConfiguration.findUnique({
      where: { academyId: ready.academyId },
    });
    expect(
      (configuration!.brand as { palette: { seeds: { primary: string } } }).palette.seeds
        .primary,
    ).toBe('221 83% 53%');
  });

  it('W2-8: the logo is attached by media-asset reference only, once the academy exists', async () => {
    const { owner, org } = await arrangeOrg('w2-logo');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Logo'),
      requestedSubdomain: uniqueSubdomain('w2-logo'),
      brand: { ...BRAND, logoPending: true },
      idempotencyKey: `w2-logo-${Date.now()}`,
    }).expect(201);
    expect(created.body.requestedBrand).toEqual({
      palette: true,
      logo: 'awaiting_upload',
    });

    const ready = await waitForReady(owner.accessToken, org.id, created.body.id);
    const uploaded = await request(app.getHttpServer())
      .post(`/academies/${ready.academyId}/media`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        fileName: 'logo.png',
        mimeType: 'image/png',
        sizeBytes: PNG.length,
        dataUrl: `data:image/png;base64,${PNG.toString('base64')}`,
      })
      .expect(201);

    // A raw URL / data URI is not a media-asset id.
    await request(app.getHttpServer())
      .put(`/organizations/${org.id}/provisioning-requests/${created.body.id}/brand-logo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaAssetId: 'data:image/png;base64,AAAA' })
      .expect(400);
    // An id that is not this academy's asset.
    await request(app.getHttpServer())
      .put(`/organizations/${org.id}/provisioning-requests/${created.body.id}/brand-logo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaAssetId: '00000000-0000-4000-8000-000000000000' })
      .expect(400);

    const attached = await request(app.getHttpServer())
      .put(`/organizations/${org.id}/provisioning-requests/${created.body.id}/brand-logo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaAssetId: uploaded.body.id })
      .expect(200);
    expect(attached.body.requestedBrand).toEqual({ palette: true, logo: 'attached' });

    const academy = await admin.academy.findUnique({ where: { id: ready.academyId } });
    expect(academy?.logoUrl).toBe(uploaded.body.url);
    const row = await admin.provisioningRequest.findUnique({
      where: { id: created.body.id },
    });
    expect(JSON.stringify(row?.requestedBrand)).not.toContain('data:');

    // Idempotent: attaching the same asset again is fine.
    await request(app.getHttpServer())
      .put(`/organizations/${org.id}/provisioning-requests/${created.body.id}/brand-logo`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ mediaAssetId: uploaded.body.id })
      .expect(200);
  });

  it('W2-9: only the organization members read the status; only the owner attaches a logo', async () => {
    const { owner, org } = await arrangeOrg('w2-authz');
    const created = await post(owner.accessToken, org.id, {
      academyName: uniqueName('Authz'),
      requestedSubdomain: uniqueSubdomain('w2-authz'),
      idempotencyKey: `w2-authz-${Date.now()}`,
    }).expect(201);
    await waitForReady(owner.accessToken, org.id, created.body.id);

    // A member of the same organization (not the owner) may read it…
    const manager = await signUp('w2-authz-manager');
    await seedMembership(admin, org.id, manager.userId, 'manager');
    const asManager = await getStatus(manager.accessToken, org.id, created.body.id);
    expect(asManager.id).toBe(created.body.id);
    // …but may not attach a logo (owner-only, like creating the request).
    await request(app.getHttpServer())
      .put(`/organizations/${org.id}/provisioning-requests/${created.body.id}/brand-logo`)
      .set('Authorization', `Bearer ${manager.accessToken}`)
      .send({ mediaAssetId: '00000000-0000-4000-8000-000000000000' })
      .expect(403);

    // A stranger is refused at the organization boundary.
    const stranger = await signUp('w2-authz-stranger');
    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/provisioning-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${stranger.accessToken}`)
      .expect(403);

    // Another organization's owner, through their OWN organization, cannot
    // reach this request id either.
    const { owner: otherOwner, org: otherOrg } = await arrangeOrg('w2-authz-other');
    await request(app.getHttpServer())
      .get(`/organizations/${otherOrg.id}/provisioning-requests/${created.body.id}`)
      .set('Authorization', `Bearer ${otherOwner.accessToken}`)
      .expect(404);
    await request(app.getHttpServer())
      .post(
        `/organizations/${otherOrg.id}/provisioning-requests/${created.body.id}/retry`,
      )
      .set('Authorization', `Bearer ${otherOwner.accessToken}`)
      .expect(404);

    // No token at all.
    await request(app.getHttpServer())
      .get(`/organizations/${org.id}/provisioning-requests/${created.body.id}`)
      .expect(401);
  });
});
