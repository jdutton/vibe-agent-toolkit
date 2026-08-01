/**
 * Rendering for the four `ValidationIssue` anchors.
 *
 * `location` / `line` / `field` are independent fields on the issue (see the
 * anchor contract on `ValidationIssue` in `@vibe-agent-toolkit/agent-schema`).
 * Splitting them apart in the producers only pays off if the renderers put
 * them back together — a `line` that no output surface prints is a `line` that,
 * from the user's side, was deleted. This is the one place that join happens,
 * so every command spells an anchor the same way.
 */

import type { ValidationIssue } from '@vibe-agent-toolkit/agent-schema';

/**
 * Render an issue's anchor as a single human/tool-readable string.
 *
 * - `docs/guide.md` — file only
 * - `docs/guide.md:24` — file + line, the `file:line` convention every editor
 *   and `grep -n` consumer already knows how to jump to
 * - `SKILL.md (frontmatter.description)` — file + document-internal field
 * - `(frontmatter.description)` — field with no known file (should not happen
 *   for skills-lane issues, but the renderer must not silently drop it)
 *
 * Returns `undefined` when the issue carries no anchor at all, so callers can
 * skip the line entirely rather than print an empty label.
 */
export function formatIssueAnchor(issue: ValidationIssue): string | undefined {
  const hasLocation = issue.location !== undefined && issue.location !== '';
  const hasField = issue.field !== undefined && issue.field !== '';
  if (!hasLocation && !hasField) {
    return undefined;
  }

  let anchor = hasLocation ? (issue.location as string) : '';
  if (issue.line !== undefined) {
    anchor = `${anchor}:${String(issue.line)}`;
  }
  if (hasField) {
    anchor = anchor === '' ? `(${issue.field as string})` : `${anchor} (${issue.field as string})`;
  }
  return anchor;
}
