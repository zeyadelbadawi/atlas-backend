/**
 * ONE worker per BullMQ queue — a structural rule, asserted structurally.
 *
 * BullMQ hands a job to whichever worker on the queue takes it first,
 * NOT to the one whose `process` understands the job's name. Two classes
 * decorated `@Processor('communications')` therefore do not each handle
 * "their own" jobs: they compete for all of them, and whatever lands on
 * the worker that does not recognise the name falls through to that
 * worker's `default` branch and is acknowledged as done. The visible
 * symptom is silent and partial — roughly half the outbound emails and
 * half the inbound delivery webhooks disappear, with no error anywhere.
 *
 * This is not hypothetical: it is exactly what happened when the outbox
 * and the provider/webhook layer were developed in parallel and each
 * added a processor for the `communications` queue. Both passed their own
 * suites; the defect only existed once they were in one tree. A review
 * catches that only if someone thinks to look, so the rule is pinned here
 * instead — the file scan is deliberate, because the failure mode is a
 * NEW file nobody remembers to check.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(__dirname, '..', '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.isFile() &&
      entry.name.endsWith('.ts') &&
      !entry.name.endsWith('.spec.ts')
      ? [full]
      : [];
  });
}

/** `@Processor(X)` / `@Processor(X, { ... })` → the queue argument as written. */
function declaredQueues(source: string): string[] {
  return [...source.matchAll(/@Processor\(\s*([A-Za-z0-9_.']+)/g)].map((m) => m[1]);
}

describe('BullMQ processors', () => {
  const byQueue = new Map<string, string[]>();

  beforeAll(() => {
    for (const file of sourceFiles(SRC_ROOT)) {
      for (const queue of declaredQueues(readFileSync(file, 'utf8'))) {
        byQueue.set(queue, [
          ...(byQueue.get(queue) ?? []),
          file.slice(SRC_ROOT.length + 1),
        ]);
      }
    }
  });

  it('finds the processors at all (the scan itself must not silently match nothing)', () => {
    expect(byQueue.size).toBeGreaterThan(0);
  });

  it('declares at most one processor per queue', () => {
    const duplicated = [...byQueue.entries()].filter(([, files]) => files.length > 1);
    expect(duplicated).toEqual([]);
  });

  it('keeps the communications queue on a single worker', () => {
    expect(byQueue.get('COMMUNICATIONS_QUEUE')).toHaveLength(1);
  });
});
