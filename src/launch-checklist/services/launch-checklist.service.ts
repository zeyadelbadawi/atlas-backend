/**
 * LaunchChecklistService — B3: the Platform Owner's launch checklist
 * (seeded by the migration). Platform Owner only, reads included (RLS).
 *
 * Toggling `done` stamps `doneAt`/`doneBy` (cleared when undone). Edits
 * compare `version` → 409 `errors.launchChecklist.stale` (code
 * `LAUNCH_CHECKLIST_ITEM_STALE`). Reordering rewrites positions only and
 * does NOT bump versions, so a reorder never makes an open editor stale.
 */
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { LaunchChecklistItem, Prisma } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type {
  CreateChecklistItemDto,
  ReorderChecklistDto,
  UpdateChecklistItemDto,
} from '../dto/launch-checklist.dto';
import type {
  LaunchChecklistItemResponse,
  LaunchChecklistResponse,
} from '../dto/launch-checklist.contract';

const TARGET_TYPE = 'launch_checklist_item';
const ROLE = 'platform_owner';

export const CHECKLIST_AUDIT = {
  created: 'platform.launch_checklist.item_created',
  updated: 'platform.launch_checklist.item_updated',
  deleted: 'platform.launch_checklist.item_deleted',
  reordered: 'platform.launch_checklist.reordered',
} as const;

export const CHECKLIST_ERRORS = {
  notFound: 'errors.launchChecklist.notFound',
  stale: 'errors.launchChecklist.stale',
  reorderMismatch: 'errors.launchChecklist.reorderMismatch',
} as const;

export const CHECKLIST_STALE_CODE = 'LAUNCH_CHECKLIST_ITEM_STALE';

