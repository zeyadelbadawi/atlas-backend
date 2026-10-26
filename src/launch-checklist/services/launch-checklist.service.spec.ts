/**
 * B3 — LaunchChecklistService: done stamps, optimistic concurrency, the
 * all-ids reorder rule, progress counts and URL validation.
 */
import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { LaunchChecklistItem } from '@prisma/client';
import {
  CHECKLIST_STALE_CODE,
  LaunchChecklistService,
  doneStamp,
  isCompleteReorder,
} from './launch-checklist.service';
import { CreateChecklistItemDto } from '../dto/launch-checklist.dto';

const PO = 'po-user';
const NOW = new Date('2026-10-26T12:00:00.000Z');

function item(
  id: string,
  position: number,
  overrides: Partial<LaunchChecklistItem> = {},
) {
  return {
    id,
    section: 'operations',
    title: `Item ${id}`,
    description: '',
    linkUrl: null,
    done: false,
    doneAt: null,
    doneByUserId: null,
    notes: '',
    position,
    version: 1,
    createdByUserId: null,
    updatedByUserId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as LaunchChecklistItem;
}

function harness(initial: LaunchChecklistItem[]) {
  const rows = new Map(initial.map((row) => [row.id, { ...row }]));
  const tx = {
    launchChecklistItem: {
      findMany: jest.fn(async () =>
        [...rows.values()].sort((a, b) => a.position - b.position),
      ),
      findUnique: jest.fn(
        async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      ),
      findUniqueOrThrow: jest.fn(async ({ where }: { where: { id: string } }) => ({
        ...rows.get(where.id)!,
      })),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Record<string, unknown>;
        }) => {
          const row = { ...rows.get(where.id)! } as Record<string, unknown>;
          for (const [key, value] of Object.entries(data)) {
            row[key] =
              value && typeof value === 'object' && 'increment' in (value as object)
                ? (row[key] as number) + 1
                : value;
          }
          rows.set(where.id, row as unknown as LaunchChecklistItem);
          return row;
        },
      ),
    },
    user: { findMany: jest.fn(async () => [{ id: PO, name: 'Platform Owner' }]) },
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, id: string) =>
      rows.has(id) ? [{ id }] : [],
    ),
    $executeRaw: jest.fn(async () => 0),
  };
  const tenancy = {
    runInUserContext: jest.fn(async (_u: string, work: (t: typeof tx) => unknown) =>
      work(tx),
    ),
  };
  const audit = { write: jest.fn() };
  return {
    service: new LaunchChecklistService(tenancy as never, audit as never),
    rows,
    audit,
  };
}

describe('doneStamp / isCompleteReorder', () => {
  it('stamps done with who and when, clears it when undone, ignores no change', () => {
    expect(doneStamp({ done: false }, true, PO, NOW)).toEqual({
      done: true,
      doneAt: NOW,
      doneByUserId: PO,
    });
    expect(doneStamp({ done: true }, false, PO, NOW)).toEqual({
      done: false,
      doneAt: null,
      doneByUserId: null,
    });
    expect(doneStamp({ done: true }, true, PO, NOW)).toBeNull();
    expect(doneStamp({ done: false }, undefined, PO, NOW)).toBeNull();
  });

  it('a reorder names every item exactly once', () => {
    expect(isCompleteReorder(['a', 'b', 'c'], ['c', 'a', 'b'])).toBe(true);
    expect(isCompleteReorder(['a', 'b', 'c'], ['a', 'b'])).toBe(false);
    expect(isCompleteReorder(['a', 'b'], ['a', 'b', 'x'])).toBe(false);
    expect(isCompleteReorder(['a', 'b'], ['a', 'a'])).toBe(false);
  });
});

describe('LaunchChecklistService', () => {
  it('lists in position order with progress', async () => {
    const h = harness([
      item('b', 1, { done: true, doneAt: NOW, doneByUserId: PO }),
      item('a', 0),
    ]);
    const list = await h.service.list(PO);
    expect(list.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(list.progress).toEqual({ done: 1, total: 2 });
    expect(list.items[1].doneByName).toBe('Platform Owner');
  });

  it('toggling done stamps doneAt/doneBy and bumps the version', async () => {
    const h = harness([item('a', 0)]);
    const updated = await h.service.update(PO, 'a', { version: 1, done: true }, NOW);
    expect(updated).toMatchObject({
      done: true,
      doneAt: NOW.toISOString(),
      doneByName: 'Platform Owner',
      version: 2,
    });
    const undone = await h.service.update(PO, 'a', { version: 2, done: false }, NOW);
    expect(undone).toMatchObject({
      done: false,
      doneAt: null,
      doneByName: null,
      version: 3,
    });
  });

  it('refuses a stale version with 409 LAUNCH_CHECKLIST_ITEM_STALE', async () => {
    const h = harness([item('a', 0, { version: 4 })]);
    const attempt = h.service.update(PO, 'a', { version: 3, notes: 'x' }, NOW);
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(attempt).rejects.toMatchObject({
      response: { code: CHECKLIST_STALE_CODE },
    });
  });

  it('reorders only with every id, without bumping versions', async () => {
    const h = harness([item('a', 0), item('b', 1), item('c', 2)]);
    await expect(h.service.reorder(PO, { ids: ['a', 'b'] })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const list = await h.service.reorder(PO, { ids: ['c', 'a', 'b'] });
    expect(list.items.map((row) => [row.id, row.position, row.version])).toEqual([
      ['c', 0, 1],
      ['a', 1, 1],
      ['b', 2, 1],
    ]);
  });
});

describe('CreateChecklistItemDto', () => {
  it('link URL: https or site-relative only; title 1..160', async () => {
    const check = async (body: object) =>
      (await validate(plainToInstance(CreateChecklistItemDto, body))).map(
        (e) => e.property,
      );
    expect(
      await check({
        section: 'content',
        title: 'Blog live',
        linkUrl: '/dashboard/platform/blog',
      }),
    ).toEqual([]);
    expect(
      await check({ section: 'content', title: 'x', linkUrl: 'javascript:alert(1)' }),
    ).toContain('linkUrl');
    expect(await check({ section: 'content', title: '   ' })).toContain('title');
    expect(await check({ section: 'other', title: 'x' })).toContain('section');
  });
});
