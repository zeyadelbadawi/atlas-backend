/**
 * Prepares the seeded Academy for the frontend browser journeys J1–J6
 * (`atlas/e2e/j1-*.spec.ts` … `j6-*.spec.ts`).
 *
 * Those journeys reach the seeded `web-development-academy` through its
 * public website (`GET /public/websites/resolve?hostname=<slug>`, learner
 * sign-up on the academy site). `prisma/seed.ts` creates the Academy but,
 * like any Academy created outside provisioning, no subdomain and no
 * website, so resolve answers 404. The seed itself is left alone: the
 * backend e2e suites are written against it as it is.
 *
 * What this does, idempotently, for the one seeded Academy:
 *   1. assigns its subdomain (label = slug), exactly the row provisioning's
 *      subdomain step writes;
 *   2. selects Theme 1 and generates its website through the real
 *      `WebsiteGenerationService` (existing pages are kept);
 *   3. publishes it through `WebsiteConfigurationService` as the seeded
 *      owner.
 *
 * Local and CI databases only — it refuses to run with NODE_ENV=production.
 *
 *   npm run e2e:prepare-journeys [-- <academy-slug>]
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import type { PlatformDomainRuntimeConfig } from '../src/config/configuration';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { WebsiteConfigurationService } from '../src/website/services/website-configuration.service';
import { WebsiteGenerationService } from '../src/website/services/website-generation.service';

const OWNER_EMAIL = 'sarah.chen@acme-academy.dev';
const THEME = 'modern-education';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('prepare-journey-fixtures is for local and CI databases only.');
  }
  const slug = process.argv[2] ?? 'web-development-academy';
  const prisma = new PrismaClient();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const academy = await prisma.academy.findUnique({
      where: { slug },
      select: { id: true, organizationId: true },
    });
    if (!academy) throw new Error(`No academy "${slug}". Seed the database first.`);
    const owner = await prisma.user.findUnique({
      where: { email: OWNER_EMAIL },
      select: { id: true },
    });
    if (!owner) throw new Error(`No seeded owner ${OWNER_EMAIL}.`);

    const baseDomain = app
      .get(ConfigService)
      .get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;
    await prisma.subdomainAllocation.upsert({
      where: { academyId: academy.id },
      update: { subdomain: slug, status: 'assigned' },
      create: {
        academyId: academy.id,
        subdomain: slug,
        status: 'assigned',
        fullHost: baseDomain ? `${slug}.${baseDomain}` : null,
      },
    });

    const configuration = app.get(WebsiteConfigurationService);
    await configuration.updateConfiguration(
      academy.id,
      academy.organizationId,
      owner.id,
      {
        themeKey: THEME,
      },
    );
    const generated = await app
      .get(TenancyContextService)
      .runInTenantAndUserContext(academy.organizationId, owner.id, (tx) =>
        app.get(WebsiteGenerationService).generate(tx, academy.id, THEME, 'complete'),
      );
    await configuration.publishConfiguration(
      academy.id,
      academy.organizationId,
      owner.id,
    );

    // eslint-disable-next-line no-console
    console.log(
      `Prepared ${slug}: subdomain assigned, website ${THEME} ` +
        `(${generated.pagesCreated} pages created, ${generated.pagesSkipped} kept), published.`,
    );
  } finally {
    await app.close();
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('prepare-journey-fixtures failed:', error);
  process.exit(1);
});
