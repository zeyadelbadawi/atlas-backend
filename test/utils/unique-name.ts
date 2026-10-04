/**
 * W4 — organization names and academy names are unique platform-wide, and a
 * learner's name is unique inside each academy (`atlas_name_key`). The e2e
 * database persists between runs, so any fixture that CREATES a named
 * organization/academy (or admits a learner) must not reuse a fixed literal:
 * the second run would collide with the first run's row. `uniqueName` keeps
 * the readable label and appends a per-process, per-call suffix.
 */
let counter = 0;
const run = `${Date.now().toString(36)}${process.pid.toString(36)}`;

export function uniqueName(label: string): string {
  counter += 1;
  return `${label} ${run}${counter.toString(36)}`;
}
