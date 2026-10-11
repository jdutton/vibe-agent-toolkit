/**
 * The closure digest identifies the BYTES an arm runs: the cli's `dist/` and
 * every `@vibe-agent-toolkit/*` `dist/` it resolves, transitively.
 *
 * The case that matters is (b): a dependency's built output changes while
 * every version string stays put. That is precisely what two `dist:` arms of
 * one version look like, and before the digest nothing in a coordinate could
 * tell them apart.
 *
 * A real temp tree laid out the way npm and bun lay one out
 * (`node_modules/@vibe-agent-toolkit/<name>`), because the resolution walk is
 * the thing under test — a mocked filesystem would test the mock.
 */

import { writeFileSync } from 'node:fs';

import { safePath } from '@vibe-agent-toolkit/utils';
import { mkdirSyncReal } from '@vibe-agent-toolkit/utils/fs';
import { tempDirTracker } from '@vibe-agent-toolkit/utils/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { closureDigest } from '../../src/harness/closure.js';

const temps = tempDirTracker('lab-closure-');

afterAll(() => {
  temps.cleanupAll();
});

/** Scope every fixture package lives under. */
const SCOPE = '@vibe-agent-toolkit';

/**
 * Write a file, creating its directory.
 *
 * @param path - Absolute file path
 * @param content - File content
 */
