/**
 * Provisioning Orchestration — functional/contract e2e suite (Phase P14,
 * master plan §21/§5.11). The real business flow this phase exists to
 * prove end to end: a Tenant creates a ProvisioningRequest → the
 * `provisioning-worker` (real BullMQ/Redis, real Postgres, no mocks) walks
 * the 7-step state machine to a terminal `ready`/`failed` status →
 * completed/skipped steps are never re-executed → a genuinely failed step
 * is retryable and resumes correctly → a redelivered/duplicate worker job
 * for an already-terminal request is a safe no-op.
 *
 * Tenant isolation and Platform Owner review-console authorization are
 * covered separately in `provisioning-tenant-isolation.e2e-spec.ts`; the
 * direct-Postgres RLS proof is `rls-provisioning.e2e-spec.ts`.
 */
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp, uniqueTestEmail, waitForAsync } from './utils/test-app';
import { createAdminPrisma, seedOrganizationWithOwner, seedPlan } from './utils/db-admin';
import { ProvisioningProducer } from '../src/provisioning/queue/provisioning.producer';
import { WebsiteGenerationService } from '../src/website/services/website-generation.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import type { Prisma, PrismaClient } from '@prisma/client';

// Real BullMQ round trips (enqueue → worker pickup → orchestrator → DB),
// not slow assertions — same headroom reasoning as
// `media-processing-worker.e2e-spec.ts`'s own per-file override.
jest.setTimeout(30000);

async function signUpAndSignIn(
  app: INestApplication,
  label: string,
): Promise<{ userId: string; accessToken: string }> {
  const email = uniqueTestEmail(label);
  const password = 'correct-horse-battery';
  await request(app.getHttpServer())
    .post('/auth/register')
    .send({ name: label, email, password })
    .expect(201);
  const signIn = await request(app.getHttpServer())
    .post('/auth/sign-in')
    .send({ email, password })
    .expect(200);
  return { userId: signIn.body.user.id, accessToken: signIn.body.accessToken };
}

