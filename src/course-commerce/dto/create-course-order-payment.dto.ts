/** `POST course-orders/:id/payments` request — mirrors `CreatePaymentDto`'s own shape (`methodKey` only; the buyer picks which registered payment method, the server resolves everything else — provider, commission, mode — from the order's Organization). */
import { IsNotEmpty, IsString } from 'class-validator';

export class CreateCourseOrderPaymentDto {
  @IsNotEmpty()
  @IsString()
  readonly methodKey!: string;
}
