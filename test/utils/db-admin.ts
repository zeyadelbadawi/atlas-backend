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

/**
 * Phase 1 (Extended Scope, Decision 11, dependency D) — every test
 * fixture that needs "a real enrolled student" now needs this too:
 * `enrollments_self_insert` (RLS) requires a real `academy_students` row
 * for the enrolling Academy, matching the real product's own
 * registration-time behavior (`AuthService.register`/`AcademiesService.
 * createStudent`). Direct-DB fixture setup reproduces that fact instead
 * of going through the full registration HTTP flow, exactly like
 * `seedAcademyMember` already does for staff.
 */
export async function seedAcademyStudent(
  admin: PrismaClient,
  academyId: string,
  userId: string,
) {
  return admin.academyStudent.create({
    data: { academyId, userId },
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

/**
 * Phase 2 — every test fixture that goes through a REAL plan-limited write
 * path (`POST /academies`, `POST /courses`, `POST /enrollments`, media
 * upload, instructor grants) now needs a real, active
 * `tenant_subscriptions` row for its organization — `EntitlementEnforcementService`
 * rejects any organization with none at all. A single, generous,
 * effectively-unlimited plan (never `'unlimited'` string values — this
 * mirrors a REAL Plan shape, just with numbers no ordinary test fixture
 * could ever reach) so existing fixtures unrelated to entitlement testing
 * never need to reason about limits at all — dedicated entitlement tests
 * seed their own narrow plans instead (see
 * `entitlement-enforcement.e2e-spec.ts`).
 */
export async function seedActiveSubscriptionForOrg(
  admin: PrismaClient,
  organizationId: string,
  labelHint = 'fixture',
) {
  const plan = await seedPlan(admin, `${labelHint}-generous-plan`, {
    limits: {
      academies: 1000,
      students: 1000,
      instructors: 1000,
      staff: 1000,
      courses: 1000,
      generalStorage: 1000,
      videoStorage: 1000,
    },
  });
  return seedTenantSubscription(admin, organizationId, plan.id, { status: 'active' });
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

/** P6 — `quizzes`/`quiz_questions`/`quiz_question_options`/`assignments` carry no write endpoint (see `schema.prisma`'s P6 header comment) — seeded via the admin connection, mirroring `seedCourseCategory`/`seedCourseInstructor`'s exact precedent from P5. */
export async function seedQuiz(
  admin: PrismaClient,
  courseId: string,
  titleLabel: string,
  overrides: {
    status?: 'draft' | 'published';
    passingScore?: number;
    maxAttempts?: number;
    sectionId?: string;
  } = {},
) {
  return admin.quiz.create({
    data: {
      courseId,
      sectionId: overrides.sectionId,
      title: titleLabel,
      status: overrides.status ?? 'published',
      passingScore: overrides.passingScore,
      maxAttempts: overrides.maxAttempts,
    },
  });
}

export async function seedQuizQuestion(
  admin: PrismaClient,
  quizId: string,
  prompt: string,
  type: 'single_choice' | 'multiple_choice' | 'true_false',
  order: number,
) {
  return admin.quizQuestion.create({ data: { quizId, prompt, type, order } });
}

export async function seedQuizQuestionOption(
  admin: PrismaClient,
  questionId: string,
  label: string,
  isCorrect: boolean,
) {
  return admin.quizQuestionOption.create({ data: { questionId, label, isCorrect } });
}

/** P12 — `payment_methods` is a platform-owned catalog table (mirrors `seedPlan`/`seedAddOn`'s exact precedent) — no write endpoint exists. */
export async function seedPaymentMethod(
  admin: PrismaClient,
  keyLabel: string,
  overrides: {
    type?: 'manual_bank_transfer' | 'manual_wallet_transfer' | 'gateway';
    enabled?: boolean;
    capabilities?: Record<string, boolean>;
    manualInstructions?: Prisma.InputJsonValue;
  } = {},
) {
  const key = `${keyLabel}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.paymentMethod.create({
    data: {
      key,
      type: overrides.type ?? 'manual_bank_transfer',
      displayName: keyLabel,
      enabled: overrides.enabled ?? true,
      provider: 'atlas_manual',
      capabilities: overrides.capabilities ?? {
        supportsManualReview: true,
        supportsProof: true,
        supportsRedirect: false,
        supportsEmbeddedCheckout: false,
        supportsAdditionalAuthentication: false,
        supportsWebhooks: false,
        supportsRefunds: false,
        supportsRecurring: false,
        supportsCancellation: true,
      },
      manualInstructions: overrides.manualInstructions ?? {
        type: 'manual_bank_transfer',
        bankName: 'Test Bank',
        accountName: 'Test Account',
        accountNumber: '0000000000',
        instructions: 'Transfer the exact amount.',
        referenceInstructions: 'Use the Checkout id as reference.',
      },
    },
  });
}

export async function seedAssignment(
  admin: PrismaClient,
  courseId: string,
  titleLabel: string,
  overrides: {
    status?: 'draft' | 'published';
    allowResubmission?: boolean;
    sectionId?: string;
    lessonId?: string;
    dueAt?: Date;
  } = {},
) {
  return admin.assignment.create({
    data: {
      courseId,
      sectionId: overrides.sectionId,
      lessonId: overrides.lessonId,
      title: titleLabel,
      status: overrides.status ?? 'published',
      allowResubmission: overrides.allowResubmission ?? false,
      dueAt: overrides.dueAt,
    },
  });
}

/** P16 — a Payment with `createdAt` freely controllable (needed to place fixtures inside/outside a test's date-range window), mirroring `seedTenantSubscription`'s own "no creation endpoint reachable this way, seed via admin" precedent. Defaults to the Atlas Subscription Billing flow (`organizationId` set); pass `payerUserId`/`payeeAcademyId`/`courseOrderId` instead for a Course Commerce row. */
export async function seedPayment(
  admin: PrismaClient,
  overrides: {
    organizationId?: string;
    payerUserId?: string;
    payeeAcademyId?: string;
    courseOrderId?: string;
    amountMinorUnits: bigint;
    currency?: string;
    status?:
      | 'created'
      | 'pending'
      | 'processing'
      | 'requires_action'
      | 'requires_confirmation'
      | 'succeeded'
      | 'failed'
      | 'cancelled'
      | 'expired';
    createdAt?: Date;
  },
) {
  return admin.payment.create({
    data: {
      organizationId: overrides.organizationId,
      payerUserId: overrides.payerUserId,
      payeeAcademyId: overrides.payeeAcademyId,
      courseOrderId: overrides.courseOrderId,
      methodKey: 'manual_bank_transfer',
      methodType: 'manual_bank_transfer',
      provider: 'atlas_manual',
      amountMinorUnits: overrides.amountMinorUnits,
      currency: overrides.currency ?? 'USD',
      status: overrides.status ?? 'succeeded',
      createdAt: overrides.createdAt,
    },
  });
}

/** P16 — the minimum `course_orders` row `revenue_ledger_entries` FK-requires (no ledger row can exist without one — `courseOrderId` is a required, non-nullable FK). */
export async function seedCourseOrder(
  admin: PrismaClient,
  studentId: string,
  courseId: string,
  academyId: string,
  organizationId: string,
) {
  return admin.courseOrder.create({
    data: {
      studentId,
      courseId,
      academyId,
      organizationId,
      snapshot: {
        course: { id: courseId, title: 'Test course' },
        price: { amountMinorUnits: 0, currency: 'USD' },
      },
      status: 'paid',
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      idempotencyKey: `p16-order-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      paidAt: new Date(),
    },
  });
}

/**
 * Phase 2 — a real `enrollments` row for `TenantUsageRecomputeService`'s
 * `students` metric / `EntitlementEnforcementService`'s live `students`
 * count, seeded directly (mirrors every other cross-tenant fixture in this
 * file — no HTTP enrollment flow needed for a usage/entitlement test that
 * only cares about the resulting count).
 */
export async function seedEnrollment(
  admin: PrismaClient,
  studentId: string,
  courseId: string,
  academyId: string,
  overrides: {
    status?: 'available' | 'pending' | 'enrolled' | 'completed' | 'unavailable';
  } = {},
) {
  return admin.enrollment.create({
    data: {
      studentId,
      courseId,
      academyId,
      status: overrides.status ?? 'enrolled',
      enrolledAt: new Date(),
    },
  });
}

/**
 * Phase 2 — a real `media_assets` row for `TenantUsageRecomputeService`'s
 * `generalStorageGb`/`videoStorageGb` metrics / `EntitlementEnforcementService`'s
 * live storage check. `sizeBytes` is the one field every storage test
 * actually varies; everything else is a plausible, fixed fixture value.
 */
export async function seedMediaAsset(
  admin: PrismaClient,
  academyId: string,
  sizeBytes: bigint,
  overrides: {
    type?: 'image' | 'video' | 'document' | 'other';
    status?: 'active' | 'archived';
  } = {},
) {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return admin.mediaAsset.create({
    data: {
      academyId,
      type: overrides.type ?? 'image',
      status: overrides.status ?? 'active',
      fileName: `fixture-${suffix}.bin`,
      storageKey: `academies/${academyId}/${suffix}.bin`,
      url: `https://storage.test.local/${suffix}.bin`,
      mimeType: 'application/octet-stream',
      sizeBytes,
    },
  });
}

/** P16 — a `revenue_ledger_entries` row with `occurredAt` freely controllable, matching `RevenueLedgerEntry`'s own documented signed-amount convention (`sale` +, `platform_fee`/`refund` -, `commission_reversal` +). */
export async function seedRevenueLedgerEntry(
  admin: PrismaClient,
  academyId: string,
  courseOrderId: string,
  overrides: {
    entryType: 'sale' | 'platform_fee' | 'refund' | 'commission_reversal' | 'payout';
    amountMinorUnits: bigint;
    currency?: string;
    occurredAt?: Date;
    paymentId?: string;
  },
) {
  return admin.revenueLedgerEntry.create({
    data: {
      academyId,
      courseOrderId,
      paymentId: overrides.paymentId,
      entryType: overrides.entryType,
      amountMinorUnits: overrides.amountMinorUnits,
      currency: overrides.currency ?? 'USD',
      occurredAt: overrides.occurredAt,
    },
  });
}