function uniqueSubdomain(label: string): string {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

describe('Provisioning Orchestration — P14 (e2e)', () => {
  let app: INestApplication;
  let admin: PrismaClient;
  let flushRateLimitKeys: () => Promise<void>;
  let provisioningProducer: ProvisioningProducer;
  let websiteGenerationService: WebsiteGenerationService;
  let tenancyContextService: TenancyContextService;

  beforeAll(async () => {
    const testApp = await createTestApp();
    app = testApp.app;
    admin = createAdminPrisma();
    flushRateLimitKeys = testApp.flushRateLimitKeys;
    provisioningProducer = app.get(ProvisioningProducer, { strict: false });
    websiteGenerationService = app.get(WebsiteGenerationService, { strict: false });
    tenancyContextService = app.get(TenancyContextService, { strict: false });
  });

  afterAll(async () => {
    await admin.$disconnect();
    await app.close();
  });

  beforeEach(async () => {
    await flushRateLimitKeys();
  });

  async function arrangeOrg(label: string) {
    const owner = await signUpAndSignIn(app, `${label}-owner`);
    const org = await seedOrganizationWithOwner(admin, owner.userId, `${label}-org`);
    // Phase P19: `createRequest` now requires a real, active/trialing
    // subscription before provisioning can start (`Reports/
    // DEVELOPMENT_E2E_FLOW_AUDIT.md` P1-2 — "provisioning cannot be
    // started merely by knowing an organization id"). This suite tests
    // the orchestrator itself, not that gate (covered by
    // `organizations.e2e-spec.ts`), so every fixture org here legitimately
    // has one from the start, matching `billing.e2e-spec.ts`'s own
    // `arrangeCheckoutAndPayment` precedent.
    const plan = await seedPlan(admin, `${label}-plan`);
    await admin.tenantSubscription.create({
      data: { organizationId: org.id, planId: plan.id, status: 'active' },
    });
    return { owner, org };
  }

  async function createRequest(
    owner: { accessToken: string },
    orgId: string,
    overrides: Partial<{
      academyName: string;
      requestedSubdomain: string;
      idempotencyKey: string;
      triggeringPaymentId: string;
    }> = {},
  ) {
    const subdomain = overrides.requestedSubdomain ?? uniqueSubdomain('academy');
    const res = await request(app.getHttpServer())
      .post(`/organizations/${orgId}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: overrides.academyName ?? 'Test Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: overrides.idempotencyKey ?? `idem-${subdomain}`,
        ...(overrides.triggeringPaymentId
          ? { triggeringPaymentId: overrides.triggeringPaymentId }
          : {}),
      })
      .expect(201);
    return res.body;
  }

  async function getRequest(
    owner: { accessToken: string },
    orgId: string,
    requestId: string,
  ) {
    const res = await request(app.getHttpServer())
      .get(`/organizations/${orgId}/provisioning-requests/${requestId}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    return res.body;
  }

  async function waitForTerminal(
    owner: { accessToken: string },
    orgId: string,
    requestId: string,
  ) {
    return waitForAsync(async () => {
      const body = await getRequest(owner, orgId, requestId);
      return ['ready', 'failed', 'cancelled'].includes(body.status) ? body : undefined;
    });
  }

  // --- 1. Creation shape ----------------------------------------------------

  it('1: creating a request returns the correct initial shape', async () => {
    const { owner, org } = await arrangeOrg('create-shape');
    const body = await createRequest(owner, org.id);

    expect(body).toMatchObject({
      organizationId: org.id,
      status: 'payment_success',
      currentStepKey: 'tenant',
      attemptCount: 0,
      requestedAcademyName: 'Test Academy',
    });
    expect(body.academyId).toBeUndefined();
    expect(body.id).toBeTruthy();
  });

  // --- 2. Correct seven-step initialization ---------------------------------

  it('2: initializes exactly the seven canonical steps, in order', async () => {
    const { owner, org } = await arrangeOrg('seven-steps');
    const body = await createRequest(owner, org.id);

    expect(body.steps.map((s: { key: string }) => s.key)).toEqual([
      'tenant',
      'academy',
      'theme',
      'branding',
      'subdomain',
      'domain',
      'finalization',
    ]);
  });

  // --- 3. Happy path through all seven steps --------------------------------

  it('3: the happy path runs all seven steps to a ready terminal state', async () => {
    const { owner, org } = await arrangeOrg('happy-path');
    const subdomain = uniqueSubdomain('happy');
    const created = await createRequest(owner, org.id, {
      academyName: 'Happy Academy',
      requestedSubdomain: subdomain,
    });

    const final = await waitForTerminal(owner, org.id, created.id);

    expect(final.status).toBe('ready');
    expect(final.academyId).toBeTruthy();
    expect(final.completedAt).toBeTruthy();
    expect(final.startedAt).toBeTruthy();

    const byKey = Object.fromEntries(
      final.steps.map((s: { key: string; status: string }) => [s.key, s.status]),
    );
    // Phase P19: 'theme' now genuinely completes even with no
    // `selectedThemeKey` in the request — the real Website Builder
    // bootstrap default applies (see `provisioning-orchestrator.service.
    // ts`'s `executeThemeStep`'s own doc comment: "nothing to change,"
    // never a skip). 'branding'/'domain' remain skipped — still
    // genuinely no data for either in this phase.
    expect(byKey).toEqual({
      tenant: 'completed',
      academy: 'completed',
      theme: 'completed',
      branding: 'skipped',
      subdomain: 'completed',
      domain: 'skipped',
      finalization: 'completed',
    });

    // Phase P19 — this request submitted no `selectedThemeKey`, so the
    // 'theme' step has nothing to write (see `executeThemeStep`'s own
    // doc comment) and correctly does not eagerly create a
    // `website_configurations` row — that stays exactly the pre-existing,
    // established `WebsiteBootstrapService` lazy get-or-create-on-read
    // behavior (test 3b, below, proves the row IS created — with the
    // Client's real chosen theme — when one is actually selected).

    // The real Academy this request created — no duplicate, correct fields.
    const academy = await admin.academy.findUnique({ where: { id: final.academyId } });
    expect(academy).toMatchObject({
      organizationId: org.id,
      name: 'Happy Academy',
      slug: subdomain,
    });

    // The real subdomain allocation this request created.
    expect(final.subdomain).toMatchObject({ subdomain, status: 'assigned' });
  });

  // --- 3b. Real theme selection (Phase P19) ----------------------------------

  it('3b: a Client-selected theme is applied to the real Academy website configuration, not just the bootstrap default', async () => {
    const { owner, org } = await arrangeOrg('themed');
    const subdomain = uniqueSubdomain('themed');
    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Themed Academy',
        requestedSubdomain: subdomain,
        selectedThemeKey: 'bold-creative',
        idempotencyKey: `themed-idem-${subdomain}`,
      })
      .expect(201);
    expect(created.body.selectedThemeKey).toBe('bold-creative');

    const final = await waitForTerminal(owner, org.id, created.body.id);
    expect(final.status).toBe('ready');
    expect(final.selectedThemeKey).toBe('bold-creative');

    const themeStep = final.steps.find((s: { key: string }) => s.key === 'theme');
    expect(themeStep.status).toBe('completed');

    // Real persistence via the SAME `WebsiteConfigurationService` the
    // post-onboarding Website Settings theme tab uses — never a second
    // theme mechanism.
    const websiteConfig = await admin.websiteConfiguration.findUnique({
      where: { academyId: final.academyId },
    });
    expect(websiteConfig?.themeKey).toBe('bold-creative');

    // Reachable through the real, ordinary Website Configuration read
    // endpoint too — not just visible via a direct DB read.
    const configRes = await request(app.getHttpServer())
      .get(`/academies/${final.academyId}/website/configuration`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    expect(configRes.body.themeKey).toBe('bold-creative');
  });

  // --- 3c. Phase 6 — Complete Website generation -----------------------------

  it('3c: selecting a theme + "complete" setup mode generates a real, structured, bilingual website — never a fabricated statistic', async () => {
    const { owner, org } = await arrangeOrg('complete-gen');
    const subdomain = uniqueSubdomain('complete-gen');
    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Complete Gen Academy',
        requestedSubdomain: subdomain,
        selectedThemeKey: 'modern-education',
        websiteSetupMode: 'complete',
        idempotencyKey: `complete-gen-idem-${subdomain}`,
      })
      .expect(201);
    expect(created.body.websiteSetupMode).toBe('complete');

    const final = await waitForTerminal(owner, org.id, created.body.id);
    expect(final.status).toBe('ready');
    expect(final.websiteSetupMode).toBe('complete');

    const pages = await admin.websitePage.findMany({
      where: { academyId: final.academyId },
    });
    const byCoreType = Object.fromEntries(pages.map((page) => [page.coreType, page]));

    // The 4 shared support pages + Home all exist — never zero sections.
    for (const coreType of ['home', 'about', 'courses', 'faqs', 'contact']) {
      expect(byCoreType[coreType]).toBeTruthy();
      expect((byCoreType[coreType]!.sections as unknown[]).length).toBeGreaterThan(0);
    }

    const homeSections = byCoreType.home!.sections as Array<{
      type: string;
      config: Record<string, unknown>;
    }>;
    const hero = homeSections.find((section) => section.type === 'hero');
    expect(hero).toBeTruthy();
    const heroTitle = hero!.config.title as { en: string; ar: string };
    expect(heroTitle.en.trim()).not.toBe('');
    expect(heroTitle.ar.trim()).not.toBe('');
    // Real, interpolated, bilingual — never blank, never a raw
    // `{{academyName}}` token left unresolved. (Theme 1 template v2 names
    // the Academy in its "Why {{academyName}}" split, not the hero.)
    const split = homeSections.find((section) => section.type === 'featureSplit');
    const eyebrow = split!.config.eyebrow as { en: string; ar: string };
    expect(eyebrow.en).toBe('Why Complete Gen Academy');
    expect(eyebrow.ar).toBe('لماذا Complete Gen Academy');
    expect(JSON.stringify(homeSections)).not.toContain('{{');

    // Statistics is generated with a LIVE metric, never a hardcoded number — a brand-new Academy has 0 courses/students/instructors.
    const statistics = homeSections.find((section) => section.type === 'statistics');
    expect(statistics).toBeTruthy();
    const items = statistics!.config.items as Array<{
      metric?: string;
      value: { en: string };
    }>;
    expect(items.every((item) => !!item.metric)).toBe(true);

    // Hero's CTA target was resolved to the REAL Courses page id (ctaTargets → pageId), not left dangling.
    const cta = hero!.config.cta as { pageId?: string } | undefined;
    expect(cta?.pageId).toBe(byCoreType.courses!.id);

    // Navigation + footer + header CTA were generated too (structure/polish, §6 of the specification).
    const configuration = await admin.websiteConfiguration.findUnique({
      where: { academyId: final.academyId },
    });
    expect((configuration?.navigation as unknown[]).length).toBeGreaterThan(0);
    const footer = configuration?.footer as { groups: unknown[] };
    expect(footer.groups.length).toBeGreaterThan(0);
    const header = configuration?.header as { cta?: { authAction?: string } };
    expect(header.cta?.authAction).toBe('signUp');
  });

  // --- 3d. Phase 6 — Empty Academy generation ---------------------------------

  it('3d: selecting a theme with no explicit setup mode generates a real structured shell (never a fabricated stat), with minimal copy', async () => {
    const { owner, org } = await arrangeOrg('empty-gen');
    const subdomain = uniqueSubdomain('empty-gen');
    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Empty Gen Academy',
        requestedSubdomain: subdomain,
        selectedThemeKey: 'minimal-editorial',
        idempotencyKey: `empty-gen-idem-${subdomain}`,
      })
      .expect(201);
    // Omitted in the request — the DTO's own backward-compatible default.
    expect(created.body.websiteSetupMode).toBeUndefined();

    const final = await waitForTerminal(owner, org.id, created.body.id);
    expect(final.status).toBe('ready');

    const homePage = await admin.websitePage.findFirst({
      where: { academyId: final.academyId, coreType: 'home' },
    });
    expect(homePage).toBeTruthy();
    const sections = homePage!.sections as Array<{
      type: string;
      config: Record<string, unknown>;
    }>;
    expect(sections.length).toBeGreaterThan(0);

    const hero = sections.find((section) => section.type === 'hero');
    const heroTitle = hero!.config.title as { en: string; ar: string };
    // Minimal — just the real Academy name, never a theme-authored marketing sentence.
    expect(heroTitle.en).toBe('Empty Gen Academy');
  });

  // --- 3e. Phase 6 — idempotency / non-destructive re-generation --------------

  it("3e: re-running generation for an already-generated Academy never overwrites an Owner's real edit", async () => {
    const { owner, org } = await arrangeOrg('idempotent-gen');
    const subdomain = uniqueSubdomain('idempotent-gen');
    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Idempotent Gen Academy',
        requestedSubdomain: subdomain,
        selectedThemeKey: 'premium-academy',
        websiteSetupMode: 'complete',
        idempotencyKey: `idempotent-gen-idem-${subdomain}`,
      })
      .expect(201);
    const final = await waitForTerminal(owner, org.id, created.body.id);
    expect(final.status).toBe('ready');
    const academyId = final.academyId as string;

    // Simulate an Owner's real edit to the generated Home page.
    const homePage = await admin.websitePage.findFirst({
      where: { academyId, coreType: 'home' },
    });
    const editedSections = (
      homePage!.sections as Array<{ type: string; config: Record<string, unknown> }>
    ).map((section) =>
      section.type === 'hero'
        ? {
            ...section,
            config: {
              ...section.config,
              title: { en: 'My Own Edited Title', ar: 'عنواني المعدّل' },
            },
          }
        : section,
    );
    await admin.websitePage.update({
      where: { id: homePage!.id },
      data: { sections: editedSections as unknown as Prisma.InputJsonValue },
    });

    // Re-run generation directly — the same call the orchestrator's
    // 'theme' step makes, simulating a redelivered/retried step.
    // `website_configurations`/`website_pages` writes are RLS-gated on
    // `is_academy_member`, so this needs the real requester's user
    // context, not plain tenant context (see `executeThemeStep`'s own
    // updated doc comment).
    await tenancyContextService.runInTenantAndUserContext(org.id, owner.userId, (tx) =>
      websiteGenerationService.generate(tx, academyId, 'premium-academy', 'complete'),
    );

    const afterRegeneration = await admin.websitePage.findFirst({
      where: { academyId, coreType: 'home' },
    });
    const heroAfter = (
      afterRegeneration!.sections as Array<{
        type: string;
        config: Record<string, unknown>;
      }>
    ).find((section) => section.type === 'hero');
    const titleAfter = heroAfter!.config.title as { en: string; ar: string };
    expect(titleAfter.en).toBe('My Own Edited Title');
    expect(titleAfter.ar).toBe('عنواني المعدّل');

    // No duplicate page was created either.
    const homePagesCount = await admin.websitePage.count({
      where: { academyId, coreType: 'home' },
    });
    expect(homePagesCount).toBe(1);
  });

  // --- 3f. Theme 1 plan Phase 7 — template v2, end to end ----------------------

  it('3f: Theme 1 provisioning creates the v2 website; re-generation is idempotent and keeps Owner edits; samples stay private until confirmed', async () => {
    type Section = { id: string; type: string; config: Record<string, unknown> };
    const { owner, org } = await arrangeOrg('theme1-v2');
    const subdomain = uniqueSubdomain('theme1-v2');
    const created = await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Cedar Academy',
        requestedSubdomain: subdomain,
        selectedThemeKey: 'modern-education',
        websiteSetupMode: 'complete',
        idempotencyKey: `theme1-v2-idem-${subdomain}`,
      })
      .expect(201);
    const final = await waitForTerminal(owner, org.id, created.body.id);
    expect(final.status).toBe('ready');
    const academyId = final.academyId as string;

    const readPages = async () => {
      const rows = await admin.websitePage.findMany({ where: { academyId } });
      return Object.fromEntries(rows.map((row) => [row.coreType, row]));
    };
    const sectionsOf = (row: { sections: unknown }) => row.sections as Section[];

    // 1. Composition: §C.1 Home, a page hero first on every inner page.
    let pages = await readPages();
    expect(sectionsOf(pages.home!).map((section) => section.type)).toEqual([
      'hero',
      'features',
      'courseCategories',
      'featuredCourses',
      'featureSplit',
      'steps',
      'instructors',
      'statistics',
      'testimonials',
      'faq',
      'cta',
    ]);
    for (const coreType of ['about', 'courses', 'faqs', 'contact']) {
      expect(sectionsOf(pages[coreType]!)[0].type).toBe('pageHeader');
    }
    const aboutHero = sectionsOf(pages.about!)[0].config;
    expect(aboutHero.eyebrow).toEqual({
      en: 'About Cedar Academy',
      ar: 'عن Cedar Academy',
    });
    expect(aboutHero.image).toBe('theme-asset:modern-education/about-header');

    // Samples and live data (§D.4): three sample testimonials; metric-only numbers.
    const testimonials = sectionsOf(pages.home!).find(
      (section) => section.type === 'testimonials',
    )!;
    const sampleItems = testimonials.config.items as Array<Record<string, unknown>>;
    expect(sampleItems.map((item) => item.sample)).toEqual([true, true, true]);
    for (const coreType of ['home', 'about']) {
      const stats = sectionsOf(pages[coreType]!).find(
        (section) => section.type === 'statistics',
      )!;
      for (const item of stats.config.items as Array<Record<string, unknown>>) {
        expect(item.metric).toBeDefined();
        expect(item.value).toEqual({ en: '', ar: '' });
      }
    }
    // CTA intents resolved to this Academy's own pages.
    const hero = sectionsOf(pages.home!)[0].config;
    expect(hero.cta).toMatchObject({ pageId: pages.courses!.id });
    expect(hero.secondaryCta).toMatchObject({ pageId: pages.contact!.id });

    const configuration = await admin.websiteConfiguration.findUnique({
      where: { academyId },
    });
    expect(configuration).toMatchObject({
      themeKey: 'modern-education',
      templateKey: 'modern-education',
      templateVersion: 2,
    });

    // 2. Idempotent, and an Owner's edit survives a re-run.
    const aboutSections = sectionsOf(pages.about!).map((section, index) =>
      index === 0
        ? {
            ...section,
            config: { ...section.config, title: { en: 'Our own title', ar: 'عنواننا' } },
          }
        : section,
    );
    await admin.websitePage.update({
      where: { id: pages.about!.id },
      data: { sections: aboutSections as unknown as Prisma.InputJsonValue },
    });
    const before = JSON.stringify(await readPages());
    const rerun = await tenancyContextService.runInTenantAndUserContext(
      org.id,
      owner.userId,
      (tx) =>
        websiteGenerationService.generate(tx, academyId, 'modern-education', 'complete'),
    );
    expect(rerun.pagesCreated).toBe(0);
    expect(JSON.stringify(await readPages())).toBe(before);
    pages = await readPages();
    expect(sectionsOf(pages.about!)[0].config.title).toEqual({
      en: 'Our own title',
      ar: 'عنواننا',
    });
    // No duplicate page either: one row per core page.
    const rows = await admin.websitePage.findMany({ where: { academyId } });
    expect(new Set(rows.map((row) => row.coreType)).size).toBe(rows.length);

    // 3. The sample chain: publish lists the samples; none reach visitors.
    const published = await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(published.body.sampleContent).toEqual([
      {
        pageId: pages.home!.id,
        pageTitle: 'Home',
        sectionId: testimonials.id,
        sectionType: 'testimonials',
        sampleItems: 3,
      },
    ]);
    const publicHome = async () => {
      const res = await request(app.getHttpServer())
        .get(`/public/websites/${academyId}/pages`)
        .expect(200);
      const home = res.body.find(
        (page: { coreType: string }) => page.coreType === 'home',
      );
      return home.sections.find((section: Section) => section.type === 'testimonials') as
        Section | undefined;
    };
    const hidden = await publicHome();
    expect(hidden?.config.items ?? []).toEqual([]);

    // Confirming exactly one ("This is a real testimonial") makes exactly that one public.
    const homeView = await request(app.getHttpServer())
      .get(`/academies/${academyId}/website/pages/${pages.home!.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);
    const confirmed = (homeView.body.sections as Section[]).map((section) =>
      section.id === testimonials.id
        ? {
            ...section,
            config: {
              ...section.config,
              items: (section.config.items as Array<Record<string, unknown>>).map(
                (item, index) => (index === 0 ? { ...item, sample: false } : item),
              ),
            },
          }
        : section,
    );
    await request(app.getHttpServer())
      .patch(`/academies/${academyId}/website/pages/${pages.home!.id}`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ sections: confirmed, expectedVersion: homeView.body.version })
      .expect(200);
    const republished = await request(app.getHttpServer())
      .post(`/academies/${academyId}/website/publish`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);
    expect(republished.body.sampleContent[0].sampleItems).toBe(2);
    const visible = await publicHome();
    expect(
      (visible!.config.items as Array<{ id: string }>).map((item) => item.id),
    ).toEqual(['sample-testimonial-1']);
    expect(JSON.stringify(visible)).not.toContain('"sample":true');
  });

  // --- 4. Step/request bookkeeping persistence ------------------------------

  it('4: currentStepKey stays at the last step and every step timestamp is persisted', async () => {
    const { owner, org } = await arrangeOrg('bookkeeping');
    const created = await createRequest(owner, org.id);
    const final = await waitForTerminal(owner, org.id, created.id);

    expect(final.currentStepKey).toBe('finalization');
    for (const step of final.steps) {
      if (step.status === 'completed' || step.status === 'skipped') {
        expect(step.completedAt).toBeTruthy();
        expect(step.attemptNumber).toBeGreaterThanOrEqual(1);
      }
    }
  });

  // --- 5. Idempotent creation ------------------------------------------------

  it('5: replaying the same idempotency key returns the same request, never a duplicate', async () => {
    const { owner, org } = await arrangeOrg('idem-create');
    const idempotencyKey = `idem-fixed-${Date.now()}`;
    const first = await createRequest(owner, org.id, { idempotencyKey });
    const second = await createRequest(owner, org.id, {
      idempotencyKey,
      requestedSubdomain: uniqueSubdomain('should-be-ignored'),
    });

    expect(second.id).toBe(first.id);
    const count = await admin.provisioningRequest.count({
      where: { organizationId: org.id, idempotencyKey },
    });
    expect(count).toBe(1);
  });

  // --- 6. Reserved subdomain refused -----------------------------------------

  it('6: a reserved subdomain is refused at creation', async () => {
    const { owner, org } = await arrangeOrg('reserved-sub');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Reserved Academy',
        requestedSubdomain: 'admin',
        idempotencyKey: `idem-reserved-${Date.now()}`,
      })
      .expect(409);
  });

  // --- 7. Invalid subdomain shape refused -------------------------------------

  it('7: an invalid subdomain shape is refused with 400', async () => {
    const { owner, org } = await arrangeOrg('invalid-sub');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Invalid Academy',
        requestedSubdomain: 'AB',
        idempotencyKey: `idem-invalid-${Date.now()}`,
      })
      .expect(400);
  });

  // --- 8. triggeringPaymentId must belong to the caller's own organization ---

  it('8: a triggeringPaymentId from a different organization is refused with 404', async () => {
    const { owner, org } = await arrangeOrg('payment-ref-a');
    const { org: otherOrg } = await arrangeOrg('payment-ref-b');
    const foreignPayment = await admin.payment.create({
      data: {
        organizationId: otherOrg.id,
        methodKey: 'manual',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: 1000n,
        currency: 'USD',
        status: 'succeeded',
      },
    });

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({
        academyName: 'Payment Ref Academy',
        requestedSubdomain: uniqueSubdomain('payref'),
        idempotencyKey: `idem-payref-${Date.now()}`,
        triggeringPaymentId: foreignPayment.id,
      })
      .expect(404);
  });

  // --- 9. A valid triggeringPaymentId is persisted and returned ---------------

  it('9: a valid triggeringPaymentId (own organization) is accepted and returned', async () => {
    const { owner, org } = await arrangeOrg('payment-ref-ok');
    const payment = await admin.payment.create({
      data: {
        organizationId: org.id,
        methodKey: 'manual',
        methodType: 'manual_bank_transfer',
        provider: 'atlas_manual',
        amountMinorUnits: 2500n,
        currency: 'USD',
        status: 'succeeded',
      },
    });

    const body = await createRequest(owner, org.id, { triggeringPaymentId: payment.id });
    expect(body.triggeringPaymentId).toBe(payment.id);
  });

  // --- 10. Listing is organization-scoped and paginated ------------------------

  it("10: listing returns only this organization's requests, in a paginated envelope", async () => {
    const { owner, org } = await arrangeOrg('list-scope');
    await createRequest(owner, org.id);
    await createRequest(owner, org.id);

    const res = await request(app.getHttpServer())
      .get(`/organizations/${org.id}/provisioning-requests`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(200);

    expect(res.body.pagination).toMatchObject({ page: 1, totalItems: 2 });
    expect(res.body.items).toHaveLength(2);
    expect(
      res.body.items.every(
        (i: { organizationId: string }) => i.organizationId === org.id,
      ),
    ).toBe(true);
  });

  // --- 11. 404 for a nonexistent request id ------------------------------------

  it('11: getting a nonexistent request id returns 404', async () => {
    const { owner, org } = await arrangeOrg('not-found');
    await request(app.getHttpServer())
      .get(
        `/organizations/${org.id}/provisioning-requests/00000000-0000-0000-0000-000000000000`,
      )
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(404);
  });

  // --- 12. 401 without an access token ------------------------------------------

  it('12: creating a request without an access token returns 401', async () => {
    const { org } = await arrangeOrg('unauth');
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests`)
      .send({
        academyName: 'Unauth Academy',
        requestedSubdomain: uniqueSubdomain('unauth'),
        idempotencyKey: `idem-unauth-${Date.now()}`,
      })
      .expect(401);
  });

  // --- 13-17. Failure, retry, and resume ----------------------------------------

  it('13-17: a genuine academy-step failure is recorded, is retryable, resumes correctly, and never re-executes an already-completed step', async () => {
    const { owner, org } = await arrangeOrg('fail-resume');
    const { org: blockerOrg } = await arrangeOrg('fail-resume-blocker');
    const subdomain = uniqueSubdomain('blocked');

    // Blocks the academy step: a real academy in a DIFFERENT organization
    // already holds this exact globally-unique slug (test-fixture-only
    // construction via the admin connection — the app itself never lets
    // two academies share a slug). Belonging to a different organization
    // is essential here: RLS hides it from this request's own tenant
    // context, so the academy step's slug-conflict "adopt my own prior
    // attempt" path correctly does NOT trigger — this is a genuine,
    // unrecoverable-until-fixed failure, not an idempotent replay.
    const blocker = await admin.academy.create({
      data: { organizationId: blockerOrg.id, name: 'Blocker Academy', slug: subdomain },
    });

    const created = await createRequest(owner, org.id, {
      academyName: 'Resumable Academy',
      requestedSubdomain: subdomain,
    });

    // 13: failure mid-provisioning is recorded correctly.
    const failed = await waitForTerminal(owner, org.id, created.id);
    expect(failed.status).toBe('failed');
    expect(failed.failedAt).toBeTruthy();
    expect(failed.lastError).toBeTruthy();
    expect(failed.currentStepKey).toBe('academy');

    const stepsByKey = Object.fromEntries(
      failed.steps.map((s: { key: string; status: string; attemptNumber: number }) => [
        s.key,
        s,
      ]),
    );
    expect(stepsByKey.tenant.status).toBe('completed');
    expect(stepsByKey.tenant.attemptNumber).toBe(1);
    expect(stepsByKey.academy.status).toBe('failed');
    expect(stepsByKey.academy.attemptNumber).toBe(1);

    // 14: a ready/cancelled request cannot be retried, but a failed one can.
    // 15: resume after failure — remove the blocker (test-fixture cleanup,
    // not application logic) and retry.
    await admin.academy.delete({ where: { id: blocker.id } });
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${created.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    // `failed` is itself a valid terminal polling state, AND
    // `runToCompletion` commits its `attemptCount` bump, AND `markRunning`
    // commits its own `attemptNumber` bump, each in their OWN transaction
    // BEFORE the step's real outcome is persisted — so a check keyed on
    // either alone can still observe a transient in-between snapshot (the
    // academy step genuinely `running`, mid-retry) as if it were a
    // concluded new outcome. And once the academy step itself resolves,
    // the SAME `runToCompletion` call keeps going through the remaining
    // steps (theme/branding/subdomain/domain/finalization) before the
    // whole request reaches a real terminal status — so the wait condition
    // requires BOTH: the academy step genuinely re-executed (its own
    // `attemptNumber` advanced and it is no longer `running`), AND the
    // request as a whole has reached ready/failed/cancelled.
    const preRetryAcademyAttemptNumber = stepsByKey.academy.attemptNumber;
    const preRetryFailedAt = failed.failedAt;
    const resumed = await waitForAsync(async () => {
      const body = await getRequest(owner, org.id, created.id);
      const academyStep = body.steps.find(
        (s: { key: string; attemptNumber: number; status: string }) =>
          s.key === 'academy',
      );
      const academyStepResolved =
        academyStep.attemptNumber > preRetryAcademyAttemptNumber &&
        academyStep.status !== 'running';
      /*
       * `failed` is NOT usable on its own as "the retry has concluded".
       * `retryRequest` deliberately only enqueues a job — it does not clear
       * `status` or `failedAt` (see its own implementation) — so between
       * the retry being accepted and the worker transitioning the request,
       * `status` still reads `failed` from the PREVIOUS attempt. Treating
       * that as a concluded new outcome is how this test used to observe a
       * stale verdict: the academy step had genuinely re-executed and
       * completed, the request was still momentarily carrying the old
       * `failed`, both halves of the condition were satisfied at once, and
       * the wait returned before the remaining steps had run.
       *
       * `failedAt` is what separates the two: a retry that genuinely fails
       * again stamps a NEW one, so a real re-failure is still observed
       * promptly and still fails the assertion below — this waits for the
       * right event, it does not tolerate a wrong one.
       */
      const reachedNewTerminal =
        body.status === 'ready' ||
        body.status === 'cancelled' ||
        (body.status === 'failed' && body.failedAt !== preRetryFailedAt);
      return academyStepResolved && reachedNewTerminal ? body : undefined;
    });
    expect(resumed.status).toBe('ready');
    expect(resumed.academyId).toBeTruthy();

    const resumedStepsByKey = Object.fromEntries(
      resumed.steps.map((s: { key: string; status: string; attemptNumber: number }) => [
        s.key,
        s,
      ]),
    );
    // 16: the already-completed `tenant` step was never re-executed — its
    // attemptNumber is still exactly 1, even though the request as a whole
    // was retried.
    expect(resumedStepsByKey.tenant.attemptNumber).toBe(1);
    // 17: the failed `academy` step WAS re-executed on retry — its
    // attemptNumber advanced from 1 to 2, and it now succeeds.
    expect(resumedStepsByKey.academy.attemptNumber).toBe(2);
    expect(resumedStepsByKey.academy.status).toBe('completed');

    // Exactly one real Academy exists for this request — no duplicate
    // Academy creation across the failed + retried attempts.
    const academyCount = await admin.academy.count({ where: { slug: subdomain } });
    expect(academyCount).toBe(1);
  });

  // --- 18. A ready request cannot be retried -------------------------------------

  it('18: retrying an already-ready request is refused with 409', async () => {
    const { owner, org } = await arrangeOrg('retry-ready');
    const created = await createRequest(owner, org.id);
    await waitForTerminal(owner, org.id, created.id);

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${created.id}/retry`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  // --- 19. Cancellation ------------------------------------------------------------

  it('19: cancelling a non-terminal request transitions it to cancelled, and a cancelled request cannot be cancelled again', async () => {
    const { owner, org } = await arrangeOrg('cancel-flow');
    // Seeded directly via the admin connection, deliberately WITHOUT ever
    // enqueuing a worker job — genuinely, deterministically non-terminal
    // (`payment_success`, the real initial status), rather than racing the
    // real worker to catch it mid-flight. Mirrors `db-admin.ts`'s own
    // "elevated connection for fixture arrangement only" precedent; the
    // SYSTEM UNDER TEST here is the cancel endpoint, not step execution.
    const subdomain = uniqueSubdomain('cancel');
    const seeded = await admin.provisioningRequest.create({
      data: {
        organizationId: org.id,
        requestedByUserId: owner.userId,
        requestedAcademyName: 'Cancel Me Academy',
        requestedSubdomain: subdomain,
        idempotencyKey: `idem-cancel-${subdomain}`,
      },
    });
    await admin.provisioningStep.createMany({
      data: [
        'tenant',
        'academy',
        'theme',
        'branding',
        'subdomain',
        'domain',
        'finalization',
      ].map((key) => ({
        provisioningRequestId: seeded.id,
        key: key as
          | 'tenant'
          | 'academy'
          | 'theme'
          | 'branding'
          | 'subdomain'
          | 'domain'
          | 'finalization',
      })),
    });

    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(201);

    const cancelled = await getRequest(owner, org.id, seeded.id);
    expect(cancelled.status).toBe('cancelled');

    // Cancelling an already-terminal (`cancelled`) request is refused.
    await request(app.getHttpServer())
      .post(`/organizations/${org.id}/provisioning-requests/${seeded.id}/cancel`)
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .expect(409);
  });

  // --- 20. Worker redelivery of an already-terminal request is a safe no-op --------

  it('20: redelivering a job for an already-ready request never re-creates the Academy/subdomain and never bumps attemptCount', async () => {
    const { owner, org } = await arrangeOrg('redelivery');
    const created = await createRequest(owner, org.id);
    const ready = await waitForTerminal(owner, org.id, created.id);
    expect(ready.status).toBe('ready');

    await provisioningProducer.enqueue({
      provisioningRequestId: created.id,
      organizationId: org.id,
    });
    // Give the (real) worker a moment to pick this up and no-op.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await getRequest(owner, org.id, created.id);
    expect(after.attemptCount).toBe(ready.attemptCount);
    expect(after.completedAt).toBe(ready.completedAt);

    const academyCount = await admin.academy.count({ where: { id: ready.academyId } });
    expect(academyCount).toBe(1);
    const subdomainCount = await admin.subdomainAllocation.count({
      where: { academyId: ready.academyId },
    });
    expect(subdomainCount).toBe(1);
  });

  // --- 21. Skipped steps are never re-executed --------------------------------------

  it('21: skipped steps (theme/branding/domain) keep their original attemptNumber across a redelivery', async () => {
    const { owner, org } = await arrangeOrg('skip-no-rerun');
    const created = await createRequest(owner, org.id);
    const ready = await waitForTerminal(owner, org.id, created.id);
    const before = Object.fromEntries(
      ready.steps.map((s: { key: string; attemptNumber: number }) => [
        s.key,
        s.attemptNumber,
      ]),
    );

    await provisioningProducer.enqueue({
      provisioningRequestId: created.id,
      organizationId: org.id,
    });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const after = await getRequest(owner, org.id, created.id);
    const afterByKey = Object.fromEntries(
      after.steps.map((s: { key: string; attemptNumber: number }) => [
        s.key,
        s.attemptNumber,
      ]),
    );
    expect(afterByKey.theme).toBe(before.theme);
    expect(afterByKey.branding).toBe(before.branding);
    expect(afterByKey.domain).toBe(before.domain);
  });

  // --- 22. Subdomain availability --------------------------------------------------

  describe('GET /subdomains/availability', () => {
    it('22a: a reserved subdomain reports status "reserved"', async () => {
      const { owner } = await arrangeOrg('avail-reserved');
      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: 'atlas' })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ subdomain: 'atlas', status: 'reserved' });
    });

    it('22b: an already-allocated subdomain reports status "unavailable"', async () => {
      const { owner, org } = await arrangeOrg('avail-taken');
      const created = await createRequest(owner, org.id);
      const ready = await waitForTerminal(owner, org.id, created.id);

      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: ready.subdomain.subdomain })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({
        subdomain: ready.subdomain.subdomain,
        status: 'unavailable',
      });
    });

    it('22c: a fresh, non-reserved subdomain reports status "available"', async () => {
      const { owner } = await arrangeOrg('avail-free');
      const subdomain = uniqueSubdomain('brand-new');
      const res = await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain })
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .expect(200);
      expect(res.body).toMatchObject({ subdomain, status: 'available' });
    });

    it('22d: checking availability without an access token returns 401', async () => {
      await request(app.getHttpServer())
        .get('/subdomains/availability')
        .query({ subdomain: uniqueSubdomain('noauth') })
        .expect(401);
    });
  });
});
