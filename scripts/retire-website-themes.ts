/**
 * Themes 2–5 retirement (frontend repo, Reports/THEMES_2_5_RETIREMENT.md): moves every
 * Academy website on a retired theme (`RETIRED_WEBSITE_THEME_KEYS`, or a
 * key no code knows) to `RETIRED_WEBSITE_THEME_REPLACEMENT` (Theme 1).
 *
 * What it writes, per website, and nothing else:
 *   `website_configurations.theme_key`  → 'modern-education'
 *   `website_configurations.config_version` + 1 (keys the public cache,
 *     `PublicWebsiteCacheService`, so the live site picks the change up)
 * Pages, sections, brand colours, palette, logos, navigation, header,
 * footer, SEO, publish status and the template provenance are untouched;
 * a fingerprint of all of them (`websiteContentFingerprint`) is taken
 * before the write and checked again after it, inside the same
 * transaction, which rolls back on any difference.
 *
 * Gated, in three steps (each writes a JSON report, `--out`):
 *   1. Dry run (default, read-only): what would move, per website.
 *        npm run db:retire-website-themes -- --out=plan.json
 *   2. Apply exactly a reviewed dry run. A website is moved only if it is
 *      still on the theme, with the fingerprint, the plan recorded; anything
 *      that changed since is skipped and listed. Re-running is a no-op.
 *        npm run db:retire-website-themes -- --apply --plan=plan.json --out=applied.json
 *   3. Rollback (dry run unless --apply): restores each moved website's
 *      previous key, only where the website is still on Theme 1 with the
 *      same content (an Owner edit since is listed, not overwritten).
 *        npm run db:retire-website-themes -- --rollback=applied.json [--apply] --out=rolled-back.json
 *
 * Writes go through the real tenant-scoped repository inside
 * `runInTenantAndUserContext`, as one of the Academy's own active owners
 * (RLS: `is_academy_member`), never an RLS bypass; the cross-tenant
 * listing runs as the Platform Owner (`*_platform_select` policies), like
 * `backfill-nav-footer-ar-labels.ts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import type { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { UsersRepository } from '../src/identity/repositories/users.repository';
import {
  RETIRED_WEBSITE_THEME_KEYS,
  RETIRED_WEBSITE_THEME_REPLACEMENT,
} from '../src/website/constants/website.constants';
import {
  planThemeRetirement,
  summariseThemeRetirement,
  websiteContentFingerprint,
  type ThemeRetirementPlanEntry,
  type ThemeRetirementWebsite,
} from '../src/website/utils/theme-retirement.util';

type Mode = 'dry-run' | 'apply' | 'rollback-dry-run' | 'rollback';

interface AcademyRow {
  readonly id: string;
  readonly organizationId: string;
  readonly name: string;
  readonly slug: string;
}

interface Outcome {
  readonly academyId: string;
  readonly academySlug: string;
  readonly result:
    | 'wouldMove'
    | 'moved'
    | 'wouldRestore'
    | 'restored'
    | 'alreadyDone'
    | 'skippedChangedSincePlan'
    | 'skippedNoActiveOwner'
    | 'skippedNoWebsite'
    | 'skippedUnmappableSections';
  readonly fromThemeKey?: string;
  readonly toThemeKey?: string;
  readonly fingerprint?: string;
  readonly configVersionBefore?: number;
  readonly configVersionAfter?: number;
  readonly detail?: string;
}

function argValue(name: string): string | undefined {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return flag?.slice(name.length + 3);
}

/** Longer interactive-transaction timeout for the cross-tenant listing (see `backfill-nav-footer-ar-labels.ts`). */
async function asPlatformOwner<T>(
  prisma: PrismaService,
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return work(tx);
    },
    { timeout: 60000 },
  );
}

