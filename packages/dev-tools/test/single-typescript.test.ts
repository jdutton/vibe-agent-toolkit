/**
 * The repository compiles with one TypeScript and `resources` declares the same one.
 *
 * Every workspace manifest (the root and each `packages/<name>/package.json`) that names
 * `typescript` in any dependency field (`dependencies`, `devDependencies`, `peerDependencies`,
 * `optionalDependencies`) names one and the same exact version; the root and `resources` must
 * name it. `bun.lock` holds exactly one `typescript@` package entry, and it is that version, so
 * bun installed a single copy (a transitive dependency resolving another TypeScript would add a
 * second entry). The copy resolved from the root and from `resources` is that version too. The
 * expected version is read from the root manifest; this file names none.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

import { resolveFromImportMeta, safePath } from '@vibe-agent-toolkit/utils';
import semver from 'semver';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolveFromImportMeta(import.meta.url, '..', '..', '..');

/** The fields a manifest can name a dependency in. */
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'] as const;

/** The directories, relative to the repository root, that must declare `typescript`. */
const REQUIRED_DIRS = ['.', 'packages/resources'] as const;

type Manifest = { version?: string } & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

function readManifest(file: string): Manifest {
  return JSON.parse(readFileSync(file, 'utf-8')) as Manifest;
}

/** The root and every `packages/<name>` directory holding a `package.json`, relative to the root. */
function workspaceDirs(): string[] {
  const packages = readdirSync(safePath.join(REPO_ROOT, 'packages'))
    .map((name) => `packages/${name}`)
    .filter((dir) => existsSync(safePath.join(REPO_ROOT, dir, 'package.json')));
  return ['.', ...packages.sort((a, b) => a.localeCompare(b))];
}

/** Every `typescript` spec `dir`'s manifest declares, one per field that names it. */
function typescriptSpecs(dir: string): Array<{ dir: string; field: string; spec: string }> {
  const manifest = readManifest(safePath.join(REPO_ROOT, dir, 'package.json'));
  return DEPENDENCY_FIELDS.flatMap((field) => {
    const spec = manifest[field]?.['typescript'];
    return spec === undefined ? [] : [{ dir, field, spec }];
  });
}

/**
 * The versions of every `typescript@` entry in `bun.lock`'s `packages` section, hoisted or nested.
 * Each entry is one line, `"<key>": ["typescript@<version>", ...]`; a package whose name merely
 * contains `typescript` (`@typescript-eslint/...`) does not start its value with `typescript@`.
 */
const LOCK_TYPESCRIPT_ENTRY = /^"[^"]+": \["typescript@([^"]+)"/;

function lockedTypescriptVersions(lock: string): string[] {
  const packagesAt = lock.indexOf('\n  "packages": {');
  if (packagesAt === -1) throw new Error('bun.lock has no packages section');
  return lock
    .slice(packagesAt)
    .split('\n')
    .flatMap((line) => {
      const version = LOCK_TYPESCRIPT_ENTRY.exec(line.trimStart())?.[1];
      return version === undefined ? [] : [version];
    });
}

function resolvedTypescriptVersion(dir: string): string | undefined {
  const require = createRequire(safePath.join(REPO_ROOT, dir, 'package.json'));
  return readManifest(require.resolve('typescript/package.json')).version;
}

describe('one installed typescript', () => {
  const specs = workspaceDirs().flatMap((dir) => typescriptSpecs(dir));
  const pinned = typescriptSpecs('.').find((entry) => entry.field === 'devDependencies')?.spec;

  it('the root pins typescript to one exact version with no range operator', () => {
    expect(pinned).toBeDefined();
    expect(semver.valid(pinned)).toBe(pinned);
  });

  it('every workspace manifest that names typescript, in any dependency field, names that version', () => {
    expect(specs.filter((entry) => entry.spec !== pinned)).toEqual([]);
    for (const dir of REQUIRED_DIRS) expect(specs.some((entry) => entry.dir === dir), dir).toBe(true);
  });

  it('bun.lock holds exactly one typescript package entry, at that version', () => {
    expect(lockedTypescriptVersions(readFileSync(safePath.join(REPO_ROOT, 'bun.lock'), 'utf-8'))).toEqual([pinned]);
  });

  it('red seed: a nested second typescript entry is counted, and @typescript-eslint is not', () => {
    const lock = [
      '{',
      '  "packages": {',
      '    "@typescript-eslint/parser": ["@typescript-eslint/parser@8.0.0", "", {}],',
      '    "knip/typescript": ["typescript@5.9.0", "", {}],',
      '    "typescript": ["typescript@6.0.3", "", {}],',
      '  }',
      '}',
    ].join('\n');
    expect(lockedTypescriptVersions(lock)).toEqual(['5.9.0', '6.0.3']);
  });

  it.each(REQUIRED_DIRS)('typescript resolved from %s is the pinned version', (dir) => {
    expect(resolvedTypescriptVersion(dir)).toBe(pinned);
  });
});
