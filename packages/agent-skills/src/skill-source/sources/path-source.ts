import { resolveAssetReference } from '@vibe-agent-toolkit/utils';

import { hashDirectory } from '../content-hash.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/**
 * Resolve a `{ path }` skill source.
 *
 * Uses resolveAssetReference for LOCATION only (filesystem branch, relative to
 * ctx.repoRoot), then content-hashes the resolved tree and stages it under that
 * hash. The hash IS the integrity story for local dirs — there is no registry.
 */
export async function resolvePathSource(
  spec: string,
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  const resolvedDir = resolveAssetReference(spec, ctx.repoRoot);
  const hash = await hashDirectory(resolvedDir);
  const stagedDir = await stageDirInto(resolvedDir, ctx, `path-${hash}`);
  return { stagedDir, identity: `path:${hash}` };
}
