/**
 * Axis C — resolving *which build of vat* is doing the measuring.
 *
 * ## Errors, never fallbacks
 *
 * Every function here fails loudly when the vat the caller named cannot be
 * found. None of them falls back to a vat on `PATH`, to a sibling checkout, or
 * to "the one we happen to be running under". That is not defensiveness for its
 * own sake — it is the single worst bug this module can have.
 *
 * A fallback does not produce a missing number. It produces a *present* number,
 * stamped with an {@link InstrumentVersion} naming an instrument that never ran.
 * The report looks complete, passes every schema check, and lands in a
 * comparison against another report — and the delta it shows is attributed to a
 * change that did not happen. Nothing downstream can detect this: by the time
 * the coordinate is written, the evidence that the wrong binary ran is gone.
 * A thrown error costs one run; a wrong stamp costs every comparison that
 * report ever takes part in, including the ones made months later by someone
 * who was not here.
 *
 * The same reasoning drives two choices that look strict in isolation:
 *
 * - **A `tree` with no git is an error, not a `null` commit.** `kind: 'tree'`
 *   means "read the version *and the commit* from this checkout" — the commit is
 *   the whole reason the tree case exists, because every dev build in this repo
 *   carries the semver of the release it branched from. A tree that cannot
 *   supply one is a `dist`, and the caller should say so.
 * - **An unpinned `npx` spec is an error.** `npx @vibe-agent-toolkit/cli` runs
 *   whatever `latest` is at that instant. Two reports stamped from it would
 *   claim to be the same instrument while potentially being different builds —
 *   precisely the confusion `commit` exists to prevent, and one we cannot
 *   resolve offline. A dist-tag (`@latest`, `@next`) is unpinned for the same
 *   reason a range (`@^0.1.0`) is.
 *
 * `commit` is `null` only where it is *knowably* absent: a bare `dist/` has no
 * checkout to ask, and a published tarball does not carry its provenance. Null
 * there is a fact, not a guess.
 *
 * ## Windows
 *
 * Paths are produced through `safePath` (forward slashes everywhere). The `npx`
 * case returns the **bare** command `npx`, never `npx.cmd` and never a resolved
 * path: the toolkit's spawn wrappers (`safeExecResult`, `spawnHardened`) already
 * resolve bare names through `which.sync` — which finds `npx.cmd` on Windows —
 * and switch on `shell: true` for `.cmd`/`.bat` shims, as Node's DEP0190
 * requires. Hardcoding the extension here would duplicate that decision and
 * break the moment it changes.
 */

import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { safeExecResult, safePath } from '@vibe-agent-toolkit/utils';
import { z } from 'zod';

import type { InstrumentSource, ResolvedInstrument } from './types.js';

/** Where a vat checkout keeps its built entry point, relative to the tree root. */
const TREE_BIN_RELATIVE = 'packages/cli/dist/bin/vat.js';

/** Where a vat checkout keeps the manifest that carries the version. */
const TREE_PACKAGE_JSON_RELATIVE = 'packages/cli/package.json';

/** Entry points looked for when `kind: 'dist'` names a directory rather than a file. */
const DIST_BIN_CANDIDATES = ['bin/vat.js', 'vat.js'] as const;

/** Lowercase hex, the alphabet of a git object id. */
const HEX = /^[0-9a-f]+$/;

/** Lengths of a concrete git object id: SHA-1, and SHA-256 repositories. */
const COMMIT_LENGTHS = new Set([40, 64]);

/** `1.2.3` — the mandatory part of a pinned npm version. */
const CORE_VERSION_SHAPE = /^\d+\.\d+\.\d+$/;

/** Everything after the first `-` or `+`: prerelease and/or build metadata. */
const VERSION_SUFFIX_SHAPE = /^[0-9A-Za-z.+-]+$/;

/** Where prerelease/build metadata starts, if it does. */
const VERSION_SUFFIX_START = /[-+]/;

/**
 * Is this string a *concrete* version, as opposed to a range or a dist-tag?
 *
 * Split-then-match rather than one regex on purpose: composing the two parts
 * into a single pattern needs a quantifier inside a quantifier, which is a
 * backtracking hazard over caller-supplied text. Each half here is anchored and
 * flat.
 *
 * @param value - The text after the spec's version separator
 * @returns `true` for `1.2.3`, `1.2.3-rc.5`, `1.0.0+build.7`; `false` for
 *   `latest`, `^0.1.0`, `0.1`
 */
function isPinnedVersion(value: string): boolean {
  const boundary = value.search(VERSION_SUFFIX_START);
  if (boundary === -1) return CORE_VERSION_SHAPE.test(value);
  return (
    CORE_VERSION_SHAPE.test(value.slice(0, boundary)) &&
    VERSION_SUFFIX_SHAPE.test(value.slice(boundary + 1))
  );
}

/**
 * Is this a concrete git object id?
 *
 * @param value - Candidate commit string
 * @returns `true` for a full-length lowercase hex id
 */
function isConcreteCommit(value: string): boolean {
  return COMMIT_LENGTHS.has(value.length) && HEX.test(value);
}

