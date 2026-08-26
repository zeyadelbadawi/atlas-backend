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
import { EnrollmentsService } from '../src/learning/services/enrollments.service';
import { CourseProgressService } from '../src/learning/services/course-progress.service';
import { AssignmentsService } from '../src/learning/services/assignments.service';
import { InstructorService } from '../src/instructor/services/instructor.service';
import { AnnouncementsService } from '../src/community/services/announcements.service';
import { BlogPostsService } from '../src/community/services/blog-posts.service';
import { ForumsService } from '../src/community/services/forums.service';

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

    console.log('Seeding a student, a quiz, an assignment, and a real enrollment (P6)...');
    const student = await seedStudent(adminPrisma, passwordHash);
    await seedLearningContent(adminPrisma);
    await seedStudentEnrollment(app, student.id);

    console.log('Seeding instructor grading and Community content (P7)...');
    await seedInstructorOperationsAndCommunity(app, adminPrisma, {
      janeDoeId: users.janeDoe.id,
      sarahChenId: users.sarahChen.id,
      studentId: student.id,
    });

    console.log('Seeding payment methods catalog and a demo Checkout (P12)...');
    await seedPaymentMethods(adminPrisma);
    await seedBillingDemo(adminPrisma, orgs);

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
    console.log('  alex.morgan@student.dev    — a pure student, no organization/academy role anywhere; enrolled in "Spanish for Beginners" with its first lesson already completed');
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
// P12 — Atlas Subscription Billing
// ---------------------------------------------------------------------------

/**
 * `payment_methods` is a platform-owned catalog table — no write endpoint
 * exists (mirrors `plans`/`add_ons`'s exact P4 precedent), seeded directly
 * here. `manualInstructions` are obviously-fake dev fixture values (never
 * real banking/wallet details), matching how P8's dev environment already
 * uses fake MinIO storage credentials, not a real Cloudflare R2 account.
 */
async function seedPaymentMethods(prisma: PrismaClient): Promise<void> {
  const capabilities = {
    supportsManualReview: true,
    supportsProof: true,
    supportsRedirect: false,
    supportsEmbeddedCheckout: false,
    supportsAdditionalAuthentication: false,
    supportsWebhooks: false,
    supportsRefunds: false,
    supportsRecurring: false,
    supportsCancellation: true,
  };

  await prisma.paymentMethod.upsert({
    where: { key: 'atlas_bank_transfer' },
    create: {
      key: 'atlas_bank_transfer',
      type: 'manual_bank_transfer',
      displayName: 'Bank Transfer',
      description: 'Pay by direct bank transfer — reviewed manually within 1-2 business days.',
      provider: 'atlas_manual',
      capabilities,
      manualInstructions: {
        type: 'manual_bank_transfer',
        bankName: 'Atlas Platform Bank (dev fixture — not a real bank)',
        accountName: 'Atlas Inc.',
        accountNumber: '0000000000',
        iban: 'XX00ATLASDEV0000000000',
        instructions: 'Transfer the exact Checkout amount to the account above.',
        referenceInstructions: 'Use your Checkout id as the transfer reference.',
      },
      displayOrder: 1,
    },
    update: {},
  });

  await prisma.paymentMethod.upsert({
    where: { key: 'atlas_wallet_transfer' },
    create: {
      key: 'atlas_wallet_transfer',
      type: 'manual_wallet_transfer',
      displayName: 'Mobile Wallet',
      description: 'Pay by mobile wallet transfer — reviewed manually within 1-2 business days.',
      provider: 'atlas_manual',
      capabilities,
      manualInstructions: {
        type: 'manual_wallet_transfer',
        walletProvider: 'Atlas Pay (dev fixture — not a real wallet provider)',
        walletNumber: '+10000000000',
        accountName: 'Atlas Inc.',
        instructions: 'Send the exact Checkout amount to the wallet number above.',
        referenceInstructions: 'Use your Checkout id as the transfer note.',
      },
      displayOrder: 2,
    },
    update: {},
  });
}

/**
 * One realistic Checkout — Org B (still `trialing` on Starter) considering
 * an upgrade to Growth — left in `pending_payment` for the manual test
 * runbook to walk the rest of the flow (create a Payment, submit proof,
 * approve as the platform owner) through the real API, rather than
 * pre-seeding every step (matches P6/P7's "seed one real starting point,
 * not a fully-simulated end-to-end").
 */
