/**
 * B0-OPS-10 — subscription proof backlog gauges: counts only, read under a
 * Platform Owner context, no sample when they cannot be read, and one
 * query shared by both gauges per scrape.
 */
import { METRICS_REGISTRY } from '../../observability/metrics/learning-metrics.service';
import type { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import type { UsersRepository } from '../../identity/repositories/users.repository';
import { SubscriptionProofBacklogMetrics } from './subscription-proof-backlog.metrics';

type Row = { pending: number; oldest_seconds: number | null };

function build(options: { owner?: string | null; rows?: Row[]; error?: Error }) {
  const queryRaw = jest.fn(async () => {
    if (options.error) throw options.error;
    return options.rows ?? [];
  });
  const runInUserContext = jest.fn(
    async (_userId: string, work: (tx: { $queryRaw: typeof queryRaw }) => unknown) =>
      work({ $queryRaw: queryRaw }),
  );
  const findFirstPlatformOwnerId = jest.fn(async () =>
    options.owner === null ? null : { id: options.owner ?? 'owner-1' },
  );
  const metrics = new SubscriptionProofBacklogMetrics(
    { runInUserContext } as unknown as TenancyContextService,
    { findFirstPlatformOwnerId } as unknown as UsersRepository,
  );
  return { metrics, queryRaw, runInUserContext };
}

async function scrape(): Promise<string> {
  const pending = await METRICS_REGISTRY.getSingleMetricAsString(
    'atlas_subscription_proofs_pending',
  );
  const oldest = await METRICS_REGISTRY.getSingleMetricAsString(
    'atlas_subscription_proof_oldest_pending_seconds',
  );
  return `${pending}\n${oldest}`;
}

describe('SubscriptionProofBacklogMetrics (B0-OPS-10)', () => {
  it('exposes the pending count and the oldest wait, labelled by queue only', async () => {
    const { runInUserContext } = build({
      rows: [{ pending: 3, oldest_seconds: 90061.7 }],
    });
    const text = await scrape();
    expect(text).toContain('atlas_subscription_proofs_pending{queue="subscription"} 3');
    expect(text).toContain(
      'atlas_subscription_proof_oldest_pending_seconds{queue="subscription"} 90061',
    );
    expect(runInUserContext).toHaveBeenCalledWith('owner-1', expect.any(Function));
    // Nothing identifying ever becomes a label.
    expect(text).not.toMatch(/organization|payment_id|user/);
  });

  it('reports an empty queue as zero, not as missing', async () => {
    build({ rows: [{ pending: 0, oldest_seconds: null }] });
    const text = await scrape();
    expect(text).toContain('atlas_subscription_proofs_pending{queue="subscription"} 0');
    expect(text).toContain(
      'atlas_subscription_proof_oldest_pending_seconds{queue="subscription"} 0',
    );
  });

  it('exposes no sample when there is no Platform Owner to read as', async () => {
    const { queryRaw } = build({ owner: null });
    const text = await scrape();
    expect(text).not.toContain('{queue="subscription"}');
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('exposes no sample, and does not throw, when the query fails', async () => {
    build({ error: new Error('connection refused') });
    await expect(scrape()).resolves.not.toContain('{queue="subscription"}');
  });

  it('runs one query for both gauges in the same scrape', async () => {
    const { queryRaw } = build({ rows: [{ pending: 1, oldest_seconds: 10 }] });
    await scrape();
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });

  it('queries only the subscription review queue (checkout payments pending review)', async () => {
    const { metrics, queryRaw } = build({ rows: [{ pending: 1, oldest_seconds: 10 }] });
    await metrics.read();
    const sql = (queryRaw.mock.calls[0] as unknown[])[0] as { sql: string };
    expect(sql.sql).toContain('p.checkout_id IS NOT NULL');
    expect(sql.sql).toContain("p.review_status = 'pending'");
    expect(sql.sql).toContain('max(pp.uploaded_at)');
  });
});
