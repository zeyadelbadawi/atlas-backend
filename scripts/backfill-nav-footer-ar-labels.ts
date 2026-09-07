/**
 * One-time, additive backfill for Academies whose website was generated
 * BEFORE the `CORE_PAGE_DEFAULTS`/`WebsiteGenerationService` fix that gives
 * auto-generated navigation items and footer "Quick Links" a real Arabic
 * label instead of `ar: ''` (see those files' own doc comments for the
 * root cause this closes).
 *
 * `generateNavigation`/`generateFooterAndHeaderCta` only ever write into
 * `navigation`/`footer` while they are still at their untouched bootstrap
 * default — once a real (even English-only) array has been written, they
 * never run again for that Academy. Fixing the generator therefore only
 * helps Academies generated AFTER this fix; this script is the one-time,
 * narrow, additive catch-up for Academies generated before it.
 *
 * Safety (per "do not make destructive changes, must not unexpectedly
 * break existing Academies"):
 *   - Only ever fills a blank `label.ar` (`''`/missing) — never touches a
 *     non-empty `ar`, which would silently discard a real Owner edit.
 *   - Only touches an item whose `label.en` is an EXACT, byte-for-byte
 *     match of one of `CORE_PAGE_DEFAULTS`' own known default titles
 *     (`Home`/`About`/`Courses`/`FAQs`/`Contact`/`Course Details`) — an
 *     Owner who retitled a nav item in English (e.g. "About" → "Our
 *     Story") is definitionally no longer an untouched default and is
 *     left completely alone.
 *   - Writes through the real, tenant-scoped `WebsiteConfigurationRepository.
 *     update` inside `runInTenantAndUserContext`, using the real
 *     Organization Owner's own id (never a superuser/RLS-bypass path) —
 *     the exact same write path/policy every real Owner edit already uses.
 *   - Read-only dry run by default; pass `--apply` to actually write.
 *
 * Usage:
 *   npm run db:backfill-nav-ar-labels            # dry run, prints a report
 *   npm run db:backfill-nav-ar-labels -- --apply  # writes for real
 */
import { NestFactory } from '@nestjs/core';
import type { Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenancyContextService } from '../src/tenancy/services/tenancy-context.service';
import { AcademiesRepository } from '../src/academy/repositories/academies.repository';
import { WebsiteConfigurationRepository } from '../src/website/repositories/website-configuration.repository';
import { UsersRepository } from '../src/identity/repositories/users.repository';
import { CORE_PAGE_DEFAULTS } from '../src/website/services/website-bootstrap.service';

interface LocalizedTextLike {
  readonly en: string;
  readonly ar: string;
}

interface NavigationItemLike {
  readonly id: string;
  readonly label: LocalizedTextLike;
  readonly [key: string]: unknown;
}

interface FooterLinkLike {
  readonly id: string;
  readonly label: LocalizedTextLike;
  readonly [key: string]: unknown;
}

interface FooterGroupLike {
  readonly id: string;
  readonly title: LocalizedTextLike;
  readonly links: readonly FooterLinkLike[];
  readonly [key: string]: unknown;
}

/** English default title → its real Arabic counterpart, from the same one source `WebsiteGenerationService` now reads. */
const AR_BY_EN_TITLE = new Map<string, string>(
  Object.values(CORE_PAGE_DEFAULTS).map((defaults) => [defaults.title, defaults.titleAr]),
);
const QUICK_LINKS_AR = 'روابط سريعة';

function isBlank(value: string | undefined | null): boolean {
  return !value || value.trim().length === 0;
}

/**
 * Same exact mechanism as `TenancyContextService.runInUserContext` (one
 * `set_config('app.current_user_id', ...)` inside its own transaction) —
 * duplicated here (not imported) only to pass a longer `$transaction`
 * `timeout`, which that shared method's signature has no parameter for.
 * Needed specifically for the platform-wide `academies`/`organizations`
 * enumeration below: `organizations_platform_select`'s `is_platform_owner()`
 * OR-branch is non-sargable (see `ATLAS_SCALE_VALIDATION_PHASE_4_6_*`
 * reports — an already-documented, pre-existing performance issue, not
 * something introduced or fixed by this script), so on a dev database with
 * a large accumulated Organization count a query can legitimately take
 * longer than Prisma's normal 5000ms interactive-transaction ceiling even
 * for a single, reasonably small page.
 */