/**
 * Reading someone else's `package.json`: liberal, per the repo's Postel's-law
 * rule. We need `version` and do not care what else is in there.
 */
const PackageManifestSchema = z
  .object({
    version: z.string().min(1),
  })
  .passthrough();

/** The standing reason no resolution failure is ever softened into a fallback. */
const NO_FALLBACK_NOTE =
  'The harness will not fall back to another vat: a report stamped with an instrument ' +
  'nobody asked for is worse than no report at all.';

/**
 * Canonical, comparable form of a path — symlinks resolved, forward slashes,
 * case-folded on Windows.
 *
 * Both sides of every comparison go through this one function, so the
 * casing-preservation difference between Node's realpath implementations cannot
 * make two spellings of the same directory look different.
 *
 * @param path - An existing absolute path
 * @returns Its canonical form
 */
async function canonicalPath(path: string): Promise<string> {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied instrument path; canonicalizing it is the point
  const real = safePath.resolve(await realpath(path));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Is this path an existing regular file?
 *
 * @param path - Path to probe
 * @returns `true` when it exists and is a file
 */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- caller-supplied instrument path; probing it is the point
    const stats = await stat(path);
    return stats.isFile();
  } catch {
    return false;
  }
}

/**
 * Read the `version` field out of a `package.json`.
 *
 * @param manifestPath - Absolute path to the manifest
 * @param kind - The instrument kind, for the error message
 * @returns The declared version
 * @throws {Error} when the file is missing, unparseable, or has no usable `version`
 */
