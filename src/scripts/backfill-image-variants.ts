/**
 * CMS phase 4 — generates the responsive AVIF/WebP variants
 * (`media/utils/image-variants.util.ts`) for public images uploaded before
 * the media worker started making them.
 *
 * What it writes, per asset, and nothing else: the variant objects at their
 * derived keys next to the original in the public bucket, then
 * `media_assets.variants`. The original object and every other column are
 * untouched; the public media route serves the original until `variants` is
 * set, so a run can be stopped at any point.
 *
 * Idempotent and resumable: it only picks assets whose `variants` IS NULL
 * (done ones, and ones with nothing to make, are recorded and never
 * revisited), walking them by id so one run visits each at most once. A
 * failure is counted and left NULL for the next run. Rate-limited: one
 * asset at a time with a pause between (`--delay-ms`, default 500), so a
 * small VPS keeps serving traffic.
 *
 * OUTPUT IS COUNTS ONLY — no names, keys, URLs or configuration.
 *
 * Usage:
 *   node dist/scripts/backfill-image-variants.js                 # dry run: counts what is pending
 *   node dist/scripts/backfill-image-variants.js --apply         # generate
 *   ... [--limit=<max assets this run>] [--delay-ms=<pause between assets>]
 * In production, in the background inside the running backend container:
 *   nohup docker compose exec -T backend node dist/scripts/backfill-image-variants.js \
 *     --apply > backups/image-variants-backfill.log 2>&1 &
 * From a checkout without a build:
 *   npx ts-node -r tsconfig-paths/register src/scripts/backfill-image-variants.ts
 *
 * The cross-tenant listing reads as the Platform Owner (the read-only
 * `media_assets_platform_select` policy, like the archived-media purge);
 * each write runs in the asset's own organization context.
 */
/* eslint-disable no-console -- an operator CLI: counts on stdout are its interface. */
import { setTimeout as sleep } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import { Prisma } from '@prisma/client';
import { AppModule } from '../app.module';
import { TenancyContextService } from '../tenancy/services/tenancy-context.service';
import { UsersRepository } from '../identity/repositories/users.repository';
import {
  ImageVariantsService,
  type ImageVariantsOutcome,
} from '../media/services/image-variants.service';
import { VARIANT_SOURCE_MIME_TYPES } from '../media/utils/image-variants.util';

const PAGE_SIZE = 100;

function numberArg(name: string, fallback: number): number {
  const flag = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  if (!flag) return fallback;
  const value = Number(flag.slice(name.length + 3));
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`--${name} must be a non-negative integer.`);
  }
  return value;
}

/** Pending = eligible public raster image, bytes not purged, no variants recorded. */
function pendingWhere(afterId: string | undefined): Prisma.MediaAssetWhereInput {
  return {
    type: 'image',
    access: 'public',
    provider: 'r2',
    status: { in: ['active', 'archived'] },
    deletedAt: null,
    mimeType: { in: [...VARIANT_SOURCE_MIME_TYPES] },
    variants: { equals: Prisma.DbNull },
    ...(afterId ? { id: { gt: afterId } } : {}),
  };
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const limit = numberArg('limit', Number.MAX_SAFE_INTEGER) || Number.MAX_SAFE_INTEGER;
  const delayMs = numberArg('delay-ms', 500);

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const tenancy = app.get(TenancyContextService);
    const variants = app.get(ImageVariantsService);
    const platformOwner = await app.get(UsersRepository).findFirstPlatformOwnerId();
    if (!platformOwner) {
      throw new Error('No platform owner account exists; cannot list media assets.');
    }

    if (!apply) {
      const pending = await tenancy.runInUserContext(platformOwner.id, (tx) =>
        tx.mediaAsset.count({ where: pendingWhere(undefined) }),
      );
      console.log(`dry run: ${pending} image(s) pending variants. Run with --apply.`);
      return;
    }

    const counts: Record<ImageVariantsOutcome, number> = {
      generated: 0,
      none: 0,
      skipped: 0,
      failed: 0,
    };
    let visited = 0;
    let afterId: string | undefined;
    while (visited < limit) {
      const page = await tenancy.runInUserContext(platformOwner.id, (tx) =>
        tx.mediaAsset.findMany({
          where: pendingWhere(afterId),
          orderBy: { id: 'asc' },
          take: Math.min(PAGE_SIZE, limit - visited),
          select: {
            id: true,
            type: true,
            access: true,
            provider: true,
            mimeType: true,
            storageKey: true,
            academy: { select: { organizationId: true } },
          },
        }),
      );
      if (page.length === 0) break;
      for (const asset of page) {
        const outcome = await variants.generateForAsset(
          asset,
          asset.academy.organizationId,
        );
        counts[outcome] += 1;
        visited += 1;
        if (delayMs > 0) await sleep(delayMs);
      }
      afterId = page[page.length - 1].id;
      console.log(`progress: ${visited} visited ${JSON.stringify(counts)}`);
    }
    console.log(`done: ${visited} visited ${JSON.stringify(counts)}`);
    if (counts.failed > 0) {
      console.log('Failures stay pending; re-running retries them.');
    }
  } finally {
    await app.close();
  }
}

main().catch((error: unknown) => {
  console.error('backfill-image-variants failed:', (error as Error).message);
  process.exit(1);
});
