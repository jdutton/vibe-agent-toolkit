/**
 * Canonical code registry.
 *
 * Single source of truth for every overridable validation code VAT emits.
 * Describes default severity, human description, fix hint, and a stable
 * reference anchor into docs/validation-codes.md.
 *
 * Renderers (CLI help, skill docs, runtime output) all pull from this
 * registry — no duplication.
 */

export type IssueSeverity = 'error' | 'warning' | 'ignore';

/** Non-ignore severities actually emitted to consumers. */
export type EmittedSeverity = Exclude<IssueSeverity, 'ignore'>;

export type IssueCode =
  // Source-detectable link codes
  | 'LINK_OUTSIDE_PROJECT'
  | 'LINK_TARGETS_DIRECTORY'
  | 'LINK_TO_NAVIGATION_FILE'
  | 'LINK_TO_GITIGNORED_FILE'
  | 'LINK_MISSING_TARGET'
  | 'LINK_TO_SKILL_DEFINITION'
  // Packaging-only link / output codes
  | 'LINK_DROPPED_BY_DEPTH'
  | 'PACKAGED_UNREFERENCED_FILE'
  | 'PACKAGED_BROKEN_LINK'
  // Best-practice / quality codes
  | 'SKILL_LENGTH_EXCEEDS_RECOMMENDED'
  | 'SKILL_TOTAL_SIZE_LARGE'
  | 'SKILL_TOO_MANY_FILES'
  | 'REFERENCE_TOO_DEEP'
  | 'DESCRIPTION_TOO_VAGUE'
  | 'NO_PROGRESSIVE_DISCLOSURE'
  // Meta-codes describing the state of the validation config itself
  | 'ALLOW_EXPIRED'
  | 'ALLOW_UNUSED';

export interface CodeRegistryEntry {
  defaultSeverity: EmittedSeverity;
  description: string;
  fix: string;
  /** Stable anchor into docs/validation-codes.md (e.g. '#link_outside_project'). */
  reference: string;
}

const entry = (
  defaultSeverity: EmittedSeverity,
  description: string,
  fix: string,
  anchor: string,
): CodeRegistryEntry => ({ defaultSeverity, description, fix, reference: `#${anchor}` });

export const CODE_REGISTRY: Record<IssueCode, CodeRegistryEntry> = {
  LINK_OUTSIDE_PROJECT: entry(
    'error',
    'Markdown link points to a file outside the project root.',
    'Move the target inside the project or remove the link. Use validation.allow if the reference is intentional and cross-project.',
    'link_outside_project',
  ),
  LINK_TARGETS_DIRECTORY: entry(
    'error',
    'Markdown link resolves to a directory rather than a file.',
    'Point the link at a specific file (e.g. README.md inside the directory) instead of the directory itself.',
    'link_targets_directory',
  ),
  LINK_TO_NAVIGATION_FILE: entry(
    'warning',
    'Markdown link targets a navigation file (README.md, index.md, etc.) which was excluded from the bundle.',
    'Link to the specific content instead of the navigation file, or set severity.LINK_TO_NAVIGATION_FILE to ignore if this is intentional.',
    'link_to_navigation_file',
  ),
  LINK_TO_GITIGNORED_FILE: entry(
    'error',
    'Markdown link targets a gitignored file; risks leaking ignored data into the bundle.',
    'Link to a non-ignored file or adjust .gitignore. Allow the specific path via validation.allow if the risk has been reviewed.',
    'link_to_gitignored_file',
  ),
  LINK_MISSING_TARGET: entry(
    'error',
    'Markdown link target does not exist on disk and is not a declared build artifact.',
    'Fix the link path, create the file, or declare it under skills.config.<name>.files as a build artifact.',
    'link_missing_target',
  ),
  LINK_TO_SKILL_DEFINITION: entry(
    'error',
    "Markdown link targets another skill's SKILL.md; bundling it creates duplicate skill definitions.",
    'Link to a specific resource inside the other skill, or reference the other skill by name.',
    'link_to_skill_definition',
  ),
  LINK_DROPPED_BY_DEPTH: entry(
    'warning',
    'Walker stopped following links at the configured linkFollowDepth; this link was not bundled.',
    'Raise linkFollowDepth, bundle the file via files config, declare the drop intentional with validation.allow, or exclude via excludeReferencesFromBundle.rules.',
    'link_dropped_by_depth',
  ),
  PACKAGED_UNREFERENCED_FILE: entry(
    'error',
    'File in the packaged output is not referenced from any packaged markdown.',
    'Add a markdown link or code-block mention in SKILL.md or a linked resource. Allow via validation.allow if the file is consumed programmatically.',
    'packaged_unreferenced_file',
  ),
  PACKAGED_BROKEN_LINK: entry(
    'error',
    'Link in the packaged output resolves to a file that is not present in the output (likely a link-rewriter bug).',
    'Report the issue — this indicates a VAT bug. As a temporary workaround, set severity.PACKAGED_BROKEN_LINK to ignore while the underlying bug is fixed.',
    'packaged_broken_link',
  ),
  SKILL_LENGTH_EXCEEDS_RECOMMENDED: entry(
    'warning',
    'SKILL.md line count exceeds the recommended limit; longer files degrade skill triggering.',
    'Split content into linked resources (progressive disclosure) or allow if the length is justified.',
    'skill_length_exceeds_recommended',
  ),
  SKILL_TOTAL_SIZE_LARGE: entry(
    'warning',
    'Total packaged line count exceeds the recommended limit.',
    'Reduce bundled content, move references out of the bundle, or allow if the size is justified.',
    'skill_total_size_large',
  ),
  SKILL_TOO_MANY_FILES: entry(
    'warning',
    'Packaged file count exceeds the recommended limit.',
    'Consolidate or restructure references, or allow if the file count is justified.',
    'skill_too_many_files',
  ),
  REFERENCE_TOO_DEEP: entry(
    'warning',
    'Bundled link graph exceeds the recommended depth; deeply nested references hurt discoverability.',
    'Flatten the reference structure or allow if depth is intentional.',
    'reference_too_deep',
  ),
  DESCRIPTION_TOO_VAGUE: entry(
    'warning',
    'SKILL.md description is too short to reliably trigger the skill.',
    'Expand the description with concrete triggers and use cases.',
    'description_too_vague',
  ),
  NO_PROGRESSIVE_DISCLOSURE: entry(
    'warning',
    'Long SKILL.md with no linked references; progressive disclosure recommended.',
    'Move background detail into linked resources and reference them from SKILL.md.',
    'no_progressive_disclosure',
  ),
  ALLOW_EXPIRED: entry(
    'warning',
    "A validation.allow entry's expires date is in the past; the allowance still applies but should be re-reviewed.",
    'Re-review the allow entry: extend expires, remove the entry, or fix the underlying issue. Upgrade severity to error for zero-tolerance expiry.',
    'allow_expired',
  ),
  ALLOW_UNUSED: entry(
    'warning',
    'A validation.allow entry did not match any emitted issue; the allow entry is dead weight.',
    'Remove the entry or fix the pattern. Upgrade severity to error to block on unused allow entries.',
    'allow_unused',
  ),
};
