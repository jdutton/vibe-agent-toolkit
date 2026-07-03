import { resolveAssetReference } from '@vibe-agent-toolkit/utils';

import { hashDirectory } from '../content-hash.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/** Match `@scope/name@version[/subpath]` or `name@version[/subpath]`, capturing name + version. */
// eslint-disable-next-line security/detect-unsafe-regex -- pattern is safe (bounded quantifiers, no backtracking)
const NPM_SPEC_RE = /^((?:@[^/@]+\/)?[^/@]+)@([^/]+)(\/.+)?$/;

/**
 * Split a version-pinned bare specifier into { name, version }.
 * Throws if no `@version` pin is present — npm sources MUST be version-pinned
 * for reproducibility (spec §11a).
 */
export function splitNpmSpecVersion(spec: string): { name: string; version: string } {
  const match = NPM_SPEC_RE.exec(spec);
  if (!match?.[1] || !match?.[2]) {
    throw new Error(
      `npm skill source '${spec}' must be version-pinned, e.g. "@scope/pkg@1.2.3" or "@scope/pkg@1.2.3/subpath".`,
    );
  }
  return { name: match[1], version: match[2] };
}

/**
 * Resolve a `{ npm }` skill source.
 *
 * resolveAssetReference locates the installed package subpath (location only —
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
  // resolveAssetReference wants a bare specifier WITHOUT the `@version` pin
  // (Node module resolution does not understand the pin). Re-attach the subpath.
  const subpath = spec.slice(`${name}@${version}`.length); // '' or '/dir/...'
  const locator = `${name}${subpath}`;
  const resolvedFile = resolveAssetReference(locator, ctx.repoRoot);
  // resolvedFile may be a file (exports subpath) or a directory specifier; stage its directory.
  const resolvedDir = await dirOf(resolvedFile);
  const hash = await hashDirectory(resolvedDir);
  const stagedDir = await stageDirInto(resolvedDir, ctx, `npm-${hash}`);
  return { stagedDir, identity: `npm:${name}@${version}:${hash}` };
}

async function dirOf(p: string): Promise<string> {
  const { statSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  const stat = statSync(p);
  return stat.isDirectory() ? p : dirname(p);
}
