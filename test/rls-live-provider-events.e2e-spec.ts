/**
 * B0-LIV-03 — `live_provider_events` has FORCE RLS.
 *
 * Talks to Postgres through the app's own `PrismaService` (the restricted
 * `atlas_app` role) and `TenancyContextService`, like the other `rls-*`
 * suites, and drives the real repository the webhook path uses:
 *
 *   - the context-free webhook insert still records an event, and a
 *     redelivery is still skipped (INSERT ... ON CONFLICT DO NOTHING);
 *   - the processor's status update still lands (Platform Owner context);
 *   - no context, a tenant context and an ordinary user read zero rows
 *     and cannot update them.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { fixtureUsers } from './utils/db-admin';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { LiveProviderEventsRepository } from '../src/live-sessions/repositories/live-provider-events.repository';

describe('Row-Level Security — live_provider_events (B0-LIV-03)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;
  let events: LiveProviderEventsRepository;
  let platformOwnerId: string;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
    events = app.get(LiveProviderEventsRepository, { strict: false });
    const owner = await fixtureUsers().create({
      data: {
        email: uniqueTestEmail('rls-lpe-po'),
        name: 'rls-lpe-po',
        isPlatformOwner: true,
      },
    });
    platformOwnerId = owner.id;
  });

  afterAll(async () => {
    await app.close();
  });

  it('the webhook insert works without a context, and a redelivery is skipped', async () => {
    const providerEventId = `evt-${randomUUID()}`;
    await expect(
      events.tryInsert({ providerEventId, eventType: 'meeting.started' }),
    ).resolves.toBe(true);
    await expect(
      events.tryInsert({ providerEventId, eventType: 'meeting.started' }),
    ).resolves.toBe(false);

    const seen = await tenancyContext.runInUserContext(platformOwnerId, (tx) =>
      tx.liveProviderEvent.findMany({ where: { providerEventId } }),
    );
    expect(seen).toHaveLength(1);
  });

  it('the processor still marks an event resolved', async () => {
    const providerEventId = `evt-${randomUUID()}`;
    await events.tryInsert({ providerEventId, eventType: 'meeting.ended' });
    await events.markResolved(providerEventId, 'unmatched');

    const row = await events.findByProviderEventId(providerEventId);
    expect(row?.status).toBe('unmatched');
    expect(row?.processedAt).not.toBeNull();
  });

  it('no context, a tenant context and an ordinary user read nothing and update nothing', async () => {
    const providerEventId = `evt-${randomUUID()}`;
    await events.tryInsert({ providerEventId, eventType: 'meeting.started' });

    expect(
      await prisma.liveProviderEvent.findMany({ where: { providerEventId } }),
    ).toEqual([]);
    const noContextUpdate = await prisma.liveProviderEvent.updateMany({
      where: { providerEventId },
      data: { status: 'failed' },
    });
    expect(noContextUpdate.count).toBe(0);

    const tenantRows = await tenancyContext.runInTenantContext(randomUUID(), (tx) =>
      tx.liveProviderEvent.findMany({ where: { providerEventId } }),
    );
    expect(tenantRows).toEqual([]);

    const user = await fixtureUsers().create({
      data: { email: uniqueTestEmail('rls-lpe-user'), name: 'rls-lpe-user' },
    });
    const userRows = await tenancyContext.runInUserContext(user.id, (tx) =>
      tx.liveProviderEvent.findMany({ where: { providerEventId } }),
    );
    expect(userRows).toEqual([]);
    const userUpdate = await tenancyContext.runInUserContext(user.id, (tx) =>
      tx.liveProviderEvent.updateMany({
        where: { providerEventId },
        data: { status: 'failed' },
      }),
    );
    expect(userUpdate.count).toBe(0);

    // Still `received`: none of the refused updates landed.
    expect((await events.findByProviderEventId(providerEventId))?.status).toBe(
      'received',
    );
  });
});
