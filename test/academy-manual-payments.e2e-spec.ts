/**
 * Academy Manual Payments (e2e) — an academy's OWN manual methods (bank
 * transfer, InstaPay, wallet), the learner paying the academy with proof,
 * and the Client Owner approving or rejecting it.
 *
 * What is protected here, end to end against the real database, RLS,
 * storage and outbox:
 *
 *   - configuration is per academy (A: bank + InstaPay, B: wallet only) and
 *     Client-Owner-only; details are validated server-side;
 *   - a learner is offered exactly their academy's enabled methods, pays the
 *     server's amount, and the method's details are frozen on the payment;
 *   - one open payment per order, one proof per review;
 *   - approve → payment succeeded, order paid, enrollment granted, ONE
 *     approval email, no Atlas ledger entry, audit row;
 *   - reject → no access, ONE rejection email carrying the reason, and the
 *     learner can pay again on the same order and be approved;
 *   - approve vs reject racing: exactly one wins, exactly one email;
 *   - another organization, a manager, a learner and the Platform Owner's
 *     queue never reach these payments; a learner sees only their own;
 *   - a payment to the academy is never self-refunded through Atlas.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrismaClient } from '@prisma/client';
import { createTestApp, uniqueTestEmail } from './utils/test-app';
import {
  createAdminPrisma,
  seedAcademy,
  seedAcademyMember,
  seedCourse,
  seedMembership,
  seedOrganizationWithOwner,
} from './utils/db-admin';
import { CommunicationsProcessor } from '../src/communications/queue/communications.processor';
import { CommunicationsScheduler } from '../src/communications/queue/communications.scheduler';
import { CommunicationDispatchService } from '../src/communications/services/communication-dispatch.service';
import { StubEmailProvider } from '../src/communications/providers/stub-email.provider';
import type { EmailSendInput } from '../src/identity/services/email-provider.interface';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';

jest.setTimeout(180000);

/** The outbox stays put for assertions; this suite dispatches on purpose. */
class InertCommunicationsProcessor {}
class InertCommunicationsScheduler {}

const PROOF_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const BANK = {
  bankName: 'National Bank of Egypt',
  branchName: 'Zamalek',
  accountName: 'Falcon Academy LLC',
  accountNumber: '1234 5678 9012',
  iban: 'EG380019000500000000263180002',
  instructions: 'Transfer the exact amount, then upload the receipt.',
  instructionsAr: 'حوّل المبلغ بالضبط ثم ارفع الإيصال.',
  referenceInstructions: 'Write your email in the transfer note.',
};
const INSTAPAY = {
  instapayAddress: 'Falcon.Academy@InstaPay',
  accountName: 'Falcon Academy',
  instructions: 'Send the amount by InstaPay.',
  referenceInstructions: 'Use your name as the reference.',
};
const WALLET = {
  walletProvider: 'vodafone_cash',
  walletNumber: '+20 10 1234 5678',
  accountName: 'Beta Academy',
  instructions: 'Send the amount to this Vodafone Cash wallet.',
  referenceInstructions: 'Send a screenshot of the confirmation.',
};

interface Session {
  userId: string;
  accessToken: string;
  email: string;
}

async function signUpAndSignIn(app: INestApplication, label: string): Promise<Session> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken, email };
}

