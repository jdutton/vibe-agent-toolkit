import { type ValidationIssue } from '@vibe-agent-toolkit/schema';
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
 * **Every one of the walker's eleven reasons reaches a code.** Two did not: a
 * navigational link resolving to a directory ('directory-target') and a
 * reference refused by the author's own rule ('pattern-matched') both evaluated
 * to `null` and were filtered out of the output below, so the author got no
 * finding at all — not a quiet one, none. Both are now reported, at severities
 * that say how much each matters: `LINK_TO_UNBUNDLED_DIRECTORY` (warning — the
 * directory never travels, so the packaged link points at nothing) and
 * `LINK_EXCLUDED_BY_PATTERN` (info — the author configured this, and the receipt
 * only needs to be there when they come looking for it).
 *
 * `LINK_TARGETS_DIRECTORY` is a DIFFERENT code for a different situation: a
 * `files:` typed-slot source that resolves to a directory, an error, owned by
 * packaging-validator. The two never fire for the same edge.
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
    case 'agent-instruction-file':
      return makeRuleContext({ subject: 'edge', fileKind: 'agent-instruction' });
    case 'missing-target':
      return makeRuleContext({ subject: 'edge', phase: 'source', existsAtSource: targetExists });
    case 'unreadable-target':
      // Present on disk, unstattable anyway. `existsAtSource` stays true (the
      // walker found it) — the edge is not broken, it is unreadable, and the two
      // send an author to different places.
      return makeRuleContext({ subject: 'edge', unreadable: true });
    case 'pattern-matched':
      return makeRuleContext({ subject: 'edge', patternExcluded: true });
    case 'non-routable-source':
      // `existsAtSource` is read from the walker's record for the same reason
      // the gitignore arm reads it: a link out of an HTML page to a path that
      // is not there is an author's broken link, and the engine must be able to
      // tell the two apart rather than being handed a hardcoded `true`.
      return makeRuleContext({ subject: 'edge', nonRoutableSource: true, existsAtSource: targetExists });
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
 * The per-issue detail appended to the registry description.
 *
 * Always the link, because that is what identifies the edge. Plus, when the
 * walker recorded WHICH rule refused the reference, the patterns of that rule:
 * with several `excludeReferencesFromBundle` rules configured, learning that one
 * of them fired is not an answer to "why did this file not ship?", and the
 * walker already knows which. Keyed on the presence of `matchedRule` rather than
 * on the code, because the walker only ever sets that field for the reason it
 * describes — so this needs no branch on a code it does not own.
 */
function exclusionDetail(r: LinkResolution, target: string): string {
  const link = `link: ${r.linkHref ?? target}`;
  return r.matchedRule === undefined
    ? link
    : `${link}; matched excludeReferencesFromBundle pattern(s): ${r.matchedRule.patterns.join(', ')}`;
}

/**
 * Map walker exclusions to validation issues by routing each through the
 * intent-aware engine.
 *
 * One exclusion in, one issue out: the engine no longer returns `null` for any
 * reason the walker can record, so no exclusion is dropped on the floor here.
 * The `null` branch remains because `evaluate` is shared with the file/orphan
 * subject, where `null` is a real verdict.
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
      detail: exclusionDetail(r, target),
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
