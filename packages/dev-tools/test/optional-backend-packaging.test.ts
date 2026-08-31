import { readFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { describe, expect, it } from 'vitest';

import { PROJECT_ROOT } from '../src/common.js';
import { DEPENDENCY_FIELDS } from '../src/resolve-workspace-deps.js';

/**
 * Packaging guard for the optional heavy backends.
 *
 * `packages/cli/src/utils/optional-backend.ts` exists so that a
 * multi-hundred-megabyte dependency stays out of every other command's cost —
 * its own docstring measures **275 MB of a 351 MB install** as the RAG lane. It
 * defers the *import* correctly.
 *
 * 🪤 Deferring the import never deferred the INSTALL. The manifest decides who
 * downloads a package, and `optionalDependencies` are **installed by default**
 * by npm and pnpm alike — "optional" there means the install may fail without
 * failing the build, not that it is skipped. Declaring the backends that way
 * silently undid the seam: measured at an adopter, upgrading pulled in
 * `onnxruntime-web`, a LanceDB platform binary, a third `apache-arrow` and
 * `protobufjs` — ~300 MB that the previous release did not install.
 *
 * Optional PEERS are the field that means what the seam intends: npm and pnpm
 * do not auto-install them, and an absent one becomes the legible
 * `reportMissingBackend` error naming the package to install.
 *
 * This guard exists because nothing else can see the drift. The seam's runtime
 * behaviour stays green whether the packages are installed or not — a passing
 * test suite is exactly what a regression here looks like.
 */
describe('optional backend packaging (install-cost guard)', () => {
  const BACKENDS = [
    '@vibe-agent-toolkit/projection-sqlite',
    '@vibe-agent-toolkit/rag',
    '@vibe-agent-toolkit/rag-lancedb',
  ] as const;

  const cliPkg = JSON.parse(
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- PROJECT_ROOT-derived path, not user input
    readFileSync(safePath.join(PROJECT_ROOT, 'packages/cli/package.json'), 'utf-8'),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
    optionalDependencies?: Record<string, string>;
    peerDependencies?: Record<string, string>;
    peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  };

  it.each(BACKENDS)('%s is NOT a dependency or optionalDependency of the CLI', (backend) => {
    expect(
      cliPkg.dependencies?.[backend],
      `${backend} as a plain dependency makes every adopter download the RAG lane`,
    ).toBeUndefined();
    expect(
      cliPkg.optionalDependencies?.[backend],
      `optionalDependencies are INSTALLED BY DEFAULT — ${backend} there ships ~300 MB to every adopter. `
      + 'Use peerDependencies + peerDependenciesMeta.optional instead.',
    ).toBeUndefined();
  });

  it.each(BACKENDS)('%s is declared as an OPTIONAL peer', (backend) => {
    expect(
      cliPkg.peerDependencies?.[backend],
      `${backend} must stay declared so adopters know it pairs with this CLI version`,
    ).toBeDefined();
    expect(
      cliPkg.peerDependenciesMeta?.[backend]?.optional,
      `${backend} must be marked optional, or npm and pnpm auto-install it and the seam is undone`,
    ).toBe(true);
  });

  it.each(BACKENDS)('%s stays a devDependency so the monorepo can still test it', (backend) => {
    expect(
      cliPkg.devDependencies?.[backend],
      `${backend} must remain a devDependency, or the CLI's own suite cannot exercise the backend it defers`,
    ).toBeDefined();
  });

  /**
   * 🚨 The rc.3 class: `workspace:*` reaching the registry.
   *
   * A published manifest carrying `workspace:*` is rejected by npm with
   * `EUNSUPPORTEDPROTOCOL`, making the release uninstallable — and bun HIDES it,
   * because bun understands the `workspace:` protocol. This repo uses bun
   * everywhere, so the one tool that would catch it is the one nothing runs.
   *
   * The publish step rewrites every field in {@link DEPENDENCY_FIELDS}. This
   * asserts the field this change introduces is covered by that list, so moving
   * the backends to peers cannot reopen the defect.
   */
  it('every field the CLI declares first-party workspace deps in is rewritten at publish', () => {
    const fieldsWithWorkspaceDeps = (
      ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const
    ).filter((field) =>
      Object.values(cliPkg[field] ?? {}).some((spec) => spec.startsWith('workspace:')),
    );

    expect(fieldsWithWorkspaceDeps.length).toBeGreaterThan(0);
    for (const field of fieldsWithWorkspaceDeps) {
      expect(
        DEPENDENCY_FIELDS as readonly string[],
        `${field} carries workspace:* specifiers but the publish resolver does not rewrite it — `
        + 'that is exactly how v0.2.0-rc.3 shipped uninstallable under npm',
      ).toContain(field);
    }
  });
});
