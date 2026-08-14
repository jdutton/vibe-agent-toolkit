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
 *
 * Third, and the reason every fixture here builds BOTH `dist/bin.js` and
 * `dist/bin/vat.js`: resolving to the wrapper instead of the CLI shipped once
 * already, and no assertion could have caught it while only one of the two files
 * was on disk. A fixture that cannot make the two answers differ tests nothing.
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
const VAT_BIN_SUFFIX = /packages\/cli\/dist\/bin\.js$/;

/** Layout a vat checkout is expected to have, mirrored by the fixtures below. */
const CLI_DIST_DIR = 'packages/cli/dist';
/** The CLI's own entry point — the only thing the harness may measure through. */
const CLI_BIN = 'packages/cli/dist/bin.js';
/** The context-detecting wrapper `package.json` maps `vat` to, sitting beside it. */
const CLI_WRAPPER = 'packages/cli/dist/bin/vat.js';
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
  /** Omit dist/bin.js, leaving the wrapper as the only thing on disk. */
  readonly noBin?: boolean;
  /** Omit dist/bin/vat.js, leaving nothing for a wrong resolver to find. */
  readonly noWrapper?: boolean;
  /** Omit packages/cli/package.json. */
  readonly noManifest?: boolean;
  /** Skip `git init` + commit. */
  readonly noGit?: boolean;
}

/**
 * Build a directory that looks like a built vat checkout.
 *
 * Both entry points exist by default — see this file's header. Leaving the
 * wrapper out would make every "resolves to bin.js" assertion pass for the wrong
 * reason.
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
  if (options.noWrapper !== true) {
    await writeFile(safePath.join(root, CLI_WRAPPER), '// context-detecting wrapper\n');
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

/**
 * Assert which entry point an instrument resolves to, having first proved the
 * fixture could have answered differently.
 *
 * The `alternative` check is the whole point: without a wrapper on disk, "it
 * chose bin.js" is indistinguishable from "bin.js was all there was".
 *
 * @param source - The instrument source to resolve
 * @param expected - The entry point it must choose
 * @param alternative - The entry point it must NOT choose, which must exist
 */
