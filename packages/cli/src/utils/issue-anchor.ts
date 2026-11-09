/**
 * Rendering for the four `ValidationIssue` anchors.
 *
 * `location` / `line` / `field` are independent fields on the issue (see the
 * anchor contract on `ValidationIssue` in `@vibe-agent-toolkit/schema`).
 * Splitting them apart in the producers only pays off if the renderers put
 * them back together — a `line` that no output surface prints is a `line` that,
 * from the user's side, was deleted. This is the one place that join happens,
 * so every command spells an anchor the same way.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/schema';

/**
 * Render an issue's anchor as a single human/tool-readable string.
 *
 * - `docs/guide.md` — file only
 * - `docs/guide.md:24` — file + line, the `file:line` convention every editor
 *   and `grep -n` consumer already knows how to jump to
 * - `docs/guide.md:24:7` — file + line + column, when a `Finding` carries one
 * - `SKILL.md (frontmatter.description)` — file + document-internal field
 * - `(frontmatter.description)` — field with no known file (should not happen
 *   for skills-lane issues, but the renderer must not silently drop it)
 *
 * 🪤 The coordinates join the anchor ONLY when there is a file to put them on.
 * Without one, `:3` or `3:5` in front of the severity reads as a file named
 * `3`; {@link formatIssuePosition} says them after the message instead.
 *
 * Returns `undefined` when the issue carries no anchor at all, so callers can
 * skip the line entirely rather than print an empty label.
 */
export function formatIssueAnchor(
  issue: Pick<ValidationIssue, 'location' | 'line' | 'column' | 'field'>,
): string | undefined {
  const hasLocation = namesFile(issue);
  const hasField = issue.field !== undefined && issue.field !== '';
  if (!hasLocation && !hasField) {
    return undefined;
  }

  let anchor = hasLocation ? (issue.location as string) : '';
  if (hasLocation && issue.line !== undefined) {
    anchor = `${anchor}:${String(issue.line)}`;
    if (issue.column !== undefined) anchor = `${anchor}:${String(issue.column)}`;
  }
  if (hasField) {
    anchor = anchor === '' ? `(${issue.field as string})` : `${anchor} (${issue.field as string})`;
  }
  return anchor;
}

/**
 * The coordinates of an issue that names NO file, as a trailing clause:
 * ` (line 3, column 5)`, or `''` when there is nothing to say there.
 *
 * The other half of {@link formatIssueAnchor}: a line with a file is part of
 * the `file:line:column` prefix, and a line without one is said here — so every
 * coordinate an issue carries is printed exactly once.
 */
export function formatIssuePosition(issue: Pick<ValidationIssue, 'location' | 'line' | 'column'>): string {
  if (namesFile(issue) || issue.line === undefined) return '';
  const column = issue.column === undefined ? '' : `, column ${String(issue.column)}`;
  return ` (line ${String(issue.line)}${column})`;
}

/** Whether the issue names a file — the one thing its coordinates can be put in front of. */
function namesFile(issue: Pick<ValidationIssue, 'location'>): boolean {
  return issue.location !== undefined && issue.location !== '';
}
