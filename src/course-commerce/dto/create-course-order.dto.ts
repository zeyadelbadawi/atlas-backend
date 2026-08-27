/** `POST courses/:id/course-orders` request — no frontend contract exists for this (master plan §3/§21: Course Commerce is "genuinely new scope," not derived from an existing frontend type file), so this shape is designed directly from master plan §23's lifecycle rather than mirrored from a frontend payload type. Mirrors `CreateCheckoutDto`'s own idempotency-key shape, the closest real precedent. */
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

export class CreateCourseOrderDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly idempotencyKey!: string;
}