async function expectEntryPoint(
  source: InstrumentSource,
  expected: string,
  alternative: string,
): Promise<void> {
  expect(existsSync(alternative), 'fixture cannot distinguish the two answers').toBe(true);

  const resolved = await resolveInstrument(source);

  expect(resolved.leadingArgs).toHaveLength(1);
  expect(toForwardSlash(resolved.leadingArgs[0] ?? '')).toBe(toForwardSlash(expected));
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

  /**
   * The shipped bug: `dist/bin/vat.js` is the cwd-detecting wrapper, and the
   * harness runs every command with cwd set to the SUBJECT. An A/B of two
   * checkouts against an adopter therefore ran the adopter's own installed vat
   * on both arms, agreed with itself, and stamped both reports with the two
   * commits under test.
   */
  it('resolves the CLI entry point, not the cwd-detecting wrapper beside it', async () => {
    const root = await makeTree('both-entry-points');

    await expectEntryPoint(
      { kind: 'tree', path: root },
      safePath.join(safePath.resolve(root), CLI_BIN),
      safePath.join(root, CLI_WRAPPER),
    );
  });

  /**
   * The shipped defect this pins: a run measured a build made from a tree with
   * substantial uncommitted changes, and the header said
   * `Instrument: vat 0.2.0-rc.2 (7b65ba86)` with nothing to indicate the bytes
   * measured were not that commit's. The SUBJECT side had detected and printed
   * `(DIRTY working tree)` all along; axis C never asked.
   *
   * The pair of assertions is the point. Asserting only that a dirty tree
   * reports `true` would pass equally well for a resolver that hard-coded it, so
   * the same fixture is measured clean first and dirtied afterwards — one tree,
   * two answers.
   */
  it('reports the instrument checkout as clean, then as dirty once it is edited', async () => {
    const root = await makeTree('dirty-instrument');

    expect((await resolveInstrument({ kind: 'tree', path: root })).version.dirty).toBe(false);

    await writeFile(safePath.join(root, CLI_BIN), '// edited, never committed\n');

    const dirty = await resolveInstrument({ kind: 'tree', path: root });
    expect(dirty.version.dirty).toBe(true);
    // The commit is still stamped — a dirty build is measured, not refused. The
    // label is what keeps the stamp honest.
    expect(dirty.version.commit).toMatch(SHA1);
  });

  it('counts an untracked file as dirty, matching what the subject axis counts', async () => {
    // Same definition on both axes, because it is literally the same function —
    // see `harness/git-state.ts`. A resolver that only looked at tracked files
    // would call a tree clean that the subject side calls dirty, and one report
    // would then carry two meanings of the word.
    const root = await makeTree('untracked-instrument');
    await writeFile(safePath.join(root, 'scratch-note.txt'), 'not committed\n');

    expect((await resolveInstrument({ kind: 'tree', path: root })).version.dirty).toBe(true);
  });

  it('throws naming the path when the tree does not exist', async () => {
    const missing = safePath.join(scratch, 'no-such-checkout');
    await expectRejectionNaming({ kind: 'tree', path: missing }, missing);
  });

  it('throws naming the expected bin when the tree was never built', async () => {
    const root = await makeTree('unbuilt', { noBin: true, noWrapper: true });
    await expectRejectionNaming({ kind: 'tree', path: root }, safePath.join(root, CLI_BIN));
  });

  it('throws naming the missing bin.js when only the wrapper was built', async () => {
    const root = await makeTree('wrapper-only-tree', { noBin: true });
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
    // And no dirtiness claim either, even though a checkout is right there: the
    // built artifact is what runs, and `dist:` deliberately does not ask the
    // tree around it anything. A `false` here would be the confident wrong
    // answer this null exists to prevent.
    expect(resolved.version.dirty).toBeNull();
  });

  it('resolves a dist directory to bin.js, not to the wrapper beside it', async () => {
    const dist = safePath.join(await makeTree('dist-both-entry-points'), CLI_DIST_DIR);

    await expectEntryPoint(
      { kind: 'dist', path: dist },
      safePath.join(dist, 'bin.js'),
      safePath.join(dist, 'bin/vat.js'),
    );
  });

  /**
   * `dist:` takes a file path verbatim, so the wrapper is one plausible typo
   * away from being measured — and it would run, and produce a complete report
   * of a binary nobody chose.
   */
  it('refuses the wrapper named directly, and points at bin.js instead', async () => {
    const root = await makeTree('dist-wrapper-named');

    await expectRejectionNaming(
      { kind: 'dist', path: safePath.join(root, CLI_WRAPPER) },
      safePath.join(root, CLI_WRAPPER),
      'wrapper',
      safePath.join(root, CLI_BIN),
    );
  });

  it('names the wrapper rather than reporting nothing when a dist holds only it', async () => {
    const dist = safePath.join(await makeTree('dist-wrapper-only', { noBin: true }), CLI_DIST_DIR);

    await expectRejectionNaming(
      { kind: 'dist', path: dist },
      safePath.join(dist, 'bin/vat.js'),
      'wrapper',
    );
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
      safePath.join(empty, 'bin.js'),
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
    // `dirty: null`, never `false`: a published tarball has no checkout, so
    // there is nothing that could have been dirty and nothing to claim clean.
    expect(resolved.version).toEqual({ version, commit: null, dirty: null });
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

/**
 * The instrument's own filesystem root, which the `io` facet uses to rewrite an
 * absolute call site into `packages/resources/dist/content-key.js:141`.
 *
 * Wrong here is not a crash. A root that is absent where it should be present
 * leaves every site absolute and machine-specific, so two reports of the same
 * work never share a site key and the N+1 detector sees a hundred lukewarm sites
 * instead of one hot one. A root that is present where it should be absent
 * bakes an `npx` cache path into the report. Both produce a complete, valid,
 * useless report — so all three cases are pinned, not just the interesting one.
 */
describe('resolveInstrument — the instrument root', () => {
  it('roots a tree at the checkout, not at its built bin', async () => {
    const root = await makeTree('rooted-tree');

    const resolved = await resolveInstrument({ kind: 'tree', path: root });

    expect(resolved.root).toBe(safePath.resolve(root));
  });

  it('roots a dist at the package that owns the manifest, not at the path named', async () => {
    const root = await makeTree('rooted-dist');

    // Named two directories BELOW the package root, and by a file rather than a
    // directory. Rooting at the caller's path would make every site outside
    // `dist/bin` look foreign and leave it absolute.
    const resolved = await resolveInstrument({
      kind: 'dist',
      path: safePath.join(root, CLI_BIN),
    });

    expect(resolved.root).toBe(safePath.resolve(safePath.join(root, 'packages/cli')));
  });

  it('gives an npx instrument no root at all, which is a fact rather than a gap', async () => {
    const resolved = await resolveInstrument({
      kind: 'npx',
      spec: '@vibe-agent-toolkit/cli@0.1.41',
    });

    // A published package is unpacked under an arbitrary cache directory, and
    // every file in it sits under `node_modules` — which the site normalizer
    // already keys on. Naming a temp path here would mean nothing to a reader.
    expect(resolved.root).toBeUndefined();
  });
});
