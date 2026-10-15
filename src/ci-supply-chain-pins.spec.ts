/**
 * B0-OPS-12 — what CI and Deploy run is pinned, not a moving tag.
 *
 * Every external GitHub Action (`uses: owner/repo@…` in a workflow or a
 * composite action) must name a full 40-hex commit SHA, with the release as
 * a trailing comment (`# v5.1.0`) for readers and Dependabot; a `docker://`
 * action must carry a digest. Every Dockerfile `FROM` of an image (not an
 * earlier build stage) must carry `@sha256:<digest>`. Whoever controls a tag
 * can repoint it, and Deploy holds `packages: write` and the VPS SSH secrets.
 * Updates arrive as Dependabot PRs (.github/dependabot.yml). Text-level
 * checks on purpose — no YAML library dependency.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');

const SHA_PINNED = /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}\s+#\s*v\d+(\.\d+)*\s*$/;
const DIGEST = /@sha256:[0-9a-f]{64}$/;

/** `uses:` values (with any trailing comment) that are not pinned. */
function unpinnedUses(text: string): string[] {
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:-\s+)?uses:\s*['"]?([^'"\s]+)['"]?(.*)$/);
    if (!m) continue;
    const [, ref, rest] = m;
    if (ref.startsWith('./')) continue; // in this repository
    if (ref.startsWith('docker://')) {
      if (!DIGEST.test(ref)) bad.push(line.trim());
      continue;
    }
    if (!SHA_PINNED.test(`${ref}${rest}`)) bad.push(line.trim());
  }
  return bad;
}

/** `FROM` lines whose image (not an earlier stage) has no digest. */
function unpinnedFroms(text: string): string[] {
  const stages = new Set<string>(['scratch']);
  const bad: string[] = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i);
    if (!m) continue;
    const [, image, stage] = m;
    if (!stages.has(image.toLowerCase()) && !DIGEST.test(image)) bad.push(line.trim());
    if (stage) stages.add(stage.toLowerCase());
  }
  return bad;
}

function files(dir: string, keep: (name: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (['node_modules', '.git', 'dist', 'coverage'].includes(e.name)) return [];
    const path = join(dir, e.name);
    if (e.isDirectory()) return files(path, keep);
    return e.isFile() && keep(e.name) ? [path] : [];
  });
}

const workflowFiles = [
  ...files(join(ROOT, '.github/workflows'), (n) => /\.ya?ml$/.test(n)),
  ...files(join(ROOT, '.github/actions'), (n) => /^action\.ya?ml$/.test(n)),
];
const dockerfiles = files(ROOT, (n) => /^Dockerfile(\..+)?$/.test(n));

describe('supply-chain pins (B0-OPS-12)', () => {
  it('finds the workflows and the Dockerfile', () => {
    expect(workflowFiles.length).toBeGreaterThan(0);
    expect(dockerfiles.map((f) => relative(ROOT, f))).toContain('Dockerfile');
  });

  it.each(workflowFiles.map((f) => [relative(ROOT, f), f]))(
    '%s pins every external action to a commit SHA',
    (_name, path) => {
      expect(unpinnedUses(readFileSync(path, 'utf-8'))).toEqual([]);
    },
  );

  it.each(dockerfiles.map((f) => [relative(ROOT, f), f]))(
    '%s pins every base image to a digest',
    (_name, path) => {
      expect(unpinnedFroms(readFileSync(path, 'utf-8'))).toEqual([]);
    },
  );

  it('rejects tags and accepts pins (the checks themselves)', () => {
    const sha = 'a'.repeat(40);
    expect(
      unpinnedUses(
        [
          '      - uses: actions/checkout@v5',
          `      - uses: actions/checkout@${sha}`,
          `        uses: docker/build-push-action@${sha} # v7.4.0`,
          '      - uses: ./.github/actions/vps-deploy',
          '      - uses: docker://alpine:3',
        ].join('\n'),
      ),
    ).toEqual([
      '- uses: actions/checkout@v5',
      `- uses: actions/checkout@${sha}`,
      '- uses: docker://alpine:3',
    ]);
    const digest = `sha256:${'b'.repeat(64)}`;
    expect(
      unpinnedFroms(
        [
          'FROM mirror.gcr.io/library/node:20-alpine AS build',
          `FROM --platform=$BUILDPLATFORM caddy:2-builder-alpine@${digest} AS caddy`,
          'FROM build AS ssr-build',
          `FROM node:20-alpine@${digest}`,
        ].join('\n'),
      ),
    ).toEqual(['FROM mirror.gcr.io/library/node:20-alpine AS build']);
  });
});
