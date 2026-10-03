/**
 * Task 3 — the audited-event catalogue, the before/after diff and the
 * writer's `record` helper.
 *
 * The catalogue is the visibility contract for the owner-facing activity
 * log, so these pin its shape (unique actions, tenant visibility of the
 * security/operator families, the actions other modules write) and the
 * writer's behaviour around it (unknown actions refused outside production,
 * one attribution query only when something is missing, diffs over an
 * allowlist only).
 */
import {
  AUDIT_CATEGORIES,
  AUDIT_EVENT_DEFINITIONS,
  TENANT_VISIBLE_AUDIT_ACTIONS,
  actionsInCategory,
  getAuditEventDefinition,
  tenantVisibleActionsInCategory,
} from '../catalog/audit-event-catalog';
import {
  computeAuditChanges,
  diffListCounts,
  normalizeAuditValue,
} from '../utils/audit-diff.util';
import {
  AuditLogWriterService,
  UnknownAuditActionError,
} from './audit-log-writer.service';
import { buildAuditFeedFilter } from '../utils/audit-feed.util';
import { decodeAuditCursor, encodeAuditCursor } from '../dto/audit-log.contract';

describe('audit event catalogue', () => {
  it('lists every action exactly once', () => {
    const actions = AUDIT_EVENT_DEFINITIONS.map((definition) => definition.action);
    expect(new Set(actions).size).toBe(actions.length);
  });

  it('uses only known categories and non-empty target types', () => {
    for (const definition of AUDIT_EVENT_DEFINITIONS) {
      expect(AUDIT_CATEGORIES).toContain(definition.category);
      expect(definition.targetType.length).toBeGreaterThan(0);
    }
  });

  it('never shows security telemetry or platform-operator actions to a tenant', () => {
    for (const action of TENANT_VISIBLE_AUDIT_ACTIONS) {
      const definition = getAuditEventDefinition(action)!;
      expect(definition.category).not.toBe('security');
      expect(definition.category).not.toBe('platform');
      expect(definition.scope).not.toBe('platform');
    }
    expect(TENANT_VISIBLE_AUDIT_ACTIONS).not.toContain('auth.otp.failed');
    expect(TENANT_VISIBLE_AUDIT_ACTIONS).not.toContain('plan.pricing_changed');
    expect(TENANT_VISIBLE_AUDIT_ACTIONS).not.toContain('domain.platform_check');
  });

  it('never allows an IP address in a tenant-visible action’s context', () => {
    for (const definition of AUDIT_EVENT_DEFINITIONS.filter((d) => d.visibleToTenant)) {
      expect(definition.context).not.toContain('ipAddress');
      expect(
        definition.context.some((key) => /email/i.test(key) && key !== 'emailInvite'),
      ).toBe(false);
    }
  });

  it('includes the actions written by other modules (course builder, contact module)', () => {
    for (const action of [
      'course.curriculum.items_reordered',
      'course_section.reordered',
      'platform.contact_submission.status_changed',
      'platform.contact_submission.deleted',
    ]) {
      expect(getAuditEventDefinition(action)).toBeDefined();
    }
  });

  it('covers the previously unaudited domains', () => {
    for (const action of [
      'website_page.created',
      'website_page.updated',
      'website_page.deleted',
      'website_page.published',
      'website.published',
      'website.unpublished',
      'website.configuration.updated',
      'website.visual_identity.updated',
      'website_faq.created',
      'website_testimonial.archived',
      'academy.updated',
      'academy.branding.updated',
      'academy.archived',
      'organization.payment_settings.updated',
      'organization.payment_gateway.credentials_saved',
      'media.uploaded',
    ]) {
      expect(TENANT_VISIBLE_AUDIT_ACTIONS).toContain(action);
    }
  });

  it('expands a category for tenant and platform filters', () => {
    expect(tenantVisibleActionsInCategory('website')).toContain('website_page.updated');
    expect(tenantVisibleActionsInCategory('security')).toEqual([]);
    expect(actionsInCategory('security')).toContain('auth.otp.failed');
  });
});

