import { resolveNpmSource } from './sources/npm-source.js';
import { resolvePathSource } from './sources/path-source.js';
import { resolveVendoredSource } from './sources/vendored-source.js';
import { resolveWorkspaceSource } from './sources/workspace-source.js';
import type { ResolvedSkillSource, ResolveSkillSourceContext, SkillSource } from './types.js';

// NOTE: the url resolver is loaded lazily (see the `url` arm below). It is the only
// source that pulls in network + zip machinery (global `fetch`, `adm-zip`), and
// eagerly importing that subgraph into every consumer of this barrel (e.g. `vat audit`,
// which only needs `cloneGitSource`) left a pending async operation that rejected during
// vitest forks-pool worker teardown, surfacing as `ERR_IPC_CHANNEL_CLOSED`. Loading it on
// demand keeps that machinery out of consumers' eager import graph; it still runs normally
// when a `{ url }` source is actually resolved.

export interface ResolveSkillSourceOptions {
  /** Map of workspace skill name -> absolute SKILL.md path (required for { workspace } sources). */
  workspaceSkillPaths?: Record<string, string>;
}

/**
 * Unified entry point: materialize any typed SkillSource to a staged directory and
 * return a stable reconciliation identity (spec §11c). Composes existing primitives —
 * it never reimplements a resolver.
 */
export async function resolveSkillSource(
  source: SkillSource,
  ctx: ResolveSkillSourceContext,
  opts: ResolveSkillSourceOptions = {},
): Promise<ResolvedSkillSource> {
  if ('path' in source) {
    return resolvePathSource(source.path, ctx);
  }
  if ('npm' in source) {
    return resolveNpmSource(source.npm, ctx);
  }
  if ('url' in source) {
    const { resolveUrlSource } = await import('./sources/url-source.js');
    return resolveUrlSource(source.url, source.sha256, ctx);
  }
  if ('vendored' in source) {
    return resolveVendoredSource(ctx);
  }
  const skillPath = opts.workspaceSkillPaths?.[source.workspace];
  if (skillPath === undefined) {
    throw new Error(
      `workspace skill source '${source.workspace}' has no SKILL.md path mapping ` +
        `(pass opts.workspaceSkillPaths['${source.workspace}']).`,
    );
  }
  return resolveWorkspaceSource(source.workspace, ctx, { skillPath });
}
