/**
 * B0-SEC-10 — moving support-ticket images out of the public media bucket.
 *
 * Images uploaded before the fix live in the public bucket under
 * `support-cases/<caseId>/<uuid>.<ext>`; new ones go to the protected
 * bucket under the same key (`SupportCasesService.storeAttachment`). This
 * moves the old ones across, key for key, so the database rows (which hold
 * only the key) need no change.
 *
 *   plan      read-only: what is in each bucket under the prefix
 *   apply     copy each public object missing from (or different in) the
 *             protected bucket, confirm the copy's size, and only then
 *             delete the public one. An object whose copy cannot be
 *             confirmed is left where it is.
 *   rollback  copy each protected object back to the public bucket (for a
 *             code rollback to the pre-fix release, which reads the public
 *             bucket only). Deletes nothing.
 *
 * Re-running any step is safe: a confirmed copy is not made again, and a
 * public object already gone is not an error.
 */
export const SUPPORT_ATTACHMENT_PREFIX = 'support-cases/';

export interface MoveStore {
  /** Every key under `prefix`, with its size. */
  list(prefix: string): Promise<readonly { key: string; size: number }[]>;
  get(key: string): Promise<{ body: Buffer; contentType?: string }>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  /** Size of the object, or null when there is none. */
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
}

export interface MoveSummary {
  readonly mode: 'plan' | 'apply' | 'rollback';
  /** Objects under the prefix in the public bucket before the step. */
  readonly publicObjects: number;
  /** Objects under the prefix in the protected bucket before the step. */
  readonly protectedObjects: number;
  /** plan: would be copied. apply/rollback: copied in this run. */
  readonly copied: number;
  /** Already present with the same size: not copied again. */
  readonly alreadyCopied: number;
  /** apply: public objects deleted after a confirmed copy. */
  readonly removedFromPublic: number;
  /** Copies that failed or could not be confirmed (source left in place). */
  readonly failed: number;
}

export async function moveSupportAttachments(
  mode: MoveSummary['mode'],
  publicStore: MoveStore,
  protectedStore: MoveStore,
): Promise<MoveSummary> {
  const publicKeys = await publicStore.list(SUPPORT_ATTACHMENT_PREFIX);
  const protectedKeys = await protectedStore.list(SUPPORT_ATTACHMENT_PREFIX);
  const [from, to] =
    mode === 'rollback' ? [protectedStore, publicStore] : [publicStore, protectedStore];
  const source = mode === 'rollback' ? protectedKeys : publicKeys;
  const target = new Map(
    (mode === 'rollback' ? publicKeys : protectedKeys).map((o) => [o.key, o.size]),
  );

  let copied = 0;
  let alreadyCopied = 0;
  let removedFromPublic = 0;
  let failed = 0;

  for (const object of source) {
    const present = target.get(object.key) === object.size;
    if (mode === 'plan') {
      if (present) alreadyCopied += 1;
      else copied += 1;
      continue;
    }
    if (present) {
      alreadyCopied += 1;
    } else {
      try {
        const { body, contentType } = await from.get(object.key);
        await to.put(object.key, body, contentType);
        if ((await to.size(object.key)) !== object.size) throw new Error('size mismatch');
        copied += 1;
      } catch {
        failed += 1;
        continue;
      }
    }
    if (mode === 'apply') {
      // Only after the protected copy is confirmed (present, or just copied
      // and its size re-read above).
      await publicStore.delete(object.key);
      removedFromPublic += 1;
    }
  }

  return {
    mode,
    publicObjects: publicKeys.length,
    protectedObjects: protectedKeys.length,
    copied,
    alreadyCopied,
    removedFromPublic,
    failed,
  };
}
