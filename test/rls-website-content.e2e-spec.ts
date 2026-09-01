/**
 * Direct PostgreSQL/RLS proof for `website_faq_entries`/
 * `website_testimonial_entries` (master plan §21 Phase P10) — mirrors
 * `rls-website.e2e-spec.ts`'s exact pattern: every test talks to Postgres
 * directly through the app's own `PrismaService` (connected as the
 * restricted `atlas_app` role) and `TenancyContextService`. No guard, no
 * service, no HTTP request is involved anywhere in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { uniqueTestEmail, createTestApp } from './utils/test-app';
import { createAdminPrisma } from './utils/db-admin';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { PrismaClient } from '@prisma/client';

describe('Row-Level Security — website_faq_entries / website_testimonial_entries (direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let admin: PrismaClient;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    admin = createAdminPrisma();
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  async function createUser(label: string): Promise<{ id: string }> {
    const user = await prisma.user.create({
      data: { email: uniqueTestEmail(label), passwordHash: 'x', name: label },
    });
    return { id: user.id };
  }

  async function createOrgOwnedBy(ownerId: string, slugLabel: string) {
    return prisma.$transaction(async (tx) => {
      const id = randomUUID();
      await tx.$executeRaw`SELECT set_config('app.current_organization_id', ${id}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${ownerId}, true)`;
      const org = await tx.organization.create({
        data: {
          id,
          name: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          ownerUserId: ownerId,
        },
      });
      await tx.organizationMembership.create({
        data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
      });
      return org;
    });
  }

  async function createAcademyFor(organizationId: string, label: string) {
    return tenancyContext.runInTenantContext(organizationId, async (tx) => {
      const org = await tx.organization.findUniqueOrThrow({
        where: { id: organizationId },
      });
      const academy = await tx.academy.create({
        data: { organizationId, name: label, slug: `${label}-${Date.now()}` },
      });
      // Phase 1 (Extended Scope, dependency A) — see `rls-website.e2e-spec.ts`'s identical helper doc comment.
      await tx.academyMember.create({
        data: {
          academyId: academy.id,
          userId: org.ownerUserId,
          role: 'owner',
          status: 'active',
        },
      });
      return academy;
    });
  }

  /** Phase 1 (Extended Scope, dependency A) — see `rls-website.e2e-spec.ts`'s identical helper. */
  async function resolveAcademyOwnerId(
    organizationId: string,
    academyId: string,
  ): Promise<string> {
    const membership = await tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academyMember.findFirst({ where: { academyId, role: 'owner' } }),
    );
    if (!membership)
      throw new Error(`No owner membership found for academy ${academyId}`);
    return membership.userId;
  }

  async function createFaqEntry(
    organizationId: string,
    academyId: string,
    label: string,
  ) {
    const ownerId = await resolveAcademyOwnerId(organizationId, academyId);
    return tenancyContext.runInTenantAndUserContext(organizationId, ownerId, (tx) =>
      tx.websiteFaqEntry.create({
        data: {
          academyId,
          question: { en: `${label} Q`, ar: `${label} س` },
          answer: { en: `${label} A`, ar: `${label} ج` },
        },
      }),
    );
  }

  async function createTestimonialEntry(
    organizationId: string,
    academyId: string,
    label: string,
  ) {
    const ownerId = await resolveAcademyOwnerId(organizationId, academyId);
    return tenancyContext.runInTenantAndUserContext(organizationId, ownerId, (tx) =>
      tx.websiteTestimonialEntry.create({
        data: {
          academyId,
          quote: { en: `${label} quote`, ar: `${label} اقتباس` },
          authorName: label,
        },
      }),
    );
  }

  it('SELECT: with no session variable set at all, FAQ/Testimonial entries are invisible (fail-closed)', async () => {
    const owner = await createUser('rls-content-noctx-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-content-noctx');
    const academy = await createAcademyFor(org.id, 'rls-content-noctx');
    const faq = await createFaqEntry(org.id, academy.id, 'rls-content-noctx-faq');
    const testimonial = await createTestimonialEntry(
      org.id,
      academy.id,
      'rls-content-noctx-t',
    );

    expect(await prisma.websiteFaqEntry.findMany({ where: { id: faq.id } })).toEqual([]);
    expect(
      await prisma.websiteTestimonialEntry.findMany({ where: { id: testimonial.id } }),
    ).toEqual([]);
  });

  it("SELECT: Organization A's session context never sees Organization B's CMS content, and vice versa", async () => {
    const ownerA = await createUser('rls-content-cross-a');
    const ownerB = await createUser('rls-content-cross-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-content-cross-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-content-cross-orgB');
    const academyA = await createAcademyFor(orgA.id, 'rls-content-cross-academyA');
    const academyB = await createAcademyFor(orgB.id, 'rls-content-cross-academyB');
    const faqA = await createFaqEntry(orgA.id, academyA.id, 'rls-content-cross-a-faq');
    const faqB = await createFaqEntry(orgB.id, academyB.id, 'rls-content-cross-b-faq');

    const visibleToA = await tenancyContext.runInTenantAndUserContext(
      orgA.id,
      ownerA.id,
      (tx) => tx.websiteFaqEntry.findMany({ where: { id: { in: [faqA.id, faqB.id] } } }),
    );
    expect(visibleToA.map((e) => e.id)).toEqual([faqA.id]);

    const visibleToB = await tenancyContext.runInTenantAndUserContext(
      orgB.id,
      ownerB.id,
      (tx) => tx.websiteFaqEntry.findMany({ where: { id: { in: [faqA.id, faqB.id] } } }),
    );
    expect(visibleToB.map((e) => e.id)).toEqual([faqB.id]);
  });

  it('ATTACK (blocked): cannot insert a FAQ entry under a different organization than the active tenant context', async () => {
    const attackerOwner = await createUser('rls-atk-content-attacker');
    const victimOwner = await createUser('rls-atk-content-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-content-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(
      victimOwner.id,
      'rls-atk-content-victim-org',
    );
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-content-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.websiteFaqEntry.create({
          data: {
            academyId: victimAcademy.id,
            question: { en: 'hijack', ar: 'اختطاف' },
            answer: { en: 'hijack', ar: 'اختطاف' },
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it('ATTACK (blocked): cannot insert a Testimonial entry under a different organization than the active tenant context', async () => {
    const attackerOwner = await createUser('rls-atk-testimonial-attacker');
    const victimOwner = await createUser('rls-atk-testimonial-victim');
    const attackerOrg = await createOrgOwnedBy(
      attackerOwner.id,
      'rls-atk-testimonial-attacker-org',
    );
    const victimOrg = await createOrgOwnedBy(
      victimOwner.id,
      'rls-atk-testimonial-victim-org',
    );
    const victimAcademy = await createAcademyFor(
      victimOrg.id,
      'rls-atk-testimonial-victim-academy',
    );

    await expect(
      tenancyContext.runInTenantContext(attackerOrg.id, (tx) =>
        tx.websiteTestimonialEntry.create({
          data: {
            academyId: victimAcademy.id,
            quote: { en: 'hijack', ar: 'اختطاف' },
            authorName: 'hijacker',
          },
        }),
      ),
    ).rejects.toThrow(/row-level security policy/i);
  });

  it("ATTACK (blocked): cannot update Organization B's FAQ entry from Organization A's tenant context, even with the exact real id", async () => {
    const ownerA = await createUser('rls-atk-content-update-a');
    const ownerB = await createUser('rls-atk-content-update-b');
    const orgA = await createOrgOwnedBy(ownerA.id, 'rls-atk-content-update-orgA');
    const orgB = await createOrgOwnedBy(ownerB.id, 'rls-atk-content-update-orgB');
    const academyB = await createAcademyFor(orgB.id, 'rls-atk-content-update-academyB');
    const faqB = await createFaqEntry(
      orgB.id,
      academyB.id,
      'rls-atk-content-update-b-faq',
    );

    const result = await tenancyContext.runInTenantContext(orgA.id, (tx) =>
      tx.websiteFaqEntry.updateMany({
        where: { id: faqB.id },
        data: { status: 'published' },
      }),
    );
    expect(result.count).toBe(0);

    const stillDraft = await admin.websiteFaqEntry.findUniqueOrThrow({
      where: { id: faqB.id },
    });
    expect(stillDraft.status).toBe('draft');
  });

  it('no DELETE policy exists on website_faq_entries — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-content-faq-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-content-faq-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-content-faq-no-delete');
    const faq = await createFaqEntry(
      org.id,
      academy.id,
      'rls-content-faq-no-delete-entry',
    );

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.websiteFaqEntry.deleteMany({ where: { id: faq.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.websiteFaqEntry.findUnique({ where: { id: faq.id } });
    expect(stillThere).not.toBeNull();
  });

  it('no DELETE policy exists on website_testimonial_entries — a direct DELETE affects zero rows even under the correct tenant context', async () => {
    const owner = await createUser('rls-content-testimonial-no-delete-owner');
    const org = await createOrgOwnedBy(owner.id, 'rls-content-testimonial-no-delete');
    const academy = await createAcademyFor(org.id, 'rls-content-testimonial-no-delete');
    const testimonial = await createTestimonialEntry(
      org.id,
      academy.id,
      'rls-content-testimonial-no-delete-entry',
    );

    const result = await tenancyContext.runInTenantContext(org.id, (tx) =>
      tx.websiteTestimonialEntry.deleteMany({ where: { id: testimonial.id } }),
    );
    expect(result.count).toBe(0);

    const stillThere = await admin.websiteTestimonialEntry.findUnique({
      where: { id: testimonial.id },
    });
    expect(stillThere).not.toBeNull();
  });
});
