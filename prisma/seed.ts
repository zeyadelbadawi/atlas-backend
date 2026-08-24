/**
 * Local development seed — deterministic, idempotent, real database data.
 *
 * Populates a realistic fixture graph spanning every phase (P1–P5) so the
 * whole backend can be exercised through the real API/frontend without
 * hand-seeding via psql first. Every row is written through real Prisma
 * `upsert` calls keyed by a stable NATURAL key (email, slug, or a compound
 * unique constraint) — never a hardcoded random id — so re-running this
 * script updates the same rows in place rather than creating duplicates,
 * and never touches any row it didn't create itself.
 *
 * Two connections, deliberately:
 *   - `adminPrisma` (`DATABASE_URL`, the migration superuser) — for
 *     writing tenant-scoped rows directly (organizations, academies,
 *     courses, ...), exactly like `test/utils/db-admin.ts`'s established,
 *     already-reviewed pattern: fixture arrangement is what an elevated
 *     connection is for; RLS's narrowed INSERT policies (see the P2/P4/P5
 *     migrations' own doc comments) deliberately do not support "seed an
 *     arbitrary tenant graph" through the restricted `atlas_app` role, any
 *     more than a real onboarding flow would.
 *   - A real, full `AppModule` context (via `NestFactory.
 *     createApplicationContext`, the same pattern `scripts/recompute-
 *     tenant-usage.ts` already uses) — for the two things that must go
 *     through REAL application code, not be faked: password hashing
 *     (`PasswordHasherService`, real Argon2id — never a placeholder hash)
 *     and `tenant_usage` computation (`TenantUsageRecomputeService.
 *     recomputeOne`, the real worker logic, so seeded usage numbers are
 *     genuinely computed from the seeded academies/members, never
 *     hand-typed).
 *
 * Safety:
 *   - Every email is `@*.dev`/`@atlas.dev` and every password is the same
 *     obviously-fake literal (`DevPassword123!`) — printed once at the end
 *     so a human running this locally has it, never silently assumed.
 *   - Never runs automatically — this file is only ever invoked by
 *     `npm run db:seed`, a manual, explicit local command.
 *   - No production guard is needed beyond that: it connects to whatever
 *     `DATABASE_URL`/`APP_DATABASE_URL` the local `.env` points at, the
 *     same as every other script in this repo — running it against a
 *     production database would be an operator error, not something this
 *     script can detect from inside itself.
 *
 * Run: `npm run db:seed`
 */
import { NestFactory } from '@nestjs/core';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordHasherService } from '../src/identity/services/password-hasher.service';
import { TenantUsageRecomputeService } from '../src/plans/services/tenant-usage-recompute.service';

const DEV_PASSWORD = 'DevPassword123!';

function requireAdminDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('DATABASE_URL must be set (the same superuser connection Prisma migrations use).');
  }
  return url;
}

async function main(): Promise<void> {
  const adminPrisma = new PrismaClient({ datasources: { db: { url: requireAdminDatabaseUrl() } } });
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });

  try {
    const passwordHasher = app.get(PasswordHasherService);
    const recomputeService = app.get(TenantUsageRecomputeService);
    const passwordHash = await passwordHasher.hash(DEV_PASSWORD);

    console.log('Seeding users (P1)...');
    const users = await seedUsers(adminPrisma, passwordHash);

    console.log('Seeding organizations + memberships (P2)...');
    const orgs = await seedOrganizations(adminPrisma, users);

    console.log('Seeding academies + academy members (P3)...');
    const academies = await seedAcademies(adminPrisma, orgs, users);

    console.log('Seeding plans, add-ons, subscriptions (P4)...');
    await seedPlansAndSubscriptions(adminPrisma, orgs);

    console.log('Seeding course categories, courses, sections, lessons (P5)...');
    await seedCourses(adminPrisma, academies, users);

    console.log('Recomputing tenant usage from real seeded data (real worker logic, not fabricated)...');
    await recomputeService.recomputeOne(orgs.orgA.id);
    await recomputeService.recomputeOne(orgs.orgB.id);

    console.log('\n✔ Seed complete.\n');
    console.log('Sign in with any seeded user below, password for all: ' + DEV_PASSWORD);
    console.log('  admin@atlas.dev            — platform owner');
    console.log('  sarah.chen@acme-academy.dev — owns Org A, owner of Academy A1, member of Org B');
    console.log('  omar.hassan@nextgen-learning.dev — owns Org B, owner of Academy B1');
    console.log('  jane.doe@acme-academy.dev  — instructor in Academy A1');
    console.log('  mike.wilson@acme-academy.dev — staff in Academy A1');
    console.log('  lisa.park@acme-academy.dev — Org A member, NO academy role (read-only on Academy A1/courses)');
  } finally {
    await adminPrisma.$disconnect();
    await app.close();
  }
}

