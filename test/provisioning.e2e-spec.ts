/**
 * Provisioning Orchestration — functional/contract e2e suite (Phase P14,
 * master plan §21/§5.11). The real business flow this phase exists to
 * prove end to end: a Tenant creates a ProvisioningRequest → the
 * `provisioning-worker` (real BullMQ/Redis, real Postgres, no mocks) walks
 * the 7-step state machine to a terminal `ready`/`failed` status →
 * completed/skipped steps are never re-executed → a genuinely failed step
 * is retryable and resumes correctly → a redelivered/duplicate worker job
 * for an already-terminal request is a safe no-op.
 *
 * Tenant isolation and Platform Owner review-console authorization are
 * covered separately in `provisioning-tenant-isolation.e2e-spec.ts`; the
 * direct-Postgres RLS proof is `rls-provisioning.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner } from './utils/db-admin';
import { ProvisioningProducer } from '../src/provisioning/queue/provisioning.producer';
import type { PrismaClient } from '@prisma/client';

// Real BullMQ round trips (enqueue → worker pickup → orchestrator → DB),
// not slow assertions — same headroom reasoning as
// `media-processing-worker.e2e-spec.ts`'s own per-file override.
jest.setTimeout(30000);

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

function uniqueSubdomain(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

describe('Provisioning Orchestration — P14 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let provisioningProducer: ProvisioningProducer;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    provisioningProducer = app.get(ProvisioningProducer, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function arrangeOrg(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    return { owner, org };
  }

  async function createRequest(
    owner: { accessToken: string },
    orgId: string,
    overrides: Partial<{
      academyName: string;
      requestedSubdomain: string;
      idempotencyKey: string;
      triggeringPaymentId: string;
    }> = {},
  ) {
    const subdomain = overrides.requestedSubdomain ?? uniqueSubdomain('academy');
    const res = await request(app.getHttpServer())
      .post(`/organizations/${orgId}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: overrides.academyName ?? 'Test Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: overrides.idempotencyKey ?? `idem-${subdomain}`,
        ...(overrides.triggeringPaymentId
          ? { triggeringPaymentId: overrides.triggeringPaymentId }
          : {}),
      })
      .expect(201);
    return res.body;
  }

  async function getRequest(
    owner: { accessToken: string },
    orgId: string,
    requestId: string,
  ) {
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgId}/provisioning-requests/${requestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    return res.body;
  }

  async function waitForTerminal(
    owner: { accessToken: string },
    orgId: string,
    requestId: string,
  ) {
    return waitForAsync(async () => {
      const body = await getRequest(owner, orgId, requestId);
      return ['ready', 'failed', 'cancelled'].includes(body.status) ? body : undefined;
    });
  }

  // --- 1. Creation shape ----------------------------------------------------

  it('1: creating a request returns the correct initial shape', async () => {
    const { owner, org } = await arrangeOrg('create-shape');
    const body = await createRequest(owner, org.id);

    expect(body).toMatchObject({
      organizationId: org.id,
      status: 'payment_success',
      currentStepKey: 'tenant',
      attemptCount: 0,
      requestedAcademyName: 'Test Academy',
    });
    expect(body.academyId).toBeUndefined();
    expect(body.id).toBeTruthy();
  });

  // --- 2. Correct seven-step initialization ---------------------------------

  it('2: initializes exactly the seven canonical steps, in order', async () => {
    const { owner, org } = await arrangeOrg('seven-steps');
    const body = await createRequest(owner, org.id);

    expect(body.steps.map((s: { key: string }) => s.key)).toEqual([
      'tenant',
      'academy',
      'theme',
      'branding',
      'subdomain',
      'domain',
      'finalization',
    ]);
  });

  // --- 3. Happy path through all seven steps --------------------------------

  it('3: the happy path runs all seven steps to a ready terminal state', async () => {
    const { owner, org } = await arrangeOrg('happy-path');
    const subdomain = uniqueSubdomain('happy');
    const created = await createRequest(owner, org.id, {
      academyName: 'Happy Academy',
      requestedSubdomain: subdomain,
    });

    const final = await waitForTerminal(owner, org.id, created.id);

    expect(final.status).toBe('ready');
    expect(final.academyId).toBeTruthy();
    expect(final.completedAt).toBeTruthy();
    expect(final.startedAt).toBeTruthy();

    const byKey = Object.fromEntries(
      final.steps.map((s: { key: string; status: string }) => [s.key, s.status]),
    );
    expect(byKey).toEqual({
      tenant: 'completed',
      academy: 'completed',
      theme: 'skipped',
      branding: 'skipped',
      subdomain: 'completed',
      domain: 'skipped',
      finalization: 'completed',
    });

    // The real Academy this request created — no duplicate, correct fields.
    const academy = await admin.academy.findUnique({ where: { id: final.academyId } });
    expect(academy).toMatchObject({
      organizationId: org.id,
      name: 'Happy Academy',
      slug: subdomain,
    });

    // The real subdomain allocation this request created.
    expect(final.subdomain).toMatchObject({ subdomain, status: 'assigned' });
  });

  // --- 4. Step/request bookkeeping persistence ------------------------------

  it('4: currentStepKey stays at the last step and every step timestamp is persisted', async () => {
    const { owner, org } = await arrangeOrg('bookkeeping');
    const created = await createRequest(owner, org.id);
    const final = await waitForTerminal(owner, org.id, created.id);

    expect(final.currentStepKey).toBe('finalization');
    for (const step of final.steps) {
      if (step.status === 'completed' || step.status === 'skipped') {
        expect(step.completedAt).toBeTruthy();
        expect(step.attemptNumber).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // --- 5. Idempotent creation ------------------------------------------------

  it('5: replaying the same idempotency key returns the same request, never a duplicate', async () => {
    const { owner, org } = await arrangeOrg('idem-create');
    const idempotencyKey = `idem-fixed-${Date.now()}`;
    const first = await createRequest(owner, org.id, { idempotencyKey });
    const second = await createRequest(owner, org.id, {
      idempotencyKey,
      requestedSubdomain: uniqueSubdomain('should-be-ignored'),
    });

    expect(second.id).toBe(first.id);
    const count = await admin.provisioningRequest.count({
      where: { organizationId: org.id, idempotencyKey },
    });
    expect(count).toBe(1);
  });

  // --- 6. Reserved subdomain refused -----------------------------------------

  it('6: a reserved subdomain is refused at creation', async () => {
    const { owner, org } = await arrangeOrg('reserved-sub');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Reserved Academy',
        requestedSubdomain: 'admin',
        idempotencyKey: `idem-reserved-${Date.now()}`,
      })
      .expect(409);
  });

  // --- 7. Invalid subdomain shape refused -------------------------------------

  it('7: an invalid subdomain shape is refused with 400', async () => {
    const { owner, org } = await arrangeOrg('invalid-sub');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Invalid Academy',
        requestedSubdomain: 'AB',
        idempotencyKey: `idem-invalid-${Date.now()}`,
      })
      .expect(400);
  });

  // --- 8. triggeringPaymentId must belong to the caller's own organization ---

  it('8: a triggeringPaymentId from a different organization is refused with 404', async () => {
    const { owner, org } = await arrangeOrg('payment-ref-a');
    const { org: otherOrg } = await arrangeOrg('payment-ref-b');
    const foreignPayment = await admin.payment.create({
      data: {
        organizationId: otherOrg.id,
        methodKey: 'manual',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: 1000n,
        currency: 'USD',
        status: 'succeeded',
      },
    });

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Payment Ref Academy',
        requestedSubdomain: uniqueSubdomain('payref'),
        idempotencyKey: `idem-payref-${Date.now()}`,
        triggeringPaymentId: foreignPayment.id,
      })
      .expect(404);
  });

  // --- 9. A valid triggeringPaymentId is persisted and returned ---------------

  it('9: a valid triggeringPaymentId (own organization) is accepted and returned', async () => {
    const { owner, org } = await arrangeOrg('payment-ref-ok');
    const payment = await admin.payment.create({
      data: {
        organizationId: org.id,
        methodKey: 'manual',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: 2500n,
        currency: 'USD',
        status: 'succeeded',
      },
    });

    const body = await createRequest(owner, org.id, { triggeringPaymentId: payment.id });
    expect(body.triggeringPaymentId).toBe(payment.id);
  });

  // --- 10. Listing is organization-scoped and paginated ------------------------

  it("10: listing returns only this organization's requests, in a paginated envelope", async () => {
    const { owner, org } = await arrangeOrg('list-scope');
    await createRequest(owner, org.id);
    await createRequest(owner, org.id);

    const res = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.pagination).toMatchObject({ page: 1, totalItems: 2 });
    expect(res.body.items).toHaveLength(2);
    expect(
      res.body.items.every(
        (i: { organizationId: string }) => i.organizationId === org.id,
      ),
    ).toBe(true);
  });

  // --- 11. 404 for a nonexistent request id ------------------------------------

  it('11: getting a nonexistent request id returns 404', async () => {
    const { owner, org } = await arrangeOrg('not-found');
    await request(app.getHttpServer())
      .get(
        `/organizations/${org.id}/provisioning-requests/00000000-0000-0000-0000-000000000000`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  // --- 12. 401 without an access token ------------------------------------------

  it('12: creating a request without an access token returns 401', async () => {
    const { org } = await arrangeOrg('unauth');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .send({
        academyName: 'Unauth Academy',
        requestedSubdomain: uniqueSubdomain('unauth'),
        idempotencyKey: `idem-unauth-${Date.now()}`,
      })
      .expect(401);
  });

  // --- 13-17. Failure, retry, and resume ----------------------------------------

  it('13-17: a genuine academy-step failure is recorded, is retryable, resumes correctly, and never re-executes an already-completed step', async () => {
    const { owner, org } = await arrangeOrg('fail-resume');
    const { org: blockerOrg } = await arrangeOrg('fail-resume-blocker');
    const subdomain = uniqueSubdomain('blocked');

    // Blocks the academy step: a real academy in a DIFFERENT organization
    // already holds this exact globally-unique slug (test-fixture-only
    // construction via the admin connection — the app itself never lets
    // two academies share a slug). Belonging to a different organization
    // is essential here: RLS hides it from this request's own tenant
    // context, so the academy step's slug-conflict "adopt my own prior
    // attempt" path correctly does NOT trigger — this is a genuine,
    // unrecoverable-until-fixed failure, not an idempotent replay.
    const blocker = await admin.academy.create({
      data: { organizationId: blockerOrg.id, name: 'Blocker Academy', slug: subdomain },
    });

    const created = await createRequest(owner, org.id, {
      academyName: 'Resumable Academy',
      requestedSubdomain: subdomain,
    });

    // 13: failure mid-provisioning is recorded correctly.
    const failed = await waitForTerminal(owner, org.id, created.id);
    expect(failed.status).toBe('failed');
    expect(failed.failedAt).toBeTruthy();
    expect(failed.lastError).toBeTruthy();
    expect(failed.currentStepKey).toBe('academy');

    const stepsByKey = Object.fromEntries(
      failed.steps.map((s: { key: string; status: string; attemptNumber: number }) => [
        s.key,
        s,
      ]),
    );
    expect(stepsByKey.tenant.status).toBe('completed');
    expect(stepsByKey.tenant.attemptNumber).toBe(1);
    expect(stepsByKey.academy.status).toBe('failed');
    expect(stepsByKey.academy.attemptNumber).toBe(1);

    // 14: a ready/cancelled request cannot be retried, but a failed one can.
    // 15: resume after failure — remove the blocker (test-fixture cleanup,
    // not application logic) and retry.
    await admin.academy.delete({ where: { id: blocker.id } });
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${created.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    // `failed` is itself a valid terminal polling state, AND
    // `runToCompletion` commits its `attemptCount` bump, AND `markRunning`
    // commits its own `attemptNumber` bump, each in their OWN transaction
    // BEFORE the step's real outcome is persisted — so a check keyed on
    // either alone can still observe a transient in-between snapshot (the
    // academy step genuinely `running`, mid-retry) as if it were a
    // concluded new outcome. And once the academy step itself resolves,
    // the SAME `runToCompletion` call keeps going through the remaining
    // steps (theme/branding/subdomain/domain/finalization) before the
    // whole request reaches a real terminal status — so the wait condition
    // requires BOTH: the academy step genuinely re-executed (its own
    // `attemptNumber` advanced and it is no longer `running`), AND the
    // request as a whole has reached ready/failed/cancelled.
    const preRetryAcademyAttemptNumber = stepsByKey.academy.attemptNumber;
    const resumed = await waitForAsync(async () => {
      const body = await getRequest(owner, org.id, created.id);
      const academyStep = body.steps.find(
        (s: { key: string; attemptNumber: number; status: string }) =>
          s.key === 'academy',
      );
      const academyStepResolved =
        academyStep.attemptNumber > preRetryAcademyAttemptNumber &&
        academyStep.status !== 'running';
      const requestResolved = ['ready', 'failed', 'cancelled'].includes(body.status);
      return academyStepResolved && requestResolved ? body : undefined;
    });
    expect(resumed.status).toBe('ready');
    expect(resumed.academyId).toBeTruthy();

    const resumedStepsByKey = Object.fromEntries(
      resumed.steps.map((s: { key: string; status: string; attemptNumber: number }) => [
        s.key,
        s,
      ]),
    );
    // 16: the already-completed `tenant` step was never re-executed — its
    // attemptNumber is still exactly 1, even though the request as a whole
    // was retried.
    expect(resumedStepsByKey.tenant.attemptNumber).toBe(1);
    // 17: the failed `academy` step WAS re-executed on retry — its
    // attemptNumber advanced from 1 to 2, and it now succeeds.
    expect(resumedStepsByKey.academy.attemptNumber).toBe(2);
    expect(resumedStepsByKey.academy.status).toBe('completed');

    // Exactly one real Academy exists for this request — no duplicate
    // Academy creation across the failed + retried attempts.
    const academyCount = await admin.academy.count({ where: { slug: subdomain } });
    expect(academyCount).toBe(1);
  });

  // --- 18. A ready request cannot be retried -------------------------------------

  it('18: retrying an already-ready request is refused with 409', async () => {
    const { owner, org } = await arrangeOrg('retry-ready');
    const created = await createRequest(owner, org.id);
    await waitForTerminal(owner, org.id, created.id);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${created.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  // --- 19. Cancellation ------------------------------------------------------------

  it('19: cancelling a non-terminal request transitions it to cancelled, and a cancelled request cannot be cancelled again', async () => {
    const { owner, org } = await arrangeOrg('cancel-flow');
    // Seeded directly via the admin connection, deliberately WITHOUT ever
    // enqueuing a worker job — genuinely, deterministically non-terminal
    // (`payment_success`, the real initial status), rather than racing the
    // real worker to catch it mid-flight. Mirrors `db-admin.ts`'s own
    // "elevated connection for fixture arrangement only" precedent; the
    // SYSTEM UNDER TEST here is the cancel endpoint, not step execution.
    const subdomain = uniqueSubdomain('cancel');
    const seeded = await admin.provisioningRequest.create({
      data: {
        organizationId: org.id,
        requestedByUserId: owner.userId,
        requestedAcademyName: 'Cancel Me Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: `idem-cancel-${subdomain}`,
      },
    });
    await admin.provisioningStep.createMany({
      data: [
        'tenant',
        'academy',
        'theme',
        'branding',
        'subdomain',
        'domain',
        'finalization',
      ].map((key) => ({
        provisioningRequestId: seeded.id,
        key: key as
          | 'tenant'
          | 'academy'
          | 'theme'
          | 'branding'
          | 'subdomain'
          | 'domain'
          | 'finalization',
      })),
    });

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const cancelled = await getRequest(owner, org.id, seeded.id);
    expect(cancelled.status).toBe('cancelled');

    // Cancelling an already-terminal (`cancelled`) request is refused.
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  // --- 20. Worker redelivery of an already-terminal request is a safe no-op --------

  it('20: redelivering a job for an already-ready request never re-creates the Academy/subdomain and never bumps attemptCount', async () => {
    const { owner, org } = await arrangeOrg('redelivery');
    const created = await createRequest(owner, org.id);
    const ready = await waitForTerminal(owner, org.id, created.id);
    expect(ready.status).toBe('ready');

    await provisioningProducer.enqueue({
      provisioningRequestId: created.id,
      organizationId: org.id,
    });
    // Give the (real) worker a moment to pick this up and no-op.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await getRequest(owner, org.id, created.id);
    expect(after.attemptCount).toBe(ready.attemptCount);
    expect(after.completedAt).toBe(ready.completedAt);

    const academyCount = await admin.academy.count({ where: { id: ready.academyId } });
    expect(academyCount).toBe(1);
    const subdomainCount = await admin.subdomainAllocation.count({
      where: { academyId: ready.academyId },
    });
    expect(subdomainCount).toBe(1);
  });

  // --- 21. Skipped steps are never re-executed --------------------------------------

  it('21: skipped steps (theme/branding/domain) keep their original attemptNumber across a redelivery', async () => {
    const { owner, org } = await arrangeOrg('skip-no-rerun');
    const created = await createRequest(owner, org.id);
    const ready = await waitForTerminal(owner, org.id, created.id);
    const before = Object.fromEntries(
      ready.steps.map((s: { key: string; attemptNumber: number }) => [
        s.key,
        s.attemptNumber,
      ]),
    );

    await provisioningProducer.enqueue({
      provisioningRequestId: created.id,
      organizationId: org.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await getRequest(owner, org.id, created.id);
    const afterByKey = Object.fromEntries(
      after.steps.map((s: { key: string; attemptNumber: number }) => [
        s.key,
        s.attemptNumber,
      ]),
    );
    expect(afterByKey.theme).toBe(before.theme);
    expect(afterByKey.branding).toBe(before.branding);
    expect(afterByKey.domain).toBe(before.domain);
  });

  // --- 22. Subdomain availability --------------------------------------------------

  describe('GET /subdomains/availability', () => {
    it('22a: a reserved subdomain reports status "reserved"', async () => {
      const { owner } = await arrangeOrg('avail-reserved');
      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: 'atlas' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ subdomain: 'atlas', status: 'reserved' });
    });

    it('22b: an already-allocated subdomain reports status "unavailable"', async () => {
      const { owner, org } = await arrangeOrg('avail-taken');
      const created = await createRequest(owner, org.id);
      const ready = await waitForTerminal(owner, org.id, created.id);

      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: ready.subdomain.subdomain })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({
        subdomain: ready.subdomain.subdomain,
        status: 'unavailable',
      });
    });

    it('22c: a fresh, non-reserved subdomain reports status "available"', async () => {
      const { owner } = await arrangeOrg('avail-free');
      const subdomain = uniqueSubdomain('brand-new');
      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ subdomain, status: 'available' });
    });

    it('22d: checking availability without an access token returns 401', async () => {
      await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: uniqueSubdomain('noauth') })
        .expect(401);
    });
  });
});
