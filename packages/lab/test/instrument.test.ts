/**
 * Axis C resolution.
 *
 * The load-bearing test in this file is not any of the happy paths — it is
 * {@link expectRejectionNaming}, applied to every way a named vat can fail to
 * exist. A resolver that quietly fell back to a vat on `PATH` would keep every
 * happy-path test green while stamping reports with an instrument that never
 * ran, and nothing downstream could ever detect it. So each failure mode is
 * pinned twice: that it throws at all, and that the message names the path or
 * spec the caller actually gave, because an error that does not is unactionable
 * in a harness that resolves several instruments per run.
 *
 * The other deliberate one is "two builds at the same version" — the property
 * `commit` exists for. Every dev build in this repo carries the semver of the
 * release it branched from, so a resolver that dropped the commit would make
 * two genuinely different instruments compare equal.
 */

/* eslint-disable security/detect-non-literal-fs-filename -- every path here is derived from a controlled mkdtemp scratch dir */

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';

import {
  normalizedTmpdir,
  resolveFromImportMeta,
  safeExecSync,
  safePath,
  toForwardSlash,
} from '@vibe-agent-toolkit/utils';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { resolveInstrument } from '../src/harness/instrument.js';
import type { InstrumentSource } from '../src/harness/types.js';

/** This checkout — packages/lab/test → packages/lab → packages → root. */
const REPO_ROOT = resolveFromImportMeta(import.meta.url, '../../..');

const SEMVER = /^\d+\.\d+\.\d+/;
const SHA1 = /^[0-9a-f]{40}$/;
const VAT_BIN_SUFFIX = /packages\/cli\/dist\/bin\/vat\.js$/;

/** Layout a vat checkout is expected to have, mirrored by the fixtures below. */
const CLI_DIST_DIR = 'packages/cli/dist';
const CLI_BIN = 'packages/cli/dist/bin/vat.js';
const CLI_MANIFEST = 'packages/cli/package.json';

