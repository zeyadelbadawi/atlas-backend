/**
 * Shared ordering primitives for the course curriculum (sections, and the
 * unified per-unit item sequence).
 *
 * ONE ORDINAL SPACE PER UNIT. Lessons, quizzes, assignments and live
 * sessions inside a unit share a single `order` integer space (see
 * `UnitCurriculumService`). Anything that appends to a unit or renumbers
 * part of it must therefore look at EVERY item type, never just its own
 * table — otherwise a new lesson computed as "max lesson order + 1" can
 * land before an existing quiz, and a lessons-only renumber can collide
 * with a quiz's ordinal.
 *
 * CONCURRENCY. Reorders are full-permutation writes. Two of them racing
 * would each validate against the same snapshot and the later commit would
 * silently win, possibly over a set that changed underneath it. Every
 * reorder therefore:
 *   1. locks the parent row (`SELECT … FOR UPDATE` on the course for a
 *      section reorder, on the section for an item reorder) inside its own
 *      transaction, so writers on the same parent are serialized and each
 *      one reads the state the previous one committed (READ COMMITTED
 *      re-reads per statement, and the reads happen after the lock);
 *   2. optionally compares the order the client SAW (`expectedOrderedIds`)
 *      with the order now stored, refusing with the shared
 *      `stale_resource_version` 409 when they differ — the client refetches
 *      instead of overwriting someone else's arrangement.
 * The parent row lock is taken under the caller's existing RLS context;
 * the tenant UPDATE policies on `courses`/`course_sections` already admit
 * every caller who passed `assertCanManage`, so a missing row here means
 * "not found", never a policy bypass.
 */
import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { STALE_RESOURCE_VERSION_CODE } from '../../concurrency/errors/stale-resource-version.exception';
import type { CurriculumItemType } from '../dto/curriculum-item.contract';

export interface UnitItem {
  id: string;
  type: CurriculumItemType;
  title: string;
  order: number;
  status: string;
}

/** Merge all content types in a section into one order-sorted list. */
export async function readUnitItems(
  tx: Prisma.TransactionClient,
  sectionId: string,
): Promise<UnitItem[]> {
  const [lessons, quizzes, assignments, liveSessions] = await Promise.all([
    tx.courseLesson.findMany({
      where: { sectionId },
      select: { id: true, title: true, order: true, status: true },
    }),
    tx.quiz.findMany({
      where: { sectionId },
      select: { id: true, title: true, order: true, status: true },
    }),
    tx.assignment.findMany({
      where: { sectionId },
      select: { id: true, title: true, order: true, status: true },
    }),
    tx.liveSession.findMany({
      where: { sectionId },
      select: { id: true, title: true, order: true, status: true },
    }),
  ]);

  const merged: UnitItem[] = [
    ...lessons.map((l) => ({ ...l, type: 'lesson' as const })),
    ...quizzes.map((q) => ({ ...q, type: 'quiz' as const })),
    ...assignments.map((a) => ({ ...a, type: 'assignment' as const })),
    ...liveSessions.map((s) => ({ ...s, type: 'live_session' as const })),
  ];
  // Stable, deterministic: primary by shared order, then type, then id —
  // so ties from legacy data never render in a random order.
  merged.sort(
    (a, b) =>
      a.order - b.order || a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
  );
  return merged;
}

/** The next ordinal at the END of a unit, across every item type. */
export async function nextUnitOrder(
  tx: Prisma.TransactionClient,
  sectionId: string,
): Promise<number> {
  const items = await readUnitItems(tx, sectionId);
  return items.length === 0 ? 0 : Math.max(...items.map((i) => i.order)) + 1;
}

/** Write one item's shared unit ordinal onto its own table. */
export async function writeUnitItemOrder(
  tx: Prisma.TransactionClient,
  type: CurriculumItemType,
  id: string,
  order: number,
): Promise<void> {
  switch (type) {
    case 'lesson':
      await tx.courseLesson.update({ where: { id }, data: { order } });
      return;
    case 'quiz':
      await tx.quiz.update({ where: { id }, data: { order } });
      return;
    case 'assignment':
      await tx.assignment.update({ where: { id }, data: { order } });
      return;
    case 'live_session':
      await tx.liveSession.update({ where: { id }, data: { order } });
      return;
  }
}

/**
 * Renumber a unit to `orderedItems` (0..n-1), writing only the rows whose
 * ordinal actually changes.
 */
export async function persistUnitOrder(
  tx: Prisma.TransactionClient,
  orderedItems: readonly UnitItem[],
): Promise<void> {
  for (let index = 0; index < orderedItems.length; index += 1) {
    const item = orderedItems[index];
    if (item.order !== index) {
      await writeUnitItemOrder(tx, item.type, item.id, index);
    }
  }
}

/** Row-lock a course for the rest of the transaction (section reorders). */
export async function lockCourseRow(
  tx: Prisma.TransactionClient,
  courseId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "courses" WHERE "id" = ${courseId} FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
}

/** Row-lock a section for the rest of the transaction (item reorders, appends). */
export async function lockSectionRow(
  tx: Prisma.TransactionClient,
  sectionId: string,
): Promise<void> {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "course_sections" WHERE "id" = ${sectionId} FOR UPDATE`;
  if (rows.length === 0) {
    throw new NotFoundException({ messageKey: 'errors.notFound' });
  }
}

/**
 * Row-lock several sections in a stable (sorted) order, so two
 * transactions moving items between the same pair of units can never
 * deadlock.
 */
export async function lockSectionRows(
  tx: Prisma.TransactionClient,
  sectionIds: readonly string[],
): Promise<void> {
  for (const id of [...new Set(sectionIds)].sort()) {
    await lockSectionRow(tx, id);
  }
}

/**
 * Refuse a reorder built on an order the client no longer has. No-op when
 * the client did not send `expectedOrderedIds` (older clients keep working
 * with last-write-wins, still serialized by the row lock).
 */
export function assertExpectedOrder(
  currentIds: readonly string[],
  expectedIds: readonly string[] | undefined,
): void {
  if (!expectedIds) return;
  const same =
    currentIds.length === expectedIds.length &&
    currentIds.every((id, index) => id === expectedIds[index]);
  if (!same) {
    throw new ConflictException({
      code: STALE_RESOURCE_VERSION_CODE,
      messageKey: 'errors.concurrency.staleVersion',
    });
  }
}

/**
 * `orderedIds` must be exactly the current set of child ids — no more, no
 * fewer, no duplicates — never a partial reorder, never a foreign id.
 */
export function isExactPermutation(
  existingIds: readonly string[],
  orderedIds: readonly string[],
): boolean {
  if (existingIds.length !== orderedIds.length) return false;
  const existingSet = new Set(existingIds);
  const orderedSet = new Set(orderedIds);
  return (
    existingSet.size === orderedSet.size &&
    [...existingSet].every((id) => orderedSet.has(id))
  );
}