// ---------------------------------------------------------------------------
// P1 — Users
// ---------------------------------------------------------------------------

interface SeededUsers {
  readonly admin: { id: string };
  readonly sarahChen: { id: string };
  readonly omarHassan: { id: string };
  readonly janeDoe: { id: string };
  readonly mikeWilson: { id: string };
  readonly lisaPark: { id: string };
}

async function seedUsers(prisma: PrismaClient, passwordHash: string): Promise<SeededUsers> {
  const upsertUser = (email: string, name: string, isPlatformOwner = false) =>
    prisma.user.upsert({
      where: { email },
      create: { email, name, passwordHash, isPlatformOwner, status: 'active' },
      update: { name, isPlatformOwner },
    });

  const [admin, sarahChen, omarHassan, janeDoe, mikeWilson, lisaPark] = await Promise.all([
    upsertUser('admin@atlas.dev', 'Atlas Admin', true),
    upsertUser('sarah.chen@acme-academy.dev', 'Sarah Chen'),
    upsertUser('omar.hassan@nextgen-learning.dev', 'Omar Hassan'),
    upsertUser('jane.doe@acme-academy.dev', 'Jane Doe'),
    upsertUser('mike.wilson@acme-academy.dev', 'Mike Wilson'),
    upsertUser('lisa.park@acme-academy.dev', 'Lisa Park'),
  ]);

  return { admin, sarahChen, omarHassan, janeDoe, mikeWilson, lisaPark };
}

// ---------------------------------------------------------------------------
// P2 — Organizations + Memberships
// ---------------------------------------------------------------------------

interface SeededOrgs {
  readonly orgA: { id: string };
  readonly orgB: { id: string };
}

async function seedOrganizations(prisma: PrismaClient, users: SeededUsers): Promise<SeededOrgs> {
  const orgA = await prisma.organization.upsert({
    where: { slug: 'acme-academy-group' },
    create: { name: 'Acme Academy Group', slug: 'acme-academy-group', ownerUserId: users.sarahChen.id },
    update: { name: 'Acme Academy Group' },
  });
  const orgB = await prisma.organization.upsert({
    where: { slug: 'nextgen-learning' },
    create: { name: 'NextGen Learning', slug: 'nextgen-learning', ownerUserId: users.omarHassan.id },
    update: { name: 'NextGen Learning' },
  });

  const upsertMembership = (organizationId: string, userId: string, role: string, isPrimary: boolean) =>
    prisma.organizationMembership.upsert({
      where: { organizationId_userId: { organizationId, userId } },
      create: { organizationId, userId, role, isPrimary, permissions: [] },
      update: { role, isPrimary },
    });

  await Promise.all([
    upsertMembership(orgA.id, users.sarahChen.id, 'owner', true),
    upsertMembership(orgB.id, users.omarHassan.id, 'owner', true),
    upsertMembership(orgA.id, users.lisaPark.id, 'member', true),
    // Sarah also belongs to Org B as a regular member — realistic
    // multi-org membership, matching the P2 tenant-isolation suite's own
    // "a user in Org 1 AND Org 2" scenario, now visible in real local data
    // (e.g. exercising the OrganizationSwitcher against real seeded orgs).
    upsertMembership(orgB.id, users.sarahChen.id, 'member', false),
  ]);

  return { orgA, orgB };
}

// ---------------------------------------------------------------------------
// P3 — Academies + Academy Members
// ---------------------------------------------------------------------------

interface SeededAcademies {
  readonly academyA1: { id: string; organizationId: string };
  readonly academyA2: { id: string; organizationId: string };
  readonly academyB1: { id: string; organizationId: string };
}

