/** `POST organizations/:id/payments` request — matches `CreatePaymentPayload` (`payment.types.ts`) exactly. */
import { IsNotEmpty, IsString } from 'class-validator';

export class CreatePaymentDto {
  @IsNotEmpty()
  @IsString()
  readonly checkoutId!: string;

  @IsNotEmpty()
  @IsString()
  readonly methodKey!: string;
}
