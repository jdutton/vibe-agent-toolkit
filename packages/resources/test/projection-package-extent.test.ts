/* eslint-disable security/detect-non-literal-fs-filename -- controlled temp fixture tree */
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';

import { mkdirSyncReal, normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ExtentContribution } from '../src/projection/contributor.js';
import { extentContextId } from '../src/projection/contributors/context-id.js';
import {
  PACKAGE_NOT_INSTALLED,
  PACKAGE_SUBPATH_NOT_EXPORTED,
  PackageExtentContributor,
} from '../src/projection/contributors/package-extent.js';
import { rootIdFor } from '../src/projection/identity.js';
import { ProjectionBuilder } from '../src/projection/projection.js';
import {
  RealizationConditionRowSchema,
  ResourceExtentRowSchema,
  ResourceRealizationRowSchema,
  ResourceRowSchema,
} from '../src/schemas/projection-resources.js';
import { ResolutionContextRowSchema } from '../src/schemas/projection-zones.js';

// Hoisted: `sonarjs/no-duplicate-string` blocks any literal used 3+ times, and
// package names / subpaths are named in almost every assertion below.
const ROOT_PKG = '@fixture/root';
const WORKSPACE_PKG = '@fixture/a';
const INSTALLED_PKG = '@fixture/b';
const ABSENT_PKG = '@fixture/absent';
const MANIFEST = 'package.json';
const PUBLIC_SUBPATH = 'public.json';
const PRIVATE_SUBPATH = 'private.json';
const WORKSPACE_DIR = 'packages/a';
const INSTALLED_DIR = 'node_modules/@fixture/b';

let root: string;

/** Write `value` as JSON at a fixture-relative path. */
function writeJson(relativePath: string, value: unknown): void {
  writeFileSync(safePath.join(root, relativePath), JSON.stringify(value));
}

/**
 * The extent id this contributor must spell for a package under the fixture root.
 *
 * Derived from the root the same way the contributor derives it, so a
 * root-blind id — the shipped bug this replaced — cannot match.
 */
function extentIdFor(packageName: string): string {
  return extentContextId('package', rootIdFor(root), packageName);
}

/** Every row this contributor produced for one package's extent. */
function forPackage(contribution: ExtentContribution, packageName: string) {
  const extentId = extentIdFor(packageName);
  const memberships = contribution.memberships.filter((row) => row.extentId === extentId);
  const memberIds = new Set(memberships.map((row) => row.resourceId));
  return {
    extentId,
    context: contribution.contexts.find((row) => row.contextId === extentId),
    memberships,
    resources: contribution.resources.filter((row) => memberIds.has(row.resourceId)),
    realizations: contribution.realizations.filter((row) => row.extentId === extentId),
    conditions: contribution.conditions.filter((row) => row.extentId === extentId),
  };
}

/** Run the contributor against the fixture root. */
async function contribute(parameters: Record<string, unknown> = {}): Promise<ExtentContribution> {
  const base = new ProjectionBuilder(root).base();
  return new PackageExtentContributor().contribute(base, parameters as never);
}

