/**
 * Arm identity by the bytes it runs: a digest over the arm's whole module
 * closure.
 *
 * Before this, an instrument was named by `version`, `commit` and `dirty` —
 * and a `dist:` arm has no commit, so two `dist:` arms carrying one version
 * were the SAME instrument to every comparison, whatever they had been built
 * from. The version cannot see the case that matters most: a dependency's
 * `dist/` rebuilt while every `package.json` stayed put.
 *
 * ## What the digest covers
 *
 * The cli package, and every `@vibe-agent-toolkit/*` package it depends on,
 * transitively — each as its `package.json` plus every file under its `dist/`
 * (build info excluded: `*.tsbuildinfo` is compiler bookkeeping, not code that
 * runs). Only `dependencies`: `@vibe-agent-toolkit/rag` and `rag-lancedb` are
 * OPTIONAL peers of the cli, absent from a plain install, and a closure that
 * required them would refuse every real one. Third-party dependencies are out
 * of scope: the lab measures vat, and a lockfile pins those.
 *
 * ## Errors, never fallbacks
 *
 * A declared `@vibe-agent-toolkit/*` dependency that does not resolve THROWS,
 * naming it — the same rule as `instrument.ts`. Skipping it would digest
 * something smaller than what runs, and two arms both missing it would match.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { isPathAbsentError, safePath } from '@vibe-agent-toolkit/utils';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';

import { type InstrumentVersion, sameInstrument } from '../envelope/coordinate.js';

import { type ArmEnvironment, sameArmEnvironment } from './arm-env.js';
import { compareByCodeUnit, contentDigest, fingerprintFiles } from './fingerprint.js';

/** The scope whose packages make up a closure. */
const VAT_SCOPE = '@vibe-agent-toolkit/';

/**
 * Separates a record's fields. A NUL occurs in no package name and no path, so
 * no two distinct closures can frame to the same byte stream.
 */
const FIELD_SEPARATOR = String.fromCodePoint(0);

/** What a package's `dist/` digest leaves out: compiler bookkeeping, not code. */
const CLOSURE_EXCLUDE: readonly string[] = ['**/*.tsbuildinfo'];

/** The fields of a package manifest the closure walk reads. */
interface ClosureManifest {
  readonly name: string;
  readonly dependencies: readonly string[];
}

/**
 * Read a package's name and its `@vibe-agent-toolkit/*` runtime dependencies.
 *
 * @param packageRoot - Absolute package directory
 * @returns The name, and the scoped names under `dependencies` only
 * @throws {Error} when the manifest is missing, unreadable, or names no package
 */
