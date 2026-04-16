import { safePath, toForwardSlash } from '@vibe-agent-toolkit/utils';

import type { LinkResolution } from '../walk-link-graph.js';

import { CODE_REGISTRY, type IssueCode } from './code-registry.js';
import type { ValidationIssue } from './types.js';

const REASON_TO_CODE: Record<NonNullable<LinkResolution['excludeReason']>, IssueCode | null> = {
  'depth-exceeded': 'LINK_DROPPED_BY_DEPTH',
  'outside-project': 'LINK_OUTSIDE_PROJECT',
  gitignored: 'LINK_TO_GITIGNORED_FILE',
  'skill-definition': 'LINK_TO_SKILL_DEFINITION',
  'directory-target': 'LINK_TARGETS_DIRECTORY',
  'navigation-file': 'LINK_TO_NAVIGATION_FILE',
  'missing-target': 'LINK_MISSING_TARGET',
  'pattern-matched': null,
};

export function walkerExclusionsToIssues(
  exclusions: readonly LinkResolution[],
  projectRoot: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  for (const r of exclusions) {
    if (!r.excludeReason) continue;
    const code = REASON_TO_CODE[r.excludeReason];
    if (!code) continue;
    const entry = CODE_REGISTRY[code];
    const location = toForwardSlash(safePath.relative(projectRoot, r.path));
    issues.push({
      severity: entry.defaultSeverity,
      code,
      message: `${entry.description} (link: ${r.linkHref ?? location})`,
      location,
      fix: entry.fix,
      reference: entry.reference,
    });
  }
  return issues;
}
