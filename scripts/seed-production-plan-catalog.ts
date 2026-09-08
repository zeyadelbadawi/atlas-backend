/**
 * Production plan-catalog seed — Phase 7.
 *
 * Extracts exactly the 3 real, intended plans (`starter`/`growth`/
 * `enterprise`) already defined in `prisma/seed.ts`'s
 * `seedPlansAndSubscriptions`, without any of that script's dev-only fake
 * users/orgs/courses. Upserts by stable `key`, so this is safe to
 * re-run — never creates a duplicate, never touches an existing plan's
 * fields once created (`update: {}`, matching the source script's own
 * established pattern).
 *
 * Required because a brand-new Organization's automatic 3-day trial
 * (Decision 6) needs at least one active Plan to attach to — confirmed as
 * the actual root cause of a real production 500
 * (`errors.entitlement.noPlanAvailable`) via
 * `OrganizationSubscriptionBootstrapService`'s own doc comment: "an empty
 * `plans` catalog" is a real, anticipated platform-configuration gap the
 * migration history alone does not close.
 *
 * Usage: `DATABASE_URL=... ts-node -r tsconfig-paths/register scripts/seed-production-plan-catalog.ts`
 */
import { PrismaClient } from '@prisma/client';

function requireAdminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set (the same superuser connection Prisma migrations use).');
  }
  return url;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({ datasources: { db: { url: requireAdminDatabaseUrl() } } });
  try {
    await prisma.plan.upsert({
      where: { key: 'starter' },
      create: {
        key: 'starter',
        name: 'Starter',
        description: 'For a single academy just getting started.',
        status: 'active',
        displayOrder: 1,
        limits: {
          academies: 1,
          students: 20,
          instructors: 2,
          staff: 2,
          courses: 5,
          generalStorage: 2,
          videoStorage: 2,
        },
        features: {
          cms: true,
          seo: false,
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
        pricing: { amount: 0, currency: 'USD', billingCycle: 'monthly' },
      },
      update: {},
    });

    await prisma.plan.upsert({
      where: { key: 'growth' },
      create: {
        key: 'growth',
        name: 'Growth',
        description: 'For growing organizations running multiple academies.',
        status: 'active',
        displayOrder: 2,
        limits: {
          academies: 5,
          students: 200,
          instructors: 10,
          staff: 10,
          courses: 50,
          generalStorage: 20,
          videoStorage: 20,
        },
        features: {
          cms: true,
          seo: true,
          seoAdvanced: true,
          marketing: true,
          marketingAdvanced: false,
          analytics: true,
          analyticsAdvanced: false,
          customDomain: true,
          themes: true,
          multipleThemes: true,
          backup: false,
        },
        pricing: { amount: 79, currency: 'USD', billingCycle: 'monthly' },
      },
      update: {},
    });

    await prisma.plan.upsert({
      where: { key: 'enterprise' },
      create: {
        key: 'enterprise',
        name: 'Enterprise',
        description: 'Unlimited scale for large organizations.',
        status: 'active',
        displayOrder: 3,
        limits: {
          academies: 'unlimited',
          students: 'unlimited',
          instructors: 'unlimited',
          staff: 'unlimited',
          courses: 'unlimited',
          generalStorage: 'unlimited',
          videoStorage: 'unlimited',
        },
        features: {
          cms: true,
          seo: true,
          seoAdvanced: true,
          marketing: true,
          marketingAdvanced: true,
          analytics: true,
          analyticsAdvanced: true,
          customDomain: true,
          themes: true,
          multipleThemes: true,
          backup: true,
        },
        pricing: { amount: 299, currency: 'USD', billingCycle: 'monthly' },
      },
      update: {},
    });

    const count = await prisma.plan.count();
    console.log(`Plan catalog seeded. Total plans in database: ${count}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error('Failed to seed plan catalog:', error);
  process.exit(1);
});
