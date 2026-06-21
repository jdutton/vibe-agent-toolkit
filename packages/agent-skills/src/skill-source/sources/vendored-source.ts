import { hashDirectory } from '../content-hash.js';
import { stageDirInto } from '../stage.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext } from '../types.js';

/**
 * Resolve a `{ vendored: true }` skill source: copy the committed pinned directory
 * (ctx.vendoredDir) into staging. Identity is the manifest hash (content hash of the
 * vendored tree). Pinned-manifest preflight verification is a separate concern.
 */
export async function resolveVendoredSource(
  ctx: ResolveSkillSourceContext,
): Promise<ResolvedSkillSource> {
  if (ctx.vendoredDir === undefined) {
    throw new Error(
      'vendored skill source requires ctx.vendoredDir (absolute path to the committed pinned copy).',
    );
  }
  const hash = await hashDirectory(ctx.vendoredDir);
  const stagedDir = await stageDirInto(ctx.vendoredDir, ctx, `vendored-${hash}`);
  return { stagedDir, identity: `vendored:${hash}` };
}
