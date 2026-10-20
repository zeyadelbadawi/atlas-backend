/**
 * B0-SEC-10 — `moveSupportAttachments`, against two in-memory buckets.
 */
import { moveSupportAttachments, type MoveStore } from './support-attachment-move.util';

function memoryStore(initial: Record<string, string> = {}) {
  const objects = new Map<string, Buffer>(
    Object.entries(initial).map(([k, v]) => [k, Buffer.from(v)]),
  );
  const failPut = new Set<string>();
  const store: MoveStore = {
    async list(prefix) {
      return [...objects.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, body]) => ({ key, size: body.length }));
    },
    async get(key) {
      const body = objects.get(key);
      if (!body) throw new Error('missing');
      return { body, contentType: 'image/png' };
    },
    async put(key, body) {
      if (failPut.has(key)) throw new Error('denied');
      objects.set(key, body);
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  return { store, objects, failPut };
}

const A = 'support-cases/c1/a.png';
const B = 'support-cases/c2/b.png';
const LOGO = 'academies/x/logo.png';

describe('moveSupportAttachments (B0-SEC-10)', () => {
  it('plan counts and writes nothing', async () => {
    const pub = memoryStore({ [A]: 'aaa', [B]: 'bb', [LOGO]: 'logo' });
    const prot = memoryStore({ [A]: 'aaa' });
    const summary = await moveSupportAttachments('plan', pub.store, prot.store);
    expect(summary).toEqual({
      mode: 'plan',
      publicObjects: 2,
      protectedObjects: 1,
      copied: 1,
      alreadyCopied: 1,
      removedFromPublic: 0,
      failed: 0,
    });
    expect(pub.objects.size).toBe(3);
    expect(prot.objects.size).toBe(1);
  });

  it('apply copies to protected, then removes the public copy; academy media is untouched', async () => {
    const pub = memoryStore({ [A]: 'aaa', [B]: 'bb', [LOGO]: 'logo' });
    const prot = memoryStore();
    const summary = await moveSupportAttachments('apply', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 2, removedFromPublic: 2, failed: 0 });
    expect([...prot.objects.keys()].sort()).toEqual([A, B]);
    expect(prot.objects.get(A)?.toString()).toBe('aaa');
    expect([...pub.objects.keys()]).toEqual([LOGO]);
  });

  it('apply leaves a public object in place when its copy fails', async () => {
    const pub = memoryStore({ [A]: 'aaa', [B]: 'bb' });
    const prot = memoryStore();
    prot.failPut.add(B);
    const summary = await moveSupportAttachments('apply', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 1, removedFromPublic: 1, failed: 1 });
    expect(pub.objects.has(B)).toBe(true);
    expect(pub.objects.has(A)).toBe(false);
  });

  it('a copy with a different size is made again, never trusted', async () => {
    const pub = memoryStore({ [A]: 'aaa' });
    const prot = memoryStore({ [A]: 'a' });
    const summary = await moveSupportAttachments('apply', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 1, alreadyCopied: 0 });
    expect(prot.objects.get(A)?.toString()).toBe('aaa');
  });

  it('a copy with the same size but different bytes is made again before the source is deleted', async () => {
    const pub = memoryStore({ [A]: 'aaa' });
    const prot = memoryStore({ [A]: 'bbb' });
    expect(await moveSupportAttachments('plan', pub.store, prot.store)).toMatchObject({
      copied: 1,
      alreadyCopied: 0,
    });
    const summary = await moveSupportAttachments('apply', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 1, alreadyCopied: 0, removedFromPublic: 1 });
    expect(prot.objects.get(A)?.toString()).toBe('aaa');
  });

  it('rollback overwrites a same-size public object with different bytes', async () => {
    const pub = memoryStore({ [A]: 'bbb' });
    const prot = memoryStore({ [A]: 'aaa' });
    const summary = await moveSupportAttachments('rollback', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 1, alreadyCopied: 0 });
    expect(pub.objects.get(A)?.toString()).toBe('aaa');
  });

  it('re-running apply is a no-op', async () => {
    const pub = memoryStore({ [A]: 'aaa' });
    const prot = memoryStore();
    await moveSupportAttachments('apply', pub.store, prot.store);
    const again = await moveSupportAttachments('apply', pub.store, prot.store);
    expect(again).toMatchObject({ publicObjects: 0, copied: 0, removedFromPublic: 0 });
  });

  it('rollback copies back to public and deletes nothing', async () => {
    const pub = memoryStore();
    const prot = memoryStore({ [A]: 'aaa' });
    const summary = await moveSupportAttachments('rollback', pub.store, prot.store);
    expect(summary).toMatchObject({ copied: 1, removedFromPublic: 0 });
    expect(pub.objects.get(A)?.toString()).toBe('aaa');
    expect(prot.objects.has(A)).toBe(true);
  });
});
