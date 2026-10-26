/**
 * SiteAnnouncementsService — B3: marketing banners, marketing pop-ups and
 * the dashboard banner, written by Platform Owners.
 *
 * CONTEXT. Platform Owner reads/writes run in the caller's user context;
 * `site_announcements` RLS admits writes from Platform Owners only. The
 * public marketing read runs with NO context, where RLS shows only live
 * marketing announcements; the dashboard read runs in the signed-in
 * user's context, where RLS shows live announcements (dashboard banners
 * need a user). The queries filter the same way.
 *
 * COUNTERS. `recordEvent` calls `record_site_announcement_event`, which
 * increments one counter of a LIVE row and touches nothing else; unknown
 * ids, non-live rows and failures are silently ignored (the route is a
 * beacon and always answers 204).
 *
 * CONCURRENCY. Lock + `version` compare + bump → 409
 * `errors.siteAnnouncements.stale` (code `SITE_ANNOUNCEMENT_STALE`).
 */
import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SiteAnnouncement } from '@prisma/client';
import { TenancyContextService } from '../../tenancy/services/tenancy-context.service';
import { AuditLogWriterService } from '../../audit-log/services/audit-log-writer.service';
import type { Principal } from '../../tenancy/services/principal-resolver.service';
import { buildPaginationMeta } from '../../common/dto/pagination.contract';
import type { PaginatedResult } from '../../common/dto/pagination.contract';
import { DEFAULT_PAGE, DEFAULT_PAGE_SIZE } from '../../common/dto/collection-query.dto';
import {
  ANNOUNCEMENT_LOCALES,
  HTML_TAG_PATTERN,
  MAX_DASHBOARD_BANNERS,
  activationProblem,
  audienceAllows,
  byPriority,
  contentFor,
  isLive,
  normalizeMarketingPath,
  selectForMarketingPage,
  type AnnouncementLocale,
} from '../site-announcement-rules';
import type {
  AnnouncementContentDto,
  AnnouncementEventType,
  CreateSiteAnnouncementDto,
  ListSiteAnnouncementsQueryDto,
  UpdateSiteAnnouncementDto,
} from '../dto/site-announcements.dto';
import type {
  DashboardAnnouncements,
  PublicAnnouncement,
  PublicMarketingAnnouncements,
  SiteAnnouncementResponse,
} from '../dto/site-announcements.contract';

const TARGET_TYPE = 'site_announcement';
const ROLE = 'platform_owner';

export const ANNOUNCEMENT_AUDIT = {
  created: 'platform.site_announcement.created',
  updated: 'platform.site_announcement.updated',
  activated: 'platform.site_announcement.activated',
  deactivated: 'platform.site_announcement.deactivated',
  archived: 'platform.site_announcement.archived',
  deleted: 'platform.site_announcement.deleted',
} as const;

export const ANNOUNCEMENT_ERRORS = {
  notFound: 'errors.siteAnnouncements.notFound',
  stale: 'errors.siteAnnouncements.stale',
  invalidTransition: 'errors.siteAnnouncements.invalidTransition',
  deleteNotAllowed: 'errors.siteAnnouncements.deleteNotAllowed',
  contentRequired: 'errors.siteAnnouncements.contentRequired',
  popupTitleRequired: 'errors.siteAnnouncements.popupTitleRequired',
  ctaUrlRequired: 'errors.siteAnnouncements.ctaUrlRequired',
  bodyRequired: 'errors.siteAnnouncements.bodyRequired',
  htmlNotAllowed: 'errors.siteAnnouncements.htmlNotAllowed',
  invalidWindow: 'errors.siteAnnouncements.invalidWindow',
} as const;

export const ANNOUNCEMENT_STALE_CODE = 'SITE_ANNOUNCEMENT_STALE';

type ContentColumns = {
  title: string | null;
  body: string | null;
  ctaLabel: string | null;
};

/** A language as stored; a language with no body but a title or label is refused. */
export function normalizeContent(
  input: AnnouncementContentDto | null | undefined,
): ContentColumns {
  if (!input) return { title: null, body: null, ctaLabel: null };
  const title = input.title?.trim() || null;
  const body = input.body?.trim() || null;
  const ctaLabel = input.ctaLabel?.trim() || null;
  for (const text of [title, body, ctaLabel]) {
    if (text && HTML_TAG_PATTERN.test(text)) {
      throw new BadRequestException({ messageKey: ANNOUNCEMENT_ERRORS.htmlNotAllowed });
    }
  }
  if (!body && (title || ctaLabel)) {
    throw new UnprocessableEntityException({
      messageKey: ANNOUNCEMENT_ERRORS.bodyRequired,
    });
  }
  return { title, body, ctaLabel };
}