async function seedAcademies(
  prisma: PrismaClient,
  orgs: SeededOrgs,
  users: SeededUsers,
): Promise<SeededAcademies> {
  const academyA1 = await prisma.academy.upsert({
    where: { slug: 'web-development-academy' },
    create: {
      organizationId: orgs.orgA.id,
      name: 'Web Development Academy',
      slug: 'web-development-academy',
      description: 'Hands-on web development courses, from fundamentals to full-stack.',
      status: 'active',
      timezone: 'America/New_York',
      language: 'en',
      currency: 'USD',
    },
    update: { description: 'Hands-on web development courses, from fundamentals to full-stack.' },
  });
  const academyA2 = await prisma.academy.upsert({
    where: { slug: 'data-science-academy' },
    create: {
      organizationId: orgs.orgA.id,
      name: 'Data Science Academy',
      slug: 'data-science-academy',
      description: 'A second academy under the same organization — still in setup.',
      status: 'draft',
    },
    update: {},
  });
  const academyB1 = await prisma.academy.upsert({
    where: { slug: 'language-learning-hub' },
    create: {
      organizationId: orgs.orgB.id,
      name: 'Language Learning Hub',
      slug: 'language-learning-hub',
      description: 'Practical language courses for real-world communication.',
      status: 'active',
      timezone: 'Asia/Dubai',
      language: 'ar',
      currency: 'USD',
    },
    update: { description: 'Practical language courses for real-world communication.' },
  });

  const upsertMember = (academyId: string, userId: string, role: 'owner' | 'administrator' | 'manager' | 'instructor' | 'staff') =>
    prisma.academyMember.upsert({
      where: { academyId_userId: { academyId, userId } },
      create: { academyId, userId, role, status: 'active' },
      update: { role },
    });

  await Promise.all([
    upsertMember(academyA1.id, users.sarahChen.id, 'owner'),
    upsertMember(academyA1.id, users.janeDoe.id, 'instructor'),
    upsertMember(academyA1.id, users.mikeWilson.id, 'staff'),
    upsertMember(academyB1.id, users.omarHassan.id, 'owner'),
  ]);

  return { academyA1, academyA2, academyB1 };
}

// ---------------------------------------------------------------------------
// P4 — Plans, Add-ons, Subscriptions
// ---------------------------------------------------------------------------