function put(path: string, content: string): void {
  mkdirSyncReal(safePath.join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf-8');
}

/** One package in the fixture install. */
interface FixturePackage {
  readonly name: string;
  readonly dependencies?: Readonly<Record<string, string>>;
  readonly peerDependencies?: Readonly<Record<string, string>>;
  /** Files under the package root, relative to it. */
  readonly files: Readonly<Record<string, string>>;
}

/**
 * Lay out an install: `<root>/node_modules/@vibe-agent-toolkit/<name>/…`.
 *
 * @param packages - The packages to install
 * @returns The install root and each package's directory by name
 */
function install(packages: readonly FixturePackage[]): {
  root: string;
  dirOf: (name: string) => string;
} {
  const root = temps.create();
  const dirOf = (name: string): string => safePath.join(root, 'node_modules', SCOPE, name);
  for (const pkg of packages) {
    const dir = dirOf(pkg.name);
    put(
      safePath.join(dir, 'package.json'),
      JSON.stringify({
        name: `${SCOPE}/${pkg.name}`,
        version: '0.2.0',
        ...(pkg.dependencies === undefined ? {} : { dependencies: pkg.dependencies }),
        ...(pkg.peerDependencies === undefined ? {} : { peerDependencies: pkg.peerDependencies }),
      }),
    );
    for (const [relative, content] of Object.entries(pkg.files)) {
      put(safePath.join(dir, relative), content);
    }
  }
  return { root, dirOf };
}

/** The cli, depending on utils (and on an optional peer nobody installed). */
const CLI: FixturePackage = {
  name: 'cli',
  dependencies: { [`${SCOPE}/utils`]: '0.2.0', commander: '^12.0.0' },
  peerDependencies: { [`${SCOPE}/rag`]: '0.2.0' },
  files: { 'dist/bin.js': '// cli\n' },
};

/** utils, with a README outside `dist/` and a build-info file inside it. */
const UTILS: FixturePackage = {
  name: 'utils',
  files: {
    'dist/index.js': '// utils v1\n',
    'dist/tsconfig.tsbuildinfo': '{"v":1}',
    'README.md': '# utils\n',
  },
};

describe('closureDigest', () => {
  it('is 64 hex characters, and stable across two calls over one tree', () => {
    const { dirOf } = install([CLI, UTILS]);

    const first = closureDigest(dirOf('cli'));

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(closureDigest(dirOf('cli'))).toBe(first);
  });

  it('changes when a DEPENDENCY’s built output changes, though no version moved', () => {
    // The case the version cannot see: utils rebuilt, every package.json untouched.
    const { dirOf } = install([CLI, UTILS]);
    const before = closureDigest(dirOf('cli'));

    writeFileSync(safePath.join(dirOf('utils'), 'dist/index.js'), '// utils v2\n', 'utf-8');

    expect(closureDigest(dirOf('cli'))).not.toBe(before);
  });

  it('does not change for a file outside any dist/, nor for build info inside one', () => {
    const { dirOf } = install([CLI, UTILS]);
    const before = closureDigest(dirOf('cli'));

    writeFileSync(safePath.join(dirOf('utils'), 'README.md'), '# utils, reworded\n', 'utf-8');
    writeFileSync(safePath.join(dirOf('utils'), 'dist/tsconfig.tsbuildinfo'), '{"v":2}', 'utf-8');

    expect(closureDigest(dirOf('cli'))).toBe(before);
  });

  it('changes when the cli’s own manifest changes', () => {
    // Positive control for the test above: an edit the digest DOES cover, so
    // "unchanged" there cannot be a digest that reads nothing at all.
    const { dirOf } = install([CLI, UTILS]);
    const before = closureDigest(dirOf('cli'));

    writeFileSync(
      safePath.join(dirOf('cli'), 'package.json'),
      JSON.stringify({ name: `${SCOPE}/cli`, version: '0.2.1', dependencies: CLI.dependencies }),
      'utf-8',
    );

    expect(closureDigest(dirOf('cli'))).not.toBe(before);
  });

  it('throws naming a declared @vibe-agent-toolkit dependency that does not resolve', () => {
    // Never a silent skip: a closure missing a package would be a digest of
    // something smaller than what runs, and would match another arm missing it too.
    const { dirOf } = install([CLI]);

    expect(() => closureDigest(dirOf('cli'))).toThrow(`${SCOPE}/utils`);
  });

  it('follows the closure TRANSITIVELY — a package reached only through another', () => {
    // cli → resources → utils: the cli does not declare utils, so only a walk
    // that recurses past depth 1 digests it.
    const cli: FixturePackage = {
      name: 'cli',
      dependencies: { [`${SCOPE}/resources`]: '0.2.0' },
      files: { 'dist/bin.js': '// cli\n' },
    };
    const resources: FixturePackage = {
      name: 'resources',
      dependencies: { [`${SCOPE}/utils`]: '0.2.0' },
      files: { 'dist/index.js': '// resources\n' },
    };
    const { dirOf } = install([cli, resources, UTILS]);
    const before = closureDigest(dirOf('cli'));

    writeFileSync(safePath.join(dirOf('utils'), 'dist/index.js'), '// utils, depth 2, rebuilt\n', 'utf-8');

    expect(closureDigest(dirOf('cli'))).not.toBe(before);
  });

  it('names the manifest when a closure member’s package.json is malformed', () => {
    const { dirOf } = install([CLI, UTILS]);
    const manifest = safePath.join(dirOf('utils'), 'package.json');
    writeFileSync(manifest, '{ not json', 'utf-8');

    expect(() => closureDigest(dirOf('cli'))).toThrow(`closure: cannot read ${manifest}`);
  });

  it('names the manifest when a resolved package directory has none', () => {
    // A directory at node_modules/@vibe-agent-toolkit/utils resolves the name,
    // but there is no package behind it — a bare ENOENT would not say whose.
    const { dirOf } = install([CLI]);
    put(safePath.join(dirOf('utils'), 'dist/index.js'), '// no manifest\n');

    expect(() => closureDigest(dirOf('cli'))).toThrow(
      `closure: cannot read ${safePath.join(dirOf('utils'), 'package.json')}`,
    );
  });

  it('takes the NEAREST copy of a dependency, the way Node resolves it', () => {
    // Every other case here resolves utils by walking UP from the cli to the
    // hoisted copy. A copy nested under the cli's own node_modules shadows it
    // for Node, so it must for the digest: the hoisted copy is not what runs.
    const { dirOf } = install([CLI, UTILS]);
    const nested = safePath.join(dirOf('cli'), 'node_modules', SCOPE, 'utils');
    put(safePath.join(nested, 'package.json'), JSON.stringify({ name: `${SCOPE}/utils`, version: '0.2.0' }));
    put(safePath.join(nested, 'dist/index.js'), '// nested utils\n');
    const before = closureDigest(dirOf('cli'));

    writeFileSync(safePath.join(dirOf('utils'), 'dist/index.js'), '// hoisted, shadowed\n', 'utf-8');
    expect(closureDigest(dirOf('cli'))).toBe(before);

    writeFileSync(safePath.join(nested, 'dist/index.js'), '// nested utils v2\n', 'utf-8');
    expect(closureDigest(dirOf('cli'))).not.toBe(before);
  });
});
