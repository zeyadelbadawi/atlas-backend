/**
 * `GET academies/:id/activity` / `GET academies/:id/activity/:entryId` —
 * the Academy owner's activity log (Task 3).
 *
 * Backed by real `audit_log_entries` rows for THIS academy only
 * (`academy_id = :id`), restricted to the catalogue's tenant-visible actions
 * (`TENANT_VISIBLE_AUDIT_ACTIONS`) — sign-in telemetry and platform-operator
 * actions never appear. Keyset-paginated: `{ items, nextCursor }`, no total.
 *
 * The shapes are the shared tenant audit shapes; see
 * `TenantAuditLogEntryResponse` for the privacy rules (actor name only, no
 * emails, Atlas staff shown as "Atlas").
 */
export type {
  AuditLogCursorPage as AcademyActivityPageResponse,
  TenantAuditLogEntryResponse as AcademyActivityResponse,
  TenantAuditLogEntryDetailResponse as AcademyActivityDetailResponse,
} from '../../audit-log/dto/audit-log.contract';