async function seedPlansAndSubscriptions(prisma: PrismaClient, orgs: SeededOrgs): Promise<void> {
  const starter = await prisma.plan.upsert({
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

  const growth = await prisma.plan.upsert({
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

  const extraAcademyAddOn = await prisma.addOn.upsert({
    where: { key: 'extra-academy' },
    create: {
      key: 'extra-academy',
      name: 'Extra Academy',
      description: 'Raises your academy limit by 2.',
      effect: { type: 'limit', limitKey: 'academies', amount: 2 },
      compatiblePlanKeys: ['starter', 'growth'],
      pricing: { amount: 15, currency: 'USD', billingCycle: 'monthly' },
    },
    update: {},
  });

  await prisma.addOn.upsert({
    where: { key: 'advanced-analytics' },
    create: {
      key: 'advanced-analytics',
      name: 'Advanced Analytics',
      description: 'Unlocks advanced analytics on the Growth plan.',
      effect: { type: 'feature', featureKey: 'analyticsAdvanced' },
      compatiblePlanKeys: ['growth'],
      pricing: { amount: 25, currency: 'USD', billingCycle: 'monthly' },
    },
    update: {},
  });

  const now = new Date();
  const in30Days = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const in7Days = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  await prisma.tenantSubscription.upsert({
    where: { organizationId: orgs.orgA.id },
    create: {
      organizationId: orgs.orgA.id,
      planId: growth.id,
      status: 'active',
      currentPeriodStart: now,
      currentPeriodEnd: in30Days,
      billingCycle: 'monthly',
    },
    update: { planId: growth.id, status: 'active' },
  });

  await prisma.tenantSubscription.upsert({
    where: { organizationId: orgs.orgB.id },
    create: {
      organizationId: orgs.orgB.id,
      planId: starter.id,
      status: 'trialing',
      trialEndsAt: in7Days,
    },
    update: { planId: starter.id },
  });

  await prisma.tenantAddOn.upsert({
    where: { organizationId_addOnId: { organizationId: orgs.orgA.id, addOnId: extraAcademyAddOn.id } },
    create: { organizationId: orgs.orgA.id, addOnId: extraAcademyAddOn.id },
    update: {},
  });
}

// ---------------------------------------------------------------------------
// P5 — Course Categories, Courses, Sections, Lessons, Instructors
//
// The schema has no separate locale/translation columns for course content
// (confirmed against master plan §5.3 and `course.types.ts` — `title`/
// `description` are plain strings, no `_ar`/`_en` variant, no i18n JSON).
// Realistic Arabic content is still seeded below (one full Arabic-titled
// course) to prove the columns round-trip UTF-8 content correctly — not a
// parallel translation system, since none exists to populate.
// ---------------------------------------------------------------------------

async function seedCourses(
  prisma: PrismaClient,
  academies: SeededAcademies,
  users: SeededUsers,
): Promise<void> {
  const webDevCategory = await prisma.courseCategory.upsert({
    where: { academyId_slug: { academyId: academies.academyA1.id, slug: 'web-development' } },
    create: {
      academyId: academies.academyA1.id,
      name: 'Web Development',
      slug: 'web-development',
      description: 'Frontend and full-stack web development courses.',
    },
    update: {},
  });
  const programmingCategory = await prisma.courseCategory.upsert({
    where: { academyId_slug: { academyId: academies.academyA1.id, slug: 'programming' } },
    create: {
      academyId: academies.academyA1.id,
      name: 'Programming',
      slug: 'programming',
      description: 'General-purpose programming and backend development.',
    },
    update: {},
  });
  const languagesCategory = await prisma.courseCategory.upsert({
    where: { academyId_slug: { academyId: academies.academyB1.id, slug: 'languages' } },
    create: {
      academyId: academies.academyB1.id,
      name: 'Languages',
      slug: 'languages',
      description: 'Practical, conversation-focused language courses.',
    },
    update: {},
  });

  const reactCourse = await prisma.course.upsert({
    where: { academyId_slug: { academyId: academies.academyA1.id, slug: 'react-fundamentals' } },
    create: {
      academyId: academies.academyA1.id,
      categoryId: webDevCategory.id,
      title: 'React Fundamentals',
      slug: 'react-fundamentals',
      shortDescription: 'Learn React from the ground up — components, state, and props.',
      description:
        'A hands-on introduction to React: JSX, components, props, state, and the hooks that tie it together. By the end you will have built a small interactive app from scratch.',
      status: 'published',
      visibility: 'public',
      pricingType: 'paid',
      pricingAmountMinorUnits: 4999n,
      pricingCurrency: 'USD',
      publishedAt: new Date(),
    },
    update: { status: 'published' },
  });

  await prisma.courseInstructor.upsert({
    where: { courseId_userId: { courseId: reactCourse.id, userId: users.janeDoe.id } },
    create: { courseId: reactCourse.id, userId: users.janeDoe.id },
    update: {},
  });

  const introSection = await upsertSection(prisma, reactCourse.id, 0, {
    title: 'Introduction',
    description: 'Getting oriented.',
  });
  const basicsSection = await upsertSection(prisma, reactCourse.id, 1, {
    title: 'React Basics',
    description: 'Core concepts.',
  });

  await upsertLesson(prisma, introSection.id, reactCourse.id, 0, {
    title: 'Welcome',
    description: 'What this course covers and how to get the most out of it.',
    contentType: 'text',
    status: 'published',
  });
  await upsertLesson(prisma, introSection.id, reactCourse.id, 1, {
    title: 'Environment Setup',
    description: 'Installing Node.js and creating your first React project.',
    contentType: 'video',
    contentUrl: 'https://example.com/videos/react-setup.mp4',
    status: 'published',
  });
  await upsertLesson(prisma, basicsSection.id, reactCourse.id, 0, {
    title: 'Components & Props',
    description: 'Building your first reusable components.',
    contentType: 'text',
    status: 'published',
  });
  await upsertLesson(prisma, basicsSection.id, reactCourse.id, 1, {
    title: 'State & Lifecycle',
    description: 'Managing state with hooks.',
    contentType: 'video',
    contentUrl: 'https://example.com/videos/react-state.mp4',
    status: 'draft',
  });

  const nodeCourse = await prisma.course.upsert({
    where: { academyId_slug: { academyId: academies.academyA1.id, slug: 'nodejs-backend-development' } },
    create: {
      academyId: academies.academyA1.id,
      categoryId: programmingCategory.id,
      title: 'Node.js Backend Development',
      slug: 'nodejs-backend-development',
      shortDescription: 'Build REST APIs with Node.js and Express.',
      description: 'Still in development — covers HTTP fundamentals, Express routing, and connecting to a real database.',
      status: 'draft',
      visibility: 'private',
      pricingType: 'free',
    },
    update: {},
  });

  const nodeSection = await upsertSection(prisma, nodeCourse.id, 0, { title: 'Getting Started' });
  await upsertLesson(prisma, nodeSection.id, nodeCourse.id, 0, {
    title: 'What is Node.js',
    contentType: 'text',
    status: 'draft',
  });
  await upsertLesson(prisma, nodeSection.id, nodeCourse.id, 1, {
    title: 'Installing Node',
    contentType: 'file',
    status: 'draft',
  });

  const spanishCourse = await prisma.course.upsert({
    where: { academyId_slug: { academyId: academies.academyB1.id, slug: 'spanish-for-beginners' } },
    create: {
      academyId: academies.academyB1.id,
      categoryId: languagesCategory.id,
      title: 'Spanish for Beginners',
      slug: 'spanish-for-beginners',
      shortDescription: 'Start speaking Spanish from day one.',
      description: 'A conversational approach to beginner Spanish — greetings, numbers, and everyday phrases.',
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
      publishedAt: new Date(),
    },
    update: { status: 'published' },
  });

  const spanishSection = await upsertSection(prisma, spanishCourse.id, 0, { title: 'Basics' });
  await upsertLesson(prisma, spanishSection.id, spanishCourse.id, 0, {
    title: 'Greetings',
    contentType: 'text',
    status: 'published',
  });
  await upsertLesson(prisma, spanishSection.id, spanishCourse.id, 1, {
    title: 'Numbers 1-10',
    contentType: 'text',
    status: 'published',
  });

  // Arabic-content course — proves the schema's plain-string columns
  // round-trip non-Latin UTF-8 content correctly; see this section's
  // header comment for why there is no separate translation mechanism.
  const arabicCourse = await prisma.course.upsert({
    where: { academyId_slug: { academyId: academies.academyB1.id, slug: 'arabic-language-basics' } },
    create: {
      academyId: academies.academyB1.id,
      categoryId: languagesCategory.id,
      title: 'أساسيات اللغة العربية',
      slug: 'arabic-language-basics',
      shortDescription: 'ابدأ رحلتك في تعلم اللغة العربية من الصفر.',
      description: 'دورة تأسيسية في اللغة العربية تغطي الحروف والتحيات والعبارات الأساسية للمحادثة اليومية.',
      status: 'published',
      visibility: 'public',
      pricingType: 'free',
      publishedAt: new Date(),
    },
    update: { status: 'published' },
  });

  const arabicSection = await upsertSection(prisma, arabicCourse.id, 0, {
    title: 'الأساسيات',
    description: 'مقدمة في الحروف والتحيات.',
  });
  await upsertLesson(prisma, arabicSection.id, arabicCourse.id, 0, {
    title: 'التحيات',
    description: 'كيف تلقي التحية وترد عليها.',
    contentType: 'text',
    status: 'published',
  });
}

interface SectionSeed {
  readonly title: string;
  readonly description?: string;
}

/** `course_sections` has no natural unique key (no `(course_id, order)` constraint — order changes via the real reorder endpoint, so it deliberately isn't one) — find-then-create-or-update by `(courseId, order)` instead, mirroring `upsertLesson`'s identical shape. */
async function upsertSection(
  prisma: PrismaClient,
  courseId: string,
  order: number,
  data: SectionSeed,
): Promise<{ id: string }> {
  const existing = await prisma.courseSection.findFirst({ where: { courseId, order }, select: { id: true } });
  if (existing) {
    await prisma.courseSection.update({ where: { id: existing.id }, data });
    return existing;
  }
  return prisma.courseSection.create({ data: { courseId, order, ...data } });
}

interface LessonSeed {
  readonly title: string;
  readonly description?: string;
  readonly contentType: 'text' | 'video' | 'file';
  readonly contentUrl?: string;
  readonly status: 'draft' | 'published';
}

async function upsertLesson(
  prisma: PrismaClient,
  sectionId: string,
  courseId: string,
  order: number,
  data: LessonSeed,
): Promise<void> {
  const existing = await prisma.courseLesson.findFirst({ where: { sectionId, order }, select: { id: true } });
  if (existing) {
    await prisma.courseLesson.update({ where: { id: existing.id }, data });
  } else {
    await prisma.courseLesson.create({ data: { sectionId, courseId, order, ...data } });
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
