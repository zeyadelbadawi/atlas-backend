/**
 * Academy Orders response contract — what an Organization Owner sees of
 * the course sales of ONE of their academies (`GET academies/:id/
 * course-orders[/:orderId]`).
 *
 * Deliberately a NEW, narrow shape rather than `CourseOrderResponse` (the
 * buyer's own receipt) or `CourseOrderPaymentResponse` (the Platform
 * Owner's review shape). Left out on purpose:
 *
 *   - `idempotencyKey` — the buyer's client-generated retry token.
 *   - manual-transfer instructions — the Platform's receiving bank, wallet
 *     and InstaPay details.
 *   - payment proofs (file, storage key, note) — the payer's private upload.
 *   - the Atlas commission snapshot — Platform-side pricing.
 *   - reviewer ids/notes and the refund's free-text reason.
 *   - the student's raw id and full email: a name and a masked email
 *     (`s•••@example.com`) are enough to recognise a buyer.
 */
import type {
  CourseOrder as PrismaCourseOrder,
  CourseOrderRefund as PrismaCourseOrderRefund,
  Payment as PrismaPayment,
} from '@prisma/client';
import type { MoneyResponse } from '../../billing/dto/checkout.contract';
import { maskEmail } from '../../identity/services/email-otp.service';

export interface AcademyCourseOrderPaymentSummary {
  readonly id: string;
  readonly status: PrismaPayment['status'];
  readonly reviewStatus: PrismaPayment['reviewStatus'];
  readonly methodType: PrismaPayment['methodType'];
  readonly providerReference?: string;
  readonly money: MoneyResponse;
  readonly createdAt: string;
}

export interface AcademyCourseOrderRefundSummary {
  readonly status: PrismaCourseOrderRefund['status'];
  readonly money: MoneyResponse;
  readonly requestedAt: string;
  readonly processedAt?: string;
}

export interface AcademyCourseOrderResponse {
  readonly id: string;
  readonly status: PrismaCourseOrder['status'];
  /** The price frozen on the order at purchase time (`snapshot.price`). */
  readonly money: MoneyResponse;
  readonly course: { readonly id: string; readonly title: string };
  readonly student: { readonly name: string; readonly maskedEmail: string };
  /** The most recent payment attempt, if any was ever made. */
  readonly latestPayment?: AcademyCourseOrderPaymentSummary;
  readonly paymentCount: number;
  readonly refund?: AcademyCourseOrderRefundSummary;
  readonly createdAt: string;
  readonly paidAt?: string;
  readonly expiresAt: string;
}

export interface AcademyCourseOrderDetailResponse extends AcademyCourseOrderResponse {
  /** Every payment attempt, newest first. */
  readonly payments: readonly AcademyCourseOrderPaymentSummary[];
}

/** Exactly the columns the mapper reads — the repository selects nothing more. */
export type AcademyCourseOrderRow = Pick<
  PrismaCourseOrder,
  'id' | 'status' | 'snapshot' | 'courseId' | 'createdAt' | 'paidAt' | 'expiresAt'
> & {
  readonly course: { readonly title: string } | null;
  readonly student: { readonly name: string; readonly email: string } | null;
  readonly payments: readonly Pick<
    PrismaPayment,
    | 'id'
    | 'status'
    | 'reviewStatus'
    | 'methodType'
    | 'providerReference'
    | 'amountMinorUnits'
    | 'currency'
    | 'createdAt'
  >[];
  readonly refund: Pick<
    PrismaCourseOrderRefund,
    'status' | 'amountMinorUnits' | 'currency' | 'requestedAt' | 'processedAt'
  > | null;
  readonly _count: { readonly payments: number };
};

interface OrderSnapshotShape {
  readonly course?: { readonly id?: string; readonly title?: string };
  readonly price?: {
    readonly amountMinorUnits?: number | string;
    readonly currency?: string;
  };
}

function toPaymentSummary(
  payment: AcademyCourseOrderRow['payments'][number],
): AcademyCourseOrderPaymentSummary {
  return {
    id: payment.id,
    status: payment.status,
    reviewStatus: payment.reviewStatus,
    methodType: payment.methodType,
    providerReference: payment.providerReference ?? undefined,
    money: {
      amountMinorUnits: Number(payment.amountMinorUnits),
      currency: payment.currency,
    },
    createdAt: payment.createdAt.toISOString(),
  };
}

export function toAcademyCourseOrderResponse(
  order: AcademyCourseOrderRow,
): AcademyCourseOrderResponse {
  const snapshot = (order.snapshot ?? {}) as OrderSnapshotShape;
  const latest = order.payments[0];
  return {
    id: order.id,
    status: order.status,
    money: {
      amountMinorUnits: Number(snapshot.price?.amountMinorUnits ?? 0),
      currency: snapshot.price?.currency ?? latest?.currency ?? '',
    },
    course: {
      id: order.courseId,
      // The frozen title is what the buyer agreed to; the live title is a
      // fallback for a malformed snapshot only.
      title: snapshot.course?.title ?? order.course?.title ?? '',
    },
    student: {
      name: order.student?.name ?? '',
      maskedEmail: order.student ? maskEmail(order.student.email) : '',
    },
    latestPayment: latest ? toPaymentSummary(latest) : undefined,
    paymentCount: order._count.payments,
    refund: order.refund
      ? {
          status: order.refund.status,
          money: {
            amountMinorUnits: Number(order.refund.amountMinorUnits),
            currency: order.refund.currency,
          },
          requestedAt: order.refund.requestedAt.toISOString(),
          processedAt: order.refund.processedAt?.toISOString(),
        }
      : undefined,
    createdAt: order.createdAt.toISOString(),
    paidAt: order.paidAt?.toISOString(),
    expiresAt: order.expiresAt.toISOString(),
  };
}

export function toAcademyCourseOrderDetailResponse(
  order: AcademyCourseOrderRow,
): AcademyCourseOrderDetailResponse {
  return {
    ...toAcademyCourseOrderResponse(order),
    payments: order.payments.map(toPaymentSummary),
  };
}
