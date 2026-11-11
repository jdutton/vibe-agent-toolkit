/**
 * Frontmatter scanner: emits ALLOWED_TOOLS_LOCAL_SHELL evidence when
 * SKILL.md frontmatter declares allowed-tools that imply a local shell
 * environment (Bash/Edit/Write/NotebookEdit).
 *
 * Delegates to the agent-skills detector so the rules are consistent
 * with standalone skill validation.
 */

import { runCompatDetectors, type EvidenceRecord } from '@vibe-agent-toolkit/agent-skills';

const FRONTMATTER_PATTERN_IDS: ReadonlySet<string> = new Set([
  'ALLOWED_TOOLS_LOCAL_SHELL',
  'PROSE_LOCAL_SHELL_TOOL_REFERENCE',
]);

/**
 * Scan SKILL.md frontmatter (and prose tool references) for compatibility
 * signals. Returns evidence records for each matched pattern. `frontmatter` is the
 * caller's one parse of it.
 */
export function scanFrontmatter(
  content: string,
  filePath: string,
  locationRoot: string,
  frontmatter: Readonly<Record<string, unknown>> | undefined,
): EvidenceRecord[] {
  const { evidence } = runCompatDetectors(content, filePath, locationRoot, frontmatter);
  return evidence.filter(e => FRONTMATTER_PATTERN_IDS.has(e.patternId));
}
