import { dirname } from 'node:path';

import { findProjectRoot, safePath, withTempDir } from '@vibe-agent-toolkit/utils';

import { packageSkill } from '../../skill-packager.js';
import { withSkillRegistries } from '../../validators/run-skill-registries.js';
import { hashDirectory } from '../content-hash.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

export interface WorkspaceResolveOptions {
  /** Absolute path to the workspace skill's SKILL.md (caller maps name -> path). */
  skillPath: string;
}

/**
 * Resolve a `{ workspace }` skill source: build the named monorepo skill via the
 * existing packageSkill build graph (the same path `vat skills build` drives) into
 * a fresh temp dir, then stage the BUILT bundle. Staging the build output is what
 * makes the packaged form the thing evaluated (spec §5).
 *
 * Identity is the content hash of the built bundle — the build-input fingerprint
 * of record for §11b reconciliation (a source edit changes the built bundle, which
 * changes the hash, which forces a re-stage).
 */
export async function resolveWorkspaceSource(
  skillName: string,
  ctx: ResolveSkillSourceContext,
  opts: WorkspaceResolveOptions,
): Promise<ResolvedSkillSource> {
  // stageDirInto copies the built bundle OUT into the staging root before we
  // return, so the build temp dir is safe to dispose of once the work is done.
  const { value, leftover } = await withTempDir('vat-ws-build-', async (buildOut) => {
    // This build is its own run: the project the skill resolves to, under its own config.
    const projectRoot = findProjectRoot(dirname(opts.skillPath)) ?? dirname(opts.skillPath);
    const result = await withSkillRegistries(projectRoot, (registries) => packageSkill(opts.skillPath, {
      outputPath: safePath.join(buildOut, skillName),
      formats: ['directory'],
      registries,
    }));
    const builtDir = result.outputPath;
    const hash = await hashDirectory(builtDir);
    const stagedDir = await stageDirInto(builtDir, ctx, `workspace-${skillName}-${hash}`);
    return { stagedDir, identity: `workspace:${skillName}:${hash}` };
  });
  return { ...value, leftovers: leftover === undefined ? [] : [leftover] };
}