function readClosureManifest(packageRoot: string): ClosureManifest {
  const manifestPath = safePath.join(packageRoot, 'package.json');
  let parsed: { name?: unknown; dependencies?: unknown };
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf-8')) as typeof parsed;
  } catch (cause) {
    // Named for the closure walk that asked, not left as a bare SyntaxError or
    // ENOENT: the reader needs to know WHICH member of which arm's closure broke.
    throw new Error(
      `closure: cannot read ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
  const dependencies =
    typeof parsed.dependencies === 'object' && parsed.dependencies !== null
      ? Object.keys(parsed.dependencies).filter((name) => name.startsWith(VAT_SCOPE))
      : [];
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    throw new Error(`closure: ${manifestPath} names no package`);
  }
  return { name: parsed.name, dependencies: dependencies.toSorted(compareByCodeUnit) };
}

/**
 * Is there a directory at this path?
 *
 * @param path - Absolute path
 * @returns True for a directory; false when nothing is there
 * @throws {Error} for anything but absence — a path the lab may not look at is
 *   not a path that is missing
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch (error) {
    if (isPathAbsentError(error)) return false;
    throw error;
  }
}

/**
 * Resolve a package name the way Node does: `<dir>/node_modules/<name>` from
 * `fromDir` upward, the first hit winning, then through any symlink.
 *
 * The same walk serves a bun workspace (a hoisted symlink into `packages/`) and
 * an npm prefix (a real directory), which is why it is the walk and not a
 * workspace-aware shortcut.
 *
 * @param name - The package to find
 * @param fromDir - The depending package's directory
 * @param dependent - The depending package's name, for the error
 * @returns The package's real directory
 * @throws {Error} naming the package when no ancestor provides it
 */
function resolvePackage(name: string, fromDir: string, dependent: string): string {
  let dir = fromDir;
  for (;;) {
    const candidate = safePath.join(dir, 'node_modules', name);
    if (isDirectory(candidate)) return safePath.resolve(normalizePath(candidate));
    const parent = safePath.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`closure: ${name} is declared by ${dependent} but does not resolve from ${fromDir}`);
}

/**
 * The digest of ONE package: its manifest plus its `dist/`.
 *
 * @param packageRoot - Absolute, real package directory
 * @param name - The package name, for the error
 * @returns A 64-character hex digest
 * @throws {Error} when the package has no `dist/` — a closure member with
 *   nothing built is not a build that can run
 */
function packageDigest(packageRoot: string, name: string): string {
  const dist = safePath.join(packageRoot, 'dist');
  if (!isDirectory(dist)) {
    throw new Error(`closure: ${name} at ${packageRoot} has no dist/ — build it first`);
  }
  const digest = createHash('sha256');
  digest.update(`package.json${FIELD_SEPARATOR}${contentDigest(packageRoot, 'package.json')}\n`, 'utf8');
  digest.update(`dist${FIELD_SEPARATOR}${fingerprintFiles(dist, { fromGit: false, exclude: CLOSURE_EXCLUDE }).fingerprint}\n`, 'utf8');
  return digest.digest('hex');
}

/**
 * The SHA-256 over an arm's whole module closure.
 *
 * @param cliPackageRoot - The cli package directory the arm runs (`packages/cli`
 *   in a tree, the package root of a `dist:` arm)
 * @returns 64 lowercase hex characters
 * @throws {Error} when a declared `@vibe-agent-toolkit/*` dependency does not
 *   resolve, or a closure member has no `dist/`
 */
export function closureDigest(cliPackageRoot: string): string {
  const root = safePath.resolve(normalizePath(safePath.resolve(cliPackageRoot)));
  const lines = new Map<string, string>();
  const visited = new Set<string>();
  const pending: { readonly dir: string }[] = [{ dir: root }];

  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (visited.has(next.dir)) continue;
    visited.add(next.dir);
    const manifest = readClosureManifest(next.dir);
    lines.set(`${manifest.name}${FIELD_SEPARATOR}${next.dir}`, `${manifest.name}${FIELD_SEPARATOR}${packageDigest(next.dir, manifest.name)}\n`);
    for (const dependency of manifest.dependencies) {
      pending.push({ dir: resolvePackage(dependency, next.dir, manifest.name) });
    }
  }

  // Keyed by name, sorted, and the path left out of the digested line: the
  // same bytes installed at two different prefixes are the same closure.
  const digest = createHash('sha256');
  for (const line of [...lines.values()].toSorted(compareByCodeUnit)) digest.update(line, 'utf8');
  return digest.digest('hex');
}

/** One arm, as the refusal compares it. */
export interface ArmIdentity {
  readonly instrument: InstrumentVersion;
  readonly env: ArmEnvironment;
}

/**
 * Would two arms measure the same thing?
 *
 * True only when the instrument (version, commit, dirty AND closure) and the
 * environment both match — one build in two configurations is a real A/B, and
 * so is one configuration of two builds. `ab` refuses a true here unless the
 * run is a declared `--control`.
 *
 * @param a - One arm
 * @param b - The other
 * @returns True when nothing distinguishes them
 */
export function indistinguishableArms(a: ArmIdentity, b: ArmIdentity): boolean {
  return sameInstrument(a.instrument, b.instrument) && sameArmEnvironment(a.env, b.env);
}
