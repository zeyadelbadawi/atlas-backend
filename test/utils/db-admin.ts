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
import { PrismaClient, Prisma } from '@prisma/client';

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

/** P3 — mirrors `seedOrganizationWithOwner`'s rationale exactly, one level down. */
export async function seedAcademy(
  admin: PrismaClient,
  organizationId: string,
  slugLabel: string,
) {
  return admin.academy.create({
    data: {
      organizationId,
      name: slugLabel,
      slug: `${slugLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    },
  });
}

export async function seedAcademyMember(
  admin: PrismaClient,
  academyId: string,
  userId: string,
  role: 'owner' | 'administrator' | 'manager' | 'instructor' | 'staff' = 'owner',
) {
  return admin.academyMember.create({
    data: { academyId, userId, role },
  });
}

/** P4 — `plans`/`add_ons` are platform-owned (no RLS), but still seeded via the admin connection for consistency: there is no write endpoint for either in P4. */
export async function seedPlan(
  admin: PrismaClient,
  keyLabel: string,
  overrides: {
    limits?: Record<string, number | 'unlimited'>;
    features?: Record<string, boolean>;
    status?: 'active' | 'archived';
  } = {},
) {
  const key = `${keyLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.plan.create({
    data: {
      key,
      name: keyLabel,
      status: overrides.status ?? 'active',
      limits: overrides.limits ?? {
        academies: 2,
        students: 50,
        instructors: 5,
        staff: 5,
        courses: 20,
        generalStorage: 10,
        videoStorage: 10,
      },
      features: overrides.features ?? {
        cms: true,
        seo: true,
        seoAdvanced: false,
        marketing: false,
        marketingAdvanced: false,
        analytics: false,
        analyticsAdvanced: false,
        customDomain: false,
        themes: true,
        multipleThemes: false,
        backup: false,
      },
    },
  });
}

export async function seedAddOn(
  admin: PrismaClient,
  keyLabel: string,
  effect: Prisma.InputJsonValue,
  compatiblePlanKeys: readonly string[],
) {
  const key = `${keyLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.addOn.create({
    data: { key, name: keyLabel, effect, compatiblePlanKeys: [...compatiblePlanKeys] },
  });
}

/** P4 — `tenant_subscriptions` is organization-scoped and RLS-protected; seeded via the admin connection because no creation endpoint exists (same precedent as `seedOrganizationWithOwner`). */
export async function seedTenantSubscription(
  admin: PrismaClient,
  organizationId: string,
  planId: string,
  overrides: {
    status?:
      | 'trialing'
      | 'active'
      | 'past_due'
      | 'paused'
      | 'grace_period'
      | 'cancelled'
      | 'expired';
    trialEndsAt?: Date;
  } = {},
) {
  return admin.tenantSubscription.create({
    data: {
      organizationId,
      planId,
      status: overrides.status ?? 'trialing',
      trialEndsAt: overrides.trialEndsAt,
    },
  });
}

export async function seedTenantAddOn(
  admin: PrismaClient,
  organizationId: string,
  addOnId: string,
) {
  return admin.tenantAddOn.create({ data: { organizationId, addOnId } });
}

/** P5 — `courses`/`course_categories`/etc. are Academy-scoped and RLS-protected; seeded via the admin connection, mirroring `seedAcademy`'s own precedent. */
export async function seedCourseCategory(
  admin: PrismaClient,
  academyId: string,
  nameLabel: string,
) {
  const slug = `${nameLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.courseCategory.create({
    data: { academyId, name: nameLabel, slug },
  });
}

export async function seedCourse(
  admin: PrismaClient,
  academyId: string,
  titleLabel: string,
  overrides: {
    status?: 'draft' | 'published' | 'archived';
    visibility?: 'public' | 'private';
    categoryId?: string;
    pricingType?: 'free' | 'paid';
    pricingAmountMinorUnits?: bigint;
    pricingCurrency?: string;
  } = {},
) {
  const slug = `${titleLabel.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.course.create({
    data: {
      academyId,
      categoryId: overrides.categoryId,
      title: titleLabel,
      slug,
      status: overrides.status ?? 'draft',
      visibility: overrides.visibility ?? 'private',
      pricingType: overrides.pricingType ?? 'free',
      pricingAmountMinorUnits: overrides.pricingAmountMinorUnits,
      pricingCurrency: overrides.pricingCurrency,
    },
  });
}

export async function seedCourseSection(
  admin: PrismaClient,
  courseId: string,
  titleLabel: string,
  order: number,
) {
  return admin.courseSection.create({ data: { courseId, title: titleLabel, order } });
}

export async function seedCourseLesson(
  admin: PrismaClient,
  sectionId: string,
  courseId: string,
  titleLabel: string,
  order: number,
  overrides: {
    contentType?: 'text' | 'video' | 'file';
    status?: 'draft' | 'published';
  } = {},
) {
  return admin.courseLesson.create({
    data: {
      sectionId,
      courseId,
      title: titleLabel,
      order,
      contentType: overrides.contentType ?? 'text',
      status: overrides.status ?? 'draft',
    },
  });
}

export async function seedCourseInstructor(
  admin: PrismaClient,
  courseId: string,
  userId: string,
) {
  return admin.courseInstructor.create({ data: { courseId, userId } });
}