async function readWebsite(
  tx: Prisma.TransactionClient,
  academy: AcademyRow,
): Promise<ThemeRetirementWebsite | null> {
  const configuration = await tx.websiteConfiguration.findUnique({
    where: { academyId: academy.id },
  });
  if (!configuration) return null;
  const pages = await tx.websitePage.findMany({
    where: { academyId: academy.id },
    select: {
      id: true,
      slug: true,
      pageType: true,
      coreType: true,
      visible: true,
      seo: true,
      sections: true,
      version: true,
    },
  });
  return {
    academyId: academy.id,
    organizationId: academy.organizationId,
    academyName: academy.name,
    academySlug: academy.slug,
    themeKey: configuration.themeKey,
    themeVersion: configuration.themeVersion,
    configVersion: configuration.configVersion,
    templateKey: configuration.templateKey,
    templateVersion: configuration.templateVersion,
    status: configuration.status,
    brand: configuration.brand,
    seo: configuration.seo,
    navigation: configuration.navigation,
    header: configuration.header,
    footer: configuration.footer,
    pages: pages.map((page) => ({ ...page, coreType: page.coreType ?? null })),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const planFile = argValue('plan');
  const rollbackFile = argValue('rollback');
  const outFile =
    argValue('out') ??
    `theme-retirement-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;

  if (planFile && rollbackFile) throw new Error('Pass --plan or --rollback, not both.');
  if (apply && !planFile && !rollbackFile) {
    throw new Error(
      '--apply needs --plan=<dry-run report> (or --rollback=<apply report>): ' +
        'only a reviewed dry run is ever applied.',
    );
  }
  const mode: Mode = rollbackFile
    ? apply
      ? 'rollback'
      : 'rollback-dry-run'
    : apply
      ? 'apply'
      : 'dry-run';

  /** academyId → what the reviewed plan (or the apply report) recorded. */
  const approved = new Map<string, { fromThemeKey: string; fingerprint: string }>();
  if (planFile) {
    const plan = JSON.parse(readFileSync(planFile, 'utf8')) as {
      mode: Mode;
      entries: ThemeRetirementPlanEntry[];
    };
    if (plan.mode !== 'dry-run') throw new Error(`${planFile} is not a dry-run report.`);
    for (const entry of plan.entries) {
      approved.set(entry.academyId, {
        fromThemeKey: entry.fromThemeKey,
        fingerprint: entry.fingerprint,
      });
    }
  }
  if (rollbackFile) {
    const applied = JSON.parse(readFileSync(rollbackFile, 'utf8')) as {
      mode: Mode;
      outcomes: Outcome[];
    };
    if (applied.mode !== 'apply')
      throw new Error(`${rollbackFile} is not an apply report.`);
    for (const outcome of applied.outcomes) {
      if (outcome.result === 'moved' && outcome.fromThemeKey && outcome.fingerprint) {
        approved.set(outcome.academyId, {
          fromThemeKey: outcome.fromThemeKey,
          fingerprint: outcome.fingerprint,
        });
      }
    }
  }

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const tenancy = app.get(TenancyContextService);
    const platformOwner = await app.get(UsersRepository).findFirstPlatformOwnerId();
    if (!platformOwner)
      throw new Error('No platform owner account exists; cannot list Academies.');

    const academies: AcademyRow[] = [];
    for (let skip = 0; ; skip += 200) {
      const page = await asPlatformOwner(prisma, platformOwner.id, (tx) =>
        tx.academy.findMany({
          select: { id: true, organizationId: true, name: true, slug: true },
          orderBy: { createdAt: 'asc' },
          skip,
          take: 200,
        }),
      );
      academies.push(...page);
      if (page.length < 200) break;
    }

    const entries: ThemeRetirementPlanEntry[] = [];
    const outcomes: Outcome[] = [];

    for (const academy of academies) {
      const target = rollbackFile || planFile ? approved.get(academy.id) : undefined;
      if ((rollbackFile || planFile) && !target) continue;

      const owner = await asPlatformOwner(prisma, platformOwner.id, (tx) =>
        tx.academyMember.findFirst({
          where: { academyId: academy.id, role: 'owner', status: 'active' },
          orderBy: { joinedAt: 'asc' },
          select: { userId: true },
        }),
      );
      if (!owner) {
        outcomes.push({
          academyId: academy.id,
          academySlug: academy.slug,
          result: 'skippedNoActiveOwner',
        });
        continue;
      }

      await tenancy.runInTenantAndUserContext(
        academy.organizationId,
        owner.userId,
        async (tx) => {
          const website = await readWebsite(tx, academy);
          if (!website) {
            if (target) {
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'skippedNoWebsite',
              });
            }
            return;
          }
          const fingerprint = websiteContentFingerprint(website);

          if (rollbackFile && target) {
            if (website.themeKey === target.fromThemeKey) {
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'alreadyDone',
              });
              return;
            }
            if (
              website.themeKey !== RETIRED_WEBSITE_THEME_REPLACEMENT ||
              fingerprint !== target.fingerprint
            ) {
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'skippedChangedSincePlan',
                detail: `now on ${website.themeKey}; content ${fingerprint === target.fingerprint ? 'unchanged' : 'edited since the move'}`,
              });
              return;
            }
            if (mode === 'rollback') {
              const updated = await tx.websiteConfiguration.update({
                where: { academyId: academy.id },
                data: { themeKey: target.fromThemeKey, configVersion: { increment: 1 } },
              });
              const after = await readWebsite(tx, academy);
              if (!after || websiteContentFingerprint(after) !== fingerprint) {
                throw new Error(
                  `Content changed while restoring ${academy.slug}; rolled back.`,
                );
              }
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'restored',
                fromThemeKey: RETIRED_WEBSITE_THEME_REPLACEMENT,
                toThemeKey: target.fromThemeKey,
                fingerprint,
                configVersionBefore: website.configVersion,
                configVersionAfter: updated.configVersion,
              });
            } else {
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'wouldRestore',
                toThemeKey: target.fromThemeKey,
                fingerprint,
              });
            }
            return;
          }

          const entry = planThemeRetirement(website);
          if (!entry) {
            if (target) {
              outcomes.push({
                academyId: academy.id,
                academySlug: academy.slug,
                result: 'alreadyDone',
              });
            }
            return;
          }
          if (mode === 'dry-run') {
            entries.push(entry);
            outcomes.push({
              academyId: academy.id,
              academySlug: academy.slug,
              result: 'wouldMove',
              fromThemeKey: entry.fromThemeKey,
              toThemeKey: entry.toThemeKey,
              fingerprint,
            });
            return;
          }

          // Apply: exactly what was reviewed, and only if nothing changed since.
          if (
            !target ||
            target.fromThemeKey !== entry.fromThemeKey ||
            target.fingerprint !== fingerprint
          ) {
            outcomes.push({
              academyId: academy.id,
              academySlug: academy.slug,
              result: 'skippedChangedSincePlan',
              fromThemeKey: entry.fromThemeKey,
              detail:
                'theme or content changed since the dry run; re-run the dry run and review it',
            });
            return;
          }
          if (entry.unmappableSections.length > 0) {
            outcomes.push({
              academyId: academy.id,
              academySlug: academy.slug,
              result: 'skippedUnmappableSections',
              fromThemeKey: entry.fromThemeKey,
              detail: JSON.stringify(entry.unmappableSections),
            });
            return;
          }
          const updated = await tx.websiteConfiguration.update({
            where: { academyId: academy.id },
            data: {
              themeKey: RETIRED_WEBSITE_THEME_REPLACEMENT,
              configVersion: { increment: 1 },
            },
          });
          const after = await readWebsite(tx, academy);
          if (!after || websiteContentFingerprint(after) !== fingerprint) {
            throw new Error(`Content changed while moving ${academy.slug}; rolled back.`);
          }
          outcomes.push({
            academyId: academy.id,
            academySlug: academy.slug,
            result: 'moved',
            fromThemeKey: entry.fromThemeKey,
            toThemeKey: RETIRED_WEBSITE_THEME_REPLACEMENT,
            fingerprint,
            configVersionBefore: website.configVersion,
            configVersionAfter: updated.configVersion,
          });
        },
      );
    }

    // In-flight provisioning requests that picked a retired theme: the
    // orchestrator's theme step applies the replacement for them
    // (`selectableWebsiteThemeKey`); listed so nothing is a surprise.
    const pendingProvisioning = await asPlatformOwner(prisma, platformOwner.id, (tx) =>
      tx.provisioningRequest.findMany({
        where: {
          selectedThemeKey: { in: [...RETIRED_WEBSITE_THEME_KEYS] },
          status: { notIn: ['ready', 'failed', 'cancelled'] },
        },
        select: { id: true, organizationId: true, selectedThemeKey: true, status: true },
      }),
    );

    const count = (result: Outcome['result']): number =>
      outcomes.filter((outcome) => outcome.result === result).length;
    const report = {
      mode,
      generatedAt: new Date().toISOString(),
      plan: planFile ?? null,
      rollbackOf: rollbackFile ?? null,
      summary:
        mode === 'dry-run'
          ? summariseThemeRetirement(academies.length, entries)
          : {
              moved: count('moved'),
              restored: count('restored'),
              wouldRestore: count('wouldRestore'),
              alreadyDone: count('alreadyDone'),
              skippedChangedSincePlan: count('skippedChangedSincePlan'),
              skippedUnmappableSections: count('skippedUnmappableSections'),
              skippedNoActiveOwner: count('skippedNoActiveOwner'),
              skippedNoWebsite: count('skippedNoWebsite'),
            },
      entries,
      outcomes,
      pendingProvisioningRequests: pendingProvisioning,
    };
    writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);

    // eslint-disable-next-line no-console
    console.log(`${mode}: ${JSON.stringify(report.summary)}\nReport: ${outFile}`);
    if (mode === 'dry-run') {
      // eslint-disable-next-line no-console
      console.log('Review the report, then: --apply --plan=<this report>');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('retire-website-themes failed:', error);
  process.exit(1);
});