function contentData(locale: AnnouncementLocale, columns: ContentColumns) {
  return locale === 'en'
    ? { titleEn: columns.title, bodyEn: columns.body, ctaLabelEn: columns.ctaLabel }
    : { titleAr: columns.title, bodyAr: columns.body, ctaLabelAr: columns.ctaLabel };
}

/** Fields that mean nothing on this surface are reset, so a stored row never carries stale ones. */
export function surfaceDefaults(
  surface: SiteAnnouncement['surface'],
): Partial<Prisma.SiteAnnouncementUncheckedCreateInput> {
  return {
    ...(surface !== 'marketing_popup'
      ? { imageUrl: null, popupDelaySeconds: 0, popupFrequency: 'once' as const }
      : {}),
    ...(surface === 'dashboard_banner' ? { pages: [] } : { audience: 'all' as const }),
  };
}

function problemError(problem: NonNullable<ReturnType<typeof activationProblem>>) {
  return new UnprocessableEntityException({ messageKey: ANNOUNCEMENT_ERRORS[problem] });
}

function parseDate(value: string | null | undefined): Date | null | undefined {
  if (value === undefined) return undefined;
  return value === null ? null : new Date(value);
}

export function toPublicAnnouncement(
  row: SiteAnnouncement,
  locale: AnnouncementLocale,
): PublicAnnouncement | null {
  const content = contentFor(row, locale);
  if (!content) return null;
  return {
    id: row.id,
    surface: row.surface,
    tone: row.tone,
    title: content.title,
    body: content.body,
    ctaLabel: content.ctaLabel,
    ctaUrl: row.ctaUrl,
    imageUrl: row.surface === 'marketing_popup' ? row.imageUrl : null,
    dismissible: row.dismissible,
    popupDelaySeconds: row.popupDelaySeconds,
    popupFrequency: row.popupFrequency,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function liveWhere(now: Date): Prisma.SiteAnnouncementWhereInput {
  return {
    status: 'active',
    AND: [
      { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
      { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
    ],
  };
}

@Injectable()
export class SiteAnnouncementsService {
  private readonly logger = new Logger(SiteAnnouncementsService.name);

  constructor(
    private readonly tenancyContextService: TenancyContextService,
    private readonly auditLogWriterService: AuditLogWriterService,
  ) {}

  // ---------------------------------------------------------------------
  // Platform Owner
  // ---------------------------------------------------------------------

  async list(
    platformOwnerId: string,
    query: ListSiteAnnouncementsQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedResult<SiteAnnouncementResponse>> {
    const page = query.page ?? DEFAULT_PAGE;
    const pageSize = query.pageSize ?? DEFAULT_PAGE_SIZE;
    const term = query.search?.trim();
    const where: Prisma.SiteAnnouncementWhereInput = {
      ...(query.surface ? { surface: query.surface } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(term ? { name: { contains: term, mode: 'insensitive' } } : {}),
    };
    const sortBy = query.sortBy ?? 'updatedAt';
    const direction = query.sortDirection ?? (sortBy === 'name' ? 'asc' : 'desc');
    const orderBy: Prisma.SiteAnnouncementOrderByWithRelationInput[] = [
      sortBy === 'name'
        ? { name: direction }
        : sortBy === 'priority'
          ? { priority: direction }
          : { updatedAt: direction },
      { id: 'asc' },
    ];
    const { rows, total, names } = await this.tenancyContextService.runInUserContext(
      platformOwnerId,
      async (tx) => {
        const rows = await tx.siteAnnouncement.findMany({
          where,
          orderBy,
          skip: (page - 1) * pageSize,
          take: pageSize,
        });
        return {
          rows,
          total: await tx.siteAnnouncement.count({ where }),
          names: await this.userNames(
            tx,
            rows.flatMap((row) => [row.createdByUserId, row.updatedByUserId]),
          ),
        };
      },
    );
    return {
      items: rows.map((row) => this.toResponse(row, names, now)),
      pagination: buildPaginationMeta(page, pageSize, total),
    };
  }

  async get(
    platformOwnerId: string,
    id: string,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, (tx) =>
      this.load(tx, id, now),
    );
  }

  async create(
    platformOwnerId: string,
    payload: CreateSiteAnnouncementDto,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    const en = normalizeContent(payload.content?.en);
    const ar = normalizeContent(payload.content?.ar);
    const data: Prisma.SiteAnnouncementUncheckedCreateInput = {
      name: payload.name,
      surface: payload.surface,
      status: 'draft',
      tone: payload.tone ?? 'info',
      startsAt: parseDate(payload.startsAt) ?? null,
      endsAt: parseDate(payload.endsAt) ?? null,
      ...contentData('en', en),
      ...contentData('ar', ar),
      ctaUrl: payload.ctaUrl ?? null,
      imageUrl: payload.imageUrl ?? null,
      pages: payload.pages ?? [],
      dismissible: payload.dismissible ?? true,
      popupDelaySeconds: payload.popupDelaySeconds ?? 0,
      popupFrequency: payload.popupFrequency ?? 'once',
      audience: payload.audience ?? 'all',
      priority: payload.priority ?? 0,
      ...surfaceDefaults(payload.surface),
      createdByUserId: platformOwnerId,
      updatedByUserId: platformOwnerId,
    };
    this.assertSavable(data as SiteAnnouncement);

    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const created = await tx.siteAnnouncement.create({ data });
      await this.audit(tx, platformOwnerId, ANNOUNCEMENT_AUDIT.created, created, {
        surface: created.surface,
      });
      return this.load(tx, created.id, now);
    });
  }

  async update(
    platformOwnerId: string,
    id: string,
    payload: UpdateSiteAnnouncementDto,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    const contents: Partial<Record<AnnouncementLocale, ContentColumns>> = {};
    for (const locale of ANNOUNCEMENT_LOCALES) {
      const given = payload.content?.[locale];
      if (given !== undefined) contents[locale] = normalizeContent(given);
    }
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockOrThrow(tx, id, payload.version);
      const next: SiteAnnouncement = { ...current };
      const assign = <K extends keyof SiteAnnouncement>(
        key: K,
        value: SiteAnnouncement[K] | undefined,
      ) => {
        if (value !== undefined) next[key] = value;
      };
      assign('name', payload.name);
      assign('surface', payload.surface);
      assign('tone', payload.tone);
      assign('startsAt', parseDate(payload.startsAt));
      assign('endsAt', parseDate(payload.endsAt));
      assign('ctaUrl', payload.ctaUrl);
      assign('imageUrl', payload.imageUrl);
      assign('pages', payload.pages);
      assign('dismissible', payload.dismissible);
      assign('popupDelaySeconds', payload.popupDelaySeconds);
      assign('popupFrequency', payload.popupFrequency);
      assign('audience', payload.audience);
      assign('priority', payload.priority);
      for (const locale of ANNOUNCEMENT_LOCALES) {
        const columns = contents[locale];
        if (columns) Object.assign(next, contentData(locale, columns));
      }
      Object.assign(next, surfaceDefaults(next.surface));

      const fields: (keyof SiteAnnouncement)[] = [
        'name',
        'surface',
        'tone',
        'startsAt',
        'endsAt',
        'titleEn',
        'bodyEn',
        'ctaLabelEn',
        'titleAr',
        'bodyAr',
        'ctaLabelAr',
        'ctaUrl',
        'imageUrl',
        'pages',
        'dismissible',
        'popupDelaySeconds',
        'popupFrequency',
        'audience',
        'priority',
      ];
      const changed = fields.filter(
        (field) => JSON.stringify(current[field]) !== JSON.stringify(next[field]),
      );
      if (changed.length === 0) return this.load(tx, id, now);

      this.assertSavable(next);
      if (current.status === 'active') {
        const problem = activationProblem(next);
        if (problem) throw problemError(problem);
      }
      const data = Object.fromEntries(
        changed.map((field) => [field, next[field]]),
      ) as Prisma.SiteAnnouncementUncheckedUpdateInput;
      const updated = await tx.siteAnnouncement.update({
        where: { id },
        data: { ...data, updatedByUserId: platformOwnerId, version: { increment: 1 } },
      });
      await this.audit(tx, platformOwnerId, ANNOUNCEMENT_AUDIT.updated, updated, {
        surface: updated.surface,
        status: updated.status,
        changedFields: changed
          .map((field) => String(field).replace(/(En|Ar)$/, (m) => `.${m.toLowerCase()}`))
          .join(','),
      });
      return this.load(tx, id, now);
    });
  }

  async activate(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockOrThrow(tx, id, version);
      if (current.status === 'active') {
        throw new ConflictException({
          messageKey: ANNOUNCEMENT_ERRORS.invalidTransition,
        });
      }
      const problem = activationProblem(current);
      if (problem) throw problemError(problem);
      const updated = await tx.siteAnnouncement.update({
        where: { id },
        data: {
          status: 'active',
          updatedByUserId: platformOwnerId,
          version: { increment: 1 },
        },
      });
      await this.audit(tx, platformOwnerId, ANNOUNCEMENT_AUDIT.activated, updated, {
        surface: updated.surface,
        previousStatus: current.status,
        startsAt: updated.startsAt?.toISOString() ?? null,
        endsAt: updated.endsAt?.toISOString() ?? null,
      });
      return this.load(tx, id, now);
    });
  }

  async deactivate(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    return this.transition(platformOwnerId, id, version, now, 'draft');
  }

  async archive(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date = new Date(),
  ): Promise<SiteAnnouncementResponse> {
    return this.transition(platformOwnerId, id, version, now, 'archived');
  }

  async remove(platformOwnerId: string, id: string): Promise<void> {
    await this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockOrThrow(tx, id, null);
      if (current.status === 'active') {
        throw new ConflictException({ messageKey: ANNOUNCEMENT_ERRORS.deleteNotAllowed });
      }
      await tx.siteAnnouncement.delete({ where: { id } });
      await this.audit(tx, platformOwnerId, ANNOUNCEMENT_AUDIT.deleted, current, {
        surface: current.surface,
        status: current.status,
      });
    });
  }

  // ---------------------------------------------------------------------
  // Public and dashboard
  // ---------------------------------------------------------------------

  async marketing(
    locale: AnnouncementLocale,
    rawPath: string | undefined,
    now: Date = new Date(),
  ): Promise<PublicMarketingAnnouncements> {
    const rows = await this.tenancyContextService.runWithoutContext((tx) =>
      tx.siteAnnouncement.findMany({
        where: {
          ...liveWhere(now),
          surface: { in: ['marketing_banner', 'marketing_popup'] },
        },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
        take: 200,
      }),
    );
    const { banners, popup } = selectForMarketingPage(
      rows,
      locale,
      normalizeMarketingPath(rawPath),
      now,
    );
    return {
      banners: banners
        .map((row) => toPublicAnnouncement(row, locale))
        .filter((row): row is PublicAnnouncement => row !== null),
      popup: popup ? toPublicAnnouncement(popup, locale) : null,
    };
  }

  async dashboard(
    principal: Pick<
      Principal,
      'userId' | 'isPlatformOwner' | 'ownsAnOrganization' | 'academyStaff'
    >,
    locale: AnnouncementLocale,
    now: Date = new Date(),
  ): Promise<DashboardAnnouncements> {
    const rows = await this.tenancyContextService.runInUserContext(
      principal.userId,
      (tx) =>
        tx.siteAnnouncement.findMany({
          where: { ...liveWhere(now), surface: 'dashboard_banner' },
          orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
          take: 100,
        }),
    );
    const banners = rows
      .filter((row) => isLive(row, now) && audienceAllows(row.audience, principal))
      .sort(byPriority)
      .map((row) => toPublicAnnouncement(row, locale))
      .filter((row): row is PublicAnnouncement => row !== null)
      .slice(0, MAX_DASHBOARD_BANNERS);
    return { banners };
  }

  /** Never throws: an unknown id, a non-live row or a database hiccup is simply not counted. */
  async recordEvent(id: string, type: AnnouncementEventType): Promise<boolean> {
    try {
      const result = await this.tenancyContextService.runWithoutContext(
        (tx) =>
          tx.$queryRaw<{ counted: number }[]>`
          SELECT record_site_announcement_event(${id}, ${type}) AS counted`,
      );
      return Number(result[0]?.counted ?? 0) > 0;
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.name : 'unknown' },
        'Site announcement event was not counted.',
      );
      return false;
    }
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  /** Rules every stored row keeps, whatever its status. */
  private assertSavable(
    row: Pick<
      SiteAnnouncement,
      'startsAt' | 'endsAt' | 'ctaUrl' | 'ctaLabelEn' | 'ctaLabelAr'
    >,
  ): void {
    if (row.startsAt && row.endsAt && row.endsAt.getTime() <= row.startsAt.getTime()) {
      throw new BadRequestException({ messageKey: ANNOUNCEMENT_ERRORS.invalidWindow });
    }
    if (!row.ctaUrl && (row.ctaLabelEn || row.ctaLabelAr)) {
      throw problemError('ctaUrlRequired');
    }
  }

  private async transition(
    platformOwnerId: string,
    id: string,
    version: number,
    now: Date,
    to: 'draft' | 'archived',
  ): Promise<SiteAnnouncementResponse> {
    return this.tenancyContextService.runInUserContext(platformOwnerId, async (tx) => {
      const current = await this.lockOrThrow(tx, id, version);
      if (current.status === to) {
        throw new ConflictException({
          messageKey: ANNOUNCEMENT_ERRORS.invalidTransition,
        });
      }
      const updated = await tx.siteAnnouncement.update({
        where: { id },
        data: { status: to, updatedByUserId: platformOwnerId, version: { increment: 1 } },
      });
      await this.audit(
        tx,
        platformOwnerId,
        to === 'draft' ? ANNOUNCEMENT_AUDIT.deactivated : ANNOUNCEMENT_AUDIT.archived,
        updated,
        { surface: updated.surface, previousStatus: current.status },
      );
      return this.load(tx, id, now);
    });
  }

  private async lockOrThrow(
    tx: Prisma.TransactionClient,
    id: string,
    version: number | null,
  ): Promise<SiteAnnouncement> {
    const locked = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM site_announcements WHERE id = ${id} FOR UPDATE`;
    if (locked.length === 0) {
      throw new NotFoundException({ messageKey: ANNOUNCEMENT_ERRORS.notFound });
    }
    const row = await tx.siteAnnouncement.findUniqueOrThrow({ where: { id } });
    if (version !== null && row.version !== version) {
      throw new ConflictException({
        messageKey: ANNOUNCEMENT_ERRORS.stale,
        code: ANNOUNCEMENT_STALE_CODE,
      });
    }
    return row;
  }

  private async userNames(
    tx: Prisma.TransactionClient,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await tx.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((user) => [user.id, user.name]));
  }

  private async load(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<SiteAnnouncementResponse> {
    const row = await tx.siteAnnouncement.findUnique({ where: { id } });
    if (!row) throw new NotFoundException({ messageKey: ANNOUNCEMENT_ERRORS.notFound });
    const names = await this.userNames(tx, [row.createdByUserId, row.updatedByUserId]);
    return this.toResponse(row, names, now);
  }

  private toResponse(
    row: SiteAnnouncement,
    names: Map<string, string>,
    now: Date,
  ): SiteAnnouncementResponse {
    return {
      id: row.id,
      name: row.name,
      surface: row.surface,
      status: row.status,
      live: isLive(row, now),
      startsAt: row.startsAt?.toISOString() ?? null,
      endsAt: row.endsAt?.toISOString() ?? null,
      tone: row.tone,
      content: { en: contentFor(row, 'en'), ar: contentFor(row, 'ar') },
      ctaUrl: row.ctaUrl,
      imageUrl: row.imageUrl,
      pages: row.pages,
      dismissible: row.dismissible,
      popupDelaySeconds: row.popupDelaySeconds,
      popupFrequency: row.popupFrequency,
      audience: row.audience,
      priority: row.priority,
      version: row.version,
      stats: { views: row.views, clicks: row.clicks, dismissals: row.dismissals },
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      createdByName: names.get(row.createdByUserId) ?? null,
      updatedByName: names.get(row.updatedByUserId) ?? null,
    };
  }

  private async audit(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    action: (typeof ANNOUNCEMENT_AUDIT)[keyof typeof ANNOUNCEMENT_AUDIT],
    row: Pick<SiteAnnouncement, 'id' | 'name'>,
    context: Record<string, string | number | boolean | null>,
  ): Promise<void> {
    await this.auditLogWriterService.write(tx, {
      actorUserId,
      role: ROLE,
      action,
      targetType: TARGET_TYPE,
      targetId: row.id,
      targetLabel: row.name,
      context,
    });
  }
}
