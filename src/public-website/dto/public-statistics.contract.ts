/**
 * `GET public/websites/:academyId/statistics` response — Phase 6. Real,
 * live, Academy-scoped counts for `StatisticsSection`'s `metric`-driven
 * items (never revenue, never any other Academy's data). One aggregation
 * request serves every `metric` value `StatisticsSection` can reference.
 */
export interface PublicWebsiteStatisticsResponse {
  readonly courses: number;
  /**
   * Active learners — `null` unless an enabled Statistics section on one of
   * the academy's pages shows the `students` metric (the count is not public
   * otherwise).
   */
  readonly students: number | null;
  readonly instructors: number;
}
