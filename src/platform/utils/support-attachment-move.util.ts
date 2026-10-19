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
 *             protected bucket, read the copy back and compare it byte for
 *             byte, and only then delete the public one. An object whose
 *             copy cannot be confirmed is left where it is.
 *   rollback  copy each protected object back to the public bucket (for a
 *             code rollback to the pre-fix release, which reads the public
 *             bucket only). Deletes nothing.
 *
 * Re-running any step is safe: an identical copy is not made again, and a
 * public object already gone is not an error. Every object is read in full
 * (ticket images are capped at MEDIA_MAX_UPLOAD_BYTES).
 */
export const SUPPORT_ATTACHMENT_PREFIX = 'support-cases/';

export interface MoveStore {
  /** Every key under `prefix`, with its size. */
  list(prefix: string): Promise<readonly { key: string; size: number }[]>;
  get(key: string): Promise<{ body: Buffer; contentType?: string }>;
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
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
  /** Already present with identical bytes: not copied again. */
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
  const target = new Set(
    (mode === 'rollback' ? publicKeys : protectedKeys).map((o) => o.key),
  );

  let copied = 0;
  let alreadyCopied = 0;
  let removedFromPublic = 0;
  let failed = 0;

  for (const object of source) {
    // Byte-for-byte, never by size alone: `apply` deletes the source on the
    // strength of this comparison.
    try {
      const original = await from.get(object.key);
      const existing = target.has(object.key) ? await to.get(object.key) : null;
      if (existing?.body.equals(original.body)) {
        alreadyCopied += 1;
      } else if (mode === 'plan') {
        copied += 1;
      } else {
        await to.put(object.key, original.body, original.contentType);
        const readBack = await to.get(object.key);
        if (!readBack.body.equals(original.body)) throw new Error('copy differs');
        copied += 1;
      }
    } catch {
      failed += 1;
      continue;
    }
    if (mode === 'apply') {
      // Only after the protected copy is confirmed identical (already there,
      // or just written and read back above).
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