describe('Academy manual payments (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;

  let owner: Session;
  let orgId: string;
  let academyA: string;
  let academyB: string;
  let courseA: { id: string; title: string };
  let courseB: { id: string; title: string };
  let otherOwner: Session;
  let otherAcademy: string;
  let manager: Session;

  const http = () => request(app.getHttpServer());
  const auth = (session: Session) => ({ Authorization: `Bearer ${session.accessToken}` });

  beforeAll(async () => {
    const testApp = await createTestApp({
      overrides: (builder) =>
        builder
          .overrideProvider(CommunicationsProcessor)
          .useClass(InertCommunicationsProcessor)
          .overrideProvider(CommunicationsScheduler)
          .useClass(InertCommunicationsScheduler),
    });
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    await flushRateLimitKeys();

    owner = await signUpAndSignIn(app, 'amp-owner');
    // The organization is deliberately left `unconfigured`: an academy's
    // own methods are enough to sell.
    const org = await seedOrganizationWithOwner(admin, owner.userId, 'amp-org');
    orgId = org.id;
    academyA = (await seedAcademy(admin, orgId, 'amp-academy-a')).id;
    academyB = (await seedAcademy(admin, orgId, 'amp-academy-b')).id;
    const paid = {
      status: 'published' as const,
      visibility: 'public' as const,
      pricingType: 'paid' as const,
      pricingAmountMinorUnits: 150000n,
      pricingCurrency: 'EGP',
    };
    const a = await seedCourse(admin, academyA, `Arabic Calligraphy ${Date.now()}`, paid);
    courseA = { id: a.id, title: a.title };
    const b = await seedCourse(admin, academyB, `Beta Robotics ${Date.now()}`, paid);
    courseB = { id: b.id, title: b.title };

    manager = await signUpAndSignIn(app, 'amp-manager');
    await seedMembership(admin, orgId, manager.userId, 'manager');
    await seedAcademyMember(admin, academyA, manager.userId, 'manager');

    otherOwner = await signUpAndSignIn(app, 'amp-other-owner');
    const otherOrg = await seedOrganizationWithOwner(
      admin,
      otherOwner.userId,
      'amp-other',
    );
    otherAcademy = (await seedAcademy(admin, otherOrg.id, 'amp-other-academy')).id;
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function order(student: Session, courseId: string, label: string) {
    const res = await http()
      .post(`/courses/${courseId}/course-orders`)
      .set(auth(student))
      .send({ idempotencyKey: `${label}-${Date.now()}-${Math.random()}` })
      .expect(201);
    return res.body as { id: string; academyId: string };
  }

  async function payAndSubmit(
    student: Session,
    orderId: string,
    methodKey: string,
    payerReference = 'TRX-1001',
  ) {
    const payment = await http()
      .post(`/course-orders/${orderId}/payments`)
      .set(auth(student))
      .send({ methodKey })
      .expect(201);
    const proof = await http()
      .patch(`/course-orders/${orderId}/payments/${payment.body.id}/proof`)
      .set(auth(student))
      .send({ fileData: PROOF_DATA_URL, fileName: 'receipt.png', payerReference })
      .expect(200);
    return proof.body as {
      id: string;
      reviewStatus: string;
      proof: { payerReference?: string };
    };
  }

  const outbox = (key: string, entityId: string) =>
    admin.communicationOutbox.findMany({ where: { key, entityId } });

  // -------------------------------------------------------------------------
  describe('configuration (Client Owner only, per academy)', () => {
    it('saves Academy A (bank + InstaPay) and Academy B (wallet only), normalised', async () => {
      const bank = await http()
        .put(`/academies/${academyA}/payment-methods/bank-transfer`)
        .set(auth(owner))
        .send({ enabled: true, instructions: BANK })
        .expect(200);
      expect(bank.body).toMatchObject({
        type: 'manual_bank_transfer',
        enabled: true,
        key: 'academy_manual_bank_transfer',
        instructions: {
          type: 'manual_bank_transfer',
          bankName: BANK.bankName,
          branchName: 'Zamalek',
          iban: BANK.iban,
          instructionsAr: BANK.instructionsAr,
        },
      });
      const instapay = await http()
        .put(`/academies/${academyA}/payment-methods/instapay`)
        .set(auth(owner))
        .send({ enabled: true, instructions: INSTAPAY })
        .expect(200);
      expect(instapay.body.instructions.instapayAddress).toBe('falcon.academy@instapay');

      const wallet = await http()
        .put(`/academies/${academyB}/payment-methods/wallet`)
        .set(auth(owner))
        .send({ enabled: true, instructions: WALLET })
        .expect(200);
      expect(wallet.body.instructions.walletNumber).toBe('01012345678');

      const listA = await http()
        .get(`/academies/${academyA}/payment-methods`)
        .set(auth(owner))
        .expect(200);
      expect(listA.body.map((m: { type: string }) => m.type)).toEqual([
        'manual_bank_transfer',
        'manual_instapay',
      ]);
      const listB = await http()
        .get(`/academies/${academyB}/payment-methods`)
        .set(auth(owner))
        .expect(200);
      expect(listB.body.map((m: { type: string }) => m.type)).toEqual([
        'manual_wallet_transfer',
      ]);

      const audit = await admin.auditLogEntry.count({
        where: { action: 'academy.payment_method.saved', academyId: academyA },
      });
      expect(audit).toBe(2);
    });

    it('refuses invalid or missing details', async () => {
      await http()
        .put(`/academies/${academyB}/payment-methods/bank-transfer`)
        .set(auth(owner))
        .send({ enabled: true, instructions: { ...BANK, iban: 'NOT-AN-IBAN' } })
        .expect(400);
      await http()
        .put(`/academies/${academyB}/payment-methods/instapay`)
        .set(auth(owner))
        .send({ enabled: true })
        .expect(400);
      await http()
        .put(`/academies/${academyB}/payment-methods/instapay`)
        .set(auth(owner))
        .send({ enabled: true, instructions: { ...INSTAPAY, accountName: '   ' } })
        .expect(400);
      await http()
        .put(`/academies/${academyB}/payment-methods/wallet`)
        .set(auth(owner))
        .send({ instructions: { ...WALLET, walletNumber: '12345' } })
        .expect(400);
      await http()
        .put(`/academies/${academyB}/payment-methods/wallet`)
        .set(auth(owner))
        .send({ enabled: true, provider: 'atlas_manual' })
        .expect(400);
    });

    it('refuses a manager, another organization’s owner and a learner', async () => {
      await http()
        .get(`/academies/${academyA}/payment-methods`)
        .set(auth(manager))
        .expect(403);
      await http()
        .put(`/academies/${academyA}/payment-methods/bank-transfer`)
        .set(auth(manager))
        .send({ enabled: false })
        .expect(403);
      const other = await http()
        .get(`/academies/${academyA}/payment-methods`)
        .set(auth(otherOwner));
      expect([403, 404]).toContain(other.status);
      const learner = await signUpAndSignIn(app, 'amp-cfg-learner');
      const asLearner = await http()
        .get(`/academies/${academyA}/payment-methods`)
        .set(auth(learner));
      expect([403, 404]).toContain(asLearner.status);
    });

    it('a tenant context of another organization can neither read nor write the rows (RLS)', async () => {
      const tenancy = app.get(TenancyContextService, { strict: false });
      const otherOrgId = (
        await admin.academy.findUniqueOrThrow({ where: { id: otherAcademy } })
      ).organizationId;
      const seen = await tenancy.runInTenantContext(otherOrgId, (tx) =>
        tx.academyPaymentMethod.findMany({ where: { academyId: academyA } }),
      );
      expect(seen).toEqual([]);
      await expect(
        tenancy.runInTenantContext(otherOrgId, (tx) =>
          tx.academyPaymentMethod.create({
            data: {
              academyId: academyA,
              organizationId: orgId,
              type: 'manual_wallet_transfer',
              instructions: { type: 'manual_wallet_transfer' },
            },
          }),
        ),
      ).rejects.toThrow();
      // Nor can a tenant attach a method to an academy of another organization.
      await expect(
        tenancy.runInTenantContext(otherOrgId, (tx) =>
          tx.academyPaymentMethod.create({
            data: {
              academyId: academyA,
              organizationId: otherOrgId,
              type: 'manual_wallet_transfer',
              instructions: { type: 'manual_wallet_transfer' },
            },
          }),
        ),
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  describe('learner checkout', () => {
    it('offers each academy exactly its own enabled methods, with their instructions', async () => {
      const learner = await signUpAndSignIn(app, 'amp-co-learner');
      const oa = await order(learner, courseA.id, 'amp-co-a');
      const methodsA = await http()
        .get(`/course-orders/${oa.id}/payment-methods`)
        .set(auth(learner))
        .expect(200);
      expect(methodsA.body.map((m: { key: string }) => m.key)).toEqual([
        'academy_manual_bank_transfer',
        'academy_manual_instapay',
      ]);
      expect(methodsA.body[0]).toMatchObject({
        provider: 'academy_manual',
        manualInstructions: {
          accountNumber: BANK.accountNumber,
          bankName: BANK.bankName,
        },
      });

      const ob = await order(learner, courseB.id, 'amp-co-b');
      const methodsB = await http()
        .get(`/course-orders/${ob.id}/payment-methods`)
        .set(auth(learner))
        .expect(200);
      expect(methodsB.body.map((m: { key: string }) => m.key)).toEqual([
        'academy_manual_wallet_transfer',
      ]);

      // Academy B does not take bank transfers: refused, not silently accepted.
      await http()
        .post(`/course-orders/${ob.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_bank_transfer' })
        .expect(404);
    });

    it('hides a disabled method and accepts it nowhere', async () => {
      await http()
        .put(`/academies/${academyA}/payment-methods/instapay`)
        .set(auth(owner))
        .send({ enabled: false })
        .expect(200);
      try {
        const learner = await signUpAndSignIn(app, 'amp-dis-learner');
        const o = await order(learner, courseA.id, 'amp-dis');
        const methods = await http()
          .get(`/course-orders/${o.id}/payment-methods`)
          .set(auth(learner))
          .expect(200);
        expect(methods.body.map((m: { key: string }) => m.key)).toEqual([
          'academy_manual_bank_transfer',
        ]);
        await http()
          .post(`/course-orders/${o.id}/payments`)
          .set(auth(learner))
          .send({ methodKey: 'academy_manual_instapay' })
          .expect(404);
      } finally {
        await http()
          .put(`/academies/${academyA}/payment-methods/instapay`)
          .set(auth(owner))
          .send({ enabled: true })
          .expect(200);
      }
    });

    it('takes the amount from the server, freezes the details and takes no commission', async () => {
      const learner = await signUpAndSignIn(app, 'amp-amt-learner');
      const o = await order(learner, courseA.id, 'amp-amt');
      const payment = await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_bank_transfer' })
        .expect(201);
      expect(payment.body).toMatchObject({
        provider: 'academy_manual',
        money: { amountMinorUnits: 150000, currency: 'EGP' },
        status: 'pending',
        reviewStatus: 'not_required',
        paymentCollectionModeSnapshot: 'academy_manual',
        instructions: { accountNumber: BANK.accountNumber },
      });
      expect(payment.body.commission).toBeUndefined();
      // A client-sent amount is not even accepted by the contract.
      await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_bank_transfer', amountMinorUnits: 1 })
        .expect(400);

      // Choosing the same method again is the same payment; switching
      // methods cancels the proof-less one — never two open payments.
      const again = await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_bank_transfer' })
        .expect(201);
      expect(again.body.id).toBe(payment.body.id);
      const switched = await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_instapay' })
        .expect(201);
      expect(switched.body.id).not.toBe(payment.body.id);
      const rows = await admin.payment.findMany({ where: { courseOrderId: o.id } });
      expect(rows.filter((p) => p.status === 'pending')).toHaveLength(1);
      expect(rows.find((p) => p.id === payment.body.id)!.status).toBe('cancelled');

      // Editing the method later never changes what this payer was shown.
      const stored = await admin.payment.findUniqueOrThrow({
        where: { id: switched.body.id },
      });
      expect(stored.instructionsSnapshot).toMatchObject({
        instapayAddress: 'falcon.academy@instapay',
      });
      expect(stored.commissionAmountMinorUnits).toBeNull();
    });

    it('refuses a second proof while under review and a new payment while one is reviewed', async () => {
      const learner = await signUpAndSignIn(app, 'amp-dup-learner');
      const o = await order(learner, courseA.id, 'amp-dup');
      const submitted = await payAndSubmit(learner, o.id, 'academy_manual_bank_transfer');
      expect(submitted.reviewStatus).toBe('pending');
      expect(submitted.proof.payerReference).toBe('TRX-1001');

      await http()
        .patch(`/course-orders/${o.id}/payments/${submitted.id}/proof`)
        .set(auth(learner))
        .send({ fileData: PROOF_DATA_URL, fileName: 'again.png' })
        .expect(409);
      await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_instapay' })
        .expect(409);
    });

    it('refuses a proof that is not PNG, JPEG or PDF', async () => {
      const learner = await signUpAndSignIn(app, 'amp-type-learner');
      const o = await order(learner, courseA.id, 'amp-type');
      const payment = await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_bank_transfer' })
        .expect(201);
      await http()
        .patch(`/course-orders/${o.id}/payments/${payment.body.id}/proof`)
        .set(auth(learner))
        .send({
          fileData: `data:image/png;base64,${Buffer.from('<svg/>').toString('base64')}`,
          fileName: 'fake.png',
        })
        .expect(409);
    });
  });

  // -------------------------------------------------------------------------
  describe('review: approve', () => {
    it('grants access, emails the learner once, writes no ledger entry', async () => {
      const learner = await signUpAndSignIn(app, 'amp_ok_learner');
      const o = await order(learner, courseA.id, 'amp-ok');
      const submitted = await payAndSubmit(
        learner,
        o.id,
        'academy_manual_bank_transfer',
        'NBE-777',
      );

      // The Client Owner was told there is a payment to review.
      const work = await admin.communicationOutbox.findMany({
        where: { key: 'academy.payment.submitted', recipientUserId: owner.userId },
      });
      expect(
        work.some(
          (row) => (row.values as { paymentId?: string }).paymentId === submitted.id,
        ),
      ).toBe(true);

      const list = await http()
        .get(`/academies/${academyA}/course-payments`)
        .query({ reviewStatus: 'pending' })
        .set(auth(owner))
        .expect(200);
      const row = list.body.items.find((p: { id: string }) => p.id === submitted.id);
      expect(row).toMatchObject({
        reviewStatus: 'pending',
        methodType: 'manual_bank_transfer',
        course: { title: courseA.title },
        proof: { payerReference: 'NBE-777', mimeType: 'image/png' },
      });
      expect(row.learner.maskedEmail).not.toBe(learner.email);
      expect(list.body.counts.pending).toBeGreaterThanOrEqual(1);

      // Search by the payer's reference.
      const found = await http()
        .get(`/academies/${academyA}/course-payments`)
        .query({ search: 'NBE-777' })
        .set(auth(owner))
        .expect(200);
      expect(found.body.items.map((p: { id: string }) => p.id)).toEqual([submitted.id]);

      // Search by the exact address, in any case — it carries underscores,
      // which a LIKE-escaped comparison would never match.
      const byEmail = await http()
        .get(`/academies/${academyA}/course-payments`)
        .query({ search: learner.email.toUpperCase() })
        .set(auth(owner))
        .expect(200);
      expect(byEmail.body.items.map((p: { id: string }) => p.id)).toEqual([submitted.id]);

      const detail = await http()
        .get(`/academies/${academyA}/course-payments/${submitted.id}`)
        .set(auth(owner))
        .expect(200);
      expect(detail.body.instructions).toMatchObject({
        accountNumber: BANK.accountNumber,
      });
      const file = await http()
        .get(`/academies/${academyA}/course-payments/${submitted.id}/proof/file`)
        .set(auth(owner))
        .expect(200);
      expect(file.headers['content-type']).toContain('image/png');

      const approved = await http()
        .post(`/academies/${academyA}/course-payments/${submitted.id}/approve`)
        .set(auth(owner))
        .send({})
        .expect(200);
      expect(approved.body).toMatchObject({
        status: 'succeeded',
        reviewStatus: 'approved',
        orderStatus: 'paid',
      });
      expect(approved.body.reviews[0]).toMatchObject({ status: 'approved' });

      const enrollment = await admin.enrollment.findFirstOrThrow({
        where: { studentId: learner.userId, courseId: courseA.id },
      });
      expect(enrollment).toMatchObject({
        status: 'enrolled',
        accessSource: 'order',
        revokedAt: null,
      });
      expect(
        await admin.revenueLedgerEntry.count({ where: { courseOrderId: o.id } }),
      ).toBe(0);
      expect(
        await admin.auditLogEntry.count({
          where: { action: 'academy.course_payment.approved', targetId: submitted.id },
        }),
      ).toBe(1);

      const emails = await outbox('course.payment.approved', submitted.id);
      expect(emails).toHaveLength(1);
      expect(emails[0].recipientUserId).toBe(learner.userId);

      // Exactly once: a second approve or a reject after it is refused.
      await http()
        .post(`/academies/${academyA}/course-payments/${submitted.id}/approve`)
        .set(auth(owner))
        .send({})
        .expect(409);
      await http()
        .post(`/academies/${academyA}/course-payments/${submitted.id}/reject`)
        .set(auth(owner))
        .send({ reason: 'late' })
        .expect(409);
      expect(await outbox('course.payment.approved', submitted.id)).toHaveLength(1);
      expect(await outbox('course.payment.rejected', submitted.id)).toHaveLength(0);

      // The learner's history shows it, and the order is not self-refundable.
      const mine = await http().get('/course-payments').set(auth(learner)).expect(200);
      expect(mine.body.items[0]).toMatchObject({
        id: submitted.id,
        reviewStatus: 'approved',
        status: 'succeeded',
        canSubmitNewPayment: false,
      });
      const orderRead = await http()
        .get(`/course-orders/${o.id}`)
        .set(auth(learner))
        .expect(200);
      expect(orderRead.body.paidToAcademy).toBe(true);
      const refund = await http()
        .post(`/course-orders/${o.id}/refund`)
        .set(auth(learner))
        .send({ idempotencyKey: `amp-refund-${Date.now()}` })
        .expect(409);
      expect(refund.body.error.messageKey).toBe(
        'errors.courseOrder.refundContactAcademy',
      );
      const stillEnrolled = await admin.enrollment.findFirstOrThrow({
        where: { studentId: learner.userId, courseId: courseA.id },
      });
      expect(stillEnrolled.status).toBe('enrolled');
    });

    it('renders and sends the approval email to the learner', async () => {
      const learner = await signUpAndSignIn(app, 'amp-mail-ok');
      const o = await order(learner, courseA.id, 'amp-mail-ok');
      const submitted = await payAndSubmit(learner, o.id, 'academy_manual_instapay');
      await http()
        .post(`/academies/${academyA}/course-payments/${submitted.id}/approve`)
        .set(auth(owner))
        .send({})
        .expect(200);
      const [row] = await outbox('course.payment.approved', submitted.id);
      const sent = await dispatchCapturing(row.id);
      if (sent) {
        expect(sent.to).toBe(learner.email);
        expect(sent.subject).toContain(courseA.title);
        expect(sent.text).toContain('1500.00 EGP');
        expect(sent.text).toContain('InstaPay');
      }
    });
  });

  // -------------------------------------------------------------------------
  describe('review: reject, then pay again', () => {
    it('denies access, emails the reason once, and lets the learner pay again', async () => {
      const learner = await signUpAndSignIn(app, 'amp-no-learner');
      const o = await order(learner, courseA.id, 'amp-no');
      const first = await payAndSubmit(learner, o.id, 'academy_manual_bank_transfer');

      // The review took days: the order's payment window has long passed.
      await admin.courseOrder.update({
        where: { id: o.id },
        data: { expiresAt: new Date(Date.now() - 24 * 3600_000) },
      });
      // Still under review — answered "under review", never expired.
      await http()
        .post(`/course-orders/${o.id}/payments`)
        .set(auth(learner))
        .send({ methodKey: 'academy_manual_instapay' })
        .expect(409);
      expect(
        (await admin.courseOrder.findUniqueOrThrow({ where: { id: o.id } })).status,
      ).toBe('pending_payment');

      const rejected = await http()
        .post(`/academies/${academyA}/course-payments/${first.id}/reject`)
        .set(auth(owner))
        .send({ reason: 'The amount received was 1,000 EGP, not 1,500 EGP.' })
        .expect(200);
      expect(rejected.body).toMatchObject({
        status: 'failed',
        reviewStatus: 'rejected',
        reviewNotes: 'The amount received was 1,000 EGP, not 1,500 EGP.',
      });
      expect(
        await admin.enrollment.count({
          where: { studentId: learner.userId, courseId: courseA.id },
        }),
      ).toBe(0);

      const emails = await outbox('course.payment.rejected', first.id);
      expect(emails).toHaveLength(1);
      expect((emails[0].values as { reason?: string }).reason).toBe(
        'The amount received was 1,000 EGP, not 1,500 EGP.',
      );
      const sent = await dispatchCapturing(emails[0].id);
      if (sent) {
        expect(sent.to).toBe(learner.email);
        expect(sent.text).toContain('The amount received was 1,000 EGP, not 1,500 EGP.');
      }

      const mine = await http().get('/course-payments').set(auth(learner)).expect(200);
      expect(mine.body.items[0]).toMatchObject({
        id: first.id,
        reviewStatus: 'rejected',
        rejectionReason: 'The amount received was 1,000 EGP, not 1,500 EGP.',
        canSubmitNewPayment: true,
      });

      // The rejection reopened the order: pay again on the SAME order.
      const second = await payAndSubmit(learner, o.id, 'academy_manual_instapay');
      expect(second.id).not.toBe(first.id);
      await http()
        .post(`/academies/${academyA}/course-payments/${second.id}/approve`)
        .set(auth(owner))
        .send({})
        .expect(200);
      const enrollment = await admin.enrollment.findFirstOrThrow({
        where: { studentId: learner.userId, courseId: courseA.id },
      });
      expect(enrollment.status).toBe('enrolled');

      const after = await http().get('/course-payments').set(auth(learner)).expect(200);
      const firstRow = after.body.items.find((p: { id: string }) => p.id === first.id);
      expect(firstRow.canSubmitNewPayment).toBe(false);
    });

    it('rejects without a reason too', async () => {
      const learner = await signUpAndSignIn(app, 'amp-noreason');
      const o = await order(learner, courseB.id, 'amp-noreason');
      const p = await payAndSubmit(learner, o.id, 'academy_manual_wallet_transfer');
      const res = await http()
        .post(`/academies/${academyB}/course-payments/${p.id}/reject`)
        .set(auth(owner))
        .send({})
        .expect(200);
      expect(res.body.reviewStatus).toBe('rejected');
      expect(res.body.reviewNotes).toBeUndefined();
      const [email] = await outbox('course.payment.rejected', p.id);
      expect((email.values as { reason?: string }).reason).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  describe('race and isolation', () => {
    it('approve and reject at the same moment: exactly one wins, exactly one email', async () => {
      const learner = await signUpAndSignIn(app, 'amp-race');
      const o = await order(learner, courseA.id, 'amp-race');
      const p = await payAndSubmit(learner, o.id, 'academy_manual_bank_transfer');
      const [approve, reject, approveAgain] = await Promise.all([
        http()
          .post(`/academies/${academyA}/course-payments/${p.id}/approve`)
          .set(auth(owner))
          .send({}),
        http()
          .post(`/academies/${academyA}/course-payments/${p.id}/reject`)
          .set(auth(owner))
          .send({ reason: 'race' }),
        http()
          .post(`/academies/${academyA}/course-payments/${p.id}/approve`)
          .set(auth(owner))
          .send({}),
      ]);
      const statuses = [approve.status, reject.status, approveAgain.status].sort();
      expect(statuses).toEqual([200, 409, 409]);
      const approvals = await outbox('course.payment.approved', p.id);
      const rejections = await outbox('course.payment.rejected', p.id);
      expect(approvals.length + rejections.length).toBe(1);
      expect(await admin.paymentReview.count({ where: { paymentId: p.id } })).toBe(1);
    });

    it('keeps payments inside their academy and organization', async () => {
      const learner = await signUpAndSignIn(app, 'amp-iso');
      const o = await order(learner, courseA.id, 'amp-iso');
      const p = await payAndSubmit(learner, o.id, 'academy_manual_bank_transfer');

      // A sibling academy of the same organization does not list it.
      const sibling = await http()
        .get(`/academies/${academyB}/course-payments`)
        .set(auth(owner))
        .expect(200);
      expect(sibling.body.items.map((x: { id: string }) => x.id)).not.toContain(p.id);
      await http()
        .post(`/academies/${academyB}/course-payments/${p.id}/approve`)
        .set(auth(owner))
        .send({})
        .expect(404);

      // Another organization's owner, a manager and the learner cannot review.
      for (const [session, academy] of [
        [otherOwner, academyA],
        [otherOwner, otherAcademy],
        [manager, academyA],
        [learner, academyA],
      ] as const) {
        const res = await http()
          .post(`/academies/${academy}/course-payments/${p.id}/approve`)
          .set(auth(session))
          .send({});
        expect([403, 404]).toContain(res.status);
        const file = await http()
          .get(`/academies/${academy}/course-payments/${p.id}/proof/file`)
          .set(auth(session));
        expect([403, 404]).toContain(file.status);
      }

      // Another learner sees none of it.
      const stranger = await signUpAndSignIn(app, 'amp-iso-stranger');
      const theirs = await http().get('/course-payments').set(auth(stranger)).expect(200);
      expect(theirs.body.items).toEqual([]);
      await http()
        .get(`/course-orders/${o.id}/payments/${p.id}/proof/file`)
        .set(auth(stranger))
        .expect(404);

      // The Platform Owner's queue never carries academy payments.
      const platformOwner = await signUpAndSignIn(app, 'amp-platform');
      await admin.user.update({
        where: { id: platformOwner.userId },
        data: { isPlatformOwner: true },
      });
      const queue = await http()
        .get('/platform-course-order-payments')
        .query({ search: p.id })
        .set(auth(platformOwner))
        .expect(200);
      expect(queue.body.items).toEqual([]);
      await http()
        .post(`/platform-course-order-payments/${p.id}/approve`)
        .set(auth(platformOwner))
        .send({})
        .expect(404);

      // RLS: another organization's tenant context cannot change it.
      const tenancy = app.get(TenancyContextService, { strict: false });
      const otherOrgId = (
        await admin.academy.findUniqueOrThrow({ where: { id: otherAcademy } })
      ).organizationId;
      const changed = await tenancy.runInTenantContext(otherOrgId, (tx) =>
        tx.payment.updateMany({
          where: { id: p.id },
          data: { reviewStatus: 'approved' },
        }),
      );
      expect(changed.count).toBe(0);
      const still = await admin.payment.findUniqueOrThrow({ where: { id: p.id } });
      expect(still.reviewStatus).toBe('pending');
    });
  });

  /** Dispatches one outbox row with the email provider captured; `null` if another worker took it. */
  async function dispatchCapturing(outboxId: string): Promise<EmailSendInput | null> {
    const stub = app.get(StubEmailProvider, { strict: false });
    const sent: EmailSendInput[] = [];
    const spy = jest
      .spyOn(stub, 'send')
      .mockImplementation(async (input: EmailSendInput) => {
        sent.push(input);
        return { providerMessageId: `amp-${sent.length}`, provider: 'stub' };
      });
    try {
      const dispatcher = app.get(CommunicationDispatchService, { strict: false });
      const outcome = await dispatcher.dispatch(outboxId, { made: 0, max: 6 });
      if (outcome !== 'sent') return null;
    } finally {
      spy.mockRestore();
    }
    return sent[0] ?? null;
  }
});