const ORDER: Prisma.LaunchChecklistItemOrderByWithRelationInput[] = [
  { position: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
];

/** `done` on: stamp it now by this person; off: clear the stamp; unchanged: nothing. */
export function doneStamp(
  current: Pick<LaunchChecklistItem, 'done'>,
  done: boolean | undefined,
  actorUserId: string,
  now: Date,
): Pick<
  Prisma.LaunchChecklistItemUncheckedUpdateInput,
  'done' | 'doneAt' | 'doneByUserId'
> | null {
  if (done === undefined || done === current.done) return null;
  return done
    ? { done: true, doneAt: now, doneByUserId: actorUserId }
    : { done: false, doneAt: null, doneByUserId: null };
}

/** The reorder must name every item exactly once. */
export function isCompleteReorder(
  existing: readonly string[],
  ids: readonly string[],
): boolean {
  if (existing.length !== ids.length) return false;
  const wanted = new Set(ids);
  return wanted.size === ids.length && existing.every((id) => wanted.has(id));
}

@Injectable()
export class LaunchChecklistService {
  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  async list(platformOwnerId: string): Promise<LaunchChecklistResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.loadAll(tx),
    );
  }

  async create(
    platformOwnerId: string,
    payload: CreateChecklistItemDto,
    now: Date = new Date(),
  ): Promise<LaunchChecklistItemResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const last = await tx.launchChecklistItem.aggregate({ _max: { position: true } });
      const created = await tx.launchChecklistItem.create({
        data: {
          section: payload.section,
          title: payload.title,
          description: payload.description ?? '',
          linkUrl: payload.linkUrl ?? null,
          notes: payload.notes ?? '',
          position: (last._max.position ?? -1) + 1,
          ...(payload.done
            ? { done: true, doneAt: now, doneByUserId: platformOwnerId }
            : {}),
          createdByUserId: platformOwnerId,
          updatedByUserId: platformOwnerId,
        },
      });
      await this.audit(tx, platformOwnerId, CHECKLIST_AUDIT.created, created, {
        section: created.section,
      });
      return this.loadOne(tx, created.id);
    });
  }

  async update(
    platformOwnerId: string,
    id: string,
    payload: UpdateChecklistItemDto,
    now: Date = new Date(),
  ): Promise<LaunchChecklistItemResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM launch_checklist_items WHERE id = ${id} FOR UPDATE`;
      if (locked.length === 0) {
        throw new NotFoundException({ messageKey: CHECKLIST_ERRORS.notFound });
      }
      const current = await tx.launchChecklistItem.findUniqueOrThrow({ where: { id } });
      if (current.version !== payload.version) {
        throw new ConflictException({
          messageKey: CHECKLIST_ERRORS.stale,
          code: CHECKLIST_STALE_CODE,
        });
      }
      const data: Prisma.LaunchChecklistItemUncheckedUpdateInput = {};
      const changed: string[] = [];
      const set = <K extends 'section' | 'title' | 'description' | 'linkUrl' | 'notes'>(
        key: K,
        value: LaunchChecklistItem[K] | undefined,
      ) => {
        if (value !== undefined && value !== current[key]) {
          data[key] = value as never;
          changed.push(key);
        }
      };
      set('section', payload.section);
      set('title', payload.title);
      set('description', payload.description);
      set('linkUrl', payload.linkUrl);
      set('notes', payload.notes);
      const stamp = doneStamp(current, payload.done, platformOwnerId, now);
      if (stamp) {
        Object.assign(data, stamp);
        changed.push('done');
      }
      if (changed.length === 0) return this.loadOne(tx, id);

      const updated = await tx.launchChecklistItem.update({
        where: { id },
        data: { ...data, updatedByUserId: platformOwnerId, version: { increment: 1 } },
      });
      await this.audit(tx, platformOwnerId, CHECKLIST_AUDIT.updated, updated, {
        section: updated.section,
        changedFields: changed.join(','),
        done: updated.done,
      });
      return this.loadOne(tx, id);
    });
  }

  async remove(platformOwnerId: string, id: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await tx.launchChecklistItem.findUnique({ where: { id } });
      if (!current)
        throw new NotFoundException({ messageKey: CHECKLIST_ERRORS.notFound });
      await tx.launchChecklistItem.delete({ where: { id } });
      await this.audit(tx, platformOwnerId, CHECKLIST_AUDIT.deleted, current, {
        section: current.section,
      });
    });
  }

  async reorder(
    platformOwnerId: string,
    payload: ReorderChecklistDto,
  ): Promise<LaunchChecklistResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      // Serialise reorders (and see every item another one just added).
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('launch_checklist_items:order', 0))`;
      const existing = await tx.launchChecklistItem.findMany({ select: { id: true } });
      if (
        !isCompleteReorder(
          existing.map((row) => row.id),
          payload.ids,
        )
      ) {
        throw new BadRequestException({ messageKey: CHECKLIST_ERRORS.reorderMismatch });
      }
      for (const [position, id] of payload.ids.entries()) {
        await tx.launchChecklistItem.update({ where: { id }, data: { position } });
      }
      await this.auditLogWriterService.write(tx, {
        actorUserId: platformOwnerId,
        role: ROLE,
        action: CHECKLIST_AUDIT.reordered,
        targetType: TARGET_TYPE,
        targetId: payload.ids[0],
        context: { itemCount: payload.ids.length },
      });
      return this.loadAll(tx);
    });
  }

  private async loadAll(tx: Prisma.TransactionClient): Promise<LaunchChecklistResponse> {
    const rows = await tx.launchChecklistItem.findMany({ orderBy: ORDER });
    const names = await this.userNames(
      tx,
      rows.map((row) => row.doneByUserId),
    );
    const items = rows.map((row) => this.toResponse(row, names));
    return {
      items,
      progress: { done: items.filter((item) => item.done).length, total: items.length },
    };
  }

  private async loadOne(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LaunchChecklistItemResponse> {
    const row = await tx.launchChecklistItem.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ messageKey: CHECKLIST_ERRORS.notFound });
    return this.toResponse(row, await this.userNames(tx, [row.doneByUserId]));
  }

  private async userNames(
    tx: Prisma.TransactionClient,
    ids: readonly (string | null)[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids.filter((id): id is string => !!id))];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private toResponse(
    row: LaunchChecklistItem,
    names: Map<string, string>,
  ): LaunchChecklistItemResponse {
    return {
      id: row.id,
      section: row.section,
      title: row.title,
      description: row.description,
      linkUrl: row.linkUrl,
      done: row.done,
      doneAt: row.doneAt?.toISOString() ?? null,
      doneByName: row.doneByUserId ? (names.get(row.doneByUserId) ?? null) : null,
      notes: row.notes,
      position: row.position,
      version: row.version,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: (typeof CHECKLIST_AUDIT)[keyof typeof CHECKLIST_AUDIT],
    row: Pick<LaunchChecklistItem, 'id' | 'title'>,
    context: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.auditLogWriterService.write(tx, {
      actorUserId,
      role: ROLE,
      action,
      targetType: TARGET_TYPE,
      targetId: row.id,
      targetLabel: row.title,
      context,
    });
  }
}
