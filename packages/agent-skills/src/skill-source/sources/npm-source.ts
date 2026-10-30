import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ASSET_REFERENCE_UNRESOLVED_CODE,
  everywhere,
  followedKindSync,
  isUnderRoot,
  pathPresent,
  resolveAssetReference,
  safePath,
  VatError,
  withFsFaultSync,
} from '@vibe-agent-toolkit/utils';

import { hashDirectory } from '../content-hash.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/**
 * The `VatError` code of an npm skill source spec that is not `name@version[/subpath]`.
 * Whoever wrote the spec fixes it, so a caller reports it against that input.
 */
export const SKILL_SOURCE_SPEC_INVALID_CODE = 'SKILL_SOURCE_SPEC_INVALID';

/** Match `@scope/name@version[/subpath]` or `name@version[/subpath]`, capturing name + version. */
// eslint-disable-next-line security/detect-unsafe-regex -- pattern is safe (bounded quantifiers, no backtracking)
const NPM_SPEC_RE = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.+)?$/;

/**
 * Split a version-pinned bare specifier into { name, version }.
 * Throws `SKILL_SOURCE_SPEC_INVALID` if no `@version` pin is present — npm
 * sources MUST be version-pinned for reproducibility (spec §11a).
 */
export function splitNpmSpecVersion(spec: string): { name: string; version: string } {
  const match = NPM_SPEC_RE.exec(spec);
  if (!match?.[1] || !match?.[2]) {
    throw new VatError(
      SKILL_SOURCE_SPEC_INVALID_CODE,
      `npm skill source '${spec}' must be version-pinned, e.g. "@scope/pkg@1.2.3" or "@scope/pkg@1.2.3/subpath".`,
    );
  }
  return { name: match[1], version: match[2] };
}

/**
 * Where an installed npm skill source sits on disk: the file or directory its
 * subpath names, or the package's own directory when it names none.
 *
 * The package is found on disk along Node's own lookup paths, never through a
 * resolution — Node resolves a package only to a file, and its `exports` map
 * may hide `./package.json`. A subpath is a path inside the package (a file or a
 * directory); one that is not on disk there is tried as an `exports` subpath, so
 * an alias the publisher declares still works. A package that is not installed,
 * or a subpath that names nothing either way, throws `ASSET_REFERENCE_UNRESOLVED`.
 *
 * @param spec Bare specifier WITH a version pin: `@scope/pkg@1.2.3[/subpath]`.
 * @param repoRoot Directory the package is installed under.
 * @throws {VatError} `SKILL_SOURCE_SPEC_INVALID` for an unpinned spec or a subpath
 *   that climbs out of the package
 */
export function locateNpmSource(spec: string, repoRoot: string): string {
  return locateInPackage(spec, repoRoot).located;
}

/**
 * {@link locateNpmSource}, with the installed package directory it found — the tree every later
 * probe of the located path is crawled in. Every probe reads the link chain beneath its tree by
 * text before the kernel follows it, and one the OS (or VAT) refused is a `source` fault, never
 * "not installed".
 */
function locateInPackage(spec: string, repoRoot: string): { located: string; packageDir: string } {
  const { name, version } = splitNpmSpecVersion(spec);
  const subpath = spec.slice(`${name}@${version}`.length); // '' or '/dir/...'
  const packageDir = installedPackageDir(spec, name, repoRoot);
  if (subpath === '') return { located: packageDir, packageDir };

  const onDisk = safePath.join(packageDir, subpath);
  if (isUnderRoot(packageDir, onDisk) === 'outside') {
    throw new VatError(SKILL_SOURCE_SPEC_INVALID_CODE, `npm skill source '${spec}' names a subpath outside the package ${packageDir}.`);
  }
  if (pathPresent(onDisk, { follow: packageDir }, everywhere('source'), 'probe')) return { located: onDisk, packageDir };

  // Not a path in the package: an `exports` subpath, held to the package it names.
  const exported = resolveAssetReference(`${name}${subpath}`, repoRoot);
  if (isUnderRoot(packageDir, exported) !== 'inside' || !pathPresent(exported, { follow: packageDir }, everywhere('source'), 'probe')) {
    throw new VatError(
      ASSET_REFERENCE_UNRESOLVED_CODE,
      `npm skill source '${spec}' names nothing in the installed package: no ${onDisk}, and no "exports" subpath '.${subpath}' on disk.`,
    );
  }
  return { located: exported, packageDir };
}

/** The installed package's directory: the first `<node_modules>/<name>` holding a package.json along Node's lookup paths. */
function installedPackageDir(spec: string, name: string, repoRoot: string): string {
  const lookupPaths = createRequire(pathToFileURL(safePath.join(repoRoot, 'package.json')).href).resolve.paths(name) ?? [];
  // Each lookup directory is the operator's own (an ancestor of the repo they named): the package
  // link beneath it — a workspace or pnpm link — is read by its text before the kernel follows it.
  const found = lookupPaths
    .map((nodeModules) => ({ nodeModules, dir: safePath.join(nodeModules, name) }))
    .find(({ nodeModules, dir }) => pathPresent(safePath.join(dir, 'package.json'), { follow: nodeModules }, everywhere('source'), 'probe'))
    ?.dir;
  if (found === undefined) {
    throw new VatError(
      ASSET_REFERENCE_UNRESOLVED_CODE,
      `npm skill source '${spec}' is not installed: no ${name}/package.json in any node_modules above ${repoRoot}. Install '${name}' in ${repoRoot}.`,
    );
  }
  return found;
}

/**
 * Resolve a `{ npm }` skill source.
 *
 * {@link locateNpmSource} finds the installed package subpath (location only —
 * NO registry-integrity check). We then content-hash the staged tree and record
 * version + tree-hash in the identity. This is NOT a registry dist.integrity
 * guarantee; v1 stages what is installed (spec §11a, stated honestly).
 *
 * @param spec Bare specifier WITH a version pin: `@scope/pkg@1.2.3[/subpath]`.
 */
export async function resolveNpmSource(
  spec: string,
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  const { name, version } = splitNpmSpecVersion(spec);
  const { located, packageDir } = locateInPackage(spec, ctx.repoRoot);
  // The located target may be a file or a directory; stage the directory.
  const kind = withFsFaultSync(
    { side: 'source', origin: 'content', action: `examine the npm skill source at ${located}`, path: located },
    () => followedKindSync(located, packageDir),
  );
  const resolvedDir = kind === 'directory' ? located : dirname(located);
  const hash = await hashDirectory(resolvedDir);
  const stagedDir = await stageDirInto(resolvedDir, ctx, `npm-${hash}`);
  return { stagedDir, identity: `npm:${name}@${version}:${hash}`, leftovers: [] };
}
