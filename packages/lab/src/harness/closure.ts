/**
 * Arm identity by what it runs: a digest over the arm's whole module closure.
 *
 * Before this, an instrument was named by `version`, `commit` and `dirty` —
 * and a `dist:` arm has no commit, so two `dist:` arms carrying one version
 * were the SAME instrument to every comparison, whatever they had been built
 * from. The version cannot see the case that matters most: a dependency's
 * `dist/` rebuilt while every `package.json` stayed put.
 *
 * ## What the digest covers — one definition for every kind
 *
 * `tree:`, `dist:` and `npx:` alike (an `npx:` arm's walk starts at its
 * installed cli), the closure is the cli package and its transitive dependency
 * closure, walked the way Node resolves it from each package's own location:
 *
 * - **The cli and every `@vibe-agent-toolkit/*` package in it — by BYTES**:
 *   each as its `package.json` plus every file under its `dist/` (build info
 *   excluded: `*.tsbuildinfo` is compiler bookkeeping, not code that runs).
 * - **Every third-party package in it — by its resolved `name@version`**, never
 *   its bytes. A third-party dependency resolved at another version is another
 *   instrument (an `npx:` install floats its ranges, so two installs of one pin
 *   can differ there); the same version's bytes are the registry's, and are not.
 *
 * The walk follows `dependencies`, and — when present — `optionalDependencies`
 * and optional peers (`peerDependenciesMeta`, `optional: true`): an absent one
 * is absent for Node too, so the cli's `@vibe-agent-toolkit/rag` and
 * `rag-lancedb`, which npm does not install unless asked, are passed over when
 * missing and digested like any other member when installed. A stub an `npx:`
 * install writes for a missing optional peer (`npx-install.ts`) is absent: its
 * `exports` names a file it does not hold, so Node fails to load it. Required
 * peers are not followed.
 *
 * Nothing else in a package directory is read. A VAT package that ships a
 * sibling tree beside `dist/` — `vendor/`, `schemas/`, or any other `files:`
 * entry — contributes only its `package.json` and `dist/`, so two `dist:` arms
 * that differ ONLY in such a tree digest identically and read as one instrument.
 *
 * A report stored by an earlier lab whose closure was computed by another
 * definition compares as a different instrument: re-capture it. Nothing detects
 * that case, and no version marker records which definition made a digest.
 *
 * ## The ceiling
 *
 * Resolution never climbs above a ceiling the caller names — the install
 * prefix of an `npx:` arm, the checkout root of a `tree:` arm, the root the
 * `dist:` package belongs to (`instrument.ts`). A package Node would find only
 * above it is not part of the arm the lab built or installed, so a declared
 * dependency that does not resolve under the ceiling is an error, never a
 * lookup above it; so is one whose real directory lies outside it.
 *
 * ## Errors, never fallbacks
 *
 * A declared dependency that does not resolve THROWS, naming it — the same rule
 * as `instrument.ts`. Skipping it would digest something smaller than what
 * runs, and two arms both missing it would match. Every such failure is an arm
 * refusal (`armRefusal`), for every kind: the CLI prints it as one `REFUSED:` line.
 */

import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

import { everywhere, isPathAbsentError, isUnderRoot, pathPresent, safePath } from '@vibe-agent-toolkit/utils';
import { normalizePath } from '@vibe-agent-toolkit/utils/fs';

import { type InstrumentVersion, sameInstrument } from '../envelope/coordinate.js';

import { armRefusal } from './arm-dirs.js';
import { type ArmEnvironment, sameArmEnvironment } from './arm-env.js';
import { compareByCodeUnit, contentDigest, fingerprintFiles } from './fingerprint.js';

/** The scope whose packages a closure digests by their bytes. */
const VAT_SCOPE = '@vibe-agent-toolkit/';

/**
 * Separates a record's fields. A NUL occurs in no package name, version or
 * path, so no two distinct closures can frame to the same byte stream.
 */
const FIELD_SEPARATOR = String.fromCodePoint(0);

/** What a package's `dist/` digest leaves out: compiler bookkeeping, not code. */
const CLOSURE_EXCLUDE: readonly string[] = ['**/*.tsbuildinfo'];

/**
 * The file a stub peer's `exports` names, and never holds: Node resolves the package,
 * stops its walk there, and fails the load as `ERR_MODULE_NOT_FOUND` naming this file.
 * A missing target rather than a throwing module body: a named import is checked at
 * link time, before a body runs, and would fail as a `SyntaxError` the cli does not
 * read as "not installed". Written by `npx-install.ts`; read here, so the closure passes a stub over as absent.
 */
export const STUB_PEER_TARGET = './vat-lab-does-not-install-optional-peers.js';

