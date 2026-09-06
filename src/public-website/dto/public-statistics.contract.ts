/**
 * `GET public/websites/:academyId/statistics` response — Phase 6. Real,
 * live, Academy-scoped counts for `StatisticsSection`'s `metric`-driven
 * items (never revenue, never any other Academy's data). One aggregation
 * request serves every `metric` value `StatisticsSection` can reference.
 */
export interface PublicWebsiteStatisticsResponse {
  readonly courses: number;
  readonly students: number;
  readonly instructors: number;
}
