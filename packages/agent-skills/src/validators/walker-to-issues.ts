import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { LinkResolution } from '../walk-link-graph.js';

import { evaluate, makeRuleContext, materializeIssue, type RuleContext } from './rule-engine/index.js';

/**
 * Live-path extraction front-end (issue #129, slice 3).
 *
 * Translates the link-graph walker's mechanical `excludeReason` into the
 * intent-aware {@link RuleContext} the engine reasons over. This is the ONLY
 * place the live path maps walker mechanics to intent; the code/severity/fix
 * decision and issue construction belong to the shared engine + materializer,
 * so the registry stays the single source of truth.
 *
 * A navigational link that resolves to a directory ('directory-target') is a
 * valid reference — the directory is excluded from the bundle but no issue is
 * emitted (the engine returns `null` for a non-typed-slot directory). A
 * `files:` typed-slot source resolving to a directory is an error, but that
 * check lives in packaging-validator, not here.
 */
function exclusionToContext(reason: NonNullable<LinkResolution['excludeReason']>): RuleContext {
  switch (reason) {
    case 'depth-exceeded':
      return makeRuleContext({ subject: 'edge', droppedByDepth: true });
    case 'outside-project':
      return makeRuleContext({ subject: 'edge', outsideProject: true });
    case 'gitignored':
      return makeRuleContext({ subject: 'edge', gitignored: true, existsAtSource: true });
    case 'skill-definition':
      return makeRuleContext({ subject: 'edge', crossSkillDefinition: true });
    case 'directory-target':
      return makeRuleContext({ subject: 'edge', fileKind: 'directory' });
    case 'navigation-file':
      return makeRuleContext({ subject: 'edge', fileKind: 'nav' });
    case 'missing-target':
      return makeRuleContext({ subject: 'edge', phase: 'source', existsAtSource: false });
    case 'pattern-matched':
      return makeRuleContext({ subject: 'edge', patternExcluded: true });
    default:
      // Exhaustive — every excludeReason is handled above.
      return makeRuleContext({ subject: 'edge' });
  }
}

/**
 * Map walker exclusions to validation issues by routing each through the
 * intent-aware engine. Exclusions whose intent is acceptable (navigational
 * directory link, pattern-excluded reference) produce no issue.
 */
export function walkerExclusionsToIssues(
  exclusions: readonly LinkResolution[],
  projectRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const r of exclusions) {
    if (!r.excludeReason) continue;
    const code = evaluate(exclusionToContext(r.excludeReason));
    if (code === null) continue;
    const location = toForwardSlash(safePath.relative(projectRoot, r.path));
    issues.push(materializeIssue(code, { location, detail: `link: ${r.linkHref ?? location}` }));
  }
  return issues;
}

/**
 * Emit one LINK_DEFERRED_ARTIFACT info issue per deferred asset path.
 *
 * Routed through the shared materializer so severity/fix/reference and the
 * description headline come from CODE_REGISTRY.
 */
export function deferredAssetsToIssues(
  deferredAssets: readonly string[],
  projectRoot: string,
): ValidationIssue[] {
  return deferredAssets.map((asset) => {
    const location = toForwardSlash(safePath.relative(projectRoot, asset));
    return materializeIssue('LINK_DEFERRED_ARTIFACT', { location, detail: location });
  });
}
