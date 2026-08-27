/**
 * `POST course-orders/:id/refund` request — buyer-initiated, self-service
 * (this session's product direction: "customer-friendly full-refund
 * policy," no manual-review gate). `idempotencyKey` follows the same
 * "every financial mutation accepts and enforces a client-supplied
 * idempotency key" rule (master plan §10) every other financial mutation
 * in this codebase already follows.
 */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class RequestCourseOrderRefundDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(255)
  readonly idempotencyKey!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  readonly reason?: string;
}
