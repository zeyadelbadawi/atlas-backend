/**
 * UX audit (Nov 2026) — the backend half of the owner-approved items the
 * audit batches recorded as "Not changed: the API has no …":
 *
 *   - B5 V35   a customer closes their own support ticket;
 *   - B5/B8    Arabic names for add-ons and Atlas payment methods;
 *   - B6 V17   server-side filters on the quiz-attempt and submission lists;
 *   - B6 V06   the grader's name on a submission;
 *   - B8 V01   who reviewed a payment, on the Platform detail;
 *   - B8       a payer reference on subscription payment proofs;
 *   - B7 V12   an order's payments, so checkout resumes in a new tab;
 *   - B3       the course price maximum (1,000,000) on the server too.
 *
 * (B8 V08's notice preview lives in `plan-price-change-notice.e2e-spec.ts`,
 * beside the notices it predicts.)
 *
 * Every new read or write is checked for who may NOT use it as well as for
 * what it does: another customer's ticket or order answers 404, a
 * non-Platform-Owner 403, an anonymous caller 401.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedAcademyStudent,
  seedActiveSubscriptionForOrg,
  seedAssignment,
  seedCourse,
  seedCourseInstructor,
  seedOrganizationWithOwner,
  seedPaymentCollectionMode,
  seedPaymentMethod,
  seedQuiz,
} from './utils/db-admin';
import { slugSuffix } from './utils/slug-suffix';

jest.setTimeout(120000);

const PASSWORD = 'correct-horse-battery';
const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface Account {
  readonly email: string;
  readonly userId: string;
  readonly token: string;
}

describe('UX audit backend gaps (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let platform: Account;

  const http = () => request(app.getHttpServer());
  const as = (token: string) => ({
    get: (url: string) => http().get(url).set('Authorization', `Bearer ${token}`),
    post: (url: string, body: object = {}) =>
      http().post(url).set('Authorization', `Bearer ${token}`).send(body),
    patch: (url: string, body: object) =>
      http().patch(url).set('Authorization', `Bearer ${token}`).send(body),
  });

  async function signIn(email: string): Promise<Account> {
    const response = await http()
      .post('/auth/sign-in')
      .send({ email, password: PASSWORD })
      .expect(200);
    return {
      email,
      userId: response.body.user.id as string,
      token: response.body.accessToken as string,
    };
  }

  async function account(label: string, name = label): Promise<Account> {
    await flushRateLimitKeys();
    const email = uniqueTestEmail(label);
    await http()
      .post('/auth/register')
      .send({ name, email, password: PASSWORD })
      .expect(201);
    return signIn(email);
  }

  beforeAll(async () => {
    const testApp = await createTestApp({ fieldViolations: true });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    platform = await account('gaps-platform', 'Rania Platform');
    await admin.user.update({
      where: { id: platform.userId },
      data: { isPlatformOwner: true },
    });
    platform = await signIn(platform.email);
  });

  afterAll(async () => {
    // The payment-method and add-on catalogs are global: leave nothing this
    // suite created offered to customers of the shared database.
    await admin.paymentMethod.updateMany({
      where: {
        OR: [{ key: { startsWith: 'gaps-' } }, { displayName: 'InstaPay (gaps)' }],
      },
      data: { enabled: false },
    });
    await admin.addOn.updateMany({
      where: { key: { startsWith: 'gaps-addon-' } },
      data: { catalogStatus: 'draft' },
    });
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  // ---------------------------------------------------------------------
  // B5 V35 — closing my own support ticket
  // ---------------------------------------------------------------------
  describe('B5 V35 — a customer closes their own ticket', () => {
    async function requesterWithTicket(label: string) {
      const requester = await account(label);
      const org = await seedOrganizationWithOwner(
        admin,
        requester.userId,
        `${label}-org`,
      );
      const created = await as(requester.token)
        .post(`/organizations/${org.id}/support-cases`, {
          subject: 'Cannot upload a video',
          description: 'It fails at 99%.',
        })
        .expect(201);
      return { requester, org, caseId: created.body.id as string };
    }

    it('closes the ticket, records it like any status change, and is idempotent', async () => {
      const { requester, caseId } = await requesterWithTicket('gaps-close');

      const closed = await as(requester.token)
        .post(`/support-cases/mine/${caseId}/close`)
        .expect(200);
      expect(closed.body.status).toBe('closed');
      expect(closed.body.messages).toHaveLength(1);

      const audits = await admin.auditLogEntry.findMany({
        where: { targetId: caseId, action: 'support_case.status_changed' },
      });
      expect(audits).toHaveLength(1);
      expect(audits[0].actorUserId).toBe(requester.userId);
      expect(audits[0].context).toMatchObject({
        status: 'closed',
        closedBy: 'requester',
      });

      // Again: 200, unchanged, nothing recorded twice.
      const again = await as(requester.token)
        .post(`/support-cases/mine/${caseId}/close`)
        .expect(200);
      expect(again.body.status).toBe('closed');
      expect(
        await admin.auditLogEntry.count({
          where: { targetId: caseId, action: 'support_case.status_changed' },
        }),
      ).toBe(1);

      // A closed ticket takes no more replies (the existing rule).
      const reply = await as(requester.token)
        .post(`/support-cases/mine/${caseId}/messages`, { body: 'One more thing' })
        .expect(409);
      expect(reply.body.error.messageKey).toBe('errors.support.caseClosed');
    });

    it('changes only the status — the subject and requester stay as they were', async () => {
      const { requester, caseId } = await requesterWithTicket('gaps-close-scope');
      const before = await admin.supportCase.findUniqueOrThrow({ where: { id: caseId } });
      await as(requester.token).post(`/support-cases/mine/${caseId}/close`).expect(200);
      const after = await admin.supportCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(after).toMatchObject({
        status: 'closed',
        subject: before.subject,
        requesterEmail: before.requesterEmail,
        requesterName: before.requesterName,
        organizationId: before.organizationId,
      });
      expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
        before.updatedAt.getTime(),
      );
    });

    it('someone else — even a colleague in the same organization — gets 404; anonymous 401', async () => {
      const { requester, org, caseId } = await requesterWithTicket('gaps-close-iso');
      const stranger = await account('gaps-close-stranger');
      await as(stranger.token).post(`/support-cases/mine/${caseId}/close`).expect(404);

      // A member of the same organization is still not the requester.
      const colleague = await account('gaps-close-colleague');
      await admin.organizationMembership.create({
        data: { organizationId: org.id, userId: colleague.userId, role: 'member' },
      });
      await as(colleague.token).post(`/support-cases/mine/${caseId}/close`).expect(404);

      await http().post(`/support-cases/mine/${caseId}/close`).expect(401);
      await as(requester.token)
        .post('/support-cases/mine/00000000-0000-4000-8000-000000000000/close')
        .expect(404);

      const row = await admin.supportCase.findUniqueOrThrow({ where: { id: caseId } });
      expect(row.status).toBe('open');
    });
  });

  // ---------------------------------------------------------------------
  // B5/B8 — Arabic names for the Platform-managed catalog
  // ---------------------------------------------------------------------
  describe('B5/B8 — Arabic catalog names', () => {
    const INSTAPAY = {
      displayName: 'InstaPay (gaps)',
      description: 'Instant transfer',
      displayNameAr: 'إنستاباي',
      descriptionAr: 'تحويل فوري',
      enabled: true,
      instructions: {
        accountName: 'Atlas',
        instructions: 'Send the exact amount.',
        referenceInstructions: 'Use your Checkout ID.',
        instapayAddress: `gaps${Math.random().toString(36).slice(2, 8)}@instapay`,
      },
    };

    it('a payment method keeps its Arabic name and description; customers read them; blank clears', async () => {
      const created = await as(platform.token)
        .post('/platform-payment-methods/instapay', INSTAPAY)
        .expect(201);
      expect(created.body).toMatchObject({
        displayName: 'InstaPay (gaps)',
        displayNameAr: 'إنستاباي',
        descriptionAr: 'تحويل فوري',
      });

      const owner = await account('gaps-methods-owner');
      // The catalog is shared by every suite on this database: page through it.
      let listed: Record<string, unknown> | undefined;
      for (let page = 1; !listed; page += 1) {
        const catalog = await as(owner.token)
          .get(`/payment-methods?page=${page}&pageSize=100`)
          .expect(200);
        listed = (catalog.body.items as { id: string }[]).find(
          (method) => method.id === created.body.id,
        );
        if (page >= catalog.body.pagination.totalPages) break;
      }
      expect(listed).toMatchObject({
        displayNameAr: 'إنستاباي',
        descriptionAr: 'تحويل فوري',
      });

      const cleared = await as(platform.token)
        .patch(`/platform-payment-methods/${created.body.id}`, {
          displayNameAr: '  ',
          enabled: false,
        })
        .expect(200);
      expect(cleared.body.displayNameAr).toBeUndefined();
      expect(cleared.body.descriptionAr).toBe('تحويل فوري');

      const tooLong = await as(platform.token)
        .patch(`/platform-payment-methods/${created.body.id}`, {
          displayNameAr: 'ا'.repeat(81),
        })
        .expect(400);
      expect(JSON.stringify(tooLong.body)).toContain('displayNameAr');
    });

    it('an add-on gets an Arabic name through the console; the store and checkout carry it', async () => {
      const key = `gaps-addon-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const addOn = await admin.addOn.create({
        data: {
          key,
          name: 'Certificates (gaps)',
          description: 'Issue certificates',
          effect: { type: 'feature', featureKey: 'certificates' },
          catalogStatus: 'published',
          pricing: { amount: 100, currency: 'EGP', billingCycle: 'monthly' },
        },
      });

      const outsider = await account('gaps-addon-outsider');
      await as(outsider.token)
        .patch(`/platform-add-ons/${key}/arabic-text`, {
          nameAr: 'x',
          descriptionAr: '',
          expectedVersion: 0,
        })
        .expect(403);
      await http()
        .patch(`/platform-add-ons/${key}/arabic-text`)
        .send({ nameAr: 'x', descriptionAr: '', expectedVersion: 0 })
        .expect(401);

      const updated = await as(platform.token)
        .patch(`/platform-add-ons/${key}/arabic-text`, {
          nameAr: ' الشهادات ',
          descriptionAr: 'إصدار الشهادات',
          expectedVersion: addOn.version,
        })
        .expect(200);
      expect(updated.body).toMatchObject({
        key,
        nameAr: 'الشهادات',
        descriptionAr: 'إصدار الشهادات',
        version: addOn.version + 1,
      });
      expect(
        await admin.auditLogEntry.count({
          where: { targetId: addOn.id, action: 'add_on.arabic_text_changed' },
        }),
      ).toBe(1);

      // A stale version is refused, not silently overwritten.
      await as(platform.token)
        .patch(`/platform-add-ons/${key}/arabic-text`, {
          nameAr: 'قديم',
          descriptionAr: '',
          expectedVersion: addOn.version,
        })
        .expect(409);

      // The customer store (GET /add-ons) carries it.
      const owner = await account('gaps-addon-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'gaps-addon-org');
      await seedActiveSubscriptionForOrg(admin, org.id, 'gaps-addon');
      const store = await as(owner.token).get('/add-ons').expect(200);
      const listed = (store.body as { key: string }[]).find((row) => row.key === key);
      expect(listed).toMatchObject({
        nameAr: 'الشهادات',
        descriptionAr: 'إصدار الشهادات',
      });

      // So does the academy add-ons store (`…/add-ons/catalog`).
      const academyStore = await as(owner.token)
        .get(`/organizations/${org.id}/add-ons/catalog`)
        .expect(200);
      expect(
        (academyStore.body as { key: string }[]).find((row) => row.key === key),
      ).toMatchObject({ nameAr: 'الشهادات', descriptionAr: 'إصدار الشهادات' });

      // A checkout for it freezes the Arabic name beside the English one.
      const checkout = await as(owner.token)
        .post(`/organizations/${org.id}/checkouts`, {
          target: { type: 'add_on', addOnKey: key },
          billingCycle: 'monthly',
          idempotencyKey: `gaps-addon-${Math.random().toString(36).slice(2)}`,
        })
        .expect(201);
      expect(checkout.body.snapshot).toMatchObject({
        displayName: 'Certificates (gaps)',
        displayNameAr: 'الشهادات',
      });

      // Blank clears it: the English name shows again.
      const cleared = await as(platform.token)
        .patch(`/platform-add-ons/${key}/arabic-text`, {
          nameAr: '',
          descriptionAr: '',
          expectedVersion: addOn.version + 1,
        })
        .expect(200);
      expect(cleared.body).toMatchObject({ nameAr: null, descriptionAr: null });
    });
  });

  // ---------------------------------------------------------------------
  // B6 V17 / V06 — review list filters and the grader's name
  // ---------------------------------------------------------------------
  describe('B6 — review filters and grader name', () => {
    async function teachingFixture(label: string) {
      const owner = await account(`${label}-owner`);
      const instructor = await account(`${label}-instr`, 'Hana Instructor');
      const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
      await seedActiveSubscriptionForOrg(admin, org.id, label);
      const academy = await seedAcademy(admin, org.id, `${label}-academy`);
      const course = await seedCourse(
        admin,
        academy.id,
        `${label}-course-${Date.now()}`,
        {
          status: 'published',
          visibility: 'public',
        },
      );
      await seedCourseInstructor(admin, course.id, instructor.userId);
      const quiz = await seedQuiz(admin, course.id, `${label} quiz`);
      return { owner, instructor, org, academy, course, quiz };
    }

    it('quiz attempts filter on the server, and the total counts the filtered rows', async () => {
      const { instructor, academy, course, quiz } = await teachingFixture('gaps-qf');
      const students = await Promise.all(
        ['Amal Zaki', 'Bassem Nour', 'Carla Haddad'].map(async (name, index) => {
          const student = await account(`gaps-qf-s${index}`, name);
          await seedAcademyStudent(admin, academy.id, student.userId);
          return student;
        }),
      );
      const attempt = (
        studentId: string,
        data: Partial<{
          status: 'submitted' | 'passed' | 'failed' | 'in_progress';
          gradingStatus: 'not_required' | 'pending' | 'graded';
          integrityFlagged: boolean;
          isLate: boolean;
        }>,
        attemptNumber = 1,
      ) =>
        admin.quizAttempt.create({
          data: {
            quizId: quiz.id,
            studentId,
            attemptNumber,
            status: data.status ?? 'submitted',
            gradingStatus: data.gradingStatus ?? 'not_required',
            integrityFlagged: data.integrityFlagged ?? false,
            isLate: data.isLate ?? false,
            submittedAt: new Date(),
          },
        });
      await attempt(students[0].userId, {
        status: 'submitted',
        gradingStatus: 'pending',
      });
      await attempt(students[0].userId, { status: 'passed', integrityFlagged: true }, 2);
      await attempt(students[1].userId, { status: 'failed', isLate: true });
      await attempt(students[2].userId, {
        status: 'submitted',
        gradingStatus: 'pending',
        isLate: true,
      });

      const list = (query: string) =>
        as(instructor.token)
          .get(`/instructor/courses/${course.id}/quizzes/${quiz.id}/attempts?${query}`)
          .expect(200);

      expect((await list('')).body.pagination.totalItems).toBe(4);

      const pending = await list('gradingStatus=pending');
      expect(pending.body.pagination.totalItems).toBe(2);
      expect(
        pending.body.items.every(
          (row: { gradingStatus: string }) => row.gradingStatus === 'pending',
        ),
      ).toBe(true);

      expect((await list('flagged=true')).body.pagination.totalItems).toBe(1);
      expect((await list('late=true')).body.pagination.totalItems).toBe(2);
      expect((await list('late=false&status=passed')).body.pagination.totalItems).toBe(1);
      expect((await list('search=bassem')).body.items).toEqual([
        expect.objectContaining({ studentName: 'Bassem Nour', status: 'failed' }),
      ]);

      // Paging applies to the filtered list: page 2 of the pending attempts.
      const page2 = await list('gradingStatus=pending&page=2&pageSize=1');
      expect(page2.body.items).toHaveLength(1);
      expect(page2.body.pagination).toMatchObject({
        page: 2,
        pageSize: 1,
        totalItems: 2,
      });

      // Validated, never ignored.
      for (const bad of [
        'status=bogus',
        'gradingStatus=ungraded',
        'flagged=yes',
        'unknown=1',
      ]) {
        await as(instructor.token)
          .get(`/instructor/courses/${course.id}/quizzes/${quiz.id}/attempts?${bad}`)
          .expect(400);
      }

      // Filters do not widen who may read: an outsider still gets nothing.
      const outsider = await account('gaps-qf-outsider');
      const refused = await as(outsider.token).get(
        `/instructor/courses/${course.id}/quizzes/${quiz.id}/attempts?gradingStatus=pending`,
      );
      expect([403, 404]).toContain(refused.status);
    });

    it('submissions filter by grading state, and a graded one names its grader', async () => {
      const { instructor, academy, course } = await teachingFixture('gaps-sf');
      const assignment = await seedAssignment(admin, course.id, 'gaps essay', {
        status: 'published',
      });
      const ids: string[] = [];
      for (const [index, name] of ['Dina Farouk', 'Eman Saleh'].entries()) {
        const student = await account(`gaps-sf-s${index}`, name);
        await seedAcademyStudent(admin, academy.id, student.userId);
        await as(student.token).post('/enrollments', { courseId: course.id }).expect(201);
        const submitted = await as(student.token)
          .post(`/courses/${course.id}/assignments/${assignment.id}/submission`, {
            response: `Answer from ${name}`,
          })
          .expect(201);
        ids.push(submitted.body.id as string);
      }

      const base = `/instructor/courses/${course.id}/assignments/${assignment.id}/submissions`;
      const graded = await as(instructor.token)
        .post(`${base}/${ids[0]}/grade`, { score: 92, feedback: 'Well argued.' })
        .expect(201);
      // The grade response, the detail and the list all name the grader.
      expect(graded.body.grade).toMatchObject({
        score: 92,
        gradedBy: instructor.userId,
        gradedByName: 'Hana Instructor',
      });
      expect(JSON.stringify(graded.body)).not.toContain(instructor.email);
      const detail = await as(instructor.token).get(`${base}/${ids[0]}`).expect(200);
      expect(detail.body.grade.gradedByName).toBe('Hana Instructor');

      const ungraded = await as(instructor.token)
        .get(`${base}?gradingStatus=ungraded`)
        .expect(200);
      expect(ungraded.body.items.map((row: { id: string }) => row.id)).toEqual([ids[1]]);
      expect(ungraded.body.pagination.totalItems).toBe(1);

      const gradedList = await as(instructor.token)
        .get(`${base}?gradingStatus=graded`)
        .expect(200);
      expect(gradedList.body.items).toEqual([
        expect.objectContaining({
          id: ids[0],
          grade: expect.objectContaining({ gradedByName: 'Hana Instructor' }),
        }),
      ]);

      const search = await as(instructor.token).get(`${base}?search=eman`).expect(200);
      expect(search.body.items.map((row: { id: string }) => row.id)).toEqual([ids[1]]);

      await as(instructor.token).get(`${base}?gradingStatus=pending`).expect(400);
    });
  });

  // ---------------------------------------------------------------------
  // B8 V01 + payer reference — subscription payment review
  // ---------------------------------------------------------------------
  describe('B8 — subscription proofs and the reviewer’s name', () => {
    async function subscriptionPaymentWithProof(label: string, payerReference?: string) {
      const owner = await account(`${label}-owner`);
      const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
      const plan = await admin.plan.create({
        data: {
          key: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: `${label} plan`,
          limits: {
            academies: 1,
            students: 50,
            instructors: 2,
            staff: 2,
            courses: 10,
            generalStorage: 5,
            videoStorage: 5,
          },
          features: { liveSessions: false },
          pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
        },
      });
      const method = await seedPaymentMethod(admin, `${label}-method`);
      const checkout = await as(owner.token)
        .post(`/organizations/${org.id}/checkouts`, {
          target: { type: 'plan_subscription', planKey: plan.key },
          billingCycle: 'monthly',
          idempotencyKey: `${label}-${Math.random().toString(36).slice(2)}`,
        })
        .expect(201);
      const payment = await as(owner.token)
        .post(`/organizations/${org.id}/payments`, {
          checkoutId: checkout.body.id,
          methodKey: method.key,
        })
        .expect(201);
      const proof = await as(owner.token)
        .patch(`/organizations/${org.id}/payments/${payment.body.id}/proof`, {
          fileData: PROOF_DATA_URL,
          fileName: 'receipt.png',
          mimeType: 'image/png',
          ...(payerReference !== undefined ? { payerReference } : {}),
        })
        .expect(200);
      return { owner, org, paymentId: payment.body.id as string, proof: proof.body };
    }

    it('a subscription proof keeps the payer reference, and the review search finds it', async () => {
      const reference = `TRX-${Math.random().toString(36).slice(2, 10).toUpperCase()}`;
      const { paymentId, proof } = await subscriptionPaymentWithProof(
        'gaps-ref',
        `  ${reference}  `,
      );
      expect(proof.proof.payerReference).toBe(reference);

      const detail = await as(platform.token).get(`/payments/${paymentId}`).expect(200);
      expect(detail.body.proof.payerReference).toBe(reference);

      const search = await as(platform.token)
        .get(`/payments?search=${reference.toLowerCase()}`)
        .expect(200);
      expect(search.body.items.map((row: { id: string }) => row.id)).toEqual([paymentId]);
    });

    it('refuses a payer reference over 120 characters, on its field', async () => {
      const owner = await account('gaps-ref-long');
      const org = await seedOrganizationWithOwner(
        admin,
        owner.userId,
        'gaps-ref-long-org',
      );
      const response = await as(owner.token)
        .patch(
          `/organizations/${org.id}/payments/00000000-0000-4000-8000-000000000000/proof`,
          {
            fileData: PROOF_DATA_URL,
            fileName: 'receipt.png',
            mimeType: 'image/png',
            payerReference: 'x'.repeat(121),
          },
        )
        .expect(400);
      expect(
        (response.body.error.violations as { field: string }[]).map(
          (violation) => violation.field,
        ),
      ).toContain('payerReference');
    });

    it('the Platform detail says who reviewed the payment, by name, and when', async () => {
      const { paymentId } = await subscriptionPaymentWithProof('gaps-reviewer');

      const before = await as(platform.token).get(`/payments/${paymentId}`).expect(200);
      expect(before.body.review).toBeUndefined();

      await as(platform.token)
        .post(`/payments/${paymentId}/reject`, {
          notes: 'The receipt shows a different amount.',
        })
        .expect(201);

      const after = await as(platform.token).get(`/payments/${paymentId}`).expect(200);
      expect(after.body.review).toEqual({
        status: 'rejected',
        reviewedAt: expect.any(String),
        reviewerName: 'Rania Platform',
      });
      expect(JSON.stringify(after.body)).not.toContain(platform.email);
    });
  });

  // ---------------------------------------------------------------------
  // B7 V12 — an order's payments, for the buyer
  // ---------------------------------------------------------------------
  describe('B7 V12 — listing my order’s payments', () => {
    it('the buyer sees their payments newest first; anyone else gets 404', async () => {
      const owner = await account('gaps-order-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'gaps-order-org');
      const academy = await seedAcademy(admin, org.id, 'gaps-order-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');
      const course = await seedCourse(admin, academy.id, `gaps order ${Date.now()}`, {
        status: 'published',
        visibility: 'public',
        pricingType: 'paid',
        pricingAmountMinorUnits: 4900n,
        pricingCurrency: 'USD',
      });
      await seedPaymentCollectionMode(admin, org.id, 'atlas_payments');
      await admin.organizationCommissionSettings.upsert({
        where: { organizationId: org.id },
        create: {
          organizationId: org.id,
          commissionMode: 'custom',
          customPercentageBasisPoints: 1000,
        },
        update: {},
      });
      const method = await seedPaymentMethod(admin, 'gaps-order-method');
      const buyer = await account('gaps-order-buyer');

      const order = await as(buyer.token)
        .post(`/courses/${course.id}/course-orders`, {
          idempotencyKey: `gaps-${slugSuffix()}`,
        })
        .expect(201);

      const empty = await as(buyer.token)
        .get(`/course-orders/${order.body.id}/payments`)
        .expect(200);
      expect(empty.body).toEqual([]);

      const payment = await as(buyer.token)
        .post(`/course-orders/${order.body.id}/payments`, { methodKey: method.key })
        .expect(201);
      await as(buyer.token)
        .patch(`/course-orders/${order.body.id}/payments/${payment.body.id}/proof`, {
          fileData: PROOF_DATA_URL,
          fileName: 'proof.png',
          payerReference: 'REF-123',
        })
        .expect(200);

      const listed = await as(buyer.token)
        .get(`/course-orders/${order.body.id}/payments`)
        .expect(200);
      expect(listed.body).toEqual([
        expect.objectContaining({
          id: payment.body.id,
          methodKey: method.key,
          reviewStatus: 'pending',
          proof: expect.objectContaining({ payerReference: 'REF-123' }),
        }),
      ]);

      const stranger = await account('gaps-order-stranger');
      await as(stranger.token)
        .get(`/course-orders/${order.body.id}/payments`)
        .expect(404);
      // Not even the academy's own owner: the order is the buyer's.
      await as(owner.token).get(`/course-orders/${order.body.id}/payments`).expect(404);
      await http().get(`/course-orders/${order.body.id}/payments`).expect(401);
    });
  });

  // ---------------------------------------------------------------------
  // B3 — the course price maximum on the server
  // ---------------------------------------------------------------------
  describe('B3 — course price maximum', () => {
    it('refuses a price above 1,000,000 with the form’s own message; accepts the maximum', async () => {
      const owner = await account('gaps-price-owner');
      const org = await seedOrganizationWithOwner(admin, owner.userId, 'gaps-price-org');
      await seedActiveSubscriptionForOrg(admin, org.id, 'gaps-price');
      const academy = await seedAcademy(admin, org.id, 'gaps-price-academy');
      await seedAcademyMember(admin, academy.id, owner.userId, 'owner');

      const create = (amount: number) =>
        as(owner.token).post(`/academies/${academy.id}/courses`, {
          title: `Priced ${amount}`,
          slug: `gaps-price-${slugSuffix()}`,
          visibility: 'public',
          pricing: { type: 'paid', amount, currency: 'EGP' },
        });

      const refused = await create(1_000_000.5).expect(400);
      expect(refused.body.error.violations).toEqual([
        {
          field: 'pricing.amount',
          messageKey: 'course:validation.priceTooHigh',
          values: { max: '1,000,000' },
        },
      ]);

      const accepted = await create(1_000_000).expect(201);
      expect(accepted.body.pricing).toMatchObject({ type: 'paid', amount: 1_000_000 });

      const patched = await as(owner.token)
        .patch(`/academies/${academy.id}/courses/${accepted.body.id}`, {
          pricing: { type: 'paid', amount: 2_000_000, currency: 'EGP' },
        })
        .expect(400);
      expect(patched.body.error.violations[0]).toMatchObject({
        field: 'pricing.amount',
        messageKey: 'course:validation.priceTooHigh',
      });
    });
  });
});
