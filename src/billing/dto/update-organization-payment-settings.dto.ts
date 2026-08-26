/** `PATCH organizations/:id/payment-settings` request. */
import { IsIn } from 'class-validator';
import type { PaymentCollectionMode } from '@prisma/client';

const MODES: readonly PaymentCollectionMode[] = [
  'unconfigured',
  'atlas_payments',
  'organization_gateway',
];

export class UpdateOrganizationPaymentSettingsDto {
  @IsIn(MODES)
  readonly paymentCollectionMode!: PaymentCollectionMode;
}
