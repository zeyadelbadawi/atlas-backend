/**
 * "Your academy is ready" arrives when the owner's build screen reaches
 * 100 %, not when the real provisioning finishes (presented-build.ts).
 *
 * Runs the REAL chain the finalization step takes — orchestrator →
 * `CommunicationService.emit` (outbox row) → `enqueueAfterCommit` →
 * `CommunicationsProducer` (BullMQ job) — against mocked persistence, and
 * reads what reaches the database row and the queue.
 */
import type { ProvisioningRequest } from '@prisma/client';
import { CommunicationService } from '../../communications/services/communication.service';
import { CommunicationsProducer } from '../../communications/queue/communications.producer';
import { ProvisioningOrchestratorService } from './provisioning-orchestrator.service';
import { presentedReadyAt } from '../dto/presented-build';

const CREATED_AT = new Date('2026-11-06T10:00:00.000Z');

function finalizationRequest(): ProvisioningRequest {
  return {
    id: 'req-ready-1',
    organizationId: 'org-1',
    academyId: 'academy-1',
    requestedByUserId: 'owner-1',
    status: 'provisioning',
    currentStepKey: 'finalization',
    requestedAcademyName: 'Nile Academy',
    requestedSubdomain: 'nile',
    triggeringPaymentId: null,
    selectedThemeKey: null,
    websiteSetupMode: null,
    requestedBrand: null,
    requestedPaymentMethods: null,
    lastProgressAt: CREATED_AT,
    idempotencyKey: 'k',
    attemptCount: 1,
    lastError: null,
    startedAt: CREATED_AT,
    completedAt: null,
    failedAt: null,
    autoSupportCaseId: null,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  } as ProvisioningRequest;
}

function harness() {
  const request = finalizationRequest();
  /** Every outbox INSERT's bound values, in order. */
  const outboxInserts: unknown[][] = [];
  const seenDedupeKeys = new Set<string>();
  const tx = {
    $executeRawUnsafe: jest.fn(async () => 0),
    $executeRaw: jest.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (strings.join('?').includes('INSERT INTO "communication_outbox"')) {
        outboxInserts.push(values);
      }
      return 1;
    }),
  };
  const tenancy = {
    runInTenantContext: jest.fn(async (_org: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const requests = {
    findById: jest.fn(async () => request),
    update: jest.fn(async () => request),
  };
  const steps = {
    findByRequestAndKey: jest.fn(async () => null),
    markRunning: jest.fn(async () => undefined),
    markCompleted: jest.fn(async () => undefined),
  };
  // The in-app row's unique (recipient, dedupe key): a second emit of the
  // same request's ready event is a no-op, like the real constraint.
  const notifications = {
    create: jest.fn(async (_tx: unknown, input: { dedupeKey: string }) => {
      if (seenDedupeKeys.has(input.dedupeKey)) return false;
      seenDedupeKeys.add(input.dedupeKey);
      return true;
    }),
  };
  const users = {
    findById: jest.fn(async () => ({ id: 'owner-1', preferences: { language: 'ar' } })),
  };
  const queue = { add: jest.fn(async () => ({})) };
  const producer = new CommunicationsProducer(queue as never);
  const metrics = { recordOutbox: jest.fn() };
  const communications = new CommunicationService(
    notifications as never,
    users as never,
    { getClient: () => ({ pttl: jest.fn(async () => -2) }) } as never,
    producer,
    metrics as never,
  );
  const unused = {} as never;
  const orchestrator = new ProvisioningOrchestratorService(
    tenancy as never,
    requests as never,
    steps as never,
    unused,
    unused,
    unused,
    unused,
    communications,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
    unused,
  );
  return {
    request,
    orchestrator,
    queue,
    outboxInserts,
  };
}

/** The `available_at` bound into the outbox INSERT (the only Date after `values`). */
function availableAtOf(values: unknown[]): Date {
  const dates = values.filter((v): v is Date => v instanceof Date);
  // VALUES (..., available_at, 0, created_at): the first Date bound.
  return dates[0];
}

describe('provisioning — the ready email waits for the build screen’s 100 %', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('fast provisioning: the row and its job are held until presentedReadyAt', async () => {
    const h = harness();
    const readyAt = presentedReadyAt(h.request);
    const finishedAt = new Date(CREATED_AT.getTime() + 8_000); // real work: 8 s
    jest.useFakeTimers({ now: finishedAt });

    await expect(h.orchestrator.runOneStep(h.request.id, 'org-1')).resolves.toBe(false);

    expect(h.outboxInserts).toHaveLength(1);
    expect(availableAtOf(h.outboxInserts[0])).toEqual(readyAt);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    const [, , options] = h.queue.add.mock.calls[0] as unknown as [
      string,
      { outboxId: string },
      { jobId: string; delay?: number },
    ];
    expect(options.delay).toBe(readyAt.getTime() - finishedAt.getTime());
    expect(options.delay).toBeGreaterThan(0);
  });

  it('slow provisioning (past the presented window): sent at once, never before it is real', async () => {
    const h = harness();
    const readyAt = presentedReadyAt(h.request);
    const finishedAt = new Date(readyAt.getTime() + 120_000);
    jest.useFakeTimers({ now: finishedAt });

    await h.orchestrator.runOneStep(h.request.id, 'org-1');

    expect(availableAtOf(h.outboxInserts[0])).toEqual(finishedAt);
    const [, , options] = h.queue.add.mock.calls[0] as unknown as [
      string,
      unknown,
      { delay?: number },
    ];
    expect(options.delay).toBeUndefined();
  });

  it('is idempotent: one dispatch job id per outbox row, one row per request', async () => {
    const h = harness();
    jest.useFakeTimers({ now: new Date(CREATED_AT.getTime() + 5_000) });

    await h.orchestrator.runOneStep(h.request.id, 'org-1');
    // A redelivered/duplicate finalization of the same request: the dedupe
    // key (`provisioning_completed:<requestId>`) admits nothing new.
    await h.orchestrator.runOneStep(h.request.id, 'org-1');

    expect(h.outboxInserts).toHaveLength(1);
    expect(h.queue.add).toHaveBeenCalledTimes(1);
    const [, payload, options] = h.queue.add.mock.calls[0] as unknown as [
      string,
      { outboxId: string },
      { jobId: string },
    ];
    expect(options.jobId).toBe(`dispatch-${payload.outboxId}-0`);
  });

  it('keeps the email itself unchanged: key, recipient, locale and values', async () => {
    const h = harness();
    jest.useFakeTimers({ now: new Date(CREATED_AT.getTime() + 5_000) });
    await h.orchestrator.runOneStep(h.request.id, 'org-1');
    const values = h.outboxInserts[0];
    expect(values).toContain('provisioning.completed');
    expect(values).toContain('owner-1');
    expect(values).toContain('ar');
    expect(values).toContain(JSON.stringify({ academyName: 'Nile Academy' }));
    expect(values).toContain('provisioning_completed:req-ready-1');
  });
});
