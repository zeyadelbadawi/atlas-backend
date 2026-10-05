/** Academy Manual Payments — the Client Owner's view of one academy method (settings page). */
import type { AcademyPaymentMethod } from '@prisma/client';
import type { ManualPaymentInstructionsResponse } from '../../billing/dto/payment-method.contract';
import { academyPaymentMethodKey } from '../../billing/utils/academy-payment-method.util';

export interface AcademyPaymentMethodResponse {
  readonly id: string;
  readonly academyId: string;
  readonly key: string;
  readonly type: AcademyPaymentMethod['type'];
  readonly enabled: boolean;
  readonly instructions: ManualPaymentInstructionsResponse;
  readonly displayOrder: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function toAcademyPaymentMethodResponse(
  method: AcademyPaymentMethod,
): AcademyPaymentMethodResponse {
  return {
    id: method.id,
    academyId: method.academyId,
    key: academyPaymentMethodKey(method.type),
    type: method.type,
    enabled: method.enabled,
    instructions: method.instructions as unknown as ManualPaymentInstructionsResponse,
    displayOrder: method.displayOrder,
    createdAt: method.createdAt.toISOString(),
    updatedAt: method.updatedAt.toISOString(),
  };
}
