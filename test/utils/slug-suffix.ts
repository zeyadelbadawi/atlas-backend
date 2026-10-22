/**
 * A unique suffix for a slug or subdomain fixture. `Date.now()` alone is not
 * safe there: `isReservedSubdomain` reads digits as their look-alike letters
 * (`4tlas`), so a timestamp holding `47145` spells "atlas" and the API
 * refuses the slug — a rare failure that depends on the clock. Each digit
 * becomes a consonant instead: the same length and uniqueness as the
 * timestamp, with no vowel to spell a reserved word.
 */
const CONSONANTS = 'bcdfghjkmp';

export function slugSuffix(): string {
  return String(Date.now()).replace(/[0-9]/g, (d) => CONSONANTS[Number(d)]);
}
