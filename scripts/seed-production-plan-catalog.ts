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
 * Required because a brand-new Organization's trial (14 days since
 * B0-CAT-03; the policy row decides the length) needs at least one active Plan to attach to — confirmed as
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
    throw new Error(
      'DATABASE_URL must be set (the same superuser connection Prisma migrations use).',
    );
  }
  return url;
}

async function main(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: requireAdminDatabaseUrl() } },
  });
  try {
    // B0-CAT-03 — the owner-approved ladder (15 Oct 2026), the same values
    // as the catalog-ladder migration and `prisma/seed.ts`.
    const ladder = [
      {
        key: 'starter',
        tier: 'basic',
        displayOrder: 1,
        en: ['Teacher', 'For a teacher starting to sell courses online.'],
        ar: ['المعلّم', 'للمعلّم الذي يبدأ بيع كورساته أونلاين.'],
        limits: {
          academies: 1,
          students: 100,
          instructors: 3,
          staff: 3,
          courses: 20,
          generalStorage: 10,
          videoStorage: 30,
          videoStorageMinutes: 1200,
          recordedSessions: 3,
        },
        amount: 1190,
      },
      {
        key: 'growth',
        tier: 'growth',
        displayOrder: 2,
        en: [
          'Academy',
          'For an established teacher with assistants, or a small team under one brand.',
        ],
        ar: [
          'الأكاديمية',
          'للمعلّم الذي يعمل مع فريق مساعد، أو لفريق صغير تحت علامة واحدة.',
        ],
        limits: {
          academies: 1,
          students: 400,
          instructors: 8,
          staff: 8,
          courses: 'unlimited',
          generalStorage: 30,
          videoStorage: 75,
          videoStorageMinutes: 3000,
          recordedSessions: 10,
        },
        amount: 2790,
      },
      {
        key: 'enterprise',
        tier: 'enterprise',
        displayOrder: 3,
        en: ['Organization', 'For organizations running several academies.'],
        ar: ['المؤسسة', 'للمؤسسات التي تدير عدة أكاديميات.'],
        limits: {
          academies: 5,
          students: 1500,
          instructors: 25,
          staff: 25,
          courses: 'unlimited',
          generalStorage: 100,
          videoStorage: 200,
          videoStorageMinutes: 8000,
          recordedSessions: 30,
        },
        amount: 7490,
      },
    ] as const;

    for (const plan of ladder) {
      await prisma.plan.upsert({
        where: { key: plan.key },
        create: {
          key: plan.key,
          name: plan.en[0],
          description: plan.en[1],
          nameLocalized: { en: plan.en[0], ar: plan.ar[0] },
          descriptionLocalized: { en: plan.en[1], ar: plan.ar[1] },
          status: 'active',
          displayOrder: plan.displayOrder,
          family: 'normal',
          tier: plan.tier,
          limits: plan.limits,
          features: { liveSessions: false },
          pricing: {
            amount: plan.amount,
            currency: 'EGP',
            billingCycle: 'monthly',
            yearlyAmount: plan.amount * 10,
          },
          trialEligible: true,
          giftedDaysYearly: 14,
        },
        update: {},
      });
    }

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
