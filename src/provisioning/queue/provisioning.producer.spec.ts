import type { Queue } from 'bullmq';
import { ProvisioningProducer, provisioningJobId } from './provisioning.producer';
import type { ProcessProvisioningJobPayload } from './provisioning.types';

function fakeQueue(existing?: { state: string; remove?: jest.Mock }) {
  const job = existing
    ? {
        getState: jest.fn().mockResolvedValue(existing.state),
        remove: existing.remove ?? jest.fn().mockResolvedValue(undefined),
      }
    : null;
  const queue = {
    getJob: jest.fn().mockResolvedValue(job),
    add: jest.fn().mockResolvedValue(undefined),
  };
  return { queue, job };
}

const payload: ProcessProvisioningJobPayload = {
  provisioningRequestId: 'req-1',
  organizationId: 'org-1',
};

describe('ProvisioningProducer (W2 — retry after a failed job)', () => {
  const producer = (queue: unknown) =>
    new ProvisioningProducer(queue as Queue<ProcessProvisioningJobPayload>);

  it('adds the job under the fixed id when none exists', async () => {
    const { queue } = fakeQueue();
    await producer(queue).enqueue(payload);
    expect(queue.getJob).toHaveBeenCalledWith(provisioningJobId('req-1'));
    expect(queue.add).toHaveBeenCalledWith(
      'process-provisioning-request',
      payload,
      expect.objectContaining({
        jobId: 'provisioning-request__req-1',
        removeOnFail: false,
      }),
    );
  });

  it.each(['failed', 'completed'])(
    'removes a %s job under the same id before re-adding it (so retry is never a no-op)',
    async (state) => {
      const { queue, job } = fakeQueue({ state });
      await producer(queue).enqueue(payload);
      expect(job!.remove).toHaveBeenCalledTimes(1);
      expect(queue.add).toHaveBeenCalledTimes(1);
      expect(job!.remove.mock.invocationCallOrder[0]).toBeLessThan(
        queue.add.mock.invocationCallOrder[0],
      );
    },
  );

  it.each(['waiting', 'active', 'delayed', 'prioritized'])(
    'leaves a %s job alone and adds nothing (idempotent)',
    async (state) => {
      const { queue, job } = fakeQueue({ state });
      await producer(queue).enqueue(payload);
      expect(job!.remove).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    },
  );

  it('still re-adds when removing the finished job races (locked or already gone)', async () => {
    const { queue } = fakeQueue({
      state: 'failed',
      remove: jest.fn().mockRejectedValue(new Error('Job is locked')),
    });
    await expect(producer(queue).enqueue(payload)).resolves.toBeUndefined();
    expect(queue.add).toHaveBeenCalledTimes(1);
  });

  it('is idempotent across two back-to-back retries', async () => {
    const { queue } = fakeQueue({ state: 'failed' });
    const p = producer(queue);
    await Promise.all([p.enqueue(payload), p.enqueue(payload)]);
    // Both calls target the same fixed id; BullMQ collapses duplicate adds.
    for (const call of queue.add.mock.calls) {
      expect(call[2].jobId).toBe('provisioning-request__req-1');
    }
  });
});