async function runInUserContextWithTimeout<T>(
  prisma: PrismaService,
  userId: string,
  work: (tx: Prisma.TransactionClient) => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return prisma.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_user_id', ${userId}, true)`;
      return work(tx);
    },
    { timeout: timeoutMs },
  );
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });

  try {
    const prisma = app.get(PrismaService);
    const tenancyContext = app.get(TenancyContextService);
    const academiesRepository = app.get(AcademiesRepository);
    const websiteConfigurationRepository = app.get(WebsiteConfigurationRepository);
    const usersRepository = app.get(UsersRepository);

    const platformOwner = await usersRepository.findFirstPlatformOwnerId();
    if (!platformOwner) {
      throw new Error('No platform owner account exists — cannot list Academies cross-tenant.');
    }

    // Cross-tenant read only (`academies_platform_select`/
    // `organizations_platform_select`) — every WRITE below still goes
    // through the real, tenant-scoped, Owner-authorized path. Each page is
    // its OWN short `runInUserContext` transaction, never one long-running
    // transaction spanning the whole list — the shared dev database this
    // was first run against has accumulated tens of thousands of
    // Organization/Academy rows from years of prior test sessions (already
    // documented in `ATLAS_SCALABILITY_ARCHITECTURE_PLAN.md`/Phase 4.6's
    // own reports), which is large enough that a single interactive
    // transaction holding the whole enumeration open reliably exceeds
    // Prisma's 5000ms interactive-transaction ceiling (`P2028`) — the same
    // pre-existing, already-documented class of issue, not a new one this
    // script introduces. Paging outside the transaction avoids it.
    const academies: { id: string; organizationId: string; name: string }[] = [];
    let skip = 0;
    const take = 200;
    for (;;) {
      const { items } = await runInUserContextWithTimeout(
        prisma,
        platformOwner.id,
        (tx) => academiesRepository.findManyAnyOrganization(tx, { skip, take }),
        60000,
      );
      if (items.length === 0) break;
      academies.push(...items.map((item) => ({ id: item.id, organizationId: item.organizationId, name: item.name })));
      if (items.length < take) break;
      skip += take;
    }

    const organizationIds = [...new Set(academies.map((a) => a.organizationId))];
    const ownerUserIdByOrganizationId = new Map<string, string>();
    const orgBatchSize = 500;
    for (let i = 0; i < organizationIds.length; i += orgBatchSize) {
      const batch = organizationIds.slice(i, i + orgBatchSize);
      const organizations = await runInUserContextWithTimeout(
        prisma,
        platformOwner.id,
        (tx) => tx.organization.findMany({ where: { id: { in: batch } }, select: { id: true, ownerUserId: true } }),
        60000,
      );
      for (const org of organizations) ownerUserIdByOrganizationId.set(org.id, org.ownerUserId);
    }

    let scanned = 0;
    let navItemsFixed = 0;
    let footerLinksFixed = 0;
    let footerTitlesFixed = 0;
    let skippedNoOwner = 0;

    for (const academy of academies) {
      scanned += 1;
      const ownerUserId = ownerUserIdByOrganizationId.get(academy.organizationId);
      if (!ownerUserId) {
        skippedNoOwner += 1;
        continue;
      }

      await tenancyContext.runInTenantAndUserContext(academy.organizationId, ownerUserId, async (tx) => {
        const configuration = await websiteConfigurationRepository.findByAcademyId(tx, academy.id);
        if (!configuration) return;

        let changed = false;

        const navigation = (configuration.navigation as unknown as NavigationItemLike[]) ?? [];
        const patchedNavigation = navigation.map((item) => {
          const arDefault = AR_BY_EN_TITLE.get(item.label?.en ?? '');
          if (arDefault && isBlank(item.label?.ar)) {
            changed = true;
            navItemsFixed += 1;
            return { ...item, label: { en: item.label.en, ar: arDefault } };
          }
          return item;
        });

        const footer = configuration.footer as unknown as {
          groups: FooterGroupLike[];
          socialLinks: unknown[];
          copyrightText?: LocalizedTextLike;
        };
        const patchedGroups = (footer?.groups ?? []).map((group) => {
          const isQuickLinksGroup = group.title?.en === 'Quick Links';
          const groupTitleChanged = isQuickLinksGroup && isBlank(group.title?.ar);
          if (groupTitleChanged) {
            changed = true;
            footerTitlesFixed += 1;
          }

          const patchedLinks = group.links.map((link) => {
            const arDefault = AR_BY_EN_TITLE.get(link.label?.en ?? '');
            if (arDefault && isBlank(link.label?.ar)) {
              changed = true;
              footerLinksFixed += 1;
              return { ...link, label: { en: link.label.en, ar: arDefault } };
            }
            return link;
          });

          return {
            ...group,
            title: groupTitleChanged ? { en: group.title.en, ar: QUICK_LINKS_AR } : group.title,
            links: patchedLinks,
          };
        });

        if (!changed) return;

        // eslint-disable-next-line no-console
        console.log(
          `${apply ? 'Fixing' : '[dry run] Would fix'} Academy "${academy.name}" (${academy.id})`,
        );

        if (apply) {
          await websiteConfigurationRepository.update(tx, academy.id, {
            navigation: patchedNavigation as unknown as import('@prisma/client').Prisma.InputJsonValue,
            footer: { ...footer, groups: patchedGroups } as unknown as import('@prisma/client').Prisma.InputJsonValue,
            // `PublicWebsiteService.getPublishedWebsite` caches its response
            // keyed by `(academyId, configVersion)` (`PublicWebsiteCacheService`,
            // Redis-backed). `WebsiteConfigurationService.updateConfiguration`
            // — the real Owner-edit path — always increments this on write,
            // which is what makes a real edit's new cache key naturally
            // bypass the old cached entry. Bypassing that service (as this
            // script does, going straight through the repository) would
            // silently leave the OLD navigation/footer visible on the live
            // public site, cached, for up to that cache's own TTL, even
            // though the database row is already correct — reproduced and
            // confirmed live during this fix's own verification.
            configVersion: { increment: 1 },
          });
        }
      });
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n${apply ? 'Applied' : 'Dry run complete'}: scanned ${scanned} Academies — ` +
        `${navItemsFixed} nav label(s), ${footerLinksFixed} footer link label(s), ` +
        `${footerTitlesFixed} footer group title(s) ${apply ? 'fixed' : 'would be fixed'}` +
        (skippedNoOwner > 0 ? `; ${skippedNoOwner} Academy(ies) skipped (no resolvable Organization owner)` : ''),
    );
    if (!apply) {
      // eslint-disable-next-line no-console
      console.log('Re-run with --apply to write these changes.');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  // eslint-disable-next-line no-console
  console.error('Backfill failed:', error);
  process.exit(1);
});