/** The fields of a package manifest the closure walk reads. */
interface ClosureManifest {
  readonly name: string;
  readonly version: string;
  /** `dependencies` not also under `optionalDependencies`: each must resolve. */
  readonly required: readonly string[];
  /** `optionalDependencies` and optional peers: each is followed when present. */
  readonly optional: readonly string[];
}

/**
 * @param peers - A manifest's `peerDependencies`, as parsed
 * @param meta - Its `peerDependenciesMeta`, as parsed
 * @returns The peers it declares optional: named under `peerDependencies`, `optional: true` in `peerDependenciesMeta`
 */
export function optionalPeerNames(peers: unknown, meta: unknown): string[] {
  if (typeof peers !== 'object' || peers === null || typeof meta !== 'object' || meta === null) return [];
  const flags = meta as Readonly<Record<string, unknown>>;
  return dependencyNames(peers).filter((name) => {
    const flag = flags[name];
    return typeof flag === 'object' && flag !== null && (flag as { optional?: unknown }).optional === true;
  });
}

/**
 * @param field - A manifest's dependency map, as parsed
 * @returns Its names, sorted
 */
function dependencyNames(field: unknown): string[] {
  return typeof field === 'object' && field !== null ? Object.keys(field).toSorted(compareByCodeUnit) : [];
}

/** A package's manifest file. */
const MANIFEST = 'package.json';

/** The fields of a manifest, as parsed — someone else's file, so unknown. */
interface RawManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly exports?: unknown;
  readonly dependencies?: unknown;
  readonly optionalDependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly peerDependenciesMeta?: unknown;
}

/**
 * @param packageRoot - Absolute package directory
 * @returns Its manifest, parsed
 * @throws {VatError} an arm refusal when the manifest is missing or not JSON
 */