let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(safePath.join(normalizedTmpdir(), 'lab-instrument-'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

/**
 * Run git in a fixture, with identity and signing pinned so the test does not
 * depend on the developer's global config.
 *
 * @param cwd - Repository directory
 * @param args - Git arguments
 */
function git(cwd: string, args: string[]): void {
  safeExecSync(
    'git',
    [
      '-c',
      'user.email=lab@example.invalid',
      '-c',
      'user.name=Lab',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'init.defaultBranch=main',
      ...args,
    ],
    { cwd, stdio: 'pipe' },
  );
}

/** What a fixture tree should be missing, if anything. */
interface FakeTreeOptions {
  /** Version written into packages/cli/package.json. */
  readonly version?: string;
  /** Body of the fake bin — varying it varies the commit. */
  readonly binBody?: string;
  /** Omit the built bin. */
  readonly noBin?: boolean;
  /** Omit packages/cli/package.json. */
  readonly noManifest?: boolean;
  /** Skip `git init` + commit. */
  readonly noGit?: boolean;
}

/**
 * Build a directory that looks like a built vat checkout.
 *
 * @param name - Subdirectory of the scratch dir to create
 * @param options - Which pieces to leave out, and what to put in the rest
 * @returns Absolute path to the fixture tree
 */
async function makeTree(name: string, options: FakeTreeOptions = {}): Promise<string> {
  const root = safePath.join(scratch, name);
  await mkdir(safePath.join(root, `${CLI_DIST_DIR}/bin`), { recursive: true });

  if (options.noBin !== true) {
    await writeFile(safePath.join(root, CLI_BIN), options.binBody ?? '#!/usr/bin/env node\n');
  }
  if (options.noManifest !== true) {
    await writeFile(
      safePath.join(root, CLI_MANIFEST),
      JSON.stringify({ name: '@vibe-agent-toolkit/cli', version: options.version ?? '0.1.42' }),
    );
  }
  if (options.noGit !== true) {
    git(root, ['init']);
    git(root, ['add', '--all']);
    git(root, ['commit', '--message', `fixture ${name}`]);
  }
  return root;
}

/**
 * Assert that resolution rejects, and that the message names each fragment —
 * normally the exact path or spec the caller supplied.
 *
 * @param source - The instrument source expected to fail
 * @param fragments - Substrings the message must contain
 */
async function expectRejectionNaming(
  source: InstrumentSource,
  ...fragments: string[]
): Promise<void> {
  const outcome: unknown = await resolveInstrument(source).then(
    () => null,
    (error: unknown) => error,
  );
  expect(outcome, 'resolveInstrument resolved where it must have thrown').toBeInstanceOf(Error);
  const { message } = outcome as Error;
  for (const fragment of fragments) {
    expect(message).toContain(fragment);
  }
}

describe('resolveInstrument — kind: tree', () => {
  it('resolves this checkout to its built bin, its version, and its HEAD commit', async () => {
    const resolved = await resolveInstrument({ kind: 'tree', path: REPO_ROOT });

    expect(resolved.command).toBe(process.execPath);
    expect(resolved.leadingArgs).toHaveLength(1);

    const bin = resolved.leadingArgs[0] ?? '';
    expect(toForwardSlash(bin)).toMatch(VAT_BIN_SUFFIX);
    expect(existsSync(bin)).toBe(true);

    expect(resolved.version.version).toMatch(SEMVER);
    expect(resolved.version.commit).toMatch(SHA1);
  });

  it('distinguishes two builds carrying the same version by their commit', async () => {
    const first = await resolveInstrument({
      kind: 'tree',
      path: await makeTree('same-version-a', { version: '0.1.42', binBody: '// build A\n' }),
    });
    const second = await resolveInstrument({
      kind: 'tree',
      path: await makeTree('same-version-b', { version: '0.1.42', binBody: '// build B\n' }),
    });

    expect(second.version.version).toBe(first.version.version);
    expect(first.version.commit).toMatch(SHA1);
    expect(second.version.commit).toMatch(SHA1);
    expect(second.version.commit).not.toBe(first.version.commit);
  });

  it('throws naming the path when the tree does not exist', async () => {
    const missing = safePath.join(scratch, 'no-such-checkout');
    await expectRejectionNaming({ kind: 'tree', path: missing }, missing);
  });

  it('throws naming the expected bin when the tree was never built', async () => {
    const root = await makeTree('unbuilt', { noBin: true });
    await expectRejectionNaming({ kind: 'tree', path: root }, safePath.join(root, CLI_BIN));
  });

  it('throws naming the manifest when packages/cli/package.json is missing', async () => {
    const root = await makeTree('no-manifest', { noManifest: true });
    await expectRejectionNaming({ kind: 'tree', path: root }, safePath.join(root, CLI_MANIFEST));
  });

  it('throws naming the tree when it is not a git checkout', async () => {
    const root = await makeTree('no-git', { noGit: true });
    await expectRejectionNaming({ kind: 'tree', path: root }, root);
  });

  it('throws rather than borrowing an enclosing repository’s HEAD', async () => {
    const outer = await makeTree('outer-repo');
    const nested = safePath.join(outer, 'vendor/vat');
    await mkdir(safePath.join(nested, `${CLI_DIST_DIR}/bin`), { recursive: true });
    await writeFile(safePath.join(nested, CLI_BIN), '// nested\n');
    await writeFile(
      safePath.join(nested, CLI_MANIFEST),
      JSON.stringify({ version: '9.9.9' }),
    );

    await expectRejectionNaming({ kind: 'tree', path: nested }, nested);
  });
});

describe('resolveInstrument — kind: dist', () => {
  it('resolves a dist directory with a null commit', async () => {
    const resolved = await resolveInstrument({
      kind: 'dist',
      path: safePath.join(REPO_ROOT, CLI_DIST_DIR),
    });

    expect(resolved.command).toBe(process.execPath);
    expect(toForwardSlash(resolved.leadingArgs[0] ?? '')).toMatch(VAT_BIN_SUFFIX);
    expect(resolved.version.version).toMatch(SEMVER);
    expect(resolved.version.commit).toBeNull();
  });

  it('resolves a bin file named directly, and reads the nearest package.json', async () => {
    const resolved = await resolveInstrument({
      kind: 'dist',
      path: safePath.join(REPO_ROOT, CLI_BIN),
    });

    expect(toForwardSlash(resolved.leadingArgs[0] ?? '')).toMatch(VAT_BIN_SUFFIX);
    expect(resolved.version.commit).toBeNull();
  });

  it('reads no commit even from a dist sitting inside a git checkout', async () => {
    const root = await makeTree('dist-inside-git');
    const resolved = await resolveInstrument({
      kind: 'dist',
      path: safePath.join(root, CLI_DIST_DIR),
    });

    expect(resolved.version.version).toBe('0.1.42');
    expect(resolved.version.commit).toBeNull();
  });

  it('throws naming the path when nothing is there', async () => {
    const missing = safePath.join(scratch, 'no-such-dist');
    await expectRejectionNaming({ kind: 'dist', path: missing }, missing);
  });

  it('throws naming the path and the candidates tried when a directory holds no entry point', async () => {
    const empty = safePath.join(scratch, 'empty-dist');
    await mkdir(empty, { recursive: true });
    await expectRejectionNaming(
      { kind: 'dist', path: empty },
      empty,
      safePath.join(empty, 'bin/vat.js'),
    );
  });
});

describe('resolveInstrument — kind: npx', () => {
  const PINNED: readonly (readonly [spec: string, version: string])[] = [
    ['@vibe-agent-toolkit/cli@0.1.41', '0.1.41'],
    ['vat@1.2.3', '1.2.3'],
    ['@vibe-agent-toolkit/cli@0.1.42-rc.5', '0.1.42-rc.5'],
    ['@vibe-agent-toolkit/cli@1.0.0+build.7', '1.0.0+build.7'],
  ];

  it.for(PINNED)('extracts %s to its pinned version', async ([spec, version]) => {
    const resolved = await resolveInstrument({ kind: 'npx', spec });

    // Bare `npx`, never `npx.cmd`: the spawn wrappers own PATH resolution and
    // the Windows `.cmd` shell decision.
    expect(resolved.command).toBe('npx');
    expect(resolved.leadingArgs).toEqual(['--yes', spec]);
    expect(resolved.version).toEqual({ version, commit: null });
  });

  /**
   * Unpinned is an ERROR, not a `latest` stamp — documented in the module
   * header. A dist-tag or a range resolves against the registry at run time, so
   * two reports stamped from it would claim to be the same instrument while
   * potentially being different builds. Resolution also has to work offline,
   * and asking npm what `latest` is today would be a network call.
   */
  const UNPINNED = [
    '@vibe-agent-toolkit/cli',
    'vat',
    '@vibe-agent-toolkit/cli@latest',
    '@vibe-agent-toolkit/cli@next',
    '@vibe-agent-toolkit/cli@^0.1.0',
    '@vibe-agent-toolkit/cli@0.1',
    'vat@',
  ] as const;

  it.for(UNPINNED)('refuses the unpinned spec %s', async (spec) => {
    await expectRejectionNaming({ kind: 'npx', spec }, `"${spec}"`);
  });

  it('refuses an empty spec', async () => {
    await expectRejectionNaming({ kind: 'npx', spec: '   ' }, 'the spec is empty');
  });
});
