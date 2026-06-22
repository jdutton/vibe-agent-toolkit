import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';

import { normalizedTmpdir, safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import { packageSkill } from '../../skill-packager.js';
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
  const buildOut = toForwardSlash(
    mkdtempSync(safePath.join(normalizedTmpdir(), 'vat-ws-build-')),
  );
  try {
    const result = await packageSkill(opts.skillPath, {
      outputPath: safePath.join(buildOut, skillName),
      formats: ['directory'],
    });
    const builtDir = result.outputPath;
    const hash = await hashDirectory(builtDir);
    // stageDirInto copies the built bundle OUT into the staging root before we
    // return, so the build temp dir is safe to remove in the finally below.
    const stagedDir = await stageDirInto(builtDir, ctx, `workspace-${skillName}-${hash}`);
    return { stagedDir, identity: `workspace:${skillName}:${hash}` };
  } finally {
    await rm(buildOut, { recursive: true, force: true });
  }
}