function parseManifest(packageRoot: string): RawManifest {
  const manifestPath = safePath.join(packageRoot, MANIFEST);
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf-8')) as RawManifest;
  } catch (cause) {
    // Named for the closure walk that asked, not left as a bare SyntaxError or
    // ENOENT: the reader needs to know WHICH member of which arm's closure broke.
    throw armRefusal(`closure: cannot read ${manifestPath}: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/**
 * Read a package's name, version and runtime dependencies.
 *
 * @param packageRoot - Absolute package directory
 * @returns What the walk needs
 * @throws {VatError} an arm refusal when the manifest is missing, unreadable, or names no package
 *   or version
 */
function readClosureManifest(packageRoot: string): ClosureManifest {
  const manifestPath = safePath.join(packageRoot, MANIFEST);
  const parsed = parseManifest(packageRoot);
  const { name, version } = parsed;
  if (typeof name !== 'string' || name === '') throw armRefusal(`closure: ${manifestPath} names no package`);
  if (typeof version !== 'string' || version === '') throw armRefusal(`closure: ${manifestPath} names no version`);
  const optional = [
    ...new Set([...dependencyNames(parsed.optionalDependencies), ...optionalPeerNames(parsed.peerDependencies, parsed.peerDependenciesMeta)]),
  ];
  const required = dependencyNames(parsed.dependencies).filter((dependency) => !optional.includes(dependency));
  return { name, version, required, optional };
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
 * @param path - An existing absolute path
 * @returns Its real path, through every link
 */
function realDirectory(path: string): string {
  const resolved = safePath.resolve(path);
  return safePath.resolve(normalizePath(resolved, { within: resolved }));
}

/**
 * Resolve a package name the way Node does — `<dir>/node_modules/<name>` from
 * `fromDir` upward, the first hit winning, then through any symlink — but never
 * above the ceiling.
 *
 * The same walk serves a bun workspace (a hoisted or per-package symlink) and
 * an npm prefix (a real directory), which is why it is the walk and not a
 * workspace-aware shortcut.
 *
 * @param name - The package to find
 * @param fromDir - The depending package's real directory, inside the ceiling
 * @param ceiling - The real directory resolution never climbs above
 * @returns The package's real directory, or `undefined` when nothing under the
 *   ceiling provides it
 * @throws {VatError} an arm refusal when the hit's real directory lies outside the ceiling
 */
function resolvePackage(name: string, fromDir: string, ceiling: string): string | undefined {
  for (let dir = fromDir; ; dir = safePath.resolve(dir, '..')) {
    const candidate = safePath.join(dir, 'node_modules', name);
    if (isDirectory(candidate)) {
      const real = realDirectory(candidate);
      if (isUnderRoot(ceiling, real) !== 'inside') {
        throw armRefusal(`closure: ${name}, found at ${candidate}, is really ${real}, outside ${ceiling}`);
      }
      return real;
    }
    if (dir === ceiling || dir === safePath.resolve(dir, '..')) return undefined;
  }
}

/**
 * The digest of ONE VAT package: its manifest plus its `dist/`.
 *
 * @param packageRoot - Absolute, real package directory
 * @param name - The package name, for the error
 * @returns A 64-character hex digest
 * @throws {VatError} an arm refusal when the package has no `dist/` — a closure member with
 *   nothing built is not a build that can run
 */
function packageDigest(packageRoot: string, name: string): string {
  const dist = safePath.join(packageRoot, 'dist');
  if (!isDirectory(dist)) {
    throw armRefusal(`closure: ${name} at ${packageRoot} has no dist/ — build it first`);
  }
  const digest = createHash('sha256');
  digest.update(`${MANIFEST}${FIELD_SEPARATOR}${contentDigest(packageRoot, MANIFEST)}\n`, 'utf8');
  digest.update(`dist${FIELD_SEPARATOR}${fingerprintFiles(dist, { fromGit: false, exclude: CLOSURE_EXCLUDE }).fingerprint}\n`, 'utf8');
  return digest.digest('hex');
}

/**
 * The real directories one package's runtime dependencies resolve to.
 *
 * @param dir - The package's real directory
 * @param manifest - Its manifest
 * @param ceiling - The real directory resolution never climbs above
 * @returns Every required dependency's directory, and every present optional one's
 * @throws {VatError} an arm refusal naming a required dependency that does not resolve under the ceiling
 */
function dependencyDirectories(dir: string, manifest: ClosureManifest, ceiling: string): string[] {
  const found: string[] = [];
  for (const dependency of manifest.required) {
    const resolved = resolvePackage(dependency, dir, ceiling);
    if (resolved === undefined) {
      throw armRefusal(`closure: ${dependency} is declared by ${manifest.name} but does not resolve from ${dir} within ${ceiling}`);
    }
    found.push(resolved);
  }
  for (const dependency of manifest.optional) {
    const resolved = resolvePackage(dependency, dir, ceiling);
    if (resolved !== undefined && !isStubPeer(resolved)) found.push(resolved);
  }
  return found;
}

/**
 * @param packageRoot - A resolved package's real directory
 * @returns Whether it is a stub an `npx:` install wrote: its `exports` is {@link STUB_PEER_TARGET},
 *   which it does not hold, so Node cannot load it
 */
function isStubPeer(packageRoot: string): boolean {
  return (
    parseManifest(packageRoot).exports === STUB_PEER_TARGET &&
    !pathPresent(safePath.join(packageRoot, STUB_PEER_TARGET), 'entry', everywhere('source'), 'probe')
  );
}

/**
 * The SHA-256 over an arm's whole module closure (module header).
 *
 * @param cliPackageRoot - The cli package directory the arm runs (`packages/cli`
 *   in a tree, the package root of a `dist:` arm, the installed cli of an `npx:` arm)
 * @param ceiling - The directory resolution never climbs above (module header);
 *   the cli package must lie inside it
 * @returns 64 lowercase hex characters
 * @throws {VatError} an arm refusal when a declared dependency does not resolve under the
 *   ceiling, a manifest cannot be read, or a VAT closure member has no `dist/`
 */
export function closureDigest(cliPackageRoot: string, ceiling: string): string {
  const root = realDirectory(cliPackageRoot);
  const top = realDirectory(ceiling);
  // A standalone `dist:` package is its own ceiling.
  if (root !== top && isUnderRoot(top, root) !== 'inside') {
    throw armRefusal(`closure: the cli package ${root} lies outside its ceiling ${top}`);
  }
  // VAT packages keyed by name and path: the same bytes at two paths are two lines,
  // as they always were. Third-party lines are a set: one name@version is one fact.
  const lines = new Map<string, string>();
  const versions = new Set<string>();
  const visited = new Set<string>();
  const pending: string[] = [root];

  for (let dir = pending.pop(); dir !== undefined; dir = pending.pop()) {
    if (visited.has(dir)) continue;
    visited.add(dir);
    const manifest = readClosureManifest(dir);
    if (dir === root || manifest.name.startsWith(VAT_SCOPE)) {
      lines.set(`${manifest.name}${FIELD_SEPARATOR}${dir}`, `bytes${FIELD_SEPARATOR}${manifest.name}${FIELD_SEPARATOR}${packageDigest(dir, manifest.name)}\n`);
    } else {
      versions.add(`version${FIELD_SEPARATOR}${manifest.name}${FIELD_SEPARATOR}${manifest.version}\n`);
    }
    pending.push(...dependencyDirectories(dir, manifest, top));
  }

  // Sorted, and the path left out of every digested line: the same closure
  // installed at two prefixes is the same closure.
  const digest = createHash('sha256');
  for (const line of [...lines.values(), ...versions].toSorted(compareByCodeUnit)) digest.update(line, 'utf8');
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
