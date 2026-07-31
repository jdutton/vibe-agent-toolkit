import { type ValidationIssue } from '@vibe-agent-toolkit/agent-schema';
import { issueLocation } from '@vibe-agent-toolkit/utils';

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
 *
 * `existsAtSource` is READ FROM the walker's record, never assumed. The engine
 * gates `LINK_TO_GITIGNORED_FILE` on "gitignored AND exists"; hardcoding
 * existence here made that guard unreachable, so a walker that mislabelled a
 * missing target as gitignored got its mislabel rubber-stamped into an error
 * about a file that is not there.
 */
function exclusionToContext(
  reason: NonNullable<LinkResolution['excludeReason']>,
  targetExists: boolean,
): RuleContext {
  switch (reason) {
    case 'depth-exceeded':
      return makeRuleContext({ subject: 'edge', droppedByDepth: true });
    case 'outside-project':
      return makeRuleContext({ subject: 'edge', outsideProject: true });
    case 'gitignored':
      return makeRuleContext({ subject: 'edge', gitignored: true, existsAtSource: targetExists });
    case 'skill-definition':
      return makeRuleContext({ subject: 'edge', crossSkillDefinition: true });
    case 'directory-target':
      return makeRuleContext({ subject: 'edge', fileKind: 'directory' });
    case 'navigation-file':
      return makeRuleContext({ subject: 'edge', fileKind: 'nav' });
    case 'missing-target':
      return makeRuleContext({ subject: 'edge', phase: 'source', existsAtSource: targetExists });
    case 'pattern-matched':
      return makeRuleContext({ subject: 'edge', patternExcluded: true });
    default: {
      // Exhaustiveness guard, NOT a fallback. A `default:` arm that returns a
      // context is precisely what disables TypeScript's exhaustiveness check:
      // a newly added excludeReason would compile and be silently dropped into
      // a no-op context. Assigning to `never` makes it a compile error instead.
      const _exhaustive: never = reason;
      throw new Error(`Unhandled walker excludeReason: ${String(_exhaustive)}`);
    }
  }
}

/**
 * Map walker exclusions to validation issues by routing each through the
 * intent-aware engine. Exclusions whose intent is acceptable (navigational
 * directory link, pattern-excluded reference) produce no issue.
 */
export function walkerExclusionsToIssues(
  exclusions: readonly LinkResolution[],
  locationRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const r of exclusions) {
    if (!r.excludeReason) continue;
    const code = evaluate(exclusionToContext(r.excludeReason, r.targetExists));
    if (code === null) continue;
    // Anchor to the file CONTAINING the link, not the target. For a
    // `missing-target` exclusion the target does not exist, so a location
    // naming it points at nothing the author can open. The target is a link,
    // and links have their own field.
    const target = issueLocation(r.path, locationRoot);
    issues.push(materializeIssue(code, {
      location: issueLocation(r.sourcePath, locationRoot),
      ...(r.sourceLine !== undefined && { line: r.sourceLine }),
      link: r.linkHref ?? target,
      detail: `link: ${r.linkHref ?? target}`,
    }));
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
  locationRoot: string,
): ValidationIssue[] {
  return deferredAssets.map((asset) => {
    const location = issueLocation(asset, locationRoot);
    return materializeIssue('LINK_DEFERRED_ARTIFACT', { location, detail: location });
  });
}
