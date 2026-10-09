/**
 * Test-only: every HTTP route the application declares, read from the
 * controllers' own decorator metadata (no Nest app, no database).
 *
 * Shared by the inventory specs (route surface, public routes, body
 * limits, subscription scoping) so they all see exactly the same list.
 * Named `*.fixture-spec.ts` so the build excludes it (`**\/*spec.ts`) and
 * Jest does not run it as a suite (`*.spec.ts` only).
 *
 * Controllers are found by CONTENT (`@Controller(`), not by file name: the
 * certificate controllers live in `certificates.controllers.ts`, which a
 * `*.controller.ts` filter silently skipped.
 */
import 'reflect-metadata';
import {
  GUARDS_METADATA,
  METHOD_METADATA,
  PATH_METADATA,
} from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export type GuardClass = abstract new (...args: never[]) => unknown;

export interface DeclaredRoute {
  /** `METHOD path`, as the controller declares it (no global prefix). */
  readonly key: string;
  readonly method: string;
  readonly path: string;
  /** Source file, relative to `src/`. */
  readonly file: string;
  readonly guards: readonly GuardClass[];
  readonly controller: object;
  readonly handler: (...args: unknown[]) => unknown;
}

const SRC_ROOT = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...controllerFiles(full));
    } else if (
      entry.endsWith('.ts') &&
      !entry.endsWith('spec.ts') &&
      readFileSync(full, 'utf8').includes('@Controller(')
    ) {
      out.push(full);
    }
  }
  return out;
}

function guardsOf(target: object): GuardClass[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as GuardClass[] | undefined) ?? [];
}

function paths(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [value ?? ''];
  return list.map((p) => String(p).replace(/^\/+|\/+$/g, ''));
}

let cache: DeclaredRoute[] | undefined;

export function collectDeclaredRoutes(): DeclaredRoute[] {
  if (cache) return cache;
  const routes: DeclaredRoute[] = [];
  for (const file of controllerFiles(SRC_ROOT)) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(file) as Record<string, unknown>;
    for (const exported of Object.values(mod)) {
      if (typeof exported !== 'function') continue;
      const controllerPaths = Reflect.getMetadata(PATH_METADATA, exported) as unknown;
      if (controllerPaths === undefined) continue;
      const classGuards = guardsOf(exported);
      const proto = (exported as { prototype: object }).prototype;
      for (const name of Object.getOwnPropertyNames(proto)) {
        if (name === 'constructor') continue;
        const handler = (proto as Record<string, unknown>)[name];
        if (typeof handler !== 'function') continue;
        const method = Reflect.getMetadata(METHOD_METADATA, handler) as
          RequestMethod | undefined;
        if (method === undefined) continue;
        const guards = [...classGuards, ...guardsOf(handler)];
        for (const base of paths(controllerPaths)) {
          for (const sub of paths(Reflect.getMetadata(PATH_METADATA, handler))) {
            const path = [base, sub].filter(Boolean).join('/');
            routes.push({
              key: `${RequestMethod[method]} ${path}`,
              method: RequestMethod[method],
              path,
              file: relative(SRC_ROOT, file),
              guards,
              controller: exported,
              handler: handler as (...args: unknown[]) => unknown,
            });
          }
        }
      }
    }
  }
  cache = routes;
  return routes;
}
