/**
 * A dedicated, elevated-privilege Prisma connection for e2e test fixture
 * setup ONLY — connects with `DATABASE_URL` (the migration superuser),
 * never `APP_DATABASE_URL` (the restricted runtime role every actual
 * request uses). This is deliberate, not a workaround: the narrowed RLS
 * INSERT policies (see
 * `prisma/migrations/20260823184500_p2_narrow_insert_rls_policies`)
 * intentionally do not support "seed an arbitrary org+membership graph for
 * a test" through the runtime role — no more than a real onboarding flow
 * would. Fixture arrangement is exactly what an elevated/admin connection
 * is for; the SYSTEM UNDER TEST in every e2e spec remains the app's own
 * `PrismaService`, still connected as the restricted role throughout.
 */
import { PrismaClient } from '@prisma/client';

export function createAdminPrisma(): PrismaClient {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set for admin test fixture setup.');
  }
  return new PrismaClient({ datasources: { db: { url } } });
}

export async function seedOrganizationWithOwner(
  admin: PrismaClient,
  ownerId: string,
  slugLabel: string,
) {
  const org = await admin.organization.create({
    data: {
      name: slugLabel,
      slug: `${slugLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      ownerUserId: ownerId,
    },
  });
  await admin.organizationMembership.create({
    data: { organizationId: org.id, userId: ownerId, role: 'owner', isPrimary: true },
  });
  return org;
}

export async function seedMembership(
  admin: PrismaClient,
  organizationId: string,
  userId: string,
  role: string,
  isPrimary = false,
) {
  return admin.organizationMembership.create({
    data: { organizationId, userId, role, isPrimary },
  });
}
