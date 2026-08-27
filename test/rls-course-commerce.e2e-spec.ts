/**
 * Direct PostgreSQL/RLS proof for Phase P13's new tables
 * (`course_orders`/`revenue_ledger_entries`/`academy_payouts`/
 * `academy_payout_items`/`course_order_refunds`) plus the additive
 * `payments_payer_*` policies — mirrors `rls-billing.e2e-spec.ts`'s exact
 * pattern: every test talks to Postgres directly through the app's own
 * `PrismaService` (connected as the restricted `atlas_app` role) and
 * `TenancyContextService`. No guard, no service, no HTTP request anywhere
 * in this file.
 */
import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

describe('Row-Level Security — Course Commerce (course_orders/revenue_ledger_entries/academy_payouts/course_order_refunds, direct, no guards)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tenancyContext: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    prisma = testApp.prisma;
    tenancyContext = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await app.close();
  });

  async function createUser(label: string, isPlatformOwner = false) {
    return prisma.user.create({
      data: {
        email: uniqueTestEmail(label),
        passwordHash: 'x',
        name: label,
        isPlatformOwner,
      },
    });
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

  async function createAcademy(organizationId: string, slugLabel: string) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.academy.create({
        data: { organizationId, name: slugLabel, slug: `${slugLabel}-${Date.now()}` },
      }),
    );
  }

  async function createCourse(
    organizationId: string,
    academyId: string,
    slugLabel: string,
  ) {
    return tenancyContext.runInTenantContext(organizationId, (tx) =>
      tx.course.create({
        data: {
          academyId,
          title: slugLabel,
          slug: `${slugLabel}-${Date.now()}`,
          status: 'published',
          visibility: 'public',
          pricingType: 'paid',
          pricingAmountMinorUnits: 5000n,
          pricingCurrency: 'USD',
        },
      }),
    );
  }

  async function createOrder(
    studentId: string,
    courseId: string,
    academyId: string,
    organizationId: string,
  ) {
    return tenancyContext.runInUserContext(studentId, (tx) =>
      tx.courseOrder.create({
        data: {
          studentId,
          courseId,
          academyId,
          organizationId,
          snapshot: {
            course: { id: courseId, title: 'x' },
            price: { amountMinorUnits: 5000, currency: 'USD' },
            capturedAt: new Date().toISOString(),
          },
          status: 'draft',
          expiresAt: new Date(Date.now() + 60_000),
          idempotencyKey: `rls-co-${randomUUID()}`,
        },
      }),
    );
  }

  describe('course_orders', () => {
    it('SELECT: a buyer user context only ever sees their own CourseOrder', async () => {
      const student1 = await createUser('rls-co-student1');
      const student2 = await createUser('rls-co-student2');
      const owner = await createUser('rls-co-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-co-org');
      const academy = await createAcademy(org.id, 'rls-co-academy');
      const course = await createCourse(org.id, academy.id, 'rls-co-course');
      const order1 = await createOrder(student1.id, course.id, academy.id, org.id);
      const order2 = await createOrder(student2.id, course.id, academy.id, org.id);

      const visible = await tenancyContext.runInUserContext(student1.id, (tx) =>
        tx.courseOrder.findMany({ where: { id: { in: [order1.id, order2.id] } } }),
      );
      expect(visible.map((o) => o.id)).toEqual([order1.id]);
    });

    it('SELECT: with no session variable set at all, every CourseOrder row is invisible (fail-closed)', async () => {
      const student = await createUser('rls-co-noctx-student');
      const owner = await createUser('rls-co-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-co-noctx-org');
      const academy = await createAcademy(org.id, 'rls-co-noctx-academy');
      const course = await createCourse(org.id, academy.id, 'rls-co-noctx-course');
      const order = await createOrder(student.id, course.id, academy.id, org.id);

      const rows = await prisma.courseOrder.findMany({ where: { id: order.id } });
      expect(rows).toEqual([]);
    });

    it('PLATFORM (allowed): a verified Platform Owner, under runInUserContext, reads a CourseOrder across every student/organization', async () => {
      const student = await createUser('rls-co-plat-student');
      const platformOwner = await createUser('rls-co-plat-owner', true);
      const owner = await createUser('rls-co-plat-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-co-plat-org');
      const academy = await createAcademy(org.id, 'rls-co-plat-academy');
      const course = await createCourse(org.id, academy.id, 'rls-co-plat-course');
      const order = await createOrder(student.id, course.id, academy.id, org.id);

      const rows = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.courseOrder.findMany({ where: { id: order.id } }),
      );
      expect(rows.map((o) => o.id)).toEqual([order.id]);
    });

    it('ATTACK (blocked): a buyer user context cannot create a CourseOrder for a different student', async () => {
      const student1 = await createUser('rls-atk-co-student1');
      const student2 = await createUser('rls-atk-co-student2');
      const owner = await createUser('rls-atk-co-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-co-org');
      const academy = await createAcademy(org.id, 'rls-atk-co-academy');
      const course = await createCourse(org.id, academy.id, 'rls-atk-co-course');

      await expect(
        tenancyContext.runInUserContext(student1.id, (tx) =>
          tx.courseOrder.create({
            data: {
              studentId: student2.id,
              courseId: course.id,
              academyId: academy.id,
              organizationId: org.id,
              snapshot: {},
              status: 'draft',
              expiresAt: new Date(Date.now() + 60_000),
              idempotencyKey: `rls-atk-${randomUUID()}`,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });

  describe('payments (payer-scoped, Course Commerce rows)', () => {
    async function createCourseOrderPayment(payerUserId: string, payeeAcademyId: string) {
      return tenancyContext.runInUserContext(payerUserId, (tx) =>
        tx.payment.create({
          data: {
            payerUserId,
            payeeAcademyId,
            methodKey: 'atlas_manual',
            methodType: 'manual_bank_transfer',
            provider: 'atlas_manual',
            amountMinorUnits: 5000n,
            currency: 'USD',
            status: 'pending',
            reviewStatus: 'pending',
          },
        }),
      );
    }

    it('SELECT: a buyer user context only ever sees their own course-order Payment', async () => {
      const student1 = await createUser('rls-pay-payer-student1');
      const student2 = await createUser('rls-pay-payer-student2');
      const owner = await createUser('rls-pay-payer-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pay-payer-org');
      const academy = await createAcademy(org.id, 'rls-pay-payer-academy');
      const p1 = await createCourseOrderPayment(student1.id, academy.id);
      const p2 = await createCourseOrderPayment(student2.id, academy.id);

      const visible = await tenancyContext.runInUserContext(student1.id, (tx) =>
        tx.payment.findMany({ where: { id: { in: [p1.id, p2.id] } } }),
      );
      expect(visible.map((p) => p.id)).toEqual([p1.id]);
    });

    it('an organization-tenant context (the OLD organization-scoped policy) never sees a course-order Payment — NULL organization_id never matches', async () => {
      const student = await createUser('rls-pay-payer-vs-org-student');
      const owner = await createUser('rls-pay-payer-vs-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-pay-payer-vs-org-org');
      const academy = await createAcademy(org.id, 'rls-pay-payer-vs-org-academy');
      const payment = await createCourseOrderPayment(student.id, academy.id);

      const rows = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.payment.findMany({ where: { id: payment.id } }),
      );
      expect(rows).toEqual([]);
    });
  });

  describe('revenue_ledger_entries (append-only, transitive via academies.organization_id)', () => {
    async function createLedgerEntry(
      organizationId: string,
      academyId: string,
      courseOrderId: string,
      entryType: 'sale' | 'platform_fee' = 'sale',
    ) {
      return tenancyContext.runInTenantContext(organizationId, (tx) =>
        tx.revenueLedgerEntry.create({
          data: {
            academyId,
            courseOrderId,
            entryType,
            amountMinorUnits: entryType === 'sale' ? 5000n : -500n,
            currency: 'USD',
          },
        }),
      );
    }

    it('SELECT: an Academy-owning Organization tenant context sees its own ledger entries; an unrelated Organization does not', async () => {
      const student = await createUser('rls-ledger-student');
      const owner1 = await createUser('rls-ledger-owner1');
      const owner2 = await createUser('rls-ledger-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-ledger-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-ledger-org2');
      const academy1 = await createAcademy(org1.id, 'rls-ledger-academy1');
      const course1 = await createCourse(org1.id, academy1.id, 'rls-ledger-course1');
      const order1 = await createOrder(student.id, course1.id, academy1.id, org1.id);
      const entry = await createLedgerEntry(org1.id, academy1.id, order1.id);

      const visibleToOwner1 = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.revenueLedgerEntry.findMany({ where: { id: entry.id } }),
      );
      expect(visibleToOwner1.map((e) => e.id)).toEqual([entry.id]);

      const visibleToOwner2 = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.revenueLedgerEntry.findMany({ where: { id: entry.id } }),
      );
      expect(visibleToOwner2).toEqual([]);
    });

    it('SELECT: with no session variable set at all, every ledger row is invisible (fail-closed)', async () => {
      const student = await createUser('rls-ledger-noctx-student');
      const owner = await createUser('rls-ledger-noctx-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ledger-noctx-org');
      const academy = await createAcademy(org.id, 'rls-ledger-noctx-academy');
      const course = await createCourse(org.id, academy.id, 'rls-ledger-noctx-course');
      const order = await createOrder(student.id, course.id, academy.id, org.id);
      const entry = await createLedgerEntry(org.id, academy.id, order.id);

      const rows = await prisma.revenueLedgerEntry.findMany({ where: { id: entry.id } });
      expect(rows).toEqual([]);
    });

    it('PLATFORM (allowed): a verified Platform Owner reads ledger entries across every Academy', async () => {
      const student = await createUser('rls-ledger-plat-student');
      const platformOwner = await createUser('rls-ledger-plat-owner', true);
      const owner = await createUser('rls-ledger-plat-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-ledger-plat-org');
      const academy = await createAcademy(org.id, 'rls-ledger-plat-academy');
      const course = await createCourse(org.id, academy.id, 'rls-ledger-plat-course');
      const order = await createOrder(student.id, course.id, academy.id, org.id);
      const entry = await createLedgerEntry(org.id, academy.id, order.id);

      const rows = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.revenueLedgerEntry.findMany({ where: { id: entry.id } }),
      );
      expect(rows.map((e) => e.id)).toEqual([entry.id]);
    });

    it('ATTACK (blocked): an unrelated Organization tenant context cannot INSERT a ledger entry for another Academy', async () => {
      const student = await createUser('rls-atk-ledger-student');
      const owner1 = await createUser('rls-atk-ledger-owner1');
      const owner2 = await createUser('rls-atk-ledger-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-atk-ledger-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-atk-ledger-org2');
      const academy2 = await createAcademy(org2.id, 'rls-atk-ledger-academy2');
      const course2 = await createCourse(org2.id, academy2.id, 'rls-atk-ledger-course2');
      const order2 = await createOrder(student.id, course2.id, academy2.id, org2.id);

      await expect(
        tenancyContext.runInTenantContext(org1.id, (tx) =>
          tx.revenueLedgerEntry.create({
            data: {
              academyId: academy2.id,
              courseOrderId: order2.id,
              entryType: 'sale',
              amountMinorUnits: 999999n,
              currency: 'USD',
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });

    it('ATTACK (blocked): no UPDATE policy exists at all — a ledger entry can never be mutated in place, even by its own Organization', async () => {
      const student = await createUser('rls-atk-ledger-upd-student');
      const owner = await createUser('rls-atk-ledger-upd-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-ledger-upd-org');
      const academy = await createAcademy(org.id, 'rls-atk-ledger-upd-academy');
      const course = await createCourse(org.id, academy.id, 'rls-atk-ledger-upd-course');
      const order = await createOrder(student.id, course.id, academy.id, org.id);
      const entry = await createLedgerEntry(org.id, academy.id, order.id);

      const affected = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.revenueLedgerEntry.updateMany({
          where: { id: entry.id },
          data: { amountMinorUnits: 1n },
        }),
      );
      expect(affected.count).toBe(0);

      const unchanged = await tenancyContext.runInTenantContext(org.id, (tx) =>
        tx.revenueLedgerEntry.findUniqueOrThrow({ where: { id: entry.id } }),
      );
      expect(unchanged.amountMinorUnits).toBe(5000n);
    });
  });

  describe('academy_payouts (asymmetric: Academy staff read, Platform Owner write)', () => {
    it('SELECT: the owning Organization tenant context can read its own AcademyPayout; an unrelated Organization cannot', async () => {
      const platformOwner = await createUser('rls-payout-select-platform', true);
      const owner1 = await createUser('rls-payout-select-owner1');
      const owner2 = await createUser('rls-payout-select-owner2');
      const org1 = await createOrgOwnedBy(owner1.id, 'rls-payout-select-org1');
      const org2 = await createOrgOwnedBy(owner2.id, 'rls-payout-select-org2');
      const academy1 = await createAcademy(org1.id, 'rls-payout-select-academy1');

      const payout = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.academyPayout.create({
          data: {
            academyId: academy1.id,
            status: 'pending',
            amountMinorUnits: 1000n,
            currency: 'USD',
            periodStart: new Date(Date.now() - 60_000),
            periodEnd: new Date(),
          },
        }),
      );

      const visibleToOrg1 = await tenancyContext.runInTenantContext(org1.id, (tx) =>
        tx.academyPayout.findMany({ where: { id: payout.id } }),
      );
      expect(visibleToOrg1.map((p) => p.id)).toEqual([payout.id]);

      const visibleToOrg2 = await tenancyContext.runInTenantContext(org2.id, (tx) =>
        tx.academyPayout.findMany({ where: { id: payout.id } }),
      );
      expect(visibleToOrg2).toEqual([]);
    });

    it('ATTACK (blocked): an Organization tenant context (Academy staff) cannot INSERT its own AcademyPayout — Platform-Owner-only write', async () => {
      const owner = await createUser('rls-atk-payout-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-payout-org');
      const academy = await createAcademy(org.id, 'rls-atk-payout-academy');

      await expect(
        tenancyContext.runInTenantContext(org.id, (tx) =>
          tx.academyPayout.create({
            data: {
              academyId: academy.id,
              status: 'pending',
              amountMinorUnits: 999999n,
              currency: 'USD',
              periodStart: new Date(Date.now() - 60_000),
              periodEnd: new Date(),
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });

    it('PLATFORM (allowed): a verified Platform Owner can INSERT/UPDATE an AcademyPayout for any Academy', async () => {
      const platformOwner = await createUser('rls-payout-plat-owner', true);
      const owner = await createUser('rls-payout-plat-org-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-payout-plat-org');
      const academy = await createAcademy(org.id, 'rls-payout-plat-academy');

      const payout = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.academyPayout.create({
          data: {
            academyId: academy.id,
            status: 'pending',
            amountMinorUnits: 1000n,
            currency: 'USD',
            periodStart: new Date(Date.now() - 60_000),
            periodEnd: new Date(),
          },
        }),
      );

      const updated = await tenancyContext.runInUserContext(platformOwner.id, (tx) =>
        tx.academyPayout.update({ where: { id: payout.id }, data: { status: 'paid' } }),
      );
      expect(updated.status).toBe('paid');
    });
  });

  describe('course_order_refunds (buyer-scoped, append-only)', () => {
    async function createSucceededPayment(payerUserId: string, payeeAcademyId: string) {
      return tenancyContext.runInUserContext(payerUserId, (tx) =>
        tx.payment.create({
          data: {
            payerUserId,
            payeeAcademyId,
            methodKey: 'atlas_manual',
            methodType: 'manual_bank_transfer',
            provider: 'atlas_manual',
            amountMinorUnits: 5000n,
            currency: 'USD',
            status: 'succeeded',
            reviewStatus: 'approved',
          },
        }),
      );
    }

    it('SELECT: a buyer user context only ever sees their own refund request', async () => {
      const student1 = await createUser('rls-refund-student1');
      const student2 = await createUser('rls-refund-student2');
      const owner = await createUser('rls-refund-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-refund-org');
      const academy = await createAcademy(org.id, 'rls-refund-academy');
      const course = await createCourse(org.id, academy.id, 'rls-refund-course');
      const order1 = await createOrder(student1.id, course.id, academy.id, org.id);
      const payment1 = await createSucceededPayment(student1.id, academy.id);

      const refund1 = await tenancyContext.runInUserContext(student1.id, (tx) =>
        tx.courseOrderRefund.create({
          data: {
            courseOrderId: order1.id,
            paymentId: payment1.id,
            amountMinorUnits: 5000n,
            currency: 'USD',
            requestedBy: student1.id,
            idempotencyKey: `rls-refund-${randomUUID()}`,
          },
        }),
      );

      const visibleToStudent2 = await tenancyContext.runInUserContext(student2.id, (tx) =>
        tx.courseOrderRefund.findMany({ where: { id: refund1.id } }),
      );
      expect(visibleToStudent2).toEqual([]);

      const visibleToStudent1 = await tenancyContext.runInUserContext(student1.id, (tx) =>
        tx.courseOrderRefund.findMany({ where: { id: refund1.id } }),
      );
      expect(visibleToStudent1.map((r) => r.id)).toEqual([refund1.id]);
    });

    it('ATTACK (blocked): a buyer user context cannot INSERT a refund request attributed to a different student', async () => {
      const student1 = await createUser('rls-atk-refund-student1');
      const student2 = await createUser('rls-atk-refund-student2');
      const owner = await createUser('rls-atk-refund-owner');
      const org = await createOrgOwnedBy(owner.id, 'rls-atk-refund-org');
      const academy = await createAcademy(org.id, 'rls-atk-refund-academy');
      const course = await createCourse(org.id, academy.id, 'rls-atk-refund-course');
      const order2 = await createOrder(student2.id, course.id, academy.id, org.id);
      const payment2 = await createSucceededPayment(student2.id, academy.id);

      await expect(
        tenancyContext.runInUserContext(student1.id, (tx) =>
          tx.courseOrderRefund.create({
            data: {
              courseOrderId: order2.id,
              paymentId: payment2.id,
              amountMinorUnits: 5000n,
              currency: 'USD',
              requestedBy: student2.id,
              idempotencyKey: `rls-atk-refund-${randomUUID()}`,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security policy/i);
    });
  });
});