async function readManifestVersion(manifestPath: string, kind: string): Promise<string> {
  let raw: string;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- manifest located relative to the caller-supplied instrument path
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new Error(
      `resolveInstrument({ kind: '${kind}' }): cannot read ${manifestPath}. ` +
        `Without it there is no version to stamp on axis C. ${NO_FALLBACK_NOTE}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `resolveInstrument({ kind: '${kind}' }): ${manifestPath} is not valid JSON ` +
        `(${error instanceof Error ? error.message : String(error)}).`,
    );
  }

  const result = PackageManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `resolveInstrument({ kind: '${kind}' }): ${manifestPath} has no usable "version" field.`,
    );
  }
  return result.data.version;
}

/**
 * Walk up from a directory to the nearest enclosing `package.json`.
 *
 * @param startDir - Absolute directory to start from
 * @param subject - The path being explained, for the error message
 * @returns Absolute path to the manifest
 * @throws {Error} when no manifest exists anywhere above `startDir`
 */
async function findNearestManifest(startDir: string, subject: string): Promise<string> {
  let current = safePath.resolve(startDir);
  for (;;) {
    const candidate = safePath.join(current, 'package.json');
    if (await isRegularFile(candidate)) return candidate;
    const parent = safePath.resolve(dirname(current));
    if (parent === current) {
      throw new Error(
        `resolveInstrument({ kind: 'dist' }): no package.json above ${subject}, ` +
          `so the vat version cannot be determined. ${NO_FALLBACK_NOTE}`,
      );
    }
    current = parent;
  }
}

/**
 * Read the HEAD commit of a vat checkout, proving the directory really is that
 * checkout's root.
 *
 * `git rev-parse` searches *upwards*, so running it inside a directory that is
 * merely nested within some other repository answers with that outer
 * repository's HEAD — a wrong commit, silently, on an instrument that looked
 * fine. Asking for `--show-toplevel` in the same invocation and comparing it
 * against the named path is what turns that into an error.
 *
 * @param treeRoot - Absolute path to the checkout root
 * @returns The resolved commit
 * @throws {Error} when the path is not a git checkout, or not the root of one
 */
async function readTreeCommit(treeRoot: string): Promise<string> {
  const result = safeExecResult('git', ['rev-parse', '--show-toplevel', 'HEAD'], {
    cwd: treeRoot,
    encoding: 'utf-8',
  });

  const lines = String(result.stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const [toplevel, commit] = lines;

  if (!result.success || toplevel === undefined || commit === undefined) {
    const detail = String(result.stderr).trim();
    const why = detail === '' ? `exit ${String(result.status)}` : detail;
    throw new Error(
      `resolveInstrument({ kind: 'tree' }): ${treeRoot} is not a git checkout ` +
        `(git rev-parse failed: ${why}). ` +
        "A tree's commit is the only thing that distinguishes two dev builds carrying the same " +
        "version, so it cannot be omitted. Use kind: 'dist' for a build with no checkout.",
    );
  }

  if ((await canonicalPath(treeRoot)) !== (await canonicalPath(toplevel))) {
    throw new Error(
      `resolveInstrument({ kind: 'tree' }): ${treeRoot} is not the root of its git checkout ` +
        `(that is ${toplevel}). Resolving the commit from here would stamp the enclosing ` +
        "repository's HEAD onto a vat that did not come from it.",
    );
  }

  if (!isConcreteCommit(commit)) {
    throw new Error(
      `resolveInstrument({ kind: 'tree' }): git returned "${commit}" as the HEAD of ${treeRoot}, ` +
        'which is not a concrete commit id.',
    );
  }

  return commit;
}

/**
 * Resolve a vat checkout: its built entry point, its declared version, and its
 * HEAD commit.
 *
 * @param path - Path to the checkout root
 * @returns The resolved instrument
 * @throws {Error} when the tree has no built CLI, no manifest, or no git
 */
async function resolveTree(path: string): Promise<ResolvedInstrument> {
  const treeRoot = safePath.resolve(path);
  const binPath = safePath.join(treeRoot, TREE_BIN_RELATIVE);

  if (!(await isRegularFile(binPath))) {
    throw new Error(
      `resolveInstrument({ kind: 'tree' }): no built vat at ${binPath}. ` +
        `Build the checkout at ${treeRoot} first. ${NO_FALLBACK_NOTE}`,
    );
  }

  const version = await readManifestVersion(
    safePath.join(treeRoot, TREE_PACKAGE_JSON_RELATIVE),
    'tree',
  );
  const commit = await readTreeCommit(treeRoot);

  return {
    command: process.execPath,
    leadingArgs: [binPath],
    version: { version, commit },
    root: treeRoot,
  };
}

/**
 * Find the entry point named by a `kind: 'dist'` path — either the file itself,
 * or the one entry point inside the directory.
 *
 * @param target - Absolute path to a dist directory or bin file
 * @returns Absolute path to the entry point
 * @throws {Error} when nothing is there, or a directory holds no entry point
 */
async function locateDistBin(target: string): Promise<string> {
  if (await isRegularFile(target)) return target;

  const candidates = DIST_BIN_CANDIDATES.map((relative) => safePath.join(target, relative));
  for (const candidate of candidates) {
    if (await isRegularFile(candidate)) return candidate;
  }

  throw new Error(
    `resolveInstrument({ kind: 'dist' }): no vat entry point at ${target} ` +
      `(tried it as a file, then ${candidates.join(', ')}). ${NO_FALLBACK_NOTE}`,
  );
}

/**
 * Resolve a built artifact. There is no checkout behind it, so `commit` is
 * `null` — a recorded absence rather than a guess.
 *
 * @param path - Path to a dist directory or directly to its bin file
 * @returns The resolved instrument
 * @throws {Error} when the path holds no entry point or no manifest
 */
async function resolveDist(path: string): Promise<ResolvedInstrument> {
  const target = safePath.resolve(path);
  const binPath = await locateDistBin(target);
  const manifestPath = await findNearestManifest(dirname(binPath), binPath);
  const version = await readManifestVersion(manifestPath, 'dist');

  return {
    command: process.execPath,
    leadingArgs: [binPath],
    version: { version, commit: null },
    // The package root, not the path the caller named: `dist:` accepts a bin
    // file as readily as a directory, and rooting sites at the file's own
    // directory would make every site outside `dist/bin` look foreign.
    root: safePath.resolve(dirname(manifestPath)),
  };
}

/**
 * Extract the pinned version from an npm spec.
 *
 * @param spec - An npm package spec
 * @returns The pinned version, or `null` when the spec names no concrete version
 */
function pinnedVersionOf(spec: string): string | null {
  const at = spec.lastIndexOf('@');
  // `-1` is a bare name; `0` is the scope sigil of `@scope/pkg`. Neither pins.
  if (at <= 0) return null;
  const version = spec.slice(at + 1);
  return isPinnedVersion(version) ? version : null;
}

/**
 * Resolve a published version run through `npx`.
 *
 * @param spec - An npm spec pinned to a concrete version
 * @returns The resolved instrument
 * @throws {Error} when the spec is empty or names no concrete version
 */
function resolveNpx(spec: string): ResolvedInstrument {
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new Error("resolveInstrument({ kind: 'npx' }): the spec is empty.");
  }

  const version = pinnedVersionOf(trimmed);
  if (version === null) {
    throw new Error(
      `resolveInstrument({ kind: 'npx' }): the spec "${trimmed}" is not pinned to a concrete ` +
        'version. npx would resolve it against the registry at run time, so two reports ' +
        'stamped from it would claim to be the same instrument while potentially being ' +
        `different builds. Pin it, e.g. "${trimmed}@0.1.41".`,
    );
  }

  return {
    // Bare on purpose — the spawn wrappers resolve it (and `npx.cmd` on Windows).
    command: 'npx',
    leadingArgs: ['--yes', trimmed],
    version: { version, commit: null },
  };
}

/**
 * Resolve a named vat into something runnable plus the axis-C coordinate every
 * report it produces will carry.
 *
 * @param source - How the caller named the vat
 * @returns An executable, its leading arguments, and the instrument version
 * @throws {Error} naming the offending path or spec whenever the named vat
 *   cannot be found or cannot supply its coordinate. Resolution failures are
 *   errors, never fallbacks — see the module header.
 */
export async function resolveInstrument(source: InstrumentSource): Promise<ResolvedInstrument> {
  switch (source.kind) {
    case 'tree':
      return resolveTree(source.path);
    case 'dist':
      return resolveDist(source.path);
    case 'npx':
      return resolveNpx(source.spec);
  }
}
