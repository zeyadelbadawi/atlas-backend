/**
 * Email normalization.
 *
 * See the `User` model's doc comment in `prisma/schema.prisma` for why this
 * exists instead of a Postgres `citext` column: every write and lookup path
 * must call this before the value ever reaches Prisma, or the "case
 * insensitive" guarantee silently breaks for that one call site.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}
