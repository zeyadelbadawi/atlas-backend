/**
 * B3 — seeds (upserts) marketing blog posts from a JSON file, by slug.
 *
 *   npm run db:seed-blog-posts -- --file=posts.json            # dry run (read-only)
 *   npm run db:seed-blog-posts -- --file=posts.json --apply    # write
 *
 * File shape: see `src/blog/blog-seed.ts`. The whole file is validated
 * first with the API's own rules (nothing is written if any entry is
 * refused).
 *
 * IDEMPOTENT. A slug that does not exist is created; one that exists is
 * updated in place with the fields the file gives (an unchanged post is
 * not touched and keeps its version). `relatedSlugs` are resolved after
 * every post exists. `status: "published" | "scheduled"` publishes or
 * schedules through the same rule as the dashboard (both languages
 * complete); a PAST `publishAt` backdates the publish and first-publish
 * dates. `status: "draft"` (the default) never unpublishes an existing
 * post. Re-running the same file changes nothing.
 *
 * Everything goes through `PlatformBlogPostsService` as the first Platform
 * Owner account, so RLS, audit rows and the `atlas-blog` edge purge all
 * apply exactly as for a dashboard edit.
 */
import { readFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { PrismaService } from '../database/prisma.service';
import { runInUserContext } from '../database/user-context';
import { UsersRepository } from '../identity/repositories/users.repository';
import { PlatformBlogPostsService } from '../blog/services/platform-blog-posts.service';
import { EdgeCachePurgeService } from '../edge-cache/edge-cache-purge.service';
import { parseBlogSeed, type BlogSeedEntry } from '../blog/blog-seed';

function argValue(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

interface Outcome {
  readonly slug: string;
  readonly action: 'create' | 'update' | 'unchanged';
  readonly status?: string;
  readonly detail?: string;
}

async function main(): Promise<void> {
  const file = argValue('file');
  if (!file) throw new Error('Pass --file=<posts.json>.');
  const apply = process.argv.includes('--apply');
  const entries = parseBlogSeed(JSON.parse(readFileSync(file, 'utf8')));

  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  try {
    const prisma = app.get(PrismaService);
    const posts = app.get(PlatformBlogPostsService);
    const platformOwner = await app.get(UsersRepository).findFirstPlatformOwnerId();
    if (!platformOwner) throw new Error('No platform owner account exists.');
    const po = platformOwner.id;
    const now = new Date();

    const findBySlug = (slug: string) =>
      runInUserContext(prisma, po, (tx) =>
        tx.platformBlogPost.findUnique({ where: { slug } }),
      );

    const outcomes: Outcome[] = [];
    const ids = new Map<string, string>();

    // Pass 1: create or update every post (without related posts).
    for (const entry of entries) {
      const { post } = entry;
      const existing = await findBySlug(post.slug);
      if (!apply) {
        outcomes.push({
          slug: post.slug,
          action: existing ? 'update' : 'create',
          status: existing
            ? `${existing.status} → ${entry.status}`
            : `new → ${entry.status}`,
        });
        continue;
      }
      if (!existing) {
        const created = await posts.create(po, { ...post, relatedPostIds: [] }, now);
        ids.set(post.slug, created.id);
        outcomes.push({ slug: post.slug, action: 'create' });
      } else {
        const updated = await posts.update(
          po,
          existing.id,
          {
            version: existing.version,
            kind: post.kind,
            topic: post.topic,
            featured: post.featured,
            coverImage: post.coverImage,
            authorName: post.authorName,
            translations: post.translations,
          },
          now,
        );
        ids.set(post.slug, existing.id);
        outcomes.push({
          slug: post.slug,
          action: updated.version === existing.version ? 'unchanged' : 'update',
        });
      }
    }

    if (apply) {
      // Pass 2: related posts, by slug (every post exists now).
      for (const entry of entries) {
        const id = ids.get(entry.post.slug)!;
        const relatedIds: string[] = [];
        for (const slug of entry.relatedSlugs) {
          const relatedId = ids.get(slug) ?? (await findBySlug(slug))?.id;
          if (!relatedId)
            throw new Error(`${entry.post.slug}: related slug ${slug} does not exist.`);
          relatedIds.push(relatedId);
        }
        const current = await posts.get(po, id, now);
        if (current.relatedPostIds.join(',') !== relatedIds.join(',')) {
          await posts.update(
            po,
            id,
            { version: current.version, relatedPostIds: relatedIds },
            now,
          );
        }
      }
      // Pass 3: publish / schedule.
      for (const entry of entries) {
        await publishIfNeeded(prisma, posts, po, ids.get(entry.post.slug)!, entry, now);
      }
    }

    for (const outcome of outcomes) {
      console.log(
        `${outcome.action.padEnd(9)} ${outcome.slug}${outcome.status ? `  (${outcome.status})` : ''}`,
      );
    }
    console.log(
      apply
        ? `Applied ${entries.length} post(s).`
        : `Dry run: ${entries.length} post(s) valid. Re-run with --apply to write.`,
    );
    // Let the first edge purge go out before the process closes its timers.
    if (apply && app.get(EdgeCachePurgeService).enabled) {
      await new Promise((resolve) => setTimeout(resolve, 2_500));
    }
  } finally {
    await app.close();
  }
}

async function publishIfNeeded(
  prisma: PrismaService,
  posts: PlatformBlogPostsService,
  po: string,
  id: string,
  entry: BlogSeedEntry,
  now: Date,
): Promise<void> {
  if (entry.status === 'draft') return;
  const current = await posts.get(po, id, now);
  const wanted = entry.publishAt;
  const backdate = wanted !== undefined && wanted.getTime() <= now.getTime();
  const sameTime =
    wanted === undefined ||
    (current.publishAt !== null &&
      new Date(current.publishAt).getTime() === wanted.getTime());
  // `current.status` is the effective status: a scheduled post whose time
  // has come reads as published, and a "published" entry dated in the future
  // is stored as scheduled. Either live state at the wanted time is applied;
  // an entry without a date wants the post published now.
  const live = current.status === 'published' || current.status === 'scheduled';
  const alreadyThere =
    wanted === undefined ? current.status === 'published' : live && sameTime;
  if (alreadyThere) return;

  await posts.publish(
    po,
    id,
    {
      version: current.version,
      ...(wanted && !backdate ? { publishAt: wanted.toISOString() } : {}),
    },
    now,
  );
  if (backdate) {
    // A past date is history (e.g. a post first published elsewhere): record it as such.
    await runInUserContext(prisma, po, (tx) =>
      tx.platformBlogPost.update({
        where: { id },
        data: { publishAt: wanted, publishedAt: wanted },
      }),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
