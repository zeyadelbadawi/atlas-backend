/**
 * Fills the fixed `enumerateDays(range)` bucket set against a sparse
 * `day -> value` map returned by a `GROUP BY` query — every chart point
 * the frontend renders must exist for every day in the selected range,
 * never silently missing a day just because nothing happened on it
 * (`AnalyticsLineChart` has no gap-handling of its own).
 */

/** A "flow" metric (e.g. daily revenue, daily active users) — a day with no rows is genuinely `0`. */
export function fillFlowSeries(
  days: readonly string[],
  byDay: Map<string, number>,
): number[] {
  return days.map((day) => byDay.get(day) ?? 0);
}

/**
 * A "stock"/cumulative metric (e.g. total users) — a day with no NEW rows
 * carries forward the previous day's running total, never resets to `0`.
 * `newCountsByDay` holds only the count of rows newly created ON each day
 * (not yet cumulative); `baseline` is the total that already existed
 * strictly before `days[0]`.
 */
export function fillCumulativeSeries(
  days: readonly string[],
  newCountsByDay: Map<string, number>,
  baseline: number,
): number[] {
  let running = baseline;
  return days.map((day) => {
    running += newCountsByDay.get(day) ?? 0;
    return running;
  });
}