async function seedBillingDemo(prisma: PrismaClient, orgs: SeededOrgs): Promise<void> {
  const growth = await prisma.plan.findUniqueOrThrow({ where: { key: 'growth' } });

  await prisma.checkout.upsert({
    where: {
      organizationId_idempotencyKey: {
        organizationId: orgs.orgB.id,
        idempotencyKey: 'seed-demo-growth-upgrade',
      },
    },
    create: {
      organizationId: orgs.orgB.id,
      targetType: 'plan_subscription',
      targetKey: growth.key,
      billingCycle: 'monthly',
      snapshot: {
        target: { type: 'plan_subscription', planKey: growth.key },
        billingCycle: 'monthly',
        displayName: growth.name,
        price: { amountMinorUnits: 7900, currency: 'USD' },
        capturedAt: new Date().toISOString(),
      },
      status: 'draft',
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      idempotencyKey: 'seed-demo-growth-upgrade',
    },
    // Re-running the seed against an already-seeded database refreshes
    // `expiresAt` (and resets `status` to `draft` if a prior manual test
    // run had advanced it) — the same "seed is safely re-runnable" rule
    // every other `upsert` in this file already follows.
    update: { status: 'draft', expiresAt: new Date(Date.now() + 30 * 60 * 1000) },
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

// ---------------------------------------------------------------------------
// P6 — Student Learning & Assessment
//
// A real student persona — deliberately NOT a member of any organization
// or academy anywhere (the genuine P6 access pattern: every table here is
// student-id-scoped via `app.current_user_id`, never organization/academy
// membership, per the P6 migration's own header comment). Enrolled in
// "Spanish for Beginners" — the one seeded course that is simultaneously
// free/published/public (the only pricing shape P6 enrollment accepts —
// "React Fundamentals" is paid, out of scope until Phase 13) — with its
// first lesson completed for real, through the actual `EnrollmentsService`/
// `CourseProgressService` (the same real-`AppModule`-context pattern
// `TenantUsageRecomputeService.recomputeOne` already uses above), never
// hand-typed progress numbers. The quiz and assignment themselves are
// seeded directly via the admin connection — no write endpoint exists for
// either (confirmed against the actual frontend `QuizService`/
// `AssignmentService`, both read-only for these two — see
// `schema.prisma`'s P6 header comment), mirroring the exact
// `course_categories`/`course_instructors` precedent from P5.
// ---------------------------------------------------------------------------

async function seedStudent(prisma: PrismaClient, passwordHash: string): Promise<{ id: string }> {
  return prisma.user.upsert({
    where: { email: 'alex.morgan@student.dev' },
    create: { email: 'alex.morgan@student.dev', name: 'Alex Morgan', passwordHash, status: 'active' },
    update: { name: 'Alex Morgan' },
  });
}

/** `quiz`/`assignment`/`quiz_question` have no natural unique key (matches `course_sections`' own precedent) — find-then-create-or-update by `(courseId, title)`/`(quizId, order)`, never a hardcoded id. */
async function upsertQuiz(
  prisma: PrismaClient,
  courseId: string,
  title: string,
  data: { passingScore?: number; maxAttempts?: number },
): Promise<{ id: string }> {
  const existing = await prisma.quiz.findFirst({ where: { courseId, title }, select: { id: true } });
  if (existing) {
    return prisma.quiz.update({ where: { id: existing.id }, data: { status: 'published', ...data } });
  }
  return prisma.quiz.create({ data: { courseId, title, status: 'published', ...data } });
}

async function upsertQuizQuestion(
  prisma: PrismaClient,
  quizId: string,
  order: number,
  data: { prompt: string; type: 'single_choice' | 'multiple_choice' | 'true_false' },
): Promise<{ id: string }> {
  const existing = await prisma.quizQuestion.findFirst({ where: { quizId, order }, select: { id: true } });
  if (existing) {
    return prisma.quizQuestion.update({ where: { id: existing.id }, data });
  }
  return prisma.quizQuestion.create({ data: { quizId, order, ...data } });
}

async function upsertQuizQuestionOption(
  prisma: PrismaClient,
  questionId: string,
  label: string,
  isCorrect: boolean,
): Promise<void> {
  const existing = await prisma.quizQuestionOption.findFirst({
    where: { questionId, label },
    select: { id: true },
  });
  if (existing) {
    await prisma.quizQuestionOption.update({ where: { id: existing.id }, data: { isCorrect } });
  } else {
    await prisma.quizQuestionOption.create({ data: { questionId, label, isCorrect } });
  }
}

async function upsertAssignment(
  prisma: PrismaClient,
  courseId: string,
  title: string,
): Promise<{ id: string }> {
  const existing = await prisma.assignment.findFirst({ where: { courseId, title }, select: { id: true } });
  if (existing) {
    return prisma.assignment.update({ where: { id: existing.id }, data: { status: 'published' } });
  }
  return prisma.assignment.create({
    data: {
      courseId,
      title,
      status: 'published',
      description: 'Write three sentences introducing yourself in Spanish.',
      instructions: 'Use at least two of the greetings from this section.',
    },
  });
}

async function seedLearningContent(prisma: PrismaClient): Promise<void> {
  const spanishCourse = await prisma.course.findFirstOrThrow({
    where: { slug: 'spanish-for-beginners' },
    select: { id: true },
  });

  const quiz = await upsertQuiz(prisma, spanishCourse.id, 'Spanish Basics Quiz', {
    passingScore: 50,
    maxAttempts: 3,
  });
  const question = await upsertQuizQuestion(prisma, quiz.id, 0, {
    prompt: 'How do you say "hello" in Spanish?',
    type: 'single_choice',
  });
  await upsertQuizQuestionOption(prisma, question.id, 'Hola', true);
  await upsertQuizQuestionOption(prisma, question.id, 'Adiós', false);
  await upsertQuizQuestionOption(prisma, question.id, 'Gracias', false);

  await upsertAssignment(prisma, spanishCourse.id, 'Introduce Yourself');
}

/** Real enrollment + real lesson completion, through the actual application services — never hand-written progress rows. */
async function seedStudentEnrollment(
  app: import('@nestjs/common').INestApplicationContext,
  studentId: string,
): Promise<void> {
  const enrollmentsService = app.get(EnrollmentsService);
  const courseProgressService = app.get(CourseProgressService);
  const admin = new PrismaClient({ datasources: { db: { url: requireAdminDatabaseUrl() } } });

  try {
    const spanishCourse = await admin.course.findFirstOrThrow({
      where: { slug: 'spanish-for-beginners' },
      select: { id: true },
    });
    const firstLesson = await admin.courseLesson.findFirstOrThrow({
      where: { courseId: spanishCourse.id, status: 'published' },
      orderBy: [{ section: { order: 'asc' } }, { order: 'asc' }],
      select: { id: true },
    });

    await enrollmentsService.createEnrollment(studentId, { courseId: spanishCourse.id });
    await courseProgressService.completeLesson(studentId, spanishCourse.id, {
      lessonId: firstLesson.id,
    });
  } finally {
    await admin.$disconnect();
  }
}

// ---------------------------------------------------------------------------
// P7 — Instructor Operations & Community
//
// `course_instructors`, `announcements`, `blog_posts`, `forums`/
// `forum_threads`/`forum_replies` writes go through the real application
// services (`AssignmentsService`/`InstructorService`/`AnnouncementsService`/
// `BlogPostsService`/`ForumsService`, the same real-`AppModule`-context
// pattern `seedStudentEnrollment` already established) wherever a real
// write endpoint exists — never hand-typed grading/announcement/blog/forum
// rows. `course_instructors` itself has no write endpoint (P5's own
// precedent, unrevised by P7 — master plan §24) — Jane Doe's second
// teaching assignment (Spanish for Beginners, in addition to React
// Fundamentals) is seeded directly via the admin connection, exactly like
// her first one already is.
// ---------------------------------------------------------------------------

/**
 * Retries a real service call up to `attempts` times. Observed necessary
 * for this local dev environment's forum thread/reply creation
 * specifically: an occasional, non-deterministic >5s delay before the
 * interactive transaction's own work even starts (Docker Desktop
 * filesystem/IPC jitter after a heavy preceding sequence of real service
 * calls, confirmed NOT a slow query — every query involved profiles under
 * 50ms in isolation) intermittently outruns Prisma's 5000ms default
 * interactive-transaction timeout. Not a masked bug: the same call
 * succeeds on retry every time, and this only ever runs in local seed
 * tooling, never a request path.
 */
async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function seedInstructorOperationsAndCommunity(
  app: import('@nestjs/common').INestApplicationContext,
  adminPrisma: PrismaClient,
  ids: { readonly janeDoeId: string; readonly sarahChenId: string; readonly studentId: string },
): Promise<void> {
  const assignmentsService = app.get(AssignmentsService);
  const instructorService = app.get(InstructorService);
  const announcementsService = app.get(AnnouncementsService);
  const blogPostsService = app.get(BlogPostsService);
  const forumsService = app.get(ForumsService);

  const [spanishCourse, reactCourse] = await Promise.all([
    adminPrisma.course.findFirstOrThrow({
      where: { slug: 'spanish-for-beginners' },
      select: { id: true },
    }),
    adminPrisma.course.findFirstOrThrow({
      where: { slug: 'react-fundamentals' },
      select: { id: true },
    }),
  ]);

  // Jane Doe also teaches Spanish for Beginners — gives the grading demo
  // below a real course with both a real instructor and a real enrolled
  // student with a real assignment to submit/grade.
  await adminPrisma.courseInstructor.upsert({
    where: { courseId_userId: { courseId: spanishCourse.id, userId: ids.janeDoeId } },
    create: { courseId: spanishCourse.id, userId: ids.janeDoeId },
    update: {},
  });

  const assignment = await adminPrisma.assignment.findFirstOrThrow({
    where: { courseId: spanishCourse.id, title: 'Introduce Yourself' },
    select: { id: true },
  });

  let submission = await adminPrisma.assignmentSubmission.findUnique({
    where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: ids.studentId } },
  });
  if (!submission) {
    await assignmentsService.submitAssignment(ids.studentId, spanishCourse.id, assignment.id, {
      response: 'Hola, me llamo Alex. Soy estudiante de espanol y me gusta aprender idiomas.',
    });
    submission = await adminPrisma.assignmentSubmission.findUniqueOrThrow({
      where: { assignmentId_studentId: { assignmentId: assignment.id, studentId: ids.studentId } },
    });
  }
  if (submission.gradingStatus === 'ungraded') {
    await instructorService.gradeSubmission(
      ids.janeDoeId,
      spanishCourse.id,
      assignment.id,
      submission.id,
      { score: 92, feedback: 'Great introduction — clear and well-structured!' },
    );
  }

  // Course announcement — React Fundamentals, authored/published by Sarah
  // Chen (Academy A1's real `owner`, the one write-authorization shape
  // `announcements_manage_*` RLS actually grants).
  const existingAnnouncement = await adminPrisma.announcement.findFirst({
    where: { courseId: reactCourse.id, title: 'Welcome to React Fundamentals!' },
  });
  if (!existingAnnouncement) {
    const created = await announcementsService.createAnnouncement(
      ids.sarahChenId,
      reactCourse.id,
      {
        title: 'Welcome to React Fundamentals!',
        body: "Excited to have you here. Check the curriculum sidebar to get started, and don't hesitate to post questions in the course forum.",
      },
    );
    await announcementsService.publishAnnouncement(ids.sarahChenId, reactCourse.id, created.id);
  }

  // Academy-level blog post — authored/published by Jane Doe (Academy A1
  // staff; `BlogPostsService.resolveAuthorAcademyId` resolves her single
  // real `academy_members` row).
  const existingPost = await adminPrisma.blogPost.findFirst({
    where: { slug: 'tips-for-new-react-developers' },
  });
  if (!existingPost) {
    const created = await blogPostsService.createPost(ids.janeDoeId, {
      title: 'Tips for New React Developers',
      slug: 'tips-for-new-react-developers',
      excerpt: 'A few habits that make learning React easier.',
      content:
        'Start small, build real components, and read error messages carefully — they usually tell you exactly what went wrong.',
      category: 'Learning',
      tags: ['react', 'beginners'],
    });
    await blogPostsService.publishPost(ids.janeDoeId, created.id);
  }

  // Course forum — React Fundamentals: Jane Doe (instructor) starts a
  // thread, Sarah Chen (academy owner, a real participant) replies.
  const existingThread = await adminPrisma.forumThread.findFirst({
    where: { courseId: reactCourse.id, title: 'Welcome — introduce yourself!' },
    select: { id: true },
  });
  const threadId =
    existingThread?.id ??
    (
      await withRetry(() =>
        forumsService.createThread(ids.janeDoeId, reactCourse.id, {
          title: 'Welcome — introduce yourself!',
          body: 'Tell us a bit about yourself and why you are learning React.',
        }),
      )
    ).id;

  const existingReply = await adminPrisma.forumReply.findFirst({
    where: { threadId, authorId: ids.sarahChenId },
  });
  if (!existingReply) {
    await withRetry(() =>
      forumsService.createReply(ids.sarahChenId, reactCourse.id, threadId, {
        body: 'Great idea, Jane — looking forward to seeing everyone here!',
      }),
    );
  }
}

main().catch((error: unknown) => {
  console.error('Seed failed:', error);
  process.exit(1);
});
