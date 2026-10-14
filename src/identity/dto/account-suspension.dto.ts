/**
 * B0-SEC-07 — Platform Owner suspend / reinstate bodies. A suspension
 * always carries a reason (it is written to the audit trail).
 */
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendAccountDto {
  @IsNotEmpty()
  @IsString()
  @MaxLength(500)
  readonly reason!: string;
}

export class UnsuspendAccountDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  readonly reason?: string;
}
