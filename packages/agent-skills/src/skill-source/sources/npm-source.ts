import { existsSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import { ASSET_REFERENCE_UNRESOLVED_CODE, resolveAssetReference, VatError } from '@vibe-agent-toolkit/utils';

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
 * A package with no subpath is found through its manifest, because Node
 * resolves a package only to a file. A target that is not on disk (the package
 * is not installed, or `resolveAssetReference` fell back to a path for an
 * unscoped name) throws `ASSET_REFERENCE_UNRESOLVED`, like a specifier Node
 * could not resolve at all.
 *
 * @param spec Bare specifier WITH a version pin: `@scope/pkg@1.2.3[/subpath]`.
 * @param repoRoot Directory the package is installed under.
 */
export function locateNpmSource(spec: string, repoRoot: string): string {
  const { name, version } = splitNpmSpecVersion(spec);
  // Node module resolution does not understand the `@version` pin; re-attach the subpath.
  const subpath = spec.slice(`${name}@${version}`.length); // '' or '/dir/...'
  const resolved = resolveAssetReference(subpath === '' ? `${name}/package.json` : `${name}${subpath}`, repoRoot);
  if (!existsSync(resolved)) {
    throw new VatError(
      ASSET_REFERENCE_UNRESOLVED_CODE,
      `npm skill source '${spec}' is not installed: nothing at ${resolved}. Install '${name}' in ${repoRoot}.`,
    );
  }
  return subpath === '' ? dirname(resolved) : resolved;
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
  const located = locateNpmSource(spec, ctx.repoRoot);
  // The located target may be a file (exports subpath) or a directory; stage its directory.
  const resolvedDir = statSync(located).isDirectory() ? located : dirname(located);
  const hash = await hashDirectory(resolvedDir);
  const stagedDir = await stageDirInto(resolvedDir, ctx, `npm-${hash}`);
  return { stagedDir, identity: `npm:${name}@${version}:${hash}` };
}
