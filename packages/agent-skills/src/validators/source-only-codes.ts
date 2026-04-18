/**
 * Codes that only apply when validating source SKILL.md files.
 * These are skipped when validating built output in dist/.
 */
export const SOURCE_ONLY_CODES: ReadonlySet<string> = new Set([
  'LINK_OUTSIDE_PROJECT',
  'LINK_BOUNDARY_VIOLATION',
  'LINK_TARGETS_DIRECTORY',
  'REFERENCE_TOO_DEEP',
  'LINK_TO_NAVIGATION_FILE',
]);
