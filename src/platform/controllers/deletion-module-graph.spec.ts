/**
 * The deletion surface's cross-module wiring must actually resolve.
 *
 * WHY THIS EXISTS. `PlatformUserManagementController` lives in
 * `PlatformModule` and injects two services that `IdentityModule` owns.
 * Nest resolves that at BOOTSTRAP, not at compile time — so on 25 Sep 2026
 * a provider used across the boundary without being exported typechecked
 * cleanly, passed `nest build`, deployed, and then refused to start. The
 * container came up unhealthy, `docker compose up --wait` failed, and every
 * `/api/v1` route answered 502 while the frontend kept serving normally.
 * Two deploys burned before the cause was visible.
 *
 * Neither `tsc` nor `nest build` models the injector, so nothing in the
 * pipeline catches it. This does, by reading the same decorator metadata
 * Nest itself reads: the controller's constructor parameter types, and the
 * owning module's `exports` array. It is a structural assertion about the
 * real DI graph, not a search for strings in source.
 *
 * Booting the whole `AppModule` would catch more, but needs Postgres,
 * Redis and a validated environment, which makes it an e2e concern rather
 * than something that runs on every unit test pass. This check is cheap
 * enough to never be skipped, and it covers the exact mistake that broke
 * production.
 */
import 'reflect-metadata';
import { IdentityModule } from '../../identity/identity.module';
import { PlatformUserManagementController } from './platform-user-management.controller';
import { AccountDeletionService } from '../../identity/services/account-deletion.service';
import { DeletionPlanService } from '../../identity/services/deletion-plan.service';

/** What Nest will try to inject into `target`'s constructor. */
function injectedDependencies(target: unknown): unknown[] {
  return (Reflect.getMetadata('design:paramtypes', target as object) ?? []) as unknown[];
}

/** What a module makes available to the modules that import it. */
function moduleExports(module: unknown): unknown[] {
  return (Reflect.getMetadata('exports', module as object) ?? []) as unknown[];
}

describe('deletion surface module graph', () => {
  const identityExports = moduleExports(IdentityModule);

  it('exports every service the platform deletion controller injects', () => {
    const dependencies = injectedDependencies(PlatformUserManagementController);

    // Guard against the metadata silently being empty — an assertion over
    // an empty list would pass while proving nothing.
    expect(dependencies.length).toBeGreaterThan(0);

    const missing = dependencies.filter(
      (dependency) => !identityExports.includes(dependency),
    );

    expect(
      missing.map(
        (dependency) => (dependency as { name?: string })?.name ?? String(dependency),
      ),
    ).toEqual([]);
  });

  it('names both deletion services explicitly, so neither export can be dropped quietly', () => {
    // The generic check above would also pass if the controller stopped
    // injecting one of these. These two assertions fail if the export
    // itself disappears, which is the regression that caused the outage.
    expect(identityExports).toContain(AccountDeletionService);
    expect(identityExports).toContain(DeletionPlanService);
  });

  it('injects the deletion services and nothing that is merely a DTO or type', () => {
    const dependencies = injectedDependencies(PlatformUserManagementController);
    expect(dependencies).toContain(AccountDeletionService);
    expect(dependencies).toContain(DeletionPlanService);
    // `Object` here would mean a parameter Nest cannot resolve at all,
    // typically an interface or a `type`-only import used as a value.
    expect(dependencies).not.toContain(Object);
  });
});
