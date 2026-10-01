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
 * What this does, idempotently, for each seeded Academy it is given (by
 * default the two the journeys use):
 *   1. assigns its subdomain (label = slug), exactly the row provisioning's
 *      subdomain step writes;
 *   2. selects Theme 1 and generates its website through the real
 *      `WebsiteGenerationService` (existing pages are kept);
 *   3. publishes it through `WebsiteConfigurationService` as the
 *      Academy's own owner.
 *
 * Local and CI databases only — it refuses to run with NODE_ENV=production.
 *
 *   npm run e2e:prepare-journeys [-- <academy-slug> ...]
 */
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import type { PlatformDomainRuntimeConfig } from '../src/config/configuration';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { WebsiteConfigurationService } from '../src/website/services/website-configuration.service';
import { WebsiteGenerationService } from '../src/website/services/website-generation.service';

/** J1–J6 use the first; J4 also needs a second academy in another organization. */
const DEFAULT_SLUGS = ['web-development-academy', 'language-learning-hub'];
const THEME = 'modern-education';

async function main(): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('prepare-journey-fixtures is for local and CI databases only.');
  }
  const slugs = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_SLUGS;
  const prisma = new PrismaClient();
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const baseDomain = app
      .get(ConfigService)
      .get<PlatformDomainRuntimeConfig>('platformDomain')?.baseDomain;
    const configuration = app.get(WebsiteConfigurationService);

    for (const slug of slugs) {
      const academy = await prisma.academy.findUnique({
        where: { slug },
        select: { id: true, organizationId: true },
      });
      if (!academy) throw new Error(`No academy "${slug}". Seed the database first.`);
      const owner = await prisma.academyMember.findFirst({
        where: { academyId: academy.id, role: 'owner', status: 'active' },
        select: { userId: true },
      });
      if (!owner) throw new Error(`Academy "${slug}" has no active owner.`);

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

      await configuration.updateConfiguration(
        academy.id,
        academy.organizationId,
        owner.userId,
        { themeKey: THEME },
      );
      const generated = await app
        .get(TenancyContextService)
        .runInTenantAndUserContext(academy.organizationId, owner.userId, (tx) =>
          app.get(WebsiteGenerationService).generate(tx, academy.id, THEME, 'complete'),
        );
      await configuration.publishConfiguration(
        academy.id,
        academy.organizationId,
        owner.userId,
      );

      // eslint-disable-next-line no-console
      console.log(
        `Prepared ${slug}: subdomain assigned, website ${THEME} ` +
          `(${generated.pagesCreated} pages created, ${generated.pagesSkipped} kept), published.`,
      );
    }
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
