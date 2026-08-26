/** `POST organizations/:id/payments/intents` request — matches `{checkoutId}` (frontend `PaymentService.createPaymentIntent`) exactly. */
import { IsNotEmpty, IsString } from 'class-validator';

export class CreatePaymentIntentDto {
  @IsNotEmpty()
  @IsString()
  readonly checkoutId!: string;
}