describe('computeAuditChanges / diffListCounts', () => {
  it('reports only allowlisted fields that actually changed', () => {
    const changes = computeAuditChanges(
      { title: 'Old', passwordHash: 'x', status: 'draft', untouched: 1 },
      { title: 'New', passwordHash: 'y', status: 'draft', untouched: 2 },
      ['title', 'status'],
    );
    expect(changes).toEqual({ title: { from: 'Old', to: 'New' } });
  });

  it('skips fields absent from `after` (not part of this write)', () => {
    expect(
      computeAuditChanges({ title: 'A', slug: 'a' }, { slug: 'b' }, ['title', 'slug']),
    ).toEqual({ slug: { from: 'a', to: 'b' } });
  });

  it('normalises dates, bigints and key order before comparing', () => {
    const at = new Date('2026-01-02T03:04:05.000Z');
    expect(normalizeAuditValue(at)).toBe('2026-01-02T03:04:05.000Z');
    expect(normalizeAuditValue(5n)).toBe('5');
    expect(
      computeAuditChanges(
        { seo: { b: 1, a: 2 }, dueAt: at },
        { seo: { a: 2, b: 1 }, dueAt: new Date(at.getTime()) },
        ['seo', 'dueAt'],
      ),
    ).toBeUndefined();
  });

  it('counts added, removed and changed list items', () => {
    const counts = diffListCounts(
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 1 },
        { id: 'c', v: 1 },
      ],
      [
        { id: 'a', v: 1 },
        { id: 'b', v: 2 },
        { id: 'd', v: 1 },
      ],
      (item) => item.id,
      (item) => String(item.v),
    );
    expect(counts).toEqual({ added: 1, removed: 1, changed: 1 });
  });
});

describe('AuditLogWriterService', () => {
  function build() {
    const create = jest.fn(async () => ({ id: 'row' }));
    const service = new AuditLogWriterService({ create } as never);
    const queryRaw = jest.fn(async () => [
      { organization_id: 'org-1', member_role: 'manager', owner_user_id: 'someone-else' },
    ]);
    const tx = { $queryRaw: queryRaw } as never;
    return { service, create, queryRaw, tx };
  }

  it('refuses an action missing from the catalogue outside production', async () => {
    const { service, tx } = build();
    await expect(
      service.write(tx, {
        actorUserId: 'u',
        action: 'made.up_action',
        targetType: 'x',
        targetId: 'y',
      }),
    ).rejects.toBeInstanceOf(UnknownAuditActionError);
  });

  it('resolves organization and role with ONE query when they are missing', async () => {
    const { service, create, queryRaw, tx } = build();
    await service.record(tx, {
      actorUserId: 'u',
      academyId: 'academy-1',
      action: 'website_page.created',
      targetId: 'page-1',
      targetLabel: 'About',
      context: { slug: 'about', notAllowed: 'dropped' },
    });
    expect(queryRaw).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        organizationId: 'org-1',
        academyId: 'academy-1',
        role: 'manager',
        targetType: 'website_page',
        context: { slug: 'about' },
      }),
    );
  });

  it('runs no attribution query when the caller already has both', async () => {
    const { service, queryRaw, tx } = build();
    await service.record(tx, {
      actorUserId: 'u',
      academyId: 'academy-1',
      organizationId: 'org-1',
      role: 'owner',
      action: 'website.published',
      targetId: 'academy-1',
    });
    expect(queryRaw).not.toHaveBeenCalled();
  });

  it('diffs before/after over the catalogue fields and masks emails on tenant rows', async () => {
    const { service, create, tx } = build();
    await service.record(tx, {
      actorUserId: 'u',
      academyId: 'academy-1',
      organizationId: 'org-1',
      role: 'owner',
      action: 'academy.updated',
      targetId: 'academy-1',
      before: { name: 'Old', contactEmail: 'old@example.com', internal: 1 },
      after: { name: 'New', contactEmail: 'new@example.com', internal: 2 },
    });
    const written = (
      create.mock.calls[0] as unknown as [unknown, { changes: unknown }]
    )[1];
    expect(written.changes).toEqual({
      name: { from: 'Old', to: 'New' },
      contactEmail: { from: '[email hidden]', to: '[email hidden]' },
    });
  });
});

describe('audit feed query', () => {
  it('round-trips a cursor and rejects anything else', () => {
    const cursor = {
      occurredAt: new Date('2026-10-01T10:00:00.123Z'),
      id: '0b9f4a3e-3a8e-4b8a-9c1d-2f1e6c7d8e9f',
    };
    expect(decodeAuditCursor(encodeAuditCursor(cursor))).toEqual(cursor);
    expect(decodeAuditCursor('not-a-cursor')).toBeUndefined();
    expect(() => buildAuditFeedFilter({ cursor: 'garbage' })).toThrow();
  });

  it('lets category and action only narrow the tenant visibility bound', () => {
    const filter = buildAuditFeedFilter(
      { category: 'website' },
      TENANT_VISIBLE_AUDIT_ACTIONS,
    );
    expect(filter.actions).toContain('website_page.updated');
    expect(filter.actions).not.toContain('course.created');

    const hidden = buildAuditFeedFilter(
      { action: 'auth.otp.failed' },
      TENANT_VISIBLE_AUDIT_ACTIONS,
    );
    expect(hidden.actions).toEqual([]);
  });
});
