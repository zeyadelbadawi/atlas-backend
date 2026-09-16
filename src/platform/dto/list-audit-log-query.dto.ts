/**
 * `GET /audit-log` query (P58).
 *
 * Extends the shared `CollectionQueryDto` rather than replacing it, so
 * page/pageSize/sortBy/sortDirection/search keep behaving exactly as they
 * do on every other Atlas list. The additions are the operational filters
 * the audit log needs and never had — every one of them backed by a real
 * index (see `AuditLogEntryListFilter`).
 */
import { IsISO8601, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { CollectionQueryDto } from '../../common/dto/collection-query.dto';

export class ListAuditLogQueryDto extends CollectionQueryDto {
  /** Exact action, e.g. `plan.pricing_changed`. */
  @IsOptional()
  @IsString()
  @MaxLength(100)
  readonly action?: string;

  @IsOptional()
  @IsUUID()
  readonly actorUserId?: string;

  /** Exact entity type, e.g. `plan`, `course`, `support_case`. */
  @IsOptional()
  @IsString()
  @MaxLength(60)
  readonly targetType?: string;

  @IsOptional()
  @IsUUID()
  readonly organizationId?: string;

  @IsOptional()
  @IsUUID()
  readonly academyId?: string;

  /** Inclusive lower bound on `occurredAt`. */
  @IsOptional()
  @IsISO8601()
  readonly occurredFrom?: string;

  /** Inclusive upper bound on `occurredAt`. */
  @IsOptional()
  @IsISO8601()
  readonly occurredTo?: string;
}
