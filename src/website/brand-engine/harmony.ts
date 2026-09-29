/**
 * Brand engine — harmony score (Theme 1 plan §F.4.2 step 8).
 *
 * MIRRORED MODULE — see `color-space.ts`.
 *
 * Reporting and ranking only: it never changes a colour and never rejects
 * a palette. 100 = no concerns; each concern costs points.
 */
import { hueDistance, tripletDeltaE, tripletToOklch } from './color-space';
import type { BrandRoleName, BrandRoles } from './palette.types';

/** Roles a visitor must be able to tell apart. */
const DISTINCT_ROLES: readonly BrandRoleName[] = [
  'cta',
  'secondary',
  'accent',
  'success',
  'warning',
  'error',
];
const MIN_DISTINGUISHABLE_DELTA_E = 0.08;

export function scoreHarmony(roles: BrandRoles): {
  score: number;
  indistinguishable: [BrandRoleName, BrandRoleName][];
} {
  const indistinguishable: [BrandRoleName, BrandRoleName][] = [];
  for (let i = 0; i < DISTINCT_ROLES.length; i += 1) {
    for (let j = i + 1; j < DISTINCT_ROLES.length; j += 1) {
      const a = DISTINCT_ROLES[i];
      const b = DISTINCT_ROLES[j];
      // The same colour on purpose (e.g. an Owner override) isn't a clash.
      if (roles[a] === roles[b]) continue;
      if (tripletDeltaE(roles[a], roles[b]) < MIN_DISTINGUISHABLE_DELTA_E) {
        indistinguishable.push([a, b]);
      }
    }
  }

  let penalty = indistinguishable.length * 10;

  // Hue relationships between the brand colours: analogous (≤ 40°) and
  // complementary / split-complementary (≥ 120°) read as intentional;
  // the band in between tends to clash.
  const chromatic = (['cta', 'secondary', 'accent'] as const)
    .map((role) => tripletToOklch(roles[role]))
    .filter((lch) => lch.C >= 0.03);
  for (let i = 0; i < chromatic.length; i += 1) {
    for (let j = i + 1; j < chromatic.length; j += 1) {
      const distance = hueDistance(chromatic[i].h, chromatic[j].h);
      if (distance > 40 && distance < 120) penalty += 5;
    }
  }

  // Chroma balance: an accent far duller than the lead can't do its job.
  const lead = tripletToOklch(roles.cta);
  const accent = tripletToOklch(roles.accent);
  if (lead.C >= 0.03 && accent.C < lead.C * 0.4) penalty += 5;

  return { score: Math.max(0, 100 - penalty), indistinguishable };
}