beforeEach(() => {
  root = toForwardSlash(mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-package-extent-')));
  mkdirSyncReal(safePath.join(root, WORKSPACE_DIR), { recursive: true });
  mkdirSyncReal(safePath.join(root, INSTALLED_DIR), { recursive: true });

  writeJson(MANIFEST, {
    name: ROOT_PKG,
    version: '0.0.0',
    workspaces: ['packages/*'],
    dependencies: { [INSTALLED_PKG]: '^1.0.0', [ABSENT_PKG]: '^2.0.0' },
  });
  writeJson(safePath.join(WORKSPACE_DIR, MANIFEST), {
    name: WORKSPACE_PKG,
    version: '0.0.0',
    dependencies: { [INSTALLED_PKG]: '^1.0.0' },
  });
  // `private.json` exists on disk but is deliberately absent from `exports`:
  // without the exports map it WOULD resolve, so the assertion below is about
  // exports being honoured rather than about a missing file.
  writeJson(safePath.join(INSTALLED_DIR, MANIFEST), {
    name: INSTALLED_PKG,
    version: '1.0.0',
    exports: { './package.json': './package.json', './public.json': './public.json' },
  });
  writeJson(safePath.join(INSTALLED_DIR, PUBLIC_SUBPATH), {});
  writeJson(safePath.join(INSTALLED_DIR, PRIVATE_SUBPATH), {});
});

describe('PackageExtentContributor identity', () => {
  it('is the base-stratum "package" contributor the registry keys on', () => {
    const contributor = new PackageExtentContributor();

    expect(contributor.id).toBe('builtin:package');
    expect(contributor.kind).toBe('package');
    expect(contributor.stratum).toBe('base');
  });
});

describe('PackageExtentContributor enumeration', () => {
  it('declares one extent per package, each its own base', async () => {
    const contribution = await contribute();

    const kinds = contribution.contexts.map((row) => row.kind);
    expect(new Set(kinds)).toEqual(new Set(['package']));
    expect(contribution.contexts.map((row) => row.contextId)).toEqual(
      expect.arrayContaining([ROOT_PKG, WORKSPACE_PKG, INSTALLED_PKG, ABSENT_PKG].map(extentIdFor)),
    );
    for (const row of contribution.contexts) {
      expect(() => ResolutionContextRowSchema.parse(row)).not.toThrow();
    }
  });

  it('puts the corpus root INSIDE every extent id, not merely in the rootId column', async () => {
    // The shipped bug: `extent:package:<name>` was root-blind, so two federated
    // roots depending on the same package produced one contextId. The
    // resolution_contexts table keys on that column alone, keep-first, so the
    // second root's extent was dropped and its memberships pointed at the
    // first root's extent.
    const contribution = await contribute();
    const expectedRootId = rootIdFor(root);

    expect(contribution.contexts.length).toBeGreaterThan(0);
    for (const row of contribution.contexts) {
      expect(row.rootId).toBe(expectedRootId);
      expect(row.contextId).toContain(expectedRootId);
    }
  });

  it('realizes a workspace package found through the workspaces globs', async () => {
    const found = forPackage(await contribute(), WORKSPACE_PKG);

    expect(found.resources).toHaveLength(1);
    expect(found.resources[0]?.kind).toBe('package');
    expect(found.resources[0]?.observed).toBe(true);
    expect(found.realizations).toHaveLength(1);
    expect(found.realizations[0]?.path).toBe(WORKSPACE_DIR);
    expect(found.realizations[0]?.isDirectory).toBe(true);
  });

  it('realizes an installed dependency at its resolved directory', async () => {
    const found = forPackage(await contribute(), INSTALLED_PKG);

    expect(found.resources[0]?.observed).toBe(true);
    expect(found.realizations).toHaveLength(1);
    expect(found.realizations[0]?.path).toBe(INSTALLED_DIR);
  });

  it('emits a resource with ZERO realizations for a declared-but-uninstalled dependency', async () => {
    // §4.1: zero realizations is legal — a resource known but not present. A
    // contributor that skipped the row, or invented a realization at a path
    // that does not exist, would erase that distinction.
    const found = forPackage(await contribute(), ABSENT_PKG);

    expect(found.resources).toHaveLength(1);
    expect(found.resources[0]?.kind).toBe('package');
    expect(found.resources[0]?.observed).toBe(false);
    expect(found.memberships).toHaveLength(1);
    expect(found.realizations).toEqual([]);
  });

  it('records WHY the uninstalled dependency has no realization', async () => {
    const found = forPackage(await contribute(), ABSENT_PKG);

    expect(found.conditions.map((row) => row.code)).toEqual([PACKAGE_NOT_INSTALLED]);
    expect(found.conditions[0]?.resourceId).toBe(found.resources[0]?.resourceId);
  });

  it('produces rows the shipped schemas accept', async () => {
    const contribution = await contribute({ subpaths: [PUBLIC_SUBPATH] });

    for (const row of contribution.resources) expect(() => ResourceRowSchema.parse(row)).not.toThrow();
    for (const row of contribution.memberships) expect(() => ResourceExtentRowSchema.parse(row)).not.toThrow();
    for (const row of contribution.realizations) expect(() => ResourceRealizationRowSchema.parse(row)).not.toThrow();
    for (const row of contribution.conditions) expect(() => RealizationConditionRowSchema.parse(row)).not.toThrow();
  });
});

describe('PackageExtentContributor exports map', () => {
  it('resolves a subpath the exports map honours', async () => {
    const found = forPackage(await contribute({ subpaths: [PUBLIC_SUBPATH] }), INSTALLED_PKG);

    const paths = found.realizations.map((row) => row.path);
    expect(paths).toContain(safePath.join(INSTALLED_DIR, PUBLIC_SUBPATH));
  });

  it('does NOT resolve a subpath the exports map excludes, though the file is on disk', async () => {
    // The negative control: the file genuinely exists, so a resolver that
    // ignored `exports` would find it and this test would go red.
    expect(existsSync(safePath.join(root, INSTALLED_DIR, PRIVATE_SUBPATH))).toBe(true);

    const found = forPackage(await contribute({ subpaths: [PRIVATE_SUBPATH] }), INSTALLED_PKG);

    const paths = found.realizations.map((row) => row.path);
    expect(paths).not.toContain(safePath.join(INSTALLED_DIR, PRIVATE_SUBPATH));
    expect(found.conditions.map((row) => row.code)).toEqual([PACKAGE_SUBPATH_NOT_EXPORTED]);
  });
});
